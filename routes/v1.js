'use strict';
/*
 * routes/v1.js - API-et recorderne i kjøreverkene bruker, etter docs/PROTOKOLL.md versjon 1:
 *   POST /hello     når recorderen starter, og når serveren svarer igjen etter et brudd
 *   GET  /rules     det ferdige regelsettet for kjøreverket, med ETag og 304
 *   POST /ingest    en batch: lagret i én transaksjon, svar etter COMMIT
 *   POST /history   historikk til trendene i HMI-en
 * Alle krever nøkkelen (Authorization: Bearer), og feltet vehicle må høre til den.
 */

const { requireKey } = require('../lib/auth');
const { effectiveFor } = require('../lib/rules');
const { ingest } = require('../lib/ingest');
const { history } = require('../lib/history');

const PROTOCOL = 1;

const helloSchema = {
  body: {
    type: 'object', required: ['protocol', 'vehicle', 'boot'],
    properties: {
      protocol: { type: 'integer' },
      vehicle: { type: 'string', minLength: 1, maxLength: 32 },
      boot: { type: 'string', minLength: 4, maxLength: 64 },
      recorder: { type: 'string', maxLength: 40 },
      clock: { type: 'object', properties: { synced: { type: 'boolean' }, piTime: { type: 'number' } } },
    },
  },
};
const rulesSchema = { querystring: { type: 'object', required: ['vehicle'], properties: { vehicle: { type: 'string', minLength: 1, maxLength: 32 } } } };
// punktene sjekkes i lib/ingest.js, som gir en forklaring med tag og nummer
const ingestSchema = {
  body: {
    type: 'object', required: ['vehicle', 'boot', 'seq'],
    properties: {
      vehicle: { type: 'string', minLength: 1, maxLength: 32 },
      boot: { type: 'string', minLength: 4, maxLength: 64 },
      seq: { type: 'integer', minimum: 1 },
      clock: { type: 'object', properties: { synced: { type: 'boolean' }, piTime: { type: 'number' } } },
      tags: { type: 'array' },
      series: { type: 'object' },
      text: { type: 'object' },
      events: { type: 'array' },
      gaps: { type: 'array' },
    },
  },
};
const historySchema = {
  body: {
    type: 'object', required: ['vehicle', 'tags', 'from', 'to'],
    properties: {
      vehicle: { type: 'string', minLength: 1, maxLength: 32 },
      tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 64 },
      from: { type: 'number' },
      to: { type: 'number' },
      points: { type: 'number' },
    },
  },
};

module.exports = async function v1(app, { db, config, log }) {
  app.decorateRequest('vehicle', null);
  app.addHook('preHandler', requireKey(db, log));
  let inflight = 0;   // batcher som lagres akkurat nå (mottrykk, docs/PLAN.md §3.4)

  app.post('/hello', { schema: helloSchema }, async (req, reply) => {
    const b = req.body, v = req.vehicle;
    if (b.protocol !== PROTOCOL) return reply.code(400).send({ error: `unknown protocol ${b.protocol}: this server speaks protocol version ${PROTOCOL}` });
    const now = Date.now();
    const clock = b.clock || {};
    const synced = clock.synced === true;
    const piTime = Number.isFinite(clock.piTime) ? Math.round(clock.piTime) : null;
    const s = await db.query(`INSERT INTO session (vehicle_id, boot, recorder_version, clock_synced) VALUES ($1, $2, $3, $4)
      ON CONFLICT (vehicle_id, boot) DO UPDATE SET recorder_version = EXCLUDED.recorder_version, clock_synced = EXCLUDED.clock_synced RETURNING id`,
    [v.id, b.boot, b.recorder || null, synced]);
    const r = await db.query(`UPDATE vehicle SET last_seen = now(), recorder_version = $2, clock_synced = $3, clock_offset_ms = $4, last_ip = $5 WHERE id = $1
      RETURNING (extract(epoch FROM last_ts) * 1000)::bigint AS last_ts`, [v.id, b.recorder || null, synced, piTime === null ? null : piTime - now, req.ip]);
    if (piTime !== null) {
      await db.query('INSERT INTO clock_obs (vehicle_id, session_id, pi_time, offset_ms, synced) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)',
        [v.id, s.rows[0].id, piTime, Math.max(-2e9, Math.min(2e9, piTime - now)), synced]);
    }
    log.info(`${v.code}: hello from recorder ${b.recorder || '?'} (boot ${String(b.boot).slice(0, 8)}, clock ${synced ? 'synced' : 'not synced'}${piTime !== null ? `, ${piTime - now > 0 ? '+' : ''}${piTime - now} ms` : ''})`);
    const lastTs = r.rows[0].last_ts;
    return { serverTime: Date.now(), rulesVersion: Number(v.rules_version_eff), lastTs: lastTs === null || lastTs === undefined ? null : Number(lastTs), maxBatchBytes: config.ingest.maxBatchBytes };
  });

  app.get('/rules', { schema: rulesSchema }, async (req, reply) => {
    const { version, recording } = await effectiveFor(db, req.vehicle);
    const etag = `"${version}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'no-cache');
    const inm = req.headers['if-none-match'];
    if (inm && String(inm).split(',').map(s => s.trim()).includes(etag)) return reply.code(304).send();
    return { version, recording };
  });

  app.post('/ingest', { schema: ingestSchema }, async (req, reply) => {
    if (inflight >= config.ingest.maxConcurrent) {
      const retryAfter = 2 + Math.floor(Math.random() * 8);   // spredt, så 42 kjøreverk ikke kommer tilbake samtidig
      reply.header('Retry-After', String(retryAfter));
      return reply.code(503).send({ error: 'busy: too many batches are being stored right now', retryAfter });
    }
    inflight++;
    const t0 = Date.now();
    try {
      const r = await ingest(db, req.vehicle, req.body, { limits: config.ingest, ip: req.ip });
      if (r.replay) log.info(`${req.vehicle.code}: batch ${req.body.seq} again; same answer, nothing stored twice`);
      else log.debug(`${req.vehicle.code}: batch ${req.body.seq}: ${r.stored} stored, ${r.duplicates} duplicates${r.events ? `, ${r.events} events` : ''}${r.gaps ? `, ${r.gaps} gaps` : ''} in ${Date.now() - t0} ms`);
      return r.json;
    } finally {
      inflight--;
    }
  });

  app.post('/history', { schema: historySchema }, async req => {
    const r = await history(db, req.vehicle, req.body, config.history);
    log.debug(`${req.vehicle.code}: history ${req.body.tags.length} tag(s), ${Math.round((req.body.to - req.body.from) / 60000)} min: ${r.ms} ms (${Object.values(r.sources).join(', ')})`);
    return { series: r.series, unrecorded: r.unrecorded, ms: r.ms };
  });
};

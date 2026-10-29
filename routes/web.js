'use strict';
/*
 * routes/web.js - det web-siden spør serveren om (docs/PLAN.md §4). Hver side får sin del her.
 *
 * Foreløpig uten innlogging: serveren står bare på det lokale nettet. Innloggingen med roller (§3.6)
 * kommer sammen med sidene som endrer noe (regler, kjøreverk).
 */

const { listVehicles, getVehicle } = require('../lib/admin');
const { listRuleSets } = require('../lib/rules');
const { VERSION } = require('../lib/app');

module.exports = async function web(app, { db, config }) {
  // oversikten: alle kjøreverkene, og hvordan serveren har det
  app.get('/overview', async () => {
    const vehicles = await listVehicles(db);
    const stats = (await db.query(`SELECT v.id,
        (SELECT coalesce(sum(n + nnull), 0) FROM sample_1h h WHERE h.vehicle_id = v.id AND h.bucket >= now() - interval '24 hours') AS points_24h,
        (SELECT count(*) FROM gap g WHERE g.vehicle_id = v.id AND g.reported_at >= now() - interval '24 hours') AS gaps_24h,
        (SELECT count(*) FROM vehicle_tag vt WHERE vt.vehicle_id = v.id) AS tags,
        (SELECT count(*) FROM event e WHERE e.vehicle_id = v.id AND e.ts >= now() - interval '24 hours' AND e.severity = 'alarm') AS alarms_24h
      FROM vehicle v`)).rows;
    const byId = new Map(stats.map(s => [s.id, s]));
    const now = Date.now();
    for (const v of vehicles) {
      const s = byId.get(v.id) || {};
      v.points_24h = Number(s.points_24h || 0);
      v.gaps_24h = Number(s.gaps_24h || 0);
      v.tags = Number(s.tags || 0);
      v.alarms_24h = Number(s.alarms_24h || 0);
      v.sending = v.last_batch_at !== null && now - v.last_batch_at < 90000;
      v.silent = v.last_batch_at === null ? true : now - v.last_batch_at > v.silent_after_s * 1000;
    }
    const size = (await db.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes;
    const dirty = (await db.query('SELECT count(*) AS n FROM rollup_dirty')).rows[0].n;
    return { time: now, version: VERSION, timescale: db.timescale, dbBytes: Number(size), rollupPending: Number(dirty), vehicles };
  });

  app.get('/vehicles/:code', async (req, reply) => {
    const v = await getVehicle(db, req.params.code);
    if (!v) return reply.code(404).send({ error: `no vehicle named ${req.params.code}` });
    v.gaps = (await db.query(`SELECT id, from_ts, to_ts, tags, reason, reported_at FROM gap WHERE vehicle_id = $1 ORDER BY from_ts DESC LIMIT 50`, [v.id])).rows;
    return v;
  });

  app.get('/rulesets', async () => listRuleSets(db));

  app.get('/config', async () => ({ history: config.history, ingest: config.ingest, retention: config.retention }));
};

'use strict';
/*
 * Hendelser og hull (docs/PLAN.md §4.6 og §5.7) på tvers av kjøreverkene, med filtre.
 *   GET /events  hendelser og alarmer fra recorderne, nyeste først, 200 om gangen (offset)
 *   GET /gaps    hull recorderne har meldt (queue-full, rejected, paused), og brudd mellom to økter
 *                der ingenting kom inn (Pi-en eller recorderen var borte)
 */
const { timeRange, codeList } = require('../../lib/catalog');

const SEV = ['info', 'warning', 'alarm'];
const like = s => `%${String(s).trim().replace(/[\\%_]/g, '\\$&')}%`;
const iso = ms => new Date(ms).toISOString();

const common = {
  from: { type: 'string' }, to: { type: 'string' },
  vehicles: { type: 'string', maxLength: 10000 },
};

module.exports = async function eventRoutes(app, { db, config }) {
  app.get('/events', {
    schema: {
      querystring: {
        type: 'object', required: ['from', 'to'],
        properties: Object.assign({
          severity: { type: 'string', enum: ['', ...SEV] }, q: { type: 'string', maxLength: 200 }, source: { type: 'string', maxLength: 200 },
          offset: { type: 'string', pattern: '^\\d{1,6}$' }, limit: { type: 'string', pattern: '^\\d{1,4}$' },
        }, common),
      },
    },
  }, async req => {
    const q = req.query;
    const { from, to } = timeRange(q, config.history.maxDays);
    const vals = [iso(from), iso(to)], where = ['e.ts >= $1', 'e.ts <= $2'];
    const codes = codeList(q.vehicles);
    if (codes.length) { vals.push(codes); where.push(`v.code = ANY($${vals.length}::text[])`); }
    if (q.q && q.q.trim()) { vals.push(like(q.q)); where.push(`e.message ILIKE $${vals.length}`); }
    if (q.source && q.source.trim()) { vals.push(like(q.source)); where.push(`e.source ILIKE $${vals.length}`); }
    // tellingen per alvorlighetsgrad tar med alt unntatt filteret på alvorlighetsgrad
    const counts = (await db.query(`SELECT e.severity, count(*)::int AS n FROM event e JOIN vehicle v ON v.id = e.vehicle_id
      WHERE ${where.join(' AND ')} GROUP BY e.severity`, vals)).rows;
    if (SEV.includes(q.severity)) { vals.push(SEV.slice(SEV.indexOf(q.severity))); where.push(`e.severity = ANY($${vals.length}::text[])`); }
    const limit = Math.max(1, Math.min(1000, Number(q.limit) || 200)), offset = Number(q.offset) || 0;
    vals.push(limit + 1, offset);
    const r = await db.query(`SELECT (extract(epoch FROM e.ts) * 1000)::bigint AS ts, v.code, v.name, e.severity, e.source, e.message, e.src, e.unsynced
      FROM event e JOIN vehicle v ON v.id = e.vehicle_id WHERE ${where.join(' AND ')}
      ORDER BY e.ts DESC, v.code LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
    const more = r.rows.length > limit;
    if (more) r.rows.length = limit;
    const bySev = {};
    for (const c of counts) bySev[c.severity] = c.n;
    return { events: r.rows, more, counts: bySev };
  });

  app.get('/gaps', {
    schema: {
      querystring: {
        type: 'object', required: ['from', 'to'],
        properties: Object.assign({ reason: { type: 'string', maxLength: 40 }, sessions: { type: 'string', enum: ['0', '1'] } }, common),
      },
    },
  }, async req => {
    const q = req.query;
    const { from, to } = timeRange(q, config.history.maxDays);
    const codes = codeList(q.vehicles);
    const vals = [iso(from), iso(to)];
    let vf = '';
    if (codes.length) { vals.push(codes); vf = ` AND v.code = ANY($${vals.length}::text[])`; }
    const out = [];
    if (q.reason !== 'session') {
      const rv = vals.slice();
      let rf = '';
      if (q.reason) { rv.push(q.reason); rf = ` AND g.reason = $${rv.length}`; }
      const r = await db.query(`SELECT 'reported' AS kind, (extract(epoch FROM g.from_ts) * 1000)::bigint AS from_ts, (extract(epoch FROM g.to_ts) * 1000)::bigint AS to_ts,
          v.code, g.tags, g.reason, (extract(epoch FROM g.reported_at) * 1000)::bigint AS reported_at
        FROM gap g JOIN vehicle v ON v.id = g.vehicle_id WHERE g.to_ts >= $1 AND g.from_ts <= $2${vf}${rf}
        ORDER BY g.from_ts DESC LIMIT 1000`, rv);
      out.push(...r.rows);
    }
    if (q.sessions !== '0' && (!q.reason || q.reason === 'session')) {
      // fra slutten av data i en økt til starten av neste, når det er lengre enn sessionGapSeconds
      const sv = vals.concat([`${config.history.sessionGapSeconds || 60} seconds`]);
      const r = await db.query(`WITH s AS (
          SELECT s.vehicle_id, s.first_ts, s.boot,
            max(s.last_ts) OVER (PARTITION BY s.vehicle_id ORDER BY s.first_ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
          FROM session s WHERE s.first_ts IS NOT NULL)
        SELECT 'session' AS kind, (extract(epoch FROM s.prev_end) * 1000)::bigint AS from_ts, (extract(epoch FROM s.first_ts) * 1000)::bigint AS to_ts,
          v.code, NULL::text[] AS tags, 'session' AS reason, NULL::bigint AS reported_at, s.boot
        FROM s JOIN vehicle v ON v.id = s.vehicle_id
        WHERE s.prev_end IS NOT NULL AND s.first_ts - s.prev_end > $${sv.length}::interval AND s.first_ts >= $1 AND s.prev_end <= $2${vf}
        ORDER BY s.prev_end DESC LIMIT 1000`, sv);
      out.push(...r.rows);
    }
    out.sort((a, b) => b.from_ts - a.from_ts);
    return { gaps: out.slice(0, 1000), truncated: out.length > 1000 };
  });
};

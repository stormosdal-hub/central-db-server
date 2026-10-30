'use strict';
/*
 * lib/find.js - Finn data (docs/PLAN.md §4.2): hvilke kjøreverk har disse dataene, eller hvor slo en betingelse til.
 *
 *   has       taggen finnes i katalogen. Treff = lagrede verdier i tidsrommet (fra sammendragene)
 *   on        verdien var ≠ 0 (av/på: på). Treff = ganger den slo seg på, og hvor lenge den var på til sammen
 *   above X   over X. Treff = ganger den gikk over, og hvor lenge
 *   below X   under X. Det samme
 *   changed   verdien endret seg i tidsrommet. Treff = lagrede verdier
 *   event     en hendelse eller alarm med denne teksten. Treff = antall hendelser
 *
 * on/above/below regnes på rådataene når det er overkommelig (method 'raw'): verdien som gjaldt ved from
 * teller med, og hver verdi gjelder til den neste. Ellers (for mange rader) teller de minuttene i
 * sample_1m der verdien var der (method 'minutes'), og varigheten blir antall minutter.
 */

const { bad } = require('./errors');
const { findTags, timeRange, codeList } = require('./catalog');

const MINUTE = 60000, HOUR = 3600000;
const RAW_LIMIT = 2000000;   // flere rader enn dette i rådataene: bruk minuttene

const floorTo = (ms, u) => Math.floor(ms / u) * u;
const ceilTo = (ms, u) => Math.ceil(ms / u) * u;
const ts = ms => new Date(ms).toISOString();

// lagrede verdier per par i tidsrommet: hele timer fra sample_1h, kantene fra sample_1m
function countBounds(from, to) {
  const Fm = floorTo(from, MINUTE), Tm = ceilTo(to + 1, MINUTE);
  let Fh = ceilTo(from, HOUR), Th = floorTo(to, HOUR);
  if (Fh >= Th) { Fh = Tm; Th = Tm; }
  return [ts(Fm), ts(Fh), ts(Th), ts(Tm)];
}
const COUNT_SQL = (a, b, c, d) => `(
  (SELECT coalesce(sum(h.n + h.nnull), 0) FROM sample_1h h WHERE h.vehicle_id = u.vid AND h.tag_id = u.tid AND h.bucket >= $${b} AND h.bucket < $${c})
  + (SELECT coalesce(sum(m.n + m.nnull), 0) FROM sample_1m m WHERE m.vehicle_id = u.vid AND m.tag_id = u.tid
      AND ((m.bucket >= $${a} AND m.bucket < $${b}) OR (m.bucket >= $${c} AND m.bucket < $${d}))))`;

const PRED = { on: 'value <> 0', above: 'value > $5', below: 'value < $5' };
const AGG_PRED = { on: '(m.vmax <> 0 OR m.vmin <> 0)', above: 'm.vmax > $5', below: 'm.vmin < $5' };

async function find(db, f, opts) {
  const { from, to } = timeRange(f, (opts && opts.maxDays) || 400);
  const cond = f.condition && typeof f.condition === 'object' ? f.condition : { kind: 'has' };
  const kind = cond.kind || 'has';
  if (kind === 'event') return findEvents(db, f, cond, from, to);
  if (!['has', 'on', 'above', 'below', 'changed'].includes(kind)) throw bad('the condition is one of has, on, above, below, changed, event');
  let x = null;
  if (kind === 'above' || kind === 'below') {
    x = Number(String(cond.value).replace(',', '.'));
    if (cond.value === undefined || cond.value === '' || !Number.isFinite(x)) throw bad(`"${kind}" needs a number`);
  }

  const cat = await findTags(db, { vehicles: f.vehicles, tags: f.tags, label: f.label, dataType: f.dataType, unit: f.unit, limit: 3000 });
  const base = { kind, from, to, truncated: cat.truncated, method: kind === 'has' || kind === 'changed' ? 'catalog' : 'raw', rows: [] };
  if (!cat.rows.length) return base;
  const numeric = cat.rows.filter(r => r.data_type !== 'string');
  const text = cat.rows.filter(r => r.data_type === 'string');
  const key = (v, t) => `${v}|${t}`;
  const out = new Map();
  for (const r of cat.rows) {
    out.set(key(r.vehicle_id, r.tag_id), {
      code: r.code, name: r.vehicle_name, tag: r.tag, label: r.label, unit: r.unit, dataType: r.data_type,
      lastTs: r.last_ts, lastValue: r.data_type === 'string' ? r.last_text : r.last_value, hits: 0, first: null, last: null,
    });
  }
  const vids = numeric.map(r => r.vehicle_id), tids = numeric.map(r => r.tag_id);
  const [Fm, Fh, Th, Tm] = countBounds(from, to);

  if (kind === 'has' || kind === 'changed') {
    if (numeric.length) {
      const r = await db.query(`SELECT u.vid, u.tid, ${COUNT_SQL(3, 4, 5, 6)} AS hits,
          (SELECT (extract(epoch FROM s.ts) * 1000)::bigint FROM sample s WHERE s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts >= $7 AND s.ts <= $8 ORDER BY s.ts LIMIT 1) AS first,
          (SELECT (extract(epoch FROM s.ts) * 1000)::bigint FROM sample s WHERE s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts >= $7 AND s.ts <= $8 ORDER BY s.ts DESC LIMIT 1) AS last
          ${kind === 'changed' ? `,
          (SELECT s.value FROM sample s WHERE s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts < $7 ORDER BY s.ts DESC LIMIT 1) AS v0,
          (SELECT min(s.value) FROM sample s WHERE s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts >= $7 AND s.ts <= $8) AS vmin,
          (SELECT max(s.value) FROM sample s WHERE s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts >= $7 AND s.ts <= $8) AS vmax` : ''}
        FROM unnest($1::smallint[], $2::int[]) AS u(vid, tid)`, [vids, tids, Fm, Fh, Th, Tm, ts(from), ts(to)]);
      for (const row of r.rows) {
        const o = out.get(key(row.vid, row.tid));
        o.hits = Number(row.hits); o.first = row.first; o.last = row.last;
        if (kind === 'changed') {
          const vals = [row.v0, row.vmin, row.vmax].filter(v => v !== null && v !== undefined);
          o.changed = vals.length > 1 && Math.min(...vals) !== Math.max(...vals);
        }
      }
    }
    if (text.length) {
      const r = await db.query(`SELECT u.vid, u.tid, count(s.ts)::int AS hits, (extract(epoch FROM min(s.ts)) * 1000)::bigint AS first,
          (extract(epoch FROM max(s.ts)) * 1000)::bigint AS last, count(DISTINCT s.value) AS distinct_values,
          (SELECT p.value FROM sample_text p WHERE p.vehicle_id = u.vid AND p.tag_id = u.tid AND p.ts < $3 ORDER BY p.ts DESC LIMIT 1) AS v0
        FROM unnest($1::smallint[], $2::int[]) AS u(vid, tid)
        LEFT JOIN sample_text s ON s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts >= $3 AND s.ts <= $4
        GROUP BY u.vid, u.tid`, [text.map(t => t.vehicle_id), text.map(t => t.tag_id), ts(from), ts(to)]);
      for (const row of r.rows) {
        const o = out.get(key(row.vid, row.tid));
        o.hits = row.hits; o.first = row.first; o.last = row.last;
        o.changed = Number(row.distinct_values) > 1 || (Number(row.distinct_values) === 1 && row.v0 !== null && row.hits > 0);
      }
    }
    let rows = [...out.values()];
    if (kind === 'changed') rows = rows.filter(o => o.changed);
    return Object.assign(base, { rows: sortRows(rows) });
  }

  // on / above / below: bare tall
  if (!numeric.length) return Object.assign(base, { rows: [] });
  const est = await db.query(`SELECT coalesce(sum(${COUNT_SQL(3, 4, 5, 6)}), 0) AS n FROM unnest($1::smallint[], $2::int[]) AS u(vid, tid)`, [vids, tids, Fm, Fh, Th, Tm]);
  const raw = Number(est.rows[0].n) <= RAW_LIMIT;
  const params = [vids, tids, ts(from), ts(to)];
  if (x !== null) params.push(x);
  let r;
  if (raw) {
    // verdien ved from, og hver verdi i tidsrommet; hver gjelder til den neste (eller til to)
    r = await db.query(`WITH u AS (SELECT * FROM unnest($1::smallint[], $2::int[]) AS u(vid, tid)),
      pts AS (
        SELECT u.vid, u.tid, $3::timestamptz AS ts, true AS initial,
          (SELECT s.value FROM sample s WHERE s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts <= $3 ORDER BY s.ts DESC LIMIT 1) AS value
        FROM u
        UNION ALL
        SELECT s.vehicle_id, s.tag_id, s.ts, false, s.value FROM u JOIN sample s ON s.vehicle_id = u.vid AND s.tag_id = u.tid AND s.ts > $3 AND s.ts <= $4
      ),
      seq AS (
        SELECT vid, tid, ts, value, initial, lag(${PRED[kind]}) OVER w AS was, coalesce(lead(ts) OVER w, $4::timestamptz) AS next
        FROM pts WINDOW w AS (PARTITION BY vid, tid ORDER BY ts)
      )
      SELECT vid, tid,
        count(*) FILTER (WHERE ${PRED[kind]} AND NOT coalesce(was, false))::int AS hits,
        (extract(epoch FROM min(ts) FILTER (WHERE ${PRED[kind]})) * 1000)::bigint AS first,
        (extract(epoch FROM max(next) FILTER (WHERE ${PRED[kind]})) * 1000)::bigint AS last,
        coalesce(sum(extract(epoch FROM next - ts)) FILTER (WHERE ${PRED[kind]}), 0) AS seconds
      FROM seq GROUP BY vid, tid`, params);
  } else {
    const table = to - from > 14 * 86400000 ? 'sample_1h' : 'sample_1m';
    const bucketS = table === 'sample_1h' ? 3600 : 60;
    r = await db.query(`SELECT u.vid, u.tid, count(m.bucket)::int AS hits, (extract(epoch FROM min(m.bucket)) * 1000)::bigint AS first,
        (extract(epoch FROM max(m.bucket)) * 1000)::bigint + ${bucketS * 1000} AS last, count(m.bucket) * ${bucketS} AS seconds
      FROM unnest($1::smallint[], $2::int[]) AS u(vid, tid)
      LEFT JOIN ${table} m ON m.vehicle_id = u.vid AND m.tag_id = u.tid AND m.bucket >= date_trunc('${table === 'sample_1h' ? 'hour' : 'minute'}', $3::timestamptz) AND m.bucket <= $4 AND ${AGG_PRED[kind]}
      GROUP BY u.vid, u.tid`, params);
    base.method = table === 'sample_1h' ? 'hours' : 'minutes';
  }
  const rows = [];
  for (const row of r.rows) {
    if (!(row.hits > 0) && !(Number(row.seconds) > 0)) continue;
    const o = out.get(key(row.vid, row.tid));
    o.hits = row.hits; o.first = row.first; o.last = row.last; o.seconds = Math.round(Number(row.seconds));
    rows.push(o);
  }
  return Object.assign(base, { rows: sortRows(rows) });
}

const sortRows = rows => rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

const SEV = ['info', 'warning', 'alarm'];
async function findEvents(db, f, cond, from, to) {
  const vals = [ts(from), ts(to)], where = ['e.ts >= $1', 'e.ts <= $2'];
  const text = String(cond.text || '').trim();
  if (text) { vals.push(`%${text.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(e.message ILIKE $${vals.length} OR e.source ILIKE $${vals.length})`); }
  const codes = codeList(f.vehicles);
  if (codes.length) { vals.push(codes); where.push(`v.code = ANY($${vals.length}::text[])`); }
  if (SEV.includes(cond.severity)) { vals.push(SEV.slice(SEV.indexOf(cond.severity))); where.push(`e.severity = ANY($${vals.length}::text[])`); }
  const r = await db.query(`SELECT v.code, v.name, count(*)::int AS hits, (extract(epoch FROM min(e.ts)) * 1000)::bigint AS first,
      (extract(epoch FROM max(e.ts)) * 1000)::bigint AS last, (array_agg(e.message ORDER BY e.ts DESC))[1] AS latest,
      (array_agg(e.severity ORDER BY e.ts DESC))[1] AS severity
    FROM event e JOIN vehicle v ON v.id = e.vehicle_id WHERE ${where.join(' AND ')}
    GROUP BY v.code, v.name ORDER BY v.code`, vals);
  return { kind: 'event', from, to, method: 'events', truncated: false, rows: r.rows.map(x => Object.assign(x, { tag: null })) };
}

module.exports = { find, countBounds };

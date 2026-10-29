'use strict';
/*
 * lib/history.js - svaret på POST /history: det HMI-en i et kjøreverk vil se i en trend, en Timeline
 * eller en tidsstripe (PROTOKOLL.md §6, docs/PLAN.md §3.5).
 *
 * For hver tag:
 *   - Kilden velges etter hvor mange rader det blir: rådataene når de er få nok (anslått fra
 *     sample_1h), ellers sample_1m, ellers sample_1h. De siste minuttene er alltid rådata, for
 *     sammendragene ligger litt etter.
 *   - Det første punktet er verdien som gjaldt ved from, satt til from, slik huben gjør.
 *   - null er et hull: et hull recorderen har meldt, eller tiden mellom to økter.
 *   - Er det mer enn 2 × points punkter, tynnes de med minste og største verdi per bøtte, i den
 *     rekkefølgen de kom, så topper og korte pulser ikke forsvinner. null-punkter beholdes.
 */

const { bad } = require('./errors');

const MINUTE = 60000, HOUR = 3600000;
const RECENT = 2 * MINUTE;   // så nær nå hentes alltid rådata

// tynner til høyst to punkter per bøtte: minste og største verdi, i tidsrekkefølge
function thin(pts, from, to, buckets) {
  if (pts.length <= 2 * buckets) return pts;
  const w = (to - from) / buckets;
  const out = [];
  let i = 0;
  while (i < pts.length) {
    const b = Math.max(0, Math.floor((pts[i][0] - from) / w));
    const end = from + (b + 1) * w;
    let lo = null, hi = null;
    const flush = () => {
      if (!lo) return;
      if (lo === hi) out.push(lo);
      else if (lo[0] <= hi[0]) out.push(lo, hi);
      else out.push(hi, lo);
      lo = hi = null;
    };
    while (i < pts.length && pts[i][0] < end) {
      const p = pts[i++];
      if (p[1] === null) { flush(); out.push(p); continue; }
      if (!lo || p[1] < lo[1]) lo = p;
      if (!hi || p[1] > hi[1]) hi = p;
    }
    flush();
  }
  return out;
}

// en sammendragsrad -> punkter: minste og største (den som ligner mest på første verdi, først), og null når bøtta slutter i et hull
function aggPoints(row, bucketMs, out) {
  const t = row.t;
  if (row.n === 0) { out.push([t, null]); return; }
  if (row.vmin === row.vmax) out.push([t, row.vmin]);
  else {
    const minFirst = row.vfirst === null || row.vlast === null ? true : Math.abs(row.vfirst - row.vmin) <= Math.abs(row.vfirst - row.vmax);
    if (minFirst) out.push([t, row.vmin], [t + bucketMs / 2, row.vmax]);
    else out.push([t, row.vmax], [t + bucketMs / 2, row.vmin]);
  }
  if (row.vlast === null) out.push([t + bucketMs - 1, null]);
}

const AGG_SQL = table => `SELECT (extract(epoch FROM bucket) * 1000)::bigint AS t, n, vmin, vmax, vfirst, vlast
  FROM ${table} WHERE vehicle_id = $1 AND tag_id = $2 AND bucket >= to_timestamp($3 / 1000.0) AND bucket < to_timestamp($4 / 1000.0) ORDER BY bucket`;
const RAW_SQL = `SELECT (extract(epoch FROM ts) * 1000)::bigint AS t, value AS v
  FROM sample WHERE vehicle_id = $1 AND tag_id = $2 AND ts > to_timestamp($3 / 1000.0) AND ts <= to_timestamp($4 / 1000.0) ORDER BY ts LIMIT $5`;

async function oneTag(db, vehicleId, tagId, q, opts, nulls) {
  const { from, to, points } = q;
  const maxRows = opts.maxRows || 60000;
  const span = to - from;
  const now = Date.now();
  const pts = [];

  // verdien som gjaldt ved from
  const first = await db.query('SELECT value AS v FROM sample WHERE vehicle_id = $1 AND tag_id = $2 AND ts <= to_timestamp($3 / 1000.0) ORDER BY ts DESC LIMIT 1', [vehicleId, tagId, from]);
  if (first.rowCount) pts.push([from, nulls.covers(from) ? null : first.rows[0].v]);

  // anslå antall rådata fra timesammendraget, og velg kilden
  const est = await db.query('SELECT coalesce(sum(n + nnull), 0) AS n FROM sample_1h WHERE vehicle_id = $1 AND tag_id = $2 AND bucket >= to_timestamp($3 / 1000.0) AND bucket < to_timestamp($4 / 1000.0)',
    [vehicleId, tagId, Math.floor(from / HOUR) * HOUR, to]);
  const estimate = Number(est.rows[0].n);
  let source = 'raw';
  if (estimate > maxRows) source = span / MINUTE <= maxRows ? '1m' : '1h';

  let rawFrom = from;
  if (source !== 'raw') {
    const bucketMs = source === '1m' ? MINUTE : HOUR;
    // sammendragene fram til for litt siden, rådata etter det
    const aggTo = Math.min(to, Math.floor((now - RECENT) / bucketMs) * bucketMs);
    if (aggTo > from) {
      const rows = (await db.query(AGG_SQL(source === '1m' ? 'sample_1m' : 'sample_1h'), [vehicleId, tagId, Math.floor(from / bucketMs) * bucketMs, aggTo])).rows;
      for (const r of rows) aggPoints(r, bucketMs, pts);
      rawFrom = aggTo;
    }
  }
  const raw = await db.query(RAW_SQL, [vehicleId, tagId, rawFrom, to, maxRows + 1]);
  let truncated = false;
  if (raw.rowCount > maxRows) { raw.rows.length = maxRows; truncated = true; }
  for (const r of raw.rows) pts.push([r.t, r.v]);

  // kjente hull og tiden mellom økter
  for (const t of nulls.starts(from, to)) pts.push([t, null]);

  // bare punkter i tidsrommet, i rekkefølge, og høyst 2 per bøtte
  const inRange = pts.filter(p => p[0] >= from && p[0] <= to).sort((a, b) => a[0] - b[0]);
  return { points: thin(inRange, from, to, points), source, estimate, truncated };
}

// hullene som gjelder en tag: fra gap-tabellen, og mellom økter
async function knownGaps(db, vehicleId, from, to, sessionGapMs) {
  const gaps = (await db.query(`SELECT (extract(epoch FROM from_ts) * 1000)::bigint AS f, (extract(epoch FROM to_ts) * 1000)::bigint AS t, tags
    FROM gap WHERE vehicle_id = $1 AND to_ts >= to_timestamp($2 / 1000.0) AND from_ts <= to_timestamp($3 / 1000.0)`, [vehicleId, from, to])).rows;
  // øktene som berører tidsrommet, og den foran, så hullet før den første synes
  const sessions = (await db.query(`SELECT * FROM (
      (SELECT (extract(epoch FROM first_ts) * 1000)::bigint AS f, (extract(epoch FROM last_ts) * 1000)::bigint AS t
         FROM session WHERE vehicle_id = $1 AND first_ts IS NOT NULL AND first_ts <= to_timestamp($3 / 1000.0) AND last_ts >= to_timestamp($2 / 1000.0))
      UNION ALL
      (SELECT (extract(epoch FROM first_ts) * 1000)::bigint, (extract(epoch FROM last_ts) * 1000)::bigint
         FROM session WHERE vehicle_id = $1 AND first_ts IS NOT NULL AND last_ts < to_timestamp($2 / 1000.0) ORDER BY last_ts DESC LIMIT 1)
    ) s ORDER BY f`, [vehicleId, from, to])).rows;
  const between = [];
  for (let i = 1; i < sessions.length; i++) {
    const prevEnd = Math.max(...sessions.slice(0, i).map(s => s.t));
    if (sessions[i].f - prevEnd > sessionGapMs) between.push({ f: prevEnd + 1, t: sessions[i].f - 1, tags: null });
  }
  return {
    forTag(tag) {
      const mine = gaps.filter(g => g.tags === null || g.tags.includes(tag)).concat(between);
      return {
        covers: ts => mine.some(g => g.f <= ts && ts <= g.t),
        starts: (a, b) => mine.map(g => Math.max(g.f, a + 1)).filter(t => t <= b),
      };
    },
  };
}

// q: { vehicle, tags, from, to, points }; vehicle: raden fra lib/auth.js
async function history(db, vehicle, q, opts) {
  const t0 = process.hrtime.bigint();
  const tags = Array.isArray(q.tags) ? q.tags.map(String) : [];
  const maxTags = opts.maxTags || 8;
  if (!tags.length) throw bad('tags is a list of tag names');
  if (tags.length > maxTags) throw bad(`at most ${maxTags} tags per question`);
  const from = Number(q.from), to = Number(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw bad('from and to are times in milliseconds, and to is after from');
  if (to - from > (opts.maxDays || 400) * 86400000) throw bad(`at most ${opts.maxDays || 400} days at a time`);
  const points = Math.max(10, Math.min(opts.maxPoints || 10000, Number(q.points) || 1000));
  const range = { from: Math.round(from), to: Math.round(to), points };

  const known = (await db.query(`SELECT t.id, t.name, vt.data_type FROM vehicle_tag vt JOIN tag t ON t.id = vt.tag_id
    WHERE vt.vehicle_id = $1 AND t.name = ANY($2::text[])`, [vehicle.id, tags])).rows;
  const byName = new Map(known.filter(r => r.data_type !== 'string').map(r => [r.name, r]));
  const nulls = await knownGaps(db, vehicle.id, range.from, range.to, (opts.sessionGapSeconds || 60) * 1000);

  const series = {}, unrecorded = [], sources = {};
  await Promise.all(tags.map(async name => {
    const t = byName.get(name);
    if (!t) { series[name] = []; unrecorded.push(name); return; }
    const r = await oneTag(db, vehicle.id, t.id, range, opts, nulls.forTag(name));
    series[name] = r.points;
    sources[name] = r.source + (r.truncated ? ' (truncated)' : '');
  }));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { series, unrecorded, ms: Math.round(ms), sources };
}

module.exports = { history, thin, aggPoints };

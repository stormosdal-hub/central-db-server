'use strict';
/*
 * lib/export.js - eksporten (docs/PLAN.md §4.4): CSV som strømmes rett fra PostgreSQL, så store uttrekk ikke
 * fyller minnet. Radene hentes med en cursor, 5000 om gangen, og sendes etter hvert.
 *
 *   kind        values (verdiene), events (hendelser og alarmer) eller gaps (meldte hull)
 *   format      long: én rad per verdi (tid, kjøreverk, tag, verdi …); wide: én kolonne per tag, én rad per tidspunkt
 *   resolution  raw: alle lagrede verdier; 1m eller 1h: snitt, minste, største og antall per minutt eller time
 *   files       one: alt i én fil; zip: én fil per kjøreverk i en zip-fil
 *   fill        (wide) fyll tomme celler med siste kjente verdi, med verdiene ved from i første rad
 *   style, tz   skilletegn og tider, se lib/csv.js
 */

const { bad } = require('./errors');
const { findTags, codeList } = require('./catalog');
const { countBounds } = require('./find');
const { csvFormat, zoneOffset, BOM } = require('./csv');
const { zip } = require('./zip');

const iso = ms => new Date(ms).toISOString();

// radene fra en spørring, i biter, med en cursor i en egen transaksjon
async function* cursor(db, sql, params, batch) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`DECLARE kv_export NO SCROLL CURSOR FOR ${sql}`, params);
    for (;;) {
      const r = await c.query(`FETCH ${batch || 5000} FROM kv_export`);
      if (!r.rows.length) break;
      yield r.rows;
    }
  } finally {
    try { await c.query('ROLLBACK'); } catch (e) { /* forbindelsen er borte */ }
    c.release();
  }
}

// samler linjer til biter på omtrent 64 kB
async function* buffered(lines) {
  let buf = '';
  for await (const l of lines) {
    buf += l;
    if (buf.length > 65536) { yield buf; buf = ''; }
  }
  if (buf) yield buf;
}

const RAW = {
  number: `SELECT (extract(epoch FROM ts) * 1000)::bigint AS t, value AS v, q, src FROM sample
    WHERE vehicle_id = $1 AND tag_id = $2 AND ts >= $3 AND ts <= $4 ORDER BY ts`,
  string: `SELECT (extract(epoch FROM ts) * 1000)::bigint AS t, value AS v, q, src FROM sample_text
    WHERE vehicle_id = $1 AND tag_id = $2 AND ts >= $3 AND ts <= $4 ORDER BY ts`,
};
const AGG = table => `SELECT (extract(epoch FROM bucket) * 1000)::bigint AS t, CASE WHEN n > 0 THEN vsum / n END AS avg, vmin, vmax, n
  FROM ${table} WHERE vehicle_id = $1 AND tag_id = $2 AND bucket >= date_trunc('${table === 'sample_1h' ? 'hour' : 'minute'}', $3::timestamptz) AND bucket <= $4 ORDER BY bucket`;

const nameOf = t => (t.label ? `${t.tag} (${t.label}${t.unit ? ', ' + t.unit : ''})` : t.unit ? `${t.tag} (${t.unit})` : t.tag);

// lang: én rad per verdi, tag for tag
async function* longLines(db, p, fmt, vehicle, tags, withHeader) {
  const aggTable = p.resolution === '1m' ? 'sample_1m' : p.resolution === '1h' ? 'sample_1h' : null;
  if (withHeader) {
    yield fmt.line(aggTable ? ['tid', 'kjøreverk', 'tag', 'navn', 'snitt', 'minste', 'største', 'antall', 'enhet']
      : ['tid', 'kjøreverk', 'tag', 'navn', 'verdi', 'enhet', 'kvalitet', 'kilde']);
  }
  for (const t of tags) {
    if (aggTable && t.data_type === 'string') continue;
    const sql = aggTable ? AGG(aggTable) : RAW[t.data_type === 'string' ? 'string' : 'number'];
    const pre = [fmt.text(vehicle.code), fmt.text(t.tag), fmt.text(t.label)];
    for await (const rows of cursor(db, sql, [t.vehicle_id, t.tag_id, iso(p.from), iso(p.to)])) {
      for (const r of rows) {
        if (aggTable) yield fmt.line([fmt.time(r.t), ...pre, fmt.num(r.avg), fmt.num(r.vmin), fmt.num(r.vmax), r.n, fmt.text(t.unit)]);
        else yield fmt.line([fmt.time(r.t), ...pre, t.data_type === 'string' ? fmt.text(r.v) : fmt.num(r.v), fmt.text(t.unit), r.q, r.src]);
      }
    }
  }
}

// bred: én kolonne per tag, én rad per tidspunkt. columns: alle tagnavnene i filen; tags: dette kjøreverkets
async function* wideLines(db, p, fmt, vehicle, tags, columns, withHeader, withVehicle) {
  const aggTable = p.resolution === '1m' ? 'sample_1m' : p.resolution === '1h' ? 'sample_1h' : null;
  const col = new Map(columns.map((c, i) => [c.tag, i]));
  if (withHeader) yield fmt.line([...(withVehicle ? ['kjøreverk'] : []), 'tid', ...columns.map(c => fmt.text(nameOf(c)))]);
  const mine = tags.filter(t => !(aggTable && t.data_type === 'string'));
  if (!mine.length) return;
  const byId = new Map(mine.map(t => [t.tag_id, t]));
  const num = mine.filter(t => t.data_type !== 'string').map(t => t.tag_id);
  const txt = mine.filter(t => t.data_type === 'string').map(t => t.tag_id);
  const cells = new Array(columns.length).fill('');
  const pre = withVehicle ? [fmt.text(vehicle.code)] : [];
  const fmtVal = (t, v) => (t.data_type === 'string' ? fmt.text(v) : fmt.num(v));

  let curT = null;
  if (p.fill) {
    // verdiene som gjaldt ved from, i første rad (slått sammen med en rad som har akkurat den tiden)
    const r = await db.query(`SELECT u.tid,
        (SELECT s.value FROM sample s WHERE s.vehicle_id = $1 AND s.tag_id = u.tid AND s.ts <= $3 ORDER BY s.ts DESC LIMIT 1) AS v,
        (SELECT s.value FROM sample_text s WHERE s.vehicle_id = $1 AND s.tag_id = u.tid AND s.ts <= $3 ORDER BY s.ts DESC LIMIT 1) AS txt
      FROM unnest($2::int[]) AS u(tid)`, [vehicle.id, mine.map(t => t.tag_id), iso(p.from)]);
    let any = false;
    for (const x of r.rows) {
      const t = byId.get(x.tid);
      const v = t.data_type === 'string' ? x.txt : x.v;
      if (v !== null && v !== undefined) { cells[col.get(t.tag)] = fmtVal(t, v); any = true; }
    }
    if (any) curT = p.from;
  }

  let sql, params;
  if (aggTable) {
    sql = `SELECT (extract(epoch FROM bucket) * 1000)::bigint AS t, tag_id AS tid, CASE WHEN n > 0 THEN vsum / n END AS v
      FROM ${aggTable} WHERE vehicle_id = $1 AND tag_id = ANY($2::int[])
        AND bucket >= date_trunc('${aggTable === 'sample_1h' ? 'hour' : 'minute'}', $3::timestamptz) AND bucket <= $4 ORDER BY bucket, tag_id`;
    params = [vehicle.id, num, iso(p.from), iso(p.to)];
  } else {
    // tall som tekst (PostgreSQL skriver dem nøyaktig), så de kan stå i samme kolonne som teksttaggene
    sql = `SELECT (extract(epoch FROM x.ts) * 1000)::bigint AS t, x.tid, x.v FROM (
        SELECT ts, tag_id AS tid, value::text AS v FROM sample WHERE vehicle_id = $1 AND tag_id = ANY($2::int[]) AND ts >= $4 AND ts <= $5
        UNION ALL
        SELECT ts, tag_id, value FROM sample_text WHERE vehicle_id = $1 AND tag_id = ANY($3::int[]) AND ts >= $4 AND ts <= $5) x
      ORDER BY x.ts, x.tid`;
    params = [vehicle.id, num, txt, iso(p.from), iso(p.to)];
  }
  const row = p.fill ? cells : new Array(columns.length).fill('');
  for await (const rows of cursor(db, sql, params)) {
    for (const r of rows) {
      if (curT !== null && r.t !== curT) {
        yield fmt.line([...pre, fmt.time(curT), ...row]);
        if (!p.fill) row.fill('');
      }
      curT = r.t;
      const t = byId.get(r.tid);
      // rådata kommer som tekst (UNION med sample_text); tall gjøres om igjen
      const v = !aggTable && t.data_type !== 'string' ? (r.v === null ? null : Number(r.v)) : r.v;
      row[col.get(t.tag)] = v === null ? '' : fmtVal(t, v);
    }
  }
  if (curT !== null) yield fmt.line([...pre, fmt.time(curT), ...row]);
}

async function* eventLines(db, p, fmt) {
  const vals = [iso(p.from), iso(p.to)], where = ['e.ts >= $1', 'e.ts <= $2'];
  const codes = codeList(p.vehicles);
  if (codes.length) { vals.push(codes); where.push(`v.code = ANY($${vals.length}::text[])`); }
  if (p.kind === 'events') {
    yield fmt.line(['tid', 'kjøreverk', 'alvorlighet', 'kilde', 'melding', 'fra']);
    for await (const rows of cursor(db, `SELECT (extract(epoch FROM e.ts) * 1000)::bigint AS t, v.code, e.severity, e.source, e.message, e.src
      FROM event e JOIN vehicle v ON v.id = e.vehicle_id WHERE ${where.join(' AND ')} ORDER BY e.ts, v.code`, vals)) {
      for (const r of rows) yield fmt.line([fmt.time(r.t), fmt.text(r.code), r.severity, fmt.text(r.source), fmt.text(r.message), r.src]);
    }
  } else {
    yield fmt.line(['fra', 'til', 'sekunder', 'kjøreverk', 'tagger', 'grunn', 'meldt']);
    const w = where.map(s => s.replace('e.ts >= $1', 'e.to_ts >= $1').replace('e.ts <= $2', 'e.from_ts <= $2'));
    for await (const rows of cursor(db, `SELECT (extract(epoch FROM e.from_ts) * 1000)::bigint AS f, (extract(epoch FROM e.to_ts) * 1000)::bigint AS t,
        v.code, e.tags, e.reason, (extract(epoch FROM e.reported_at) * 1000)::bigint AS rep
      FROM gap e JOIN vehicle v ON v.id = e.vehicle_id WHERE ${w.join(' AND ')} ORDER BY e.from_ts, v.code`, vals)) {
      for (const r of rows) yield fmt.line([fmt.time(r.f), fmt.time(r.t), Math.round((r.t - r.f) / 1000), fmt.text(r.code), fmt.text(r.tags ? r.tags.join(' ') : 'alle'), fmt.text(r.reason), fmt.time(r.rep)]);
    }
  }
}

// sjekker valgene og finner taggene: { p, tags, vehicles: [{ id, code, tags }] }
async function plan(db, q) {
  const p = Object.assign({ kind: 'values', format: 'long', resolution: 'raw', style: 'no', files: 'one', fill: false }, q);
  if (!['values', 'events', 'gaps'].includes(p.kind)) throw bad('kind is values, events or gaps');
  if (!['long', 'wide'].includes(p.format)) throw bad('format is long or wide');
  if (!['raw', '1m', '1h'].includes(p.resolution)) throw bad('resolution is raw, 1m or 1h');
  if (!['no', 'intl'].includes(p.style)) throw bad('style is no or intl');
  if (!['one', 'zip'].includes(p.files)) throw bad('files is one or zip');
  if (p.kind !== 'values') return { p, tags: [], vehicles: [] };
  const cat = await findTags(db, { vehicles: p.vehicles, tags: p.tags, label: p.label, limit: 5000 });
  if (!cat.rows.length) throw bad('no tags match: choose vehicles and tags that have data');
  if (cat.truncated) throw bad('more than 5000 vehicle and tag pairs: choose fewer');
  const vehicles = [];
  for (const r of cat.rows) {
    let v = vehicles[vehicles.length - 1];
    if (!v || v.id !== r.vehicle_id) { v = { id: r.vehicle_id, code: r.code, tags: [] }; vehicles.push(v); }
    v.tags.push(r);
  }
  return { p, tags: cat.rows, vehicles };
}

// { filename, type, chunks }: chunks er en async generator av tekst eller Buffer
async function buildExport(db, q, log) {
  const { p, tags, vehicles } = await plan(db, q);
  const fmt = csvFormat(p.style, p.tz);
  const now = Date.now();
  const stamp = new Date(now + zoneOffset(p.tz)(now)).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const what = { values: 'verdier', events: 'hendelser', gaps: 'hull' }[p.kind];
  const guard = async function* (gen, name) {
    try { yield* gen; } catch (e) {
      if (log) log.error(`export ${name}: ${e.message}`);
      yield `\r\n!!! Eksporten stoppet her: ${e.message}\r\n`;
    }
  };

  if (p.kind !== 'values') {
    return { filename: `kjoreverk-${what}-${stamp}.csv`, type: 'text/csv; charset=utf-8',
      chunks: buffered(guard((async function* () { yield BOM; yield* eventLines(db, p, fmt); })(), what)) };
  }
  // kolonnene i en bred fil: alle taggene, sortert etter navn
  const columnsOf = list => {
    const seen = new Map();
    for (const t of list) if (!seen.has(t.tag) && !(p.resolution !== 'raw' && t.data_type === 'string')) seen.set(t.tag, t);
    return [...seen.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1));
  };
  const fileFor = (vs, many) => (async function* () {
    yield BOM;
    const cols = p.format === 'wide' ? columnsOf(vs.flatMap(v => v.tags)) : null;
    let first = true;
    for (const v of vs) {
      yield* (p.format === 'wide' ? wideLines(db, p, fmt, v, v.tags, cols, first, many) : longLines(db, p, fmt, v, v.tags, first));
      first = false;
    }
  })();

  if (p.files === 'zip') {
    const files = (async function* () {
      for (const v of vehicles) yield { name: `${v.code}.csv`, chunks: buffered(guard(fileFor([v], false), v.code)) };
    })();
    return { filename: `kjoreverk-${what}-${stamp}.zip`, type: 'application/zip', chunks: zip(files) };
  }
  return { filename: `kjoreverk-${what}-${stamp}.csv`, type: 'text/csv; charset=utf-8', chunks: buffered(guard(fileFor(vehicles, vehicles.length > 1), what)) };
}

// omtrent hvor mange rader eksporten blir, før den lastes ned
async function estimate(db, q) {
  const { p, tags, vehicles } = await plan(db, q);
  if (p.kind !== 'values') {
    const table = p.kind === 'events' ? 'event' : 'gap';
    const vals = [iso(p.from), iso(p.to)], where = p.kind === 'events' ? ['e.ts >= $1', 'e.ts <= $2'] : ['e.to_ts >= $1', 'e.from_ts <= $2'];
    const codes = codeList(p.vehicles);
    if (codes.length) { vals.push(codes); where.push(`v.code = ANY($${vals.length}::text[])`); }
    const r = await db.query(`SELECT count(*)::int AS n FROM ${table} e JOIN vehicle v ON v.id = e.vehicle_id WHERE ${where.join(' AND ')}`, vals);
    return { rows: r.rows[0].n, vehicles: null, tags: null };
  }
  const num = tags.filter(t => t.data_type !== 'string');
  const [Fm, Fh, Th, Tm] = countBounds(p.from, p.to);
  const r = await db.query(`SELECT coalesce(sum(
      (SELECT coalesce(sum(h.n + h.nnull), 0) FROM sample_1h h WHERE h.vehicle_id = u.vid AND h.tag_id = u.tid AND h.bucket >= $4 AND h.bucket < $5)
      + (SELECT coalesce(sum(m.n + m.nnull), 0) FROM sample_1m m WHERE m.vehicle_id = u.vid AND m.tag_id = u.tid
          AND ((m.bucket >= $3 AND m.bucket < $4) OR (m.bucket >= $5 AND m.bucket < $6)))), 0) AS n
    FROM unnest($1::smallint[], $2::int[]) AS u(vid, tid)`, [num.map(t => t.vehicle_id), num.map(t => t.tag_id), Fm, Fh, Th, Tm]);
  let rows = Number(r.rows[0].n);
  if (p.resolution !== 'raw') {
    const buckets = Math.ceil((p.to - p.from) / (p.resolution === '1m' ? 60000 : 3600000)) * num.length;
    rows = Math.min(rows, buckets);
  }
  return { rows, vehicles: vehicles.length, tags: new Set(tags.map(t => t.tag)).size, pairs: tags.length };
}

module.exports = { buildExport, estimate, plan, cursor };

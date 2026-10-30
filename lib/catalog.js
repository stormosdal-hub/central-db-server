'use strict';
/*
 * lib/catalog.js - katalogen (vehicle_tag): hvilke tagger hvert kjøreverk har. Grunnlaget for Finn data,
 * trend og eksport, som alle velger tagger med mønstre som i reglene: "kv_1.bit*, calc.speed".
 */

const { bad } = require('./errors');

// "kv_1.bit*, calc.*" -> ['^kv_1\.bit.*$', '^calc\..*$'] for PostgreSQLs ~. * passer med hva som helst.
function patternsToRegex(text) {
  return String(text || '').split(/[\s,]+/).filter(Boolean).slice(0, 50)
    .map(p => '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

const MS = /^\d{12,14}$/;
// et tidsrom fra en forespørsel: { from, to } i ms, sjekket
function timeRange(q, maxDays) {
  const from = Number(q.from), to = Number(q.to);
  if (!MS.test(String(q.from)) || !MS.test(String(q.to)) || !(to > from)) throw bad('from and to are times in milliseconds since 1970, and to is after from');
  if (maxDays && to - from > maxDays * 86400000) throw bad(`at most ${maxDays} days at a time`);
  return { from, to };
}

// kodene som en liste: "kv01,kv02" eller ['kv01']; tom = alle
function codeList(v) {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map(s => String(s).trim()).filter(Boolean).slice(0, 500);
}

/*
 * Tagger i katalogen som passer: { vehicles: ['kv01'] | [], tags: 'mønstre', label: 'tekst', dataType, unit, limit }
 * -> [{ vehicle_id, code, vehicle_name, tag_id, tag, data_type, unit, label, description, last_ts, last_value, last_text }]
 */
async function findTags(db, f) {
  const where = ['v.active OR v.last_batch_at IS NOT NULL'], vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  const codes = codeList(f.vehicles);
  if (codes.length) add('v.code = ANY(?::text[])', codes);
  const res = patternsToRegex(f.tags);
  if (res.length) add('t.name ~ ANY(?::text[])', res);
  if (f.label && String(f.label).trim()) {
    vals.push(`%${String(f.label).trim().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`vt.label ILIKE $${vals.length} OR vt.description ILIKE $${vals.length}`);
  }
  if (f.dataType) add('vt.data_type = ?', String(f.dataType));
  if (f.unit && String(f.unit).trim()) add('vt.unit ILIKE ?', String(f.unit).trim());
  const limit = Math.min(Number(f.limit) || 2000, 10000);
  vals.push(limit + 1);
  const r = await db.query(`SELECT v.id AS vehicle_id, v.code, v.name AS vehicle_name, t.id AS tag_id, t.name AS tag, vt.data_type, vt.unit, vt.label, vt.description,
      (extract(epoch FROM vt.last_ts) * 1000)::bigint AS last_ts, vt.last_value, vt.last_text
    FROM vehicle_tag vt JOIN vehicle v ON v.id = vt.vehicle_id JOIN tag t ON t.id = vt.tag_id
    WHERE (${where.join(') AND (')}) ORDER BY v.code, t.name LIMIT $${vals.length}`, vals);
  const truncated = r.rows.length > limit;
  if (truncated) r.rows.length = limit;
  return { rows: r.rows, truncated };
}

// distinkte tagger (for velgerne): navn, navn fra PLS-en, enhet, type, og hvor mange kjøreverk som har dem
async function tagList(db, { vehicles, q, limit }) {
  const vals = [], where = [];
  const codes = codeList(vehicles);
  if (codes.length) { vals.push(codes); where.push(`v.code = ANY($${vals.length}::text[])`); }
  if (q && String(q).trim()) {
    vals.push(`%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(t.name ILIKE $${vals.length} OR vt.label ILIKE $${vals.length} OR vt.unit ILIKE $${vals.length})`);
  }
  vals.push(Math.min(Number(limit) || 300, 2000));
  const r = await db.query(`SELECT t.name AS tag, mode() WITHIN GROUP (ORDER BY vt.label) AS label, mode() WITHIN GROUP (ORDER BY vt.unit) AS unit,
      mode() WITHIN GROUP (ORDER BY vt.data_type) AS data_type, count(*)::int AS vehicles
    FROM vehicle_tag vt JOIN tag t ON t.id = vt.tag_id JOIN vehicle v ON v.id = vt.vehicle_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY t.name ORDER BY t.name LIMIT $${vals.length}`, vals);
  return r.rows;
}

module.exports = { patternsToRegex, timeRange, codeList, findTags, tagList };

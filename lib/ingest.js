'use strict';
/*
 * lib/ingest.js - mottaket: én batch fra en recorder, i én transaksjon (PROTOKOLL.md §5, docs/PLAN.md §3.4).
 *
 *   1. Økten (vehicle, boot). Er batchen (boot, seq) lagret fra før, er svaret det samme som sist, og
 *      ingenting lagres på nytt.
 *   2. Katalogen: taggene recorderen meldte, og tagger med punkter som ikke sto der fra før.
 *   3. Punktene, teksten og hendelsene, med ON CONFLICT DO NOTHING: hvert punkt lagres én gang, med
 *      nøkkelen kjøreverk, tag og tid. Det som finnes fra før, beholdes.
 *   4. Hullene, økten, kjøreverket, klokkeobservasjonen og tidsrommet sammendragene må regne om.
 *   5. Svaret lagres i batch, og COMMIT. Først da får recorderen svar.
 *
 * Punktene sjekkes før transaksjonen: en feil gir 400 med en forklaring, og recorderen kaster batchen
 * og melder et hull (§2). Tider før 2001 eller mer enn et døgn fram i tid regnes som feil: en Pi uten
 * synkronisert klokke kan ha en tid ingen vet noe om, og lagrede tider skrives aldri om.
 */

const { bad } = require('./errors');

const MIN_TS = Date.UTC(2001, 0, 1);
const FUTURE_MS = 24 * 3600 * 1000;
const SEVERITIES = new Set(['info', 'warning', 'alarm']);
const DATA_TYPES = new Set(['boolean', 'number', 'string']);
const TAG_NAME = /^[^\x00-\x1f\x7f]{1,200}$/;

const str = (v, max) => (v === undefined || v === null ? '' : String(v)).slice(0, max);

// gjør om batchen til kolonner klare for unnest, og sjekker hvert felt
function parseBatch(body, limits) {
  const maxTs = Date.now() + FUTURE_MS;
  const maxPoints = limits.maxPointsPerBatch || 200000;
  const checkTs = (ts, where) => {
    if (!Number.isInteger(ts)) throw bad(`${where}: the time is a whole number of milliseconds since 1970 (UTC)`);
    if (ts < MIN_TS || ts > maxTs) throw bad(`${where}: the time ${new Date(ts).toISOString()} is before 2001 or more than a day ahead`);
  };
  const checkTag = (name, where) => { if (typeof name !== 'string' || !TAG_NAME.test(name)) throw bad(`${where}: the tag name must be 1 to 200 characters`); };
  const qsrc = (p, where) => {
    const q = p[2] === undefined ? 0 : p[2], src = p[3] === undefined ? 0 : p[3];
    if (q !== 0 && q !== 1 && q !== 2 && q !== 3) throw bad(`${where}: q is 0, 1, 2 or 3`);
    if (src !== 0 && src !== 1 && src !== 2) throw bad(`${where}: src is 0, 1 or 2`);
    return [q, src];
  };

  const out = {
    names: new Set(),                                       // alle tagnavn i batchen
    num: { ts: [], tag: [], v: [], q: [], src: [], last: new Map() },   // punkter med tall; last: tag -> [ts, v]
    txt: { ts: [], tag: [], v: [], q: [], src: [], last: new Map() },
    events: { ts: [], source: [], severity: [], message: [], src: [] },
    gaps: [],
    catalog: [],
    textTags: new Set(),
    n: 0, minTs: Infinity, maxTs: -Infinity,                // alle punkter
    rtMin: Infinity, rtMax: -Infinity,                      // sanntidspunktene (src 0): øktens tidsrom
  };
  const seen = (ts, src) => {
    if (ts < out.minTs) out.minTs = ts;
    if (ts > out.maxTs) out.maxTs = ts;
    if (src === 0) { if (ts < out.rtMin) out.rtMin = ts; if (ts > out.rtMax) out.rtMax = ts; }
    if (++out.n > maxPoints) throw bad(`more than ${maxPoints} points in one batch`);
  };

  const series = body.series || {};
  if (typeof series !== 'object' || Array.isArray(series)) throw bad('series is an object: tag name -> list of points');
  for (const tag of Object.keys(series)) {
    checkTag(tag, 'series');
    const arr = series[tag];
    if (!Array.isArray(arr)) throw bad(`series ${tag}: a list of points`);
    out.names.add(tag);
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i], where = `series ${tag}[${i}]`;
      if (!Array.isArray(p) || p.length < 2 || p.length > 4) throw bad(`${where}: a point is [ts, value, q, src]`);
      checkTs(p[0], where);
      let v = p[1];
      if (v === true) v = 1; else if (v === false) v = 0;
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw bad(`${where}: the value is a number or null`);
      const [q, src] = qsrc(p, where);
      out.num.ts.push(p[0]); out.num.tag.push(tag); out.num.v.push(v); out.num.q.push(q); out.num.src.push(src);
      const l = out.num.last.get(tag);
      if (!l || p[0] >= l[0]) out.num.last.set(tag, [p[0], v]);
      seen(p[0], src);
    }
  }

  const text = body.text || {};
  if (typeof text !== 'object' || Array.isArray(text)) throw bad('text is an object: tag name -> list of points');
  for (const tag of Object.keys(text)) {
    checkTag(tag, 'text');
    const arr = text[tag];
    if (!Array.isArray(arr)) throw bad(`text ${tag}: a list of points`);
    out.names.add(tag);
    out.textTags.add(tag);
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i], where = `text ${tag}[${i}]`;
      if (!Array.isArray(p) || p.length < 2 || p.length > 4) throw bad(`${where}: a point is [ts, text, q, src]`);
      checkTs(p[0], where);
      const v = p[1];
      if (v !== null && typeof v !== 'string') throw bad(`${where}: the value is a text or null`);
      const [q, src] = qsrc(p, where);
      out.txt.ts.push(p[0]); out.txt.tag.push(tag); out.txt.v.push(v === null ? null : v.slice(0, 4000)); out.txt.q.push(q); out.txt.src.push(src);
      const l = out.txt.last.get(tag);
      if (!l || p[0] >= l[0]) out.txt.last.set(tag, [p[0], v]);
      seen(p[0], src);
    }
  }

  const events = body.events || [];
  if (!Array.isArray(events)) throw bad('events is a list');
  events.forEach((e, i) => {
    const where = `events[${i}]`;
    if (!e || typeof e !== 'object') throw bad(`${where}: an event is { ts, source, severity, message, src }`);
    checkTs(e.ts, where);
    const message = str(e.message, 2000);
    if (!message) throw bad(`${where}: the message is missing`);
    const src = e.src === undefined ? 0 : e.src;
    if (src !== 0 && src !== 1 && src !== 2) throw bad(`${where}: src is 0, 1 or 2`);
    out.events.ts.push(e.ts); out.events.source.push(str(e.source, 200));
    out.events.severity.push(SEVERITIES.has(e.severity) ? e.severity : 'info'); out.events.message.push(message); out.events.src.push(src);
    seen(e.ts, src);
  });

  const gaps = body.gaps || [];
  if (!Array.isArray(gaps)) throw bad('gaps is a list');
  gaps.forEach((g, i) => {
    const where = `gaps[${i}]`;
    if (!g || typeof g !== 'object') throw bad(`${where}: a gap is { from, to, tags, reason }`);
    checkTs(g.from, `${where}.from`); checkTs(g.to, `${where}.to`);
    if (g.to < g.from) throw bad(`${where}: "to" is before "from"`);
    let tags = null;
    if (Array.isArray(g.tags)) {
      if (g.tags.length > 500) tags = null;
      else { g.tags.forEach((t, j) => checkTag(t, `${where}.tags[${j}]`)); tags = g.tags; }
    } else if (g.tags !== undefined && g.tags !== '*') throw bad(`${where}: tags is "*" or a list of names`);
    out.gaps.push({ from: g.from, to: g.to, tags, reason: str(g.reason, 40) });
  });

  const catalog = body.tags || [];
  if (!Array.isArray(catalog)) throw bad('tags is a list');
  if (catalog.length > 5000) throw bad('more than 5000 tags in the catalogue');
  catalog.forEach((t, i) => {
    const where = `tags[${i}]`;
    if (!t || typeof t !== 'object') throw bad(`${where}: a tag is { name, dataType, unit, label, description }`);
    checkTag(t.name, where);
    out.names.add(t.name);
    out.catalog.push({ name: t.name, dataType: DATA_TYPES.has(t.dataType) ? t.dataType : 'number', unit: str(t.unit, 40), label: str(t.label, 200), description: str(t.description, 1000) });
  });
  return out;
}

const msOf = ms => (ms === null || ms === undefined ? null : Math.round(ms));

// lagrer en batch; returnerer { json, stored, duplicates, replay }
async function ingest(db, vehicle, body, opts) {
  const b = parseBatch(body, opts.limits || {});
  const clock = body.clock && typeof body.clock === 'object' ? body.clock : {};
  const synced = clock.synced === true;
  const piTime = Number.isFinite(clock.piTime) ? Math.round(clock.piTime) : null;
  const now = Date.now();

  return db.tx(async c => {
    // økten; raden låses, så to batcher fra samme recorder lagres etter hverandre
    const s = await c.query(`INSERT INTO session (vehicle_id, boot, recorder_version, clock_synced)
      VALUES ($1, $2, $3, $4) ON CONFLICT (vehicle_id, boot) DO UPDATE SET clock_synced = EXCLUDED.clock_synced RETURNING id`,
    [vehicle.id, body.boot, vehicle.recorder_version || null, synced]);
    const sid = s.rows[0].id;

    const seen = await c.query('SELECT response FROM batch WHERE session_id = $1 AND seq = $2', [sid, body.seq]);
    if (seen.rowCount) {
      const json = Object.assign({}, seen.rows[0].response, { rulesVersion: vehicle.rules_version_eff });
      return { json, stored: 0, duplicates: 0, replay: true };
    }

    // tag-ider
    const names = [...b.names];
    const tagId = new Map();
    if (names.length) {
      await c.query('INSERT INTO tag (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING', [names]);
      const r = await c.query('SELECT id, name FROM tag WHERE name = ANY($1::text[])', [names]);
      for (const row of r.rows) tagId.set(row.name, row.id);
    }
    const ids = list => list.map(n => tagId.get(n));

    // katalogen
    if (b.catalog.length) {
      await c.query(`INSERT INTO vehicle_tag (vehicle_id, tag_id, data_type, unit, label, description, last_seen)
        SELECT $1, t.id, c.data_type, c.unit, c.label, c.description, now()
        FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS c(name, data_type, unit, label, description)
        JOIN tag t ON t.name = c.name
        ON CONFLICT (vehicle_id, tag_id) DO UPDATE SET data_type = EXCLUDED.data_type, unit = EXCLUDED.unit, label = EXCLUDED.label,
          description = EXCLUDED.description, last_seen = now()`,
      [vehicle.id, b.catalog.map(t => t.name), b.catalog.map(t => t.dataType), b.catalog.map(t => t.unit), b.catalog.map(t => t.label), b.catalog.map(t => t.description)]);
    }
    const uncatalogued = names.filter(n => !b.catalog.some(t => t.name === n));
    if (uncatalogued.length) {
      await c.query(`INSERT INTO vehicle_tag (vehicle_id, tag_id, data_type, last_seen)
        SELECT $1, t.id, c.dt, now() FROM unnest($2::text[], $3::text[]) AS c(name, dt) JOIN tag t ON t.name = c.name
        ON CONFLICT (vehicle_id, tag_id) DO NOTHING`,
      [vehicle.id, uncatalogued, uncatalogued.map(n => (b.textTags.has(n) ? 'string' : 'number'))]);
    }

    let stored = 0, duplicates = 0;
    // punktene
    if (b.num.ts.length) {
      const r = await c.query(`INSERT INTO sample (ts, vehicle_id, tag_id, value, q, src, unsynced)
        SELECT to_timestamp(u.t / 1000.0), $1, u.tag_id, u.v, u.q, u.src, $7
        FROM unnest($2::bigint[], $3::int[], $4::float8[], $5::smallint[], $6::smallint[]) AS u(t, tag_id, v, q, src)
        ON CONFLICT (vehicle_id, tag_id, ts) DO NOTHING`,
      [vehicle.id, b.num.ts, ids(b.num.tag), b.num.v, b.num.q, b.num.src, !synced]);
      stored += r.rowCount; duplicates += b.num.ts.length - r.rowCount;
      const last = [...b.num.last];
      await c.query(`UPDATE vehicle_tag vt SET last_ts = to_timestamp(u.t / 1000.0), last_value = u.v, last_text = NULL, last_seen = now()
        FROM unnest($2::int[], $3::bigint[], $4::float8[]) AS u(tag_id, t, v)
        WHERE vt.vehicle_id = $1 AND vt.tag_id = u.tag_id AND (vt.last_ts IS NULL OR to_timestamp(u.t / 1000.0) >= vt.last_ts)`,
      [vehicle.id, ids(last.map(x => x[0])), last.map(x => x[1][0]), last.map(x => x[1][1])]);
    }
    // teksten
    if (b.txt.ts.length) {
      const r = await c.query(`INSERT INTO sample_text (ts, vehicle_id, tag_id, value, q, src, unsynced)
        SELECT to_timestamp(u.t / 1000.0), $1, u.tag_id, u.v, u.q, u.src, $7
        FROM unnest($2::bigint[], $3::int[], $4::text[], $5::smallint[], $6::smallint[]) AS u(t, tag_id, v, q, src)
        ON CONFLICT (vehicle_id, tag_id, ts) DO NOTHING`,
      [vehicle.id, b.txt.ts, ids(b.txt.tag), b.txt.v, b.txt.q, b.txt.src, !synced]);
      stored += r.rowCount; duplicates += b.txt.ts.length - r.rowCount;
      const last = [...b.txt.last];
      await c.query(`UPDATE vehicle_tag vt SET last_ts = to_timestamp(u.t / 1000.0), last_text = u.v, last_value = NULL, last_seen = now()
        FROM unnest($2::int[], $3::bigint[], $4::text[]) AS u(tag_id, t, v)
        WHERE vt.vehicle_id = $1 AND vt.tag_id = u.tag_id AND (vt.last_ts IS NULL OR to_timestamp(u.t / 1000.0) >= vt.last_ts)`,
      [vehicle.id, ids(last.map(x => x[0])), last.map(x => x[1][0]), last.map(x => x[1][1])]);
    }
    // hendelsene
    if (b.events.ts.length) {
      const r = await c.query(`INSERT INTO event (ts, vehicle_id, source, severity, message, src, unsynced)
        SELECT to_timestamp(u.t / 1000.0), $1, u.source, u.severity, u.message, u.src, $7
        FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::smallint[]) AS u(t, source, severity, message, src)
        ON CONFLICT (vehicle_id, ts, source, md5(message)) DO NOTHING`,
      [vehicle.id, b.events.ts, b.events.source, b.events.severity, b.events.message, b.events.src, !synced]);
      stored += r.rowCount; duplicates += b.events.ts.length - r.rowCount;
    }
    // hullene
    for (const g of b.gaps) {
      await c.query('INSERT INTO gap (vehicle_id, session_id, from_ts, to_ts, tags, reason) VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5, $6)',
        [vehicle.id, sid, g.from, g.to, g.tags, g.reason]);
    }

    // økten og kjøreverket
    const rtMin = b.rtMin === Infinity ? null : b.rtMin, rtMax = b.rtMax === -Infinity ? null : b.rtMax;
    await c.query(`UPDATE session SET last_batch_at = now(), last_seq = GREATEST(last_seq, $2), batches = batches + 1, points = points + $3,
        first_ts = LEAST(first_ts, to_timestamp($4 / 1000.0)), last_ts = GREATEST(last_ts, to_timestamp($5 / 1000.0)) WHERE id = $1`,
    [sid, body.seq, b.n, rtMin, rtMax]);
    const maxTs = b.maxTs === -Infinity ? null : b.maxTs;
    const v = await c.query(`UPDATE vehicle SET last_seen = now(), last_batch_at = now(), last_ts = GREATEST(last_ts, to_timestamp($2 / 1000.0)),
        clock_synced = $3, clock_offset_ms = $4 WHERE id = $1 RETURNING (extract(epoch FROM last_ts) * 1000)::bigint AS last_ts`,
    [vehicle.id, maxTs, synced, piTime === null ? null : piTime - now]);
    if (piTime !== null) {
      await c.query('INSERT INTO clock_obs (vehicle_id, session_id, pi_time, offset_ms, synced) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)',
        [vehicle.id, sid, piTime, Math.max(-2e9, Math.min(2e9, piTime - now)), synced]);
    }
    // sammendragene må regne om dette tidsrommet
    if (b.num.ts.length) {
      let lo = Infinity, hi = -Infinity;
      for (const t of b.num.ts) { if (t < lo) lo = t; if (t > hi) hi = t; }
      await c.query('INSERT INTO rollup_dirty (vehicle_id, from_ts, to_ts) VALUES ($1, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0))', [vehicle.id, lo, hi + 1]);
    }

    const json = { ok: true, seq: body.seq, stored, duplicates, rulesVersion: vehicle.rules_version_eff, lastTs: msOf(v.rows[0].last_ts) };
    await c.query('INSERT INTO batch (session_id, seq, response) VALUES ($1, $2, $3)', [sid, body.seq, JSON.stringify(json)]);
    return { json, stored, duplicates, replay: false, points: b.n, events: b.events.ts.length, gaps: b.gaps.length };
  });
}

module.exports = { ingest, parseBatch, MIN_TS };

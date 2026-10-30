'use strict';
/*
 * lib/preview.js - hva et regelsett ville lagret (docs/PLAN.md §4.5): «denne regelen ville gitt så mange punkter
 * siste døgn for kv07». Regelmotoren fra hmi-core (lib/record-rules.js) kjøres på rådataene i databasen, i
 * tidsrekkefølge, med et tikk hvert sekund som i recorderen.
 *
 * Rådataene er allerede valgt ut av reglene som gjaldt da de ble lagret. Forhåndsvisningen viser derfor hva
 * strengere regler ville spart, men ikke hva løsere regler ville tatt med i tillegg.
 */

const { bad } = require('./errors');
const { checkRecording, compileRules, createRecorderRules, ruleFor } = require('./record-rules');
const { cursor } = require('./export');

const MAX_ROWS = 3000000;
const QUALITY = ['good', 'uncertain', 'bad', 'bad'];

// ${kv}: prosjektvariablene på Pi-en er ukjente her, så kv gjettes fra det vanligste prefikset i taggene (kv_1.bit03 -> kv_1)
function guessVars(tags) {
  const n = new Map();
  for (const t of tags) {
    const dev = t.split('.')[0];
    if (dev && dev !== t && dev !== 'calc' && dev !== 'rec') n.set(dev, (n.get(dev) || 0) + 1);
  }
  let best = null;
  for (const [k, c] of n) if (!best || c > n.get(best)) best = k;
  return best ? { kv: best } : {};
}

async function preview(db, vehicle, input, hours, vars) {
  const { recording, errors } = checkRecording(input);
  if (errors.length) throw bad(`the rule set has errors: ${errors.join('; ')}`);
  const h = Math.max(1, Math.min(168, Number(hours) || 24));
  const to = Date.now(), from = to - h * 3600000;
  const iso = ms => new Date(ms).toISOString();

  const est = (await db.query(`SELECT coalesce(sum(n + nnull), 0) AS n FROM sample_1h WHERE vehicle_id = $1 AND bucket >= date_trunc('hour', $2::timestamptz)`, [vehicle.id, iso(from)])).rows[0].n;
  if (Number(est) > MAX_ROWS) throw bad(`${vehicle.code} has about ${est} stored values in ${h} h; choose fewer hours`);
  const tags = (await db.query('SELECT t.name FROM vehicle_tag vt JOIN tag t ON t.id = vt.tag_id WHERE vt.vehicle_id = $1', [vehicle.id])).rows.map(r => r.name);
  const v = vars && Object.keys(vars).length ? vars : guessVars(tags);
  const compiled = compileRules(recording, v);

  const per = new Map();   // tag -> { now, would }
  const get = tag => { let x = per.get(tag); if (!x) { x = { now: 0, would: 0 }; per.set(tag, x); } return x; };
  let flickers = 0;
  const eng = createRecorderRules(compiled, {
    store(tag) { get(tag).would++; },
    event(severity) { if (severity === 'warning') flickers++; },
  });
  let tick = from;
  for await (const rows of cursor(db, `SELECT (extract(epoch FROM x.ts) * 1000)::bigint AS t, t.name AS tag, x.v, x.vt, x.q FROM (
      SELECT ts, tag_id, value AS v, NULL::text AS vt, q FROM sample WHERE vehicle_id = $1 AND ts > $2 AND ts <= $3
      UNION ALL
      SELECT ts, tag_id, NULL, value, q FROM sample_text WHERE vehicle_id = $1 AND ts > $2 AND ts <= $3) x
    JOIN tag t ON t.id = x.tag_id ORDER BY x.ts`, [vehicle.id, iso(from), iso(to)], 10000)) {
    for (const r of rows) {
      if (r.q === 3) continue;                          // merket der en pause begynte: ingen verdi
      while (tick + 1000 <= r.t) { tick += 1000; eng.tick(tick, tick); }
      get(r.tag).now++;
      eng.value(r.tag, r.vt !== null ? r.vt : r.v, QUALITY[r.q] || 'good', r.t, r.t);
    }
  }
  while (tick + 1000 <= to) { tick += 1000; eng.tick(tick, tick); }

  const list = [...per.entries()].map(([tag, x]) => {
    const rule = ruleFor(compiled, tag);
    return { tag, rule: rule ? rule.index : null, mode: rule ? rule.mode : null, now: x.now, would: x.would };
  }).sort((a, b) => b.now - a.now);
  const rules = recording.rules.map((r, i) => ({ index: i, tags: r.tags, mode: r.mode, tagCount: 0, now: 0, would: 0 }));
  const none = { index: null, tags: '(ingen regel: lagres ikke)', mode: null, tagCount: 0, now: 0, would: 0 };
  for (const x of list) {
    const r = x.rule === null ? none : rules[x.rule];
    r.tagCount++; r.now += x.now; r.would += x.would;
  }
  const total = list.reduce((a, x) => ({ now: a.now + x.now, would: a.would + x.would }), { now: 0, would: 0 });
  return { vehicle: vehicle.code, from, to, hours: h, vars: v, total, flickers, rules: rules.concat(none.tagCount ? [none] : []), tags: list.slice(0, 300), tagCount: list.length };
}

module.exports = { preview, guessVars };

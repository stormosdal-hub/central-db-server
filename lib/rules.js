'use strict';
/*
 * lib/rules.js - regelsettene og hva hvert kjøreverk får (PROTOKOLL.md §4 og §7, docs/PLAN.md §4.5).
 *
 * Et regelsett (rule_set) deles av mange kjøreverk. Et kjøreverk kan ha et tillegg (vehicle.rule_extra):
 * regler og pauser som legges foran settets. events og eventsMin kommer alltid fra settet.
 * Hver endring får et nytt nummer fra rules_version_seq; kjøreverkets versjon er den største av settets og
 * tilleggets, og recorderen henter reglene på nytt når den ser et nytt nummer.
 *
 * Alt sjekkes med checkRecording fra lib/record-rules.js (kopien av hmi-core sin), og et regelsett med
 * feil lagres ikke.
 */

const crypto = require('crypto');
const { checkRecording } = require('./record-rules');
const { HttpError, bad } = require('./errors');
const { audit } = require('./audit');

const EMPTY = { events: true, eventsMin: 'info', rules: [], pauses: [] };
const PRUNE_AFTER = 7 * 24 * 3600 * 1000;   // pauser som har vært over så lenge, tas ut av listen ved neste lagring

// tillegget først, så det felles
function merge(extra, shared) {
  const s = shared || EMPTY;
  return {
    events: s.events !== false,
    eventsMin: s.eventsMin || 'info',
    rules: (extra && Array.isArray(extra.rules) ? extra.rules : []).concat(Array.isArray(s.rules) ? s.rules : []),
    pauses: (extra && Array.isArray(extra.pauses) ? extra.pauses : []).concat(Array.isArray(s.pauses) ? s.pauses : []),
  };
}

// det ferdige regelsettet for et kjøreverk (raden fra lib/auth.js): { version, recording }
async function effectiveFor(q, vehicle) {
  const r = await q.query('SELECT recording, version FROM rule_set WHERE id = $1', [vehicle.rule_set_id]);
  const shared = r.rows[0] ? r.rows[0].recording : EMPTY;
  const version = Math.max(r.rows[0] ? Number(r.rows[0].version) : 0, Number(vehicle.rules_version || 0));
  return { version, recording: merge(vehicle.rule_extra, shared) };
}

// sjekker et regelsett og kaster 400 med feilene hvis det ikke kan lagres
function checked(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('the rule set is a JSON object with events, eventsMin, rules and pauses');
  const { recording, errors } = checkRecording(input);
  if (errors.length) throw new HttpError(400, `the rule set has errors: ${errors.join('; ')}`, { errors });
  const now = Date.now();
  recording.pauses = recording.pauses.filter(p => p.until === null || p.until > now - PRUNE_AFTER);
  return recording;
}

async function listRuleSets(db) {
  const r = await db.query(`SELECT rs.id, rs.name, rs.version, rs.updated_at, rs.updated_by,
      jsonb_array_length(rs.recording->'rules') AS rules, jsonb_array_length(rs.recording->'pauses') AS pauses,
      (SELECT count(*) FROM vehicle v WHERE v.rule_set_id = rs.id) AS vehicles
    FROM rule_set rs ORDER BY rs.id`);
  return r.rows;
}

async function getRuleSet(db, name) {
  const r = await db.query('SELECT id, name, recording, version, updated_at, updated_by FROM rule_set WHERE name = $1', [String(name)]);
  return r.rows[0] || null;
}

// lagrer et regelsett (lager det om det ikke finnes): { id, name, version }
async function setRuleSet(db, name, input, who, note) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(String(name))) throw bad('a rule set\'s name is letters, digits, -, _ and ., up to 40 characters');
  const recording = checked(input);
  return db.tx(async c => {
    const r = await c.query(`INSERT INTO rule_set (name, recording, updated_by, version) VALUES ($1, $2, $3, nextval('rules_version_seq'))
      ON CONFLICT (name) DO UPDATE SET recording = EXCLUDED.recording, version = EXCLUDED.version, updated_at = now(), updated_by = EXCLUDED.updated_by
      RETURNING id, name, version`, [name, JSON.stringify(recording), who]);
    const row = r.rows[0];
    await c.query('INSERT INTO rule_history (rule_set_id, version, recording, changed_by, note) VALUES ($1, $2, $3, $4, $5)',
      [row.id, row.version, JSON.stringify(recording), who, note || '']);
    await audit(c, who, 'rules.set', name, { version: row.version, rules: recording.rules.length, pauses: recording.pauses.length, note: note || '' });
    return row;
  });
}

async function deleteRuleSet(db, name, who) {
  return db.tx(async c => {
    const r = await c.query('SELECT id FROM rule_set WHERE name = $1', [name]);
    if (!r.rowCount) throw new HttpError(404, `no rule set named ${name}`);
    if (r.rows[0].id === 1) throw bad('the default rule set can\'t be deleted');
    const used = await c.query('SELECT code FROM vehicle WHERE rule_set_id = $1 ORDER BY code', [r.rows[0].id]);
    if (used.rowCount) throw bad(`${name} is used by ${used.rows.map(x => x.code).join(', ')}; give them another rule set first`);
    await c.query('DELETE FROM rule_history WHERE rule_set_id = $1', [r.rows[0].id]);
    await c.query('DELETE FROM rule_set WHERE id = $1', [r.rows[0].id]);
    await audit(c, who, 'rules.delete', name);
  });
}

// tillegget for et kjøreverk: regler og pauser foran settets. null fjerner det.
async function setVehicleExtra(db, code, input, who, note) {
  const recording = input === null ? null : checked(input);
  return db.tx(async c => {
    const r = await c.query(`UPDATE vehicle SET rule_extra = $2, rules_version = nextval('rules_version_seq') WHERE code = $1 RETURNING id, rules_version`,
      [code, recording === null ? null : JSON.stringify(recording)]);
    if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
    await c.query('INSERT INTO rule_history (vehicle_id, version, recording, changed_by, note) VALUES ($1, $2, $3, $4, $5)',
      [r.rows[0].id, r.rows[0].rules_version, recording === null ? null : JSON.stringify(recording), who, note || '']);
    await audit(c, who, 'rules.extra', code, { version: r.rows[0].rules_version, removed: recording === null });
    return { version: r.rows[0].rules_version };
  });
}

// hvilket regelsett et kjøreverk bruker
async function setVehicleRuleSet(db, code, setName, who) {
  return db.tx(async c => {
    const rs = await c.query('SELECT id FROM rule_set WHERE name = $1', [setName]);
    if (!rs.rowCount) throw new HttpError(404, `no rule set named ${setName}`);
    const r = await c.query(`UPDATE vehicle SET rule_set_id = $2, rules_version = nextval('rules_version_seq') WHERE code = $1 RETURNING rules_version`, [code, rs.rows[0].id]);
    if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
    await audit(c, who, 'vehicle.ruleset', code, { ruleSet: setName });
    return { version: r.rows[0].rules_version };
  });
}

// ---------------------------------------------------------------- pauser
// target: { set: 'default' } eller { vehicle: 'kv07' }
async function loadTarget(db, target) {
  if (target.vehicle) {
    const r = await db.query('SELECT rule_extra FROM vehicle WHERE code = $1', [target.vehicle]);
    if (!r.rowCount) throw new HttpError(404, `no vehicle named ${target.vehicle}`);
    return r.rows[0].rule_extra || { rules: [], pauses: [] };
  }
  const rs = await getRuleSet(db, target.set || 'default');
  if (!rs) throw new HttpError(404, `no rule set named ${target.set}`);
  return rs.recording;
}
async function saveTarget(db, target, recording, who, note) {
  if (target.vehicle) return setVehicleExtra(db, target.vehicle, recording, who, note);
  return setRuleSet(db, target.set || 'default', recording, who, note);
}

// en pause fra nå: { tags: '*', untilMs: null | ms, reason }
async function addPause(db, target, p, who) {
  const rec = await loadTarget(db, target);
  const pause = {
    id: crypto.randomBytes(3).toString('hex'),
    tags: String(p.tags || '*').trim() || '*',
    since: Number.isFinite(p.sinceMs) ? p.sinceMs : Date.now(),
    until: Number.isFinite(p.untilMs) ? p.untilMs : null,
  };
  if (pause.until !== null && pause.until <= pause.since) throw bad('the pause ends before it begins');
  if (p.reason) pause.reason = String(p.reason).slice(0, 200);
  rec.pauses = (rec.pauses || []).concat([pause]);
  const r = await saveTarget(db, target, rec, who, `pause ${pause.id}: ${pause.tags}${pause.reason ? ' (' + pause.reason + ')' : ''}`);
  return Object.assign({ pause }, r);
}

// avslutter en pause nå (id, eller 'all' for alle som gjelder)
async function resumePause(db, target, id, who) {
  const rec = await loadTarget(db, target);
  const now = Date.now();
  let n = 0;
  for (const p of rec.pauses || []) {
    const active = p.since <= now && (p.until === null || p.until > now);
    if ((id === 'all' && active) || p.id === id) {
      if (p.until === null || p.until > now) { p.until = Math.max(now, p.since + 1); n++; }
    }
  }
  if (!n) throw new HttpError(404, id === 'all' ? 'no pause is active' : `no active pause with id ${id}`);
  const r = await saveTarget(db, target, rec, who, `resume ${id}`);
  return Object.assign({ resumed: n }, r);
}

module.exports = { merge, effectiveFor, checked, listRuleSets, getRuleSet, setRuleSet, deleteRuleSet, setVehicleExtra, setVehicleRuleSet, addPause, resumePause, EMPTY };

'use strict';
/*
 * lib/admin.js - kjøreverk, nøkler og brukere. Brukes av bin/kv-admin.js, og senere av web-siden.
 */

const crypto = require('crypto');
const { newKey, hashKey } = require('./auth');
const { HttpError, bad } = require('./errors');
const { audit } = require('./audit');

// koden er kjøreverkets navn på Pi-en, så den følger samme regel som VEHICLE_RX i hmi-core/lib/vehicle.js
// (og install.sh der): en bokstav eller _ først. En kode Pi-en ikke godtar, kan aldri brukes
const CODE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const CODE_RULE = 'a vehicle\'s code is its name on the Pi: a letter or _ first, then letters, digits, -, _ and ., up to 32 characters, like kv_52';
const ROLES = ['view', 'rules', 'admin'];

// navn, notater og grensen for stille-varselet, sjekket
function checkFields({ name, notes, silentAfter }) {
  if (name !== undefined && String(name).length > 100) throw bad('the name is at most 100 characters');
  if (notes !== undefined && String(notes).length > 2000) throw bad('the notes are at most 2000 characters');
  if (silentAfter !== undefined && silentAfter !== null && !(Number.isInteger(silentAfter) && silentAfter >= 60 && silentAfter <= 90 * 86400)) {
    throw bad('"silent after" is a whole number of seconds, from 60 to 90 days');
  }
}

async function addVehicle(db, { code, name, ruleSet, silentAfter, notes, who }) {
  if (!CODE.test(String(code || ''))) throw bad(CODE_RULE);
  checkFields({ name, notes, silentAfter: Number.isFinite(silentAfter) ? silentAfter : undefined });
  return db.tx(async c => {
    let setId = 1;
    if (ruleSet) {
      const rs = await c.query('SELECT id FROM rule_set WHERE name = $1', [ruleSet]);
      if (!rs.rowCount) throw new HttpError(404, `no rule set named ${ruleSet}`);
      setId = rs.rows[0].id;
    }
    const r = await c.query(`INSERT INTO vehicle (code, name, rule_set_id, silent_after_s, notes) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (code) DO NOTHING RETURNING id`, [code, name || '', setId, silentAfter > 0 ? silentAfter : 7200, notes || '']);
    if (!r.rowCount) throw bad(`${code} exists already`);
    await audit(c, who, 'vehicle.add', code, { name: name || '', ruleSet: ruleSet || 'default' });
    return { id: r.rows[0].id, code };
  });
}

async function listVehicles(db) {
  const r = await db.query(`SELECT v.id, v.code, v.name, v.active, v.key_prefix, v.key_made_at, v.last_seen, v.last_batch_at, v.last_ts, v.last_ip,
      v.last_refused_at, v.last_refused_reason, v.last_refused_ip,
      v.recorder_version, v.clock_synced, v.clock_offset_ms, v.silent_after_s, v.notes, v.created_at, rs.name AS rule_set,
      GREATEST(rs.version, v.rules_version) AS rules_version, v.rule_extra IS NOT NULL AS has_extra
    FROM vehicle v JOIN rule_set rs ON rs.id = v.rule_set_id ORDER BY v.code`);
  return r.rows;
}

// kjøreverkene med tallene Oversikt og Kjøreverk viser: punkter, hull og alarmer siste døgn, tagger, og om det sender
async function vehiclesWithStats(db) {
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
    // avvist etter siste gang det slapp inn: nøkkelen eller navnet stemmer ikke
    v.refused = v.last_refused_at !== null && (v.last_seen === null || v.last_refused_at > v.last_seen);
  }
  return vehicles;
}

async function getVehicle(db, code) {
  const r = await db.query(`SELECT v.*, rs.name AS rule_set, GREATEST(rs.version, v.rules_version) AS rules_version_eff
    FROM vehicle v JOIN rule_set rs ON rs.id = v.rule_set_id WHERE v.code = $1`, [String(code)]);
  if (!r.rowCount) return null;
  const v = r.rows[0];
  delete v.key_hash;
  const s = await db.query(`SELECT id, boot, started_at, last_batch_at, last_seq, batches, points, first_ts, last_ts, recorder_version, clock_synced
    FROM session WHERE vehicle_id = $1 ORDER BY started_at DESC LIMIT 10`, [v.id]);
  v.sessions = s.rows;
  const t = await db.query('SELECT count(*) AS tags FROM vehicle_tag WHERE vehicle_id = $1', [v.id]);
  v.tags = t.rows[0].tags;
  v.has_data = await hasData(db, v.id);
  return v;
}

// har kjøreverket lagret noe? Da kan det ikke slettes, bare slås av.
async function hasData(q, id) {
  const r = await q.query(`SELECT EXISTS (SELECT 1 FROM sample WHERE vehicle_id = $1) OR EXISTS (SELECT 1 FROM sample_text WHERE vehicle_id = $1)
    OR EXISTS (SELECT 1 FROM event WHERE vehicle_id = $1) OR EXISTS (SELECT 1 FROM gap WHERE vehicle_id = $1) AS has`, [id]);
  return r.rows[0].has;
}

// sletter et kjøreverk som aldri har lagret data, for eksempel et som ble lagt til med feil kode
// ny kode for et kjøreverk, for eksempel kv52 -> kv_52 når navnet på Pi-ene endres. Dataene, nøkkelen og
// reglene følger med (de henger på kjøreverkets id, ikke koden). Recorderen må sende den nye koden.
async function renameVehicle(db, code, newCode, who) {
  if (!CODE.test(String(newCode || ''))) throw bad(CODE_RULE);
  if (newCode === code) return;
  return db.tx(async c => {
    const r = await c.query('SELECT id FROM vehicle WHERE code = $1 FOR UPDATE', [code]);
    if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
    if ((await c.query('SELECT 1 FROM vehicle WHERE code = $1', [newCode])).rowCount) throw bad(`${newCode} exists already`);
    await c.query('UPDATE vehicle SET code = $2, last_refused_at = NULL, last_refused_reason = NULL, last_refused_ip = NULL WHERE id = $1', [r.rows[0].id, newCode]);
    await audit(c, who, 'vehicle.rename', newCode, { from: code, to: newCode });
  });
}

async function deleteVehicle(db, code, who) {
  return db.tx(async c => {
    const r = await c.query('SELECT id FROM vehicle WHERE code = $1 FOR UPDATE', [code]);
    if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
    const id = r.rows[0].id;
    if (await hasData(c, id)) throw bad(`${code} has stored data, so it can't be deleted; disable it instead`);
    for (const table of ['vehicle_tag', 'clock_obs', 'rollup_dirty', 'rule_history', 'session']) await c.query(`DELETE FROM ${table} WHERE vehicle_id = $1`, [id]);
    await c.query('DELETE FROM vehicle WHERE id = $1', [id]);
    await audit(c, who, 'vehicle.delete', code);
  });
}

async function updateVehicle(db, code, fields, who) {
  checkFields(fields);
  const allowed = { name: 'name', silentAfter: 'silent_after_s', notes: 'notes' };
  const sets = [], vals = [code];
  for (const k of Object.keys(fields)) {
    if (!(k in allowed) || fields[k] === undefined) continue;
    vals.push(fields[k]);
    sets.push(`${allowed[k]} = $${vals.length}`);
  }
  if (!sets.length) return;
  const r = await db.query(`UPDATE vehicle SET ${sets.join(', ')} WHERE code = $1`, vals);
  if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
  const changed = {};
  for (const k of Object.keys(allowed)) if (fields[k] !== undefined) changed[k] = fields[k];
  await audit(db, who, 'vehicle.update', code, changed);
}

// en ny nøkkel; den gamle slutter å virke med en gang. Nøkkelen vises bare her, én gang.
async function makeKey(db, code, who) {
  const key = newKey();
  const prefix = key.slice(0, 6);
  return db.tx(async c => {
    const r = await c.query('UPDATE vehicle SET key_hash = $2, key_prefix = $3, key_made_at = now() WHERE code = $1 RETURNING id', [code, hashKey(key), prefix]);
    if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
    await audit(c, who, 'vehicle.key', code, { prefix });
    return { key, prefix };
  });
}

async function revokeKey(db, code, who) {
  const r = await db.query('UPDATE vehicle SET key_hash = NULL, key_prefix = NULL WHERE code = $1 RETURNING id', [code]);
  if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
  await audit(db, who, 'vehicle.revoke', code);
}

async function setActive(db, code, active, who) {
  const r = await db.query('UPDATE vehicle SET active = $2 WHERE code = $1 RETURNING id', [code, !!active]);
  if (!r.rowCount) throw new HttpError(404, `no vehicle named ${code}`);
  await audit(db, who, active ? 'vehicle.enable' : 'vehicle.disable', code);
}

// ---------------------------------------------------------------- brukere på web-siden
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hash, 'base64');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

async function addUser(db, { name, password, role, who }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,39}$/.test(String(name || ''))) throw bad('a user name is letters, digits, -, _, . and @, up to 40 characters');
  if (!ROLES.includes(role)) throw bad(`the role is one of ${ROLES.join(', ')}`);
  if (String(password || '').length < 8) throw bad('the password is at least 8 characters');
  const r = await db.query(`INSERT INTO app_user (name, pw_hash, role) VALUES ($1, $2, $3)
    ON CONFLICT (name) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, role = EXCLUDED.role, disabled = false RETURNING id, (xmax = 0) AS created`,
  [name, hashPassword(password), role]);
  await audit(db, who, r.rows[0].created ? 'user.add' : 'user.update', name, { role });
  return r.rows[0];
}

async function verifyUser(db, name, password) {
  const r = await db.query('SELECT id, name, pw_hash, role, disabled FROM app_user WHERE name = $1', [String(name)]);
  const u = r.rows[0];
  if (!u || u.disabled || !checkPassword(password, u.pw_hash)) return null;
  await db.query('UPDATE app_user SET last_login = now() WHERE id = $1', [u.id]);
  return { id: u.id, name: u.name, role: u.role };
}

async function listUsers(db) {
  return (await db.query('SELECT id, name, role, disabled, created_at, last_login FROM app_user ORDER BY name')).rows;
}

async function removeUser(db, name, who) {
  const r = await db.query('DELETE FROM app_user WHERE name = $1', [name]);
  if (!r.rowCount) throw new HttpError(404, `no user named ${name}`);
  await audit(db, who, 'user.remove', name);
}

module.exports = { addVehicle, listVehicles, vehiclesWithStats, getVehicle, updateVehicle, renameVehicle, deleteVehicle, makeKey, revokeKey, setActive,
  addUser, verifyUser, listUsers, removeUser, hashPassword, checkPassword, ROLES };

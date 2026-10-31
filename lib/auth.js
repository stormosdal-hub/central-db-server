'use strict';
/*
 * lib/auth.js - nøkkelen per kjøreverk (PROTOKOLL.md §1, docs/PLAN.md §3.4).
 *
 * Nøkkelen er lang og tilfeldig, og lagres bare som SHA-256. Recorderen sender den som
 * Authorization: Bearer <nøkkel>, og feltet vehicle i forespørselen må høre til den.
 */

const crypto = require('crypto');

// 30 tilfeldige byte som base64url: 40 tegn, bare bokstaver, sifre, - og _
function newKey() { return crypto.randomBytes(30).toString('base64url'); }
function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest(); }

const VEHICLE_COLUMNS = `v.id, v.code, v.name, v.active, v.rule_set_id, v.rule_extra, v.rules_version, v.recorder_version,
  v.silent_after_s, GREATEST(rs.version, v.rules_version) AS rules_version_eff`;

// kjøreverket en nøkkel hører til, eller null
async function vehicleByKey(db, key) {
  if (!key || key.length < 16 || key.length > 200) return null;
  const r = await db.query(`SELECT ${VEHICLE_COLUMNS} FROM vehicle v JOIN rule_set rs ON rs.id = v.rule_set_id WHERE v.key_hash = $1`, [hashKey(key)]);
  return r.rows[0] || null;
}

async function vehicleByCode(db, code) {
  const r = await db.query(`SELECT ${VEHICLE_COLUMNS} FROM vehicle v JOIN rule_set rs ON rs.id = v.rule_set_id WHERE v.code = $1`, [String(code)]);
  return r.rows[0] || null;
}

// preHandler for /api/v1: setter request.vehicle, eller svarer 401/403. Et avslag skrives i loggen med
// IP-adressen (høyst én gang i minuttet per adresse), så en Pi med feil nøkkel kan finnes. Vet serveren
// hvilket kjøreverk det gjelder (nøkkelen, eller navnet det oppga), noteres avslaget også der, så
// web-siden kan vise det.
function requireKey(db, log) {
  const told = new Map();   // ip -> sist logget
  const noted = new Map();  // kjøreverk -> { at, error } sist notert
  const refuse = async (req, reply, status, error, vehicleId) => {
    const claimed = (req.body && req.body.vehicle) || (req.query && req.query.vehicle) || '?';
    const last = told.get(req.ip) || 0;
    if (log && Date.now() - last > 60000) {
      told.set(req.ip, Date.now());
      if (told.size > 1000) told.delete(told.keys().next().value);
      log.warn(`refused ${req.method} ${req.url.split('?')[0]} from ${req.ip} (says it is ${claimed}): ${error}`);
    }
    try {
      let id = vehicleId;
      if (!id && claimed !== '?') { const v = await vehicleByCode(db, claimed); if (v) id = v.id; }
      const prev = id && noted.get(id);
      // høyst én gang i halvminuttet, med mindre grunnen er en annen
      if (id && (!prev || prev.error !== error || Date.now() - prev.at > 30000)) {
        noted.set(id, { at: Date.now(), error });
        if (noted.size > 1000) noted.delete(noted.keys().next().value);
        await db.query('UPDATE vehicle SET last_refused_at = now(), last_refused_reason = $2, last_refused_ip = $3 WHERE id = $1', [id, error, req.ip]);
      }
    } catch (e) { /* avslaget sendes uansett */ }
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    reply.code(status).send({ error });
    return reply;
  };
  return async function (req, reply) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!m) return refuse(req, reply, 401, 'the key is missing: send it as Authorization: Bearer <key>');
    const v = await vehicleByKey(db, m[1]);
    if (!v) return refuse(req, reply, 403, 'the key is unknown or has been revoked');
    if (!v.active) return refuse(req, reply, 403, `${v.code} is disabled on the server`, v.id);
    const claimed = req.body && req.body.vehicle !== undefined ? req.body.vehicle : (req.query ? req.query.vehicle : undefined);
    if (claimed !== undefined && String(claimed) !== v.code) {
      return refuse(req, reply, 403, `the key belongs to ${v.code}, not ${claimed}: the vehicle's name on the Pi (/etc/kjoreverk/vehicle, or "vehicle" in /etc/hmi-recorder.json) must be its code on the server`, v.id);
    }
    req.vehicle = v;
  };
}

module.exports = { newKey, hashKey, vehicleByKey, vehicleByCode, requireKey, VEHICLE_COLUMNS };

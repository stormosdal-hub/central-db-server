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

// preHandler for /api/v1: setter request.vehicle, eller svarer 401/403
function requireKey(db) {
  return async function (req, reply) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!m) {
      reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'the key is missing: send it as Authorization: Bearer <key>' });
      return reply;
    }
    const v = await vehicleByKey(db, m[1]);
    if (!v) { reply.code(403).send({ error: 'the key is unknown or has been revoked' }); return reply; }
    if (!v.active) { reply.code(403).send({ error: `${v.code} is disabled on the server` }); return reply; }
    const claimed = req.body && req.body.vehicle !== undefined ? req.body.vehicle : (req.query ? req.query.vehicle : undefined);
    if (claimed !== undefined && String(claimed) !== v.code) {
      reply.code(403).send({ error: `the key belongs to ${v.code}, not ${claimed}` });
      return reply;
    }
    req.vehicle = v;
  };
}

module.exports = { newKey, hashKey, vehicleByKey, vehicleByCode, requireKey, VEHICLE_COLUMNS };

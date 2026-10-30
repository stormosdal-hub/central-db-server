'use strict';
/*
 * lib/session.js - innloggingen på web-siden (docs/PLAN.md §3.6).
 *
 * Brukerne lages med kv-admin user add (passordet lagres med scrypt, lib/admin.js). En innlogging gir en
 * cookie med et tilfeldig token; databasen har bare SHA-256 av det (web_session), så øktene overlever en
 * omstart av serveren. Cookien er HttpOnly og SameSite=Strict, og alt som endrer noe, må sendes som JSON
 * fra samme adresse (Origin), så en annen nettside ikke kan gjøre det på vegne av den innloggede.
 *
 * Rollene: view (se og eksportere), rules (regler og pauser, og hvilket regelsett et kjøreverk bruker),
 * admin (kjøreverk, nøkler og brukere). Hver rolle kan alt rollene under kan.
 */

const crypto = require('crypto');

const COOKIE = 'kv_session';
const ROLE_RANK = { view: 1, rules: 2, admin: 3 };
const can = (user, role) => !!user && (ROLE_RANK[user.role] || 0) >= ROLE_RANK[role];
const hash = token => crypto.createHash('sha256').update(String(token)).digest();

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieHeader(token, maxAgeSeconds) {
  return `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function createSession(db, userId, ip, days) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO web_session (token_hash, user_id, expires_at, ip) VALUES ($1, $2, now() + $3::interval, $4)`,
    [hash(token), userId, `${days} days`, ip || null]);
  return token;
}

// brukeren en cookie hører til, eller null. Økten forlenges når den brukes (høyst én gang i timen).
async function sessionUser(db, token, days) {
  if (!token || token.length > 100) return null;
  const r = await db.query(`SELECT u.id, u.name, u.role, s.last_seen < now() - interval '1 hour' AS stale
    FROM web_session s JOIN app_user u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, [hash(token)]);
  if (!r.rowCount) return null;
  const u = r.rows[0];
  if (u.stale) await db.query(`UPDATE web_session SET last_seen = now(), expires_at = now() + $2::interval WHERE token_hash = $1`, [hash(token), `${days} days`]);
  return { id: u.id, name: u.name, role: u.role };
}

async function destroySession(db, token) {
  if (token) await db.query('DELETE FROM web_session WHERE token_hash = $1', [hash(token)]);
}

// feilede innlogginger per IP: etter 5 på 10 minutter må den vente til det eldste forsøket er 10 minutter gammelt
function createLimiter(max, windowMs) {
  const fails = new Map();   // ip -> [tidspunkter]
  const recent = ip => (fails.get(ip) || []).filter(t => t > Date.now() - windowMs);
  return {
    waitSeconds(ip) {
      const list = recent(ip);
      return list.length >= max ? Math.ceil((list[0] + windowMs - Date.now()) / 1000) : 0;
    },
    fail(ip) {
      const list = recent(ip);
      list.push(Date.now());
      fails.set(ip, list);
      if (fails.size > 10000) fails.delete(fails.keys().next().value);
    },
    ok(ip) { fails.delete(ip); },
  };
}

module.exports = { COOKIE, ROLE_RANK, can, readCookie, cookieHeader, createSession, sessionUser, destroySession, createLimiter };

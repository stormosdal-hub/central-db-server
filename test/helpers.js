'use strict';
/*
 * Testene kjører mot en ekte PostgreSQL: KV_TEST_DB, ellers postgres://kjoreverk:kjoreverk@localhost:5432/kjoreverk_test.
 * Skjemaet bygges på nytt for hver testfil (DROP SCHEMA public), så databasen må være en som bare brukes til dette.
 * Filene kjøres etter hverandre (--test-concurrency=1), siden de deler databasen.
 */

const zlib = require('zlib');
const Db = require('../lib/db');
const buildApp = require('../lib/app');
const makeLogger = require('../lib/log');
const { merge, DEFAULTS } = require('../lib/config');
const admin = require('../lib/admin');

const URL = process.env.KV_TEST_DB || 'postgres://kjoreverk:kjoreverk@localhost:5432/kjoreverk_test';

async function freshDb() {
  const db = new Db({ url: URL, max: 6 });
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.init();
  return db;
}

async function addVehicle(db, code) {
  await admin.addVehicle(db, { code, who: 'test' });
  const { key } = await admin.makeKey(db, code, 'test');
  return { code, key };
}

// { db, app, config, code, key, post, get, close }
async function setup(overrides) {
  const db = await freshDb();
  const config = merge(DEFAULTS, merge({ log: 'warn', web: { enabled: false } }, overrides || {}));
  const app = await buildApp({ config, db, log: makeLogger('warn') });
  await app.ready();
  const v = await addVehicle(db, 'kv07');
  const t = {
    db, app, config, code: v.code, key: v.key,
    post(route, body, opts) {
      const o = opts || {};
      const headers = Object.assign({ authorization: `Bearer ${o.key || v.key}`, 'content-type': 'application/json' }, o.headers || {});
      let payload = JSON.stringify(body);
      if (o.gzip) { payload = zlib.gzipSync(payload); headers['content-encoding'] = 'gzip'; }
      return app.inject({ method: 'POST', url: `/api/v1${route}`, headers, payload });
    },
    get(route, opts) {
      const o = opts || {};
      return app.inject({ method: 'GET', url: `/api/v1${route}`, headers: Object.assign({ authorization: `Bearer ${o.key || v.key}` }, o.headers || {}) });
    },
    async close() { await app.close(); await db.close(); },
  };
  return t;
}

const BOOT = '3f2b9c1e-0000-4000-8000-000000000001';
const hello = (code, extra) => Object.assign({ protocol: 1, vehicle: code, boot: BOOT, recorder: '1.0.0', clock: { synced: true, piTime: Date.now() } }, extra || {});

// en batch med n punkter per tag, ett i sekundet, det siste ved `end`: punkt i har tiden end - (n - 1 - i) s og verdien fn(i)
function batch(code, seq, tags, n, end, extra) {
  const series = {};
  end = end || Date.now() - 5000;
  for (const [tag, fn] of Object.entries(tags)) {
    series[tag] = [];
    for (let i = 0; i < n; i++) series[tag].push([end - (n - 1 - i) * 1000, fn(i)]);
  }
  return Object.assign({ vehicle: code, boot: BOOT, seq, clock: { synced: true, piTime: Date.now() }, series }, extra || {});
}

// en nettleser: husker cookien, sender JSON og Origin som web-siden gjør
function browser(T) {
  let cookie = null;
  const req = async (method, url, body, extra) => {
    const headers = Object.assign({ host: 'dbserver:8090', origin: 'http://dbserver:8090' }, extra || {});
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await T.app.inject({ method, url: `/api/web${url}`, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers['set-cookie'];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    return r;
  };
  return {
    get: url => req('GET', url),
    post: (url, body, extra) => req('POST', url, body === undefined ? {} : body, extra),
    patch: (url, body) => req('PATCH', url, body),
    put: (url, body) => req('PUT', url, body),
    del: url => req('DELETE', url),
    login: (name, password) => req('POST', '/login', { name, password }),
    get cookie() { return cookie; },
  };
}

module.exports = { setup, freshDb, addVehicle, hello, batch, browser, BOOT };

'use strict';
/*
 * lib/config.js - oppsettet for serveren: én JSON-fil (docs/PLAN.md §3.2).
 *
 * Filen finnes med --config <fil>, KV_SERVER_CONFIG, /etc/kjoreverk-server/config.json eller
 * config.json i prosjektmappen, i den rekkefølgen. Finnes ingen, brukes standardverdiene.
 * config.example.json viser alt.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 8090,
  host: '0.0.0.0',
  db: { host: '/var/run/postgresql', database: 'kjoreverk', user: 'kjoreverk', password: '', max: 10 },
  ingest: { maxBatchBytes: 5000000, maxConcurrent: 4, maxPointsPerBatch: 200000 },
  history: { maxRows: 60000, maxTags: 8, maxPoints: 10000, maxDays: 400, sessionGapSeconds: 60 },
  rollup: { everySeconds: 20 },
  retention: { rawDays: 400, textDays: 400, eventDays: 0, aggDays: 0, batchDays: 7, clockDays: 90 },
  web: { enabled: true, loginToView: false, sessionDays: 14 },
  log: 'info',
};

function merge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    if (k.startsWith('_')) continue;   // _notes
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

// { config, file }: file er null når bare standardverdiene gjelder
function load(explicit) {
  const given = explicit || process.env.KV_SERVER_CONFIG;
  const files = given ? [given] : ['/etc/kjoreverk-server/config.json', path.join(__dirname, '..', 'config.json')];
  for (const f of files) {
    if (!given && !fs.existsSync(f)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); }
    catch (e) { throw new Error(`The server's settings in ${f} can't be read: ${e.message}`); }
    return { config: merge(DEFAULTS, s), file: f };
  }
  return { config: merge(DEFAULTS, {}), file: null };
}

// innstillingene til pg.Pool: { url } eller host/port/database/user/password
function poolOptions(db) {
  // bøttene i sammendragene (date_trunc) skal følge UTC, uansett hva maskinen står i
  const common = { max: db.max || 10, options: '-c TimeZone=UTC' };
  if (db.url) return Object.assign({ connectionString: db.url }, common);
  const o = Object.assign({ host: db.host, database: db.database, user: db.user }, common);
  if (db.port) o.port = db.port;
  if (db.password) o.password = db.password;
  return o;
}

module.exports = { load, merge, poolOptions, DEFAULTS };

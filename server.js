#!/usr/bin/env node
'use strict';
/*
 * server.js - den sentrale serveren for kjøreverkene: mottaket fra recorderne, historikk til HMI-ene,
 * reglene og web-siden. Planen står i docs/PLAN.md, og grensesnittet mot kjøreverkene i docs/PROTOKOLL.md.
 *
 *   node server.js [--config /etc/kjoreverk-server/config.json]
 *
 * Oppsettet er én JSON-fil (config.example.json viser alt). Alle data ligger i PostgreSQL.
 * Migreringene kjøres ved oppstart, så en ny versjon bare er å bytte filene og starte på nytt.
 */

const { load } = require('./lib/config');
const Db = require('./lib/db');
const makeLogger = require('./lib/log');
const buildApp = require('./lib/app');
const { startJobs } = require('./lib/jobs');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };

async function main() {
  const { config, file } = load(opt('--config'));
  const log = makeLogger(config.log);
  const db = new Db(config.db);
  const applied = await db.init();
  for (const m of applied) log.info(`database: migration ${m} applied`);
  const app = await buildApp({ config, db, log });
  const jobs = startJobs({ config, db, log });
  await app.listen({ port: Number(process.env.PORT) || config.port, host: config.host });
  log.info(`kjoreverk-server ${buildApp.VERSION} on http://${config.host}:${Number(process.env.PORT) || config.port}${file ? `, settings from ${file}` : ' with default settings'}; `
    + `PostgreSQL ${db.timescale ? 'with' : 'without'} TimescaleDB`);

  let stopping = false;
  const stop = async sig => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: stopping`);
    jobs.stop();
    try { await app.close(); await db.close(); } catch (e) { /* på vei ned */ }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});

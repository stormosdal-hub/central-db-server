'use strict';
/*
 * lib/db.js - forbindelsen til PostgreSQL og migreringene.
 *
 * Migreringene er nummererte SQL-filer i db/migrations/. Hver kjøres én gang, i rekkefølge, og
 * noteres i schema_migration, så det samme skjemaet kan bygges på en ny maskin (docs/PLAN.md §5.1).
 *
 * Tider leses som millisekunder siden 1970 (tall), som i protokollen, og bigint/numeric som tall.
 */

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const { poolOptions } = require('./config');

types.setTypeParser(20, Number);      // int8
types.setTypeParser(1700, Number);    // numeric
const tsParser = types.getTypeParser(1184);
types.setTypeParser(1184, v => tsParser(v).getTime());   // timestamptz -> ms

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

class Db {
  constructor(dbConfig) {
    this.pool = new Pool(poolOptions(dbConfig || {}));
    this.pool.on('error', () => {});   // en forbindelse som dør i bakgrunnen: poolen lager en ny
    this.timescale = false;
  }

  query(text, params) { return this.pool.query(text, params); }

  // alt i fn i én transaksjon; kastes det, rulles den tilbake
  async tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (e2) { /* forbindelsen er borte */ }
      throw e;
    } finally {
      c.release();
    }
  }

  // migreringene, og om TimescaleDB er i bruk. Returnerer navnene på dem som ble kjørt nå.
  async init() {
    const applied = await this.migrate();
    const r = await this.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
    this.timescale = r.rowCount > 0;
    return applied;
  }

  async migrate() {
    const files = fs.readdirSync(MIGRATIONS).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    return this.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(7340981)');   // to servere som starter samtidig
      await c.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await c.query('SELECT name FROM schema_migration')).rows.map(r => r.name));
      const applied = [];
      for (const f of files) {
        if (done.has(f)) continue;
        await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        await c.query('INSERT INTO schema_migration (name) VALUES ($1)', [f]);
        applied.push(f);
      }
      return applied;
    });
  }

  async close() { await this.pool.end(); }
}

module.exports = Db;

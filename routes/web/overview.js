'use strict';
// Oversikt (docs/PLAN.md §4.1): alle kjøreverkene, og hvordan serveren har det
const admin = require('../../lib/admin');
const { VERSION } = require('../../lib/app');
const { storage } = require('../../lib/storage');
const { serverClock } = require('../../lib/clock');

module.exports = async function overview(app, { db, config }) {
  app.get('/overview', async () => {
    const vehicles = await admin.vehiclesWithStats(db);
    const dirty = (await db.query('SELECT count(*) AS n FROM rollup_dirty')).rows[0].n;
    const disk = await storage(db, config);
    return { time: Date.now(), version: VERSION, timescale: db.timescale, dbBytes: disk.dbBytes, storage: disk, clock: await serverClock(config),
      rollupPending: Number(dirty), vehicles };
  });

  app.get('/config', async () => ({ history: config.history, ingest: config.ingest, retention: config.retention }));
};

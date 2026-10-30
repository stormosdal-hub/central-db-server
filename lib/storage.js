'use strict';
/*
 * lib/storage.js - hvor mye plass dataene tar, hvor fort det vokser, og hvor lenge disken rekker.
 *
 * Størrelsen noteres i storage_log én gang i timen (siste måling per døgn blir stående), og veksten er
 * forskjellen over de siste opptil 7 døgnene. Med TimescaleDB krymper dataene når de komprimeres etter
 * 7 dager, så de første ukene vokser databasen fortere enn den vil gjøre senere.
 */

const fs = require('fs');

async function recordStorage(db) {
  await db.query(`INSERT INTO storage_log (day, bytes) VALUES (current_date, pg_database_size(current_database()))
    ON CONFLICT (day) DO UPDATE SET bytes = EXCLUDED.bytes, at = now()`);
}

// disken der databasen ligger: config.storagePath, ellers /var/lib/postgresql, ellers /
async function disk(config) {
  for (const p of [config.storagePath, '/var/lib/postgresql', '/'].filter(Boolean)) {
    try {
      const s = await fs.promises.statfs(p);
      return { path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch (e) { /* neste */ }
  }
  return null;
}

async function storage(db, config) {
  const size = (await db.query('SELECT pg_database_size(current_database()) AS b')).rows[0].b;
  const log = (await db.query(`SELECT (extract(epoch FROM at) * 1000)::bigint AS at, bytes FROM storage_log
    WHERE day >= current_date - 7 ORDER BY day`)).rows;
  let growthPerDay = null;
  if (log.length) {
    const first = log[0];
    const days = (Date.now() - first.at) / 86400000;
    if (days >= 0.9) growthPerDay = Math.max(0, (size - first.bytes) / days);
  }
  const points = (await db.query(`SELECT coalesce(sum(n + nnull), 0) AS n, count(DISTINCT date_trunc('day', bucket)) AS days
    FROM sample_1h WHERE bucket >= now() - interval '7 days'`)).rows[0];
  const d = await disk(config);
  return {
    dbBytes: size,
    growthPerDay,                                         // byte per døgn, null før det er et døgns historikk
    pointsPerDay: points.days ? Math.round(points.n / Math.min(7, Math.max(1, points.days))) : 0,
    disk: d,
    daysLeft: d && growthPerDay > 0 ? Math.floor(d.free / growthPerDay) : null,
  };
}

module.exports = { recordStorage, storage, disk };

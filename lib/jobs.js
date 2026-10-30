'use strict';
/*
 * lib/jobs.js - det serveren gjør i bakgrunnen:
 *
 *   - Sammendragene sample_1m og sample_1h (docs/PLAN.md §3.3). Mottaket legger tidsrommet til hver
 *     batch i rollup_dirty; denne jobben regner om de minuttene og timene, likt med og uten TimescaleDB,
 *     og tar derfor også med punkter som kommer i etterkant (ringen i PLS-en, hubens minne).
 *   - Sletting etter alder, etter oppsettet (retention). Med TimescaleDB som en policy i databasen,
 *     ellers ved at serveren sletter selv én gang i døgnet.
 *   - Opprydding: svarene på gamle batcher og gamle klokkeobservasjoner.
 */

const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const MAX_PIECE = DAY;   // et tidsrom regnes om i biter på høyst et døgn

const floorTo = (ms, unit) => Math.floor(ms / unit) * unit;
const ceilTo = (ms, unit) => Math.ceil(ms / unit) * unit;

// slår sammen tidsrom som overlapper eller ligger inntil hverandre
function mergeRanges(list) {
  list.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const SQL_1M = `INSERT INTO sample_1m (bucket, vehicle_id, tag_id, n, nnull, vmin, vmax, vsum, vfirst, vlast)
  SELECT date_trunc('minute', ts), vehicle_id, tag_id, count(value)::int, (count(*) - count(value))::int, min(value), max(value), sum(value),
    (array_agg(value ORDER BY ts))[1], (array_agg(value ORDER BY ts DESC))[1]
  FROM sample WHERE vehicle_id = $1 AND ts >= to_timestamp($2 / 1000.0) AND ts < to_timestamp($3 / 1000.0)
  GROUP BY 1, 2, 3`;
const SQL_1H = `INSERT INTO sample_1h (bucket, vehicle_id, tag_id, n, nnull, vmin, vmax, vsum, vfirst, vlast)
  SELECT date_trunc('hour', bucket), vehicle_id, tag_id, sum(n)::int, sum(nnull)::int, min(vmin), max(vmax), sum(vsum),
    (array_agg(vfirst ORDER BY bucket))[1], (array_agg(vlast ORDER BY bucket DESC))[1]
  FROM sample_1m WHERE vehicle_id = $1 AND bucket >= to_timestamp($2 / 1000.0) AND bucket < to_timestamp($3 / 1000.0)
  GROUP BY 1, 2, 3`;

// én runde: tar det som ligger i rollup_dirty, og regner om. Returnerer { ranges, rows }
async function rollupOnce(db) {
  return db.tx(async c => {
    const dirty = await c.query(`SELECT id, vehicle_id, (extract(epoch FROM from_ts) * 1000)::bigint AS f, (extract(epoch FROM to_ts) * 1000)::bigint AS t
      FROM rollup_dirty ORDER BY id LIMIT 2000 FOR UPDATE SKIP LOCKED`);
    if (!dirty.rowCount) return { ranges: 0, rows: 0 };
    const byVehicle = new Map();
    for (const r of dirty.rows) {
      if (!byVehicle.has(r.vehicle_id)) byVehicle.set(r.vehicle_id, []);
      byVehicle.get(r.vehicle_id).push([floorTo(r.f, MINUTE), ceilTo(r.t, MINUTE)]);
    }
    let ranges = 0, rows = 0;
    for (const [vehicleId, list] of byVehicle) {
      for (const [a, b] of mergeRanges(list)) {
        for (let x = a; x < b; x += MAX_PIECE) {
          const y = Math.min(b, x + MAX_PIECE);
          await c.query('DELETE FROM sample_1m WHERE vehicle_id = $1 AND bucket >= to_timestamp($2 / 1000.0) AND bucket < to_timestamp($3 / 1000.0)', [vehicleId, x, y]);
          rows += (await c.query(SQL_1M, [vehicleId, x, y])).rowCount;
          const X = floorTo(x, HOUR), Y = ceilTo(y, HOUR);
          await c.query('DELETE FROM sample_1h WHERE vehicle_id = $1 AND bucket >= to_timestamp($2 / 1000.0) AND bucket < to_timestamp($3 / 1000.0)', [vehicleId, X, Y]);
          await c.query(SQL_1H, [vehicleId, X, Y]);
          ranges++;
        }
      }
    }
    await c.query('DELETE FROM rollup_dirty WHERE id = ANY($1::bigint[])', [dirty.rows.map(r => r.id)]);
    return { ranges, rows };
  });
}

// sletting etter alder, og opprydding. Kjøres ved oppstart og én gang i døgnet.
async function retention(db, config, log) {
  const R = config.retention || {};
  const tables = [['sample', 'ts', R.rawDays], ['sample_text', 'ts', R.textDays], ['event', 'ts', R.eventDays], ['sample_1m', 'bucket', R.aggDays], ['sample_1h', 'bucket', R.aggDays]];
  if (db.timescale) {
    for (const [table, , days] of tables) {
      await db.query('SELECT remove_retention_policy($1::regclass, if_exists => true)', [table]);
      if (days > 0) await db.query('SELECT add_retention_policy($1::regclass, $2::interval, if_not_exists => true)', [table, `${days} days`]);
    }
  } else {
    for (const [table, col, days] of tables) {
      if (!(days > 0)) continue;
      const r = await db.query(`DELETE FROM ${table} WHERE ${col} < now() - $1::interval`, [`${days} days`]);
      if (r.rowCount && log) log.info(`retention: ${r.rowCount} rows older than ${days} days deleted from ${table}`);
    }
  }
  if (R.batchDays > 0) await db.query('DELETE FROM batch WHERE received_at < now() - $1::interval', [`${R.batchDays} days`]);
  if (R.clockDays > 0) await db.query('DELETE FROM clock_obs WHERE ts < now() - $1::interval', [`${R.clockDays} days`]);
  await db.query('DELETE FROM web_session WHERE expires_at < now()');
}

function startJobs({ db, config, log }) {
  let busy = false;
  const every = Math.max(5, Number(config.rollup && config.rollup.everySeconds) || 20) * 1000;
  const rollup = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await rollupOnce(db);
      if (r.rows) log.debug(`rollup: ${r.ranges} range${r.ranges === 1 ? '' : 's'}, ${r.rows} minute rows`);
    } catch (e) { log.error('rollup:', e); } finally { busy = false; }
  };
  const keep = () => retention(db, config, log).catch(e => log.error('retention:', e));
  const timers = [setInterval(rollup, every), setInterval(keep, DAY), setTimeout(keep, 60000)];
  for (const t of timers) if (t.unref) t.unref();
  return {
    stop() { for (const t of timers) clearInterval(t); },
    rollup,
  };
}

module.exports = { startJobs, rollupOnce, retention, mergeRanges };

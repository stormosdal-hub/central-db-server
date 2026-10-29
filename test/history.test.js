'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, batch, BOOT } = require('./helpers');
const { thin } = require('../lib/history');
const { rollupOnce, mergeRanges } = require('../lib/jobs');

const HOUR = 3600000, MINUTE = 60000;

test('tynning', () => {
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push([i * 10, Math.sin(i / 7) * 100 + (i === 500 ? 1000 : 0)]);
  const out = thin(pts, 0, 10000, 50);
  assert.ok(out.length <= 100 && out.length >= 50, `${out.length}`);
  assert.ok(out.some(p => p[1] > 900), 'toppen beholdes');
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] >= out[i - 1][0], 'i rekkefølge');
  assert.deepEqual(thin(pts.slice(0, 20), 0, 10000, 50), pts.slice(0, 20), 'få nok: uendret');
  const withNull = [[0, 1], [5, null], [6, 2], [7, 3], [8, 0]];
  assert.deepEqual(thin(withNull, 0, 10, 1), [[0, 1], [5, null], [7, 3], [8, 0]]);
  assert.deepEqual(mergeRanges([[10, 20], [30, 40], [15, 25], [40, 50]]), [[10, 25], [30, 50]]);
});

test('historikk', async t => {
  const T = await setup({ history: { maxRows: 5000 } });
  t.after(() => T.close());
  const end = Math.floor(Date.now() / MINUTE) * MINUTE - 5 * MINUTE;   // på et helt minutt, litt tilbake
  const start = end - 3 * HOUR;
  const speed = i => 1000 + 500 * Math.sin(i / 60);      // ett punkt i sekundet i 3 timer

  // 3 timer med data, i tre batcher, pluss en bit som skifter sjelden
  for (let k = 0; k < 3; k++) {
    const b = batch('kv07', k + 1, { 'kv_1.speed': i => speed(i + k * 3600) }, 3600, start + (k + 1) * HOUR - 1000);
    b.series['kv_1.bit03'] = [[start + k * HOUR, k % 2]];
    b.text = { 'kv_1.state': [[start + k * HOUR, 'run' + k]] };
    const r = await T.post('/ingest', b);
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.equal((await T.db.query('SELECT count(*) AS n FROM sample')).rows[0].n, 10803);
  const q = (tags, from, to, points) => T.post('/history', { vehicle: 'kv07', tags, from, to, points });

  await t.test('rådata: første punkt ved from, tynning, ukjente tagger', async () => {
    const from = start + HOUR + 1500, to = start + 2 * HOUR;
    const r = await q(['kv_1.speed', 'kv_1.bit03', 'kv_1.unknown', 'kv_1.state'], from, to, 200);
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    assert.deepEqual(j.unrecorded, ['kv_1.unknown', 'kv_1.state']);
    assert.deepEqual(j.series['kv_1.unknown'], []);
    const s = j.series['kv_1.speed'];
    assert.equal(s[0][0], from, 'første punkt er ved from');
    assert.equal(s[0][1], speed(3600 + 1), 'verdien som gjaldt ved from');
    assert.ok(s.length <= 401 && s.length > 200, `${s.length} punkter`);
    assert.ok(s.every(p => p[0] >= from && p[0] <= to));
    const mx = Math.max(...s.map(p => p[1]));
    assert.ok(mx > 1499, 'toppen beholdes');
    assert.deepEqual(j.series['kv_1.bit03'], [[from, 1], [start + 2 * HOUR, 0]], 'en bit: verdien ved from, og endringen i tidsrommet');
    assert.ok(j.ms >= 0);
  });

  await t.test('få punkter sendes som de er', async () => {
    const r = await q(['kv_1.speed'], end - 30000, end, 1500);
    const s = r.json().series['kv_1.speed'];
    assert.equal(s.length, 30);   // det siste punktet er ved end - 1 s
    assert.equal(s[0][0], end - 30000);
    assert.equal(s[29][0], end - 1000);
  });

  await t.test('kjente hull og tiden mellom økter blir null', async () => {
    // et hull meldt av recorderen midt i den andre timen
    const gapFrom = start + HOUR + 10 * MINUTE, gapTo = start + HOUR + 12 * MINUTE;
    let r = await T.post('/ingest', { vehicle: 'kv07', boot: BOOT, seq: 4, clock: { synced: true }, gaps: [{ from: gapFrom, to: gapTo, tags: ['kv_1.speed'], reason: 'queue-full' }] });
    assert.equal(r.statusCode, 200);
    r = await q(['kv_1.speed', 'kv_1.bit03'], gapFrom - MINUTE, gapTo + MINUTE, 2000);
    const s = r.json().series['kv_1.speed'];
    const nulls = s.filter(p => p[1] === null);
    assert.equal(nulls.length, 1);
    assert.equal(nulls[0][0], gapFrom);
    assert.equal(r.json().series['kv_1.bit03'].filter(p => p[1] === null).length, 0, 'hullet gjaldt bare speed');
    r = await q(['kv_1.speed'], gapFrom + 30000, gapTo - 30000, 100);
    assert.deepEqual(r.json().series['kv_1.speed'][0], [gapFrom + 30000, null], 'from inne i hullet: første punkt er null');

    // en ny økt som begynner lenge etter at den forrige sluttet
    const boot2 = '3f2b9c1e-0000-4000-8000-000000000002';
    const later = end + 30 * MINUTE;
    r = await T.post('/ingest', { vehicle: 'kv07', boot: boot2, seq: 1, clock: { synced: true }, series: { 'kv_1.speed': [[later, 1], [later + 1000, 2]] } });
    assert.equal(r.statusCode, 200);
    r = await q(['kv_1.speed'], end - MINUTE, later + 2000, 500);
    const pts = r.json().series['kv_1.speed'];
    const nl = pts.filter(p => p[1] === null);
    assert.equal(nl.length, 1);
    assert.equal(nl[0][0], end - 1000 + 1, 'null rett etter den forrige øktens siste punkt');
    assert.deepEqual(pts.slice(-2), [[later, 1], [later + 1000, 2]]);
  });

  await t.test('sammendragene og lange tidsrom', async () => {
    const r1 = await rollupOnce(T.db);
    assert.ok(r1.ranges >= 1);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM rollup_dirty')).rows[0].n, 0);
    const m = (await T.db.query(`SELECT count(*) AS n, min(n) AS mn, max(n) AS mx FROM sample_1m m JOIN tag t ON t.id = m.tag_id WHERE t.name = 'kv_1.speed' AND bucket >= to_timestamp($1 / 1000.0) AND bucket < to_timestamp($2 / 1000.0)`, [start, end])).rows[0];
    assert.deepEqual([m.n, m.mn, m.mx], [180, 60, 60]);
    const h = (await T.db.query(`SELECT count(*) AS n, sum(n) AS pts FROM sample_1h h JOIN tag t ON t.id = h.tag_id WHERE t.name = 'kv_1.speed'`)).rows[0];
    assert.ok(h.n >= 4 && h.n <= 5, `${h.n} timer`);   // 3 timer (over 3 eller 4 timebøtter) + den nye økten
    assert.equal(h.pts, 10802);
    const one = (await T.db.query(`SELECT vmin, vmax, vfirst, vlast FROM sample_1m m JOIN tag t ON t.id = m.tag_id WHERE t.name = 'kv_1.speed' AND bucket = to_timestamp($1 / 1000.0)`, [start + HOUR])).rows[0];
    const vals = []; for (let i = 3600; i < 3660; i++) vals.push(speed(i));
    assert.equal(one.vmin, Math.min(...vals));
    assert.equal(one.vmax, Math.max(...vals));
    assert.equal(one.vfirst, vals[0]);
    assert.equal(one.vlast, vals[59]);

    // 3 timer = 10 800 rådata > maxRows 5000: sample_1m brukes, og svaret er likevel riktig i form
    const r = await q(['kv_1.speed'], start, end, 300);
    const s = r.json().series['kv_1.speed'];
    assert.ok(s.length <= 601 && s.length >= 100, `${s.length}`);
    assert.ok(s.every(p => p[0] >= start && p[0] <= end));
    assert.ok(Math.max(...s.filter(p => p[1] !== null).map(p => p[1])) > 1499, 'toppen er med fra sammendraget');
    assert.ok(Math.min(...s.filter(p => p[1] !== null).map(p => p[1])) < 501);
    assert.ok(s.some(p => p[1] === null), 'hullet synes også her');
    // noe som kom i etterkant regnes om
    const late = await T.post('/ingest', { vehicle: 'kv07', boot: BOOT, seq: 5, clock: { synced: true }, series: { 'kv_1.speed': [[start + HOUR + 500, 9999, 0, 2]] } });
    assert.equal(late.statusCode, 200);
    await rollupOnce(T.db);
    const again = (await T.db.query(`SELECT vmax, n FROM sample_1m m JOIN tag t ON t.id = m.tag_id WHERE t.name = 'kv_1.speed' AND bucket = to_timestamp($1 / 1000.0)`, [start + HOUR])).rows[0];
    assert.deepEqual([again.vmax, again.n], [9999, 61]);
  });

  await t.test('grensene', async () => {
    let r = await q(new Array(9).fill('kv_1.speed'), start, end, 100);
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /at most 8 tags/);
    r = await q(['kv_1.speed'], end, start, 100);
    assert.equal(r.statusCode, 400);
    r = await T.post('/history', { vehicle: 'kv08', tags: ['x'], from: 1, to: 2 });
    assert.equal(r.statusCode, 403);
  });
});

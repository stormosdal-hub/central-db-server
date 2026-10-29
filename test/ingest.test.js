'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, hello, batch, BOOT } = require('./helpers');
const admin = require('../lib/admin');

test('mottaket', async t => {
  const T = await setup();
  t.after(() => T.close());
  const now = Date.now() - 10000;

  await t.test('/hello: nøkkel, kjøreverk og protokoll', async () => {
    let r = await T.app.inject({ method: 'POST', url: '/api/v1/hello', payload: hello('kv07') });
    assert.equal(r.statusCode, 401);
    assert.match(r.json().error, /key is missing/);
    r = await T.post('/hello', hello('kv07'), { key: 'x'.repeat(40) });
    assert.equal(r.statusCode, 403);
    r = await T.post('/hello', hello('kv08'));
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /belongs to kv07/);
    r = await T.post('/hello', hello('kv07', { protocol: 2 }));
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /protocol version 1/);
    r = await T.post('/hello', hello('kv07'));
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.lastTs, null);
    assert.equal(typeof j.rulesVersion, 'number');
    assert.equal(j.maxBatchBytes, T.config.ingest.maxBatchBytes);
    assert.ok(Math.abs(j.serverTime - Date.now()) < 5000);
    const v = (await T.db.query('SELECT recorder_version, clock_synced, last_seen FROM vehicle WHERE code = $1', ['kv07'])).rows[0];
    assert.equal(v.recorder_version, '1.0.0');
    assert.equal(v.clock_synced, true);
    assert.ok(v.last_seen > 0);
  });

  await t.test('/ingest: en batch lagres én gang, og samme seq gir samme svar', async () => {
    const body = batch('kv07', 1, { 'kv_1.bit03': i => (i % 2), 'kv_1.speed': i => 100 + i }, 10, now, {
      tags: [{ name: 'kv_1.bit03', dataType: 'boolean', unit: '', label: 'Nødstopp OK', description: '' }, { name: 'kv_1.speed', dataType: 'number', unit: 'rpm', label: 'Hastighet' }],
      text: { 'kv_1.state': [[now - 3000, 'running'], [now, 'stopped']] },
      events: [{ ts: now - 2500, source: 'kv_1', severity: 'alarm', message: 'Feil (ZSW1)' }],
      gaps: [{ from: now - 100000, to: now - 90000, tags: '*', reason: 'queue-full' }],
    });
    body.series['kv_1.speed'][3][1] = null;              // et hull
    body.series['kv_1.speed'][4] = [now - 5000, 7, 2, 1]; // dårlig kvalitet, fra ringen
    let r = await T.post('/ingest', body);
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    assert.deepEqual([j.ok, j.seq, j.stored, j.duplicates], [true, 1, 23, 0]);
    assert.equal(j.lastTs, now);
    assert.equal(typeof j.rulesVersion, 'number');

    const n = async sql => (await T.db.query(sql)).rows[0].n;
    assert.equal(await n('SELECT count(*) AS n FROM sample'), 20);
    assert.equal(await n('SELECT count(*) AS n FROM sample_text'), 2);
    assert.equal(await n('SELECT count(*) AS n FROM event'), 1);
    assert.equal(await n('SELECT count(*) AS n FROM gap'), 1);
    assert.equal(await n('SELECT count(*) AS n FROM sample WHERE value IS NULL'), 1);
    assert.equal(await n('SELECT count(*) AS n FROM sample WHERE q = 2 AND src = 1'), 1);
    assert.equal(await n('SELECT count(*) AS n FROM rollup_dirty'), 1);
    const cat = (await T.db.query('SELECT t.name, vt.data_type, vt.unit, vt.label, vt.last_value, vt.last_text FROM vehicle_tag vt JOIN tag t ON t.id = vt.tag_id ORDER BY t.name')).rows;
    assert.deepEqual(cat.map(c => [c.name, c.data_type, c.unit, c.label]), [['kv_1.bit03', 'boolean', '', 'Nødstopp OK'], ['kv_1.speed', 'number', 'rpm', 'Hastighet'], ['kv_1.state', 'string', '', '']]);
    assert.equal(cat[1].last_value, 109);
    assert.equal(cat[2].last_text, 'stopped');
    const s = (await T.db.query('SELECT batches, points, last_seq, first_ts, last_ts FROM session WHERE boot = $1', [BOOT])).rows[0];
    assert.deepEqual([s.batches, s.points, s.last_seq], [1, 23, 1]);
    assert.equal(s.last_ts, now);
    assert.equal(s.first_ts, now - 9000);   // src 1-punktet (now - 5000) er ikke sanntid, men now - 9000 er

    // samme batch en gang til: samme svar, ingenting lagret på nytt
    r = await T.post('/ingest', body);
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().seq, r.json().stored, r.json().duplicates], [1, 23, 0]);
    assert.equal(await n('SELECT count(*) AS n FROM sample'), 20);
    assert.equal(await n('SELECT count(*) AS n FROM event'), 1);
    assert.equal(await n('SELECT count(*) AS n FROM gap'), 1);
    assert.equal((await T.db.query('SELECT batches FROM session WHERE boot = $1', [BOOT])).rows[0].batches, 1);

    // de samme punktene med et nytt løpenummer: duplikater, og ingen nye rader
    body.seq = 2;
    body.series['kv_1.speed'].push([now + 1000, 55]);
    r = await T.post('/ingest', body);
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().stored, r.json().duplicates], [1, 23]);
    assert.equal(r.json().lastTs, now + 1000);
    assert.equal(await n('SELECT count(*) AS n FROM sample'), 21);

    // /hello sier nå hvor langt serveren har data
    r = await T.post('/hello', hello('kv07'));
    assert.equal(r.json().lastTs, now + 1000);
  });

  await t.test('/ingest: gzip inn, og store svar ut', async () => {
    const r = await T.post('/ingest', batch('kv07', 3, { 'kv_1.speed': i => i }, 500, now - 100000), { gzip: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().stored, 500);
    const h = await T.get('/rules?vehicle=kv07', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(h.statusCode, 200);
    assert.equal(h.headers['content-encoding'], undefined);   // for lite til å pakkes
  });

  await t.test('/ingest: feil i batchen gir 400 med en forklaring', async () => {
    const cases = [
      [{ series: { 'kv_1.x': [[1, 2, 3]] } }, /before 2001/],
      [{ series: { 'kv_1.x': [[now + 2 * 86400000, 2]] } }, /more than a day ahead/],
      [{ series: { 'kv_1.x': [[now, 'tekst']] } }, /number or null/],
      [{ series: { 'kv_1.x': [[now, 1, 9]] } }, /q is 0, 1, 2 or 3/],
      [{ series: { 'kv_1.x': [[now.toString(), 1]] } }, /whole number of milliseconds/],
      [{ series: { 'kv_1.x': [now, 1] } }, /a point is/],
      [{ text: { 'kv_1.x': [[now, 5]] } }, /text or null/],
      [{ events: [{ ts: now }] }, /message is missing/],
      [{ gaps: [{ from: now, to: now - 1 }] }, /"to" is before "from"/],
      [{ seq: 0 }, /invalid request/],
      [{ boot: undefined }, /invalid request/],
    ];
    for (const [extra, re] of cases) {
      const b = Object.assign({ vehicle: 'kv07', boot: BOOT, seq: 9, clock: { synced: true } }, extra);
      const r = await T.post('/ingest', b);
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.match(r.json().error, re, JSON.stringify(extra));
    }
    const r = await T.app.inject({ method: 'POST', url: '/api/v1/ingest', headers: { authorization: `Bearer ${T.key}`, 'content-type': 'application/json' }, payload: '{not json' });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /not valid JSON/);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM batch WHERE seq = 9')).rows[0].n, 0);
  });

  await t.test('/ingest: klokka ikke synkronisert merkes på hvert punkt', async () => {
    const b = batch('kv07', 4, { 'kv_1.speed': i => i }, 3, now - 900000);   // et tidsrom ingen batch har dekket
    b.clock = { synced: false, piTime: Date.now() + 90000 };
    const r = await T.post('/ingest', b);
    assert.equal(r.statusCode, 200);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM sample WHERE unsynced')).rows[0].n, 3);
    const o = (await T.db.query('SELECT offset_ms, synced FROM clock_obs ORDER BY ts DESC LIMIT 1')).rows[0];
    assert.equal(o.synced, false);
    assert.ok(o.offset_ms > 80000 && o.offset_ms < 100000);
  });

  await t.test('nøkkelen trukket tilbake, kjøreverket slått av', async () => {
    await admin.setActive(T.db, 'kv07', false, 'test');
    let r = await T.post('/hello', hello('kv07'));
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /disabled/);
    await admin.setActive(T.db, 'kv07', true, 'test');
    await admin.revokeKey(T.db, 'kv07', 'test');
    r = await T.post('/hello', hello('kv07'));
    assert.equal(r.statusCode, 403);
    const { key } = await admin.makeKey(T.db, 'kv07', 'test');
    r = await T.post('/hello', hello('kv07'), { key });
    assert.equal(r.statusCode, 200);
    T.key = key;
    const log = (await T.db.query('SELECT action FROM audit_log ORDER BY id')).rows.map(x => x.action);
    assert.deepEqual(log.slice(-4), ['vehicle.disable', 'vehicle.enable', 'vehicle.revoke', 'vehicle.key']);
  });
});

test('mottaket: for stor batch og mottrykk', async t => {
  const T = await setup({ ingest: { maxBatchBytes: 20000, maxConcurrent: 0 } });
  t.after(() => T.close());
  const now = Date.now() - 10000;
  let r = await T.post('/ingest', batch('kv07', 1, { 'kv_1.speed': i => i }, 5, now));
  assert.equal(r.statusCode, 503);
  assert.ok(r.json().retryAfter >= 2 && r.json().retryAfter <= 10);
  assert.equal(r.headers['retry-after'], String(r.json().retryAfter));
  T.config.ingest.maxConcurrent = 4;
  r = await T.post('/ingest', batch('kv07', 1, { 'kv_1.speed': i => i }, 2000, now), { gzip: true });   // pakket er den liten, utpakket for stor
  assert.equal(r.statusCode, 413);
  assert.match(r.json().error, /larger than 20000 bytes/);
  r = await T.post('/ingest', batch('kv07', 1, { 'kv_1.speed': i => i }, 5, now));
  assert.equal(r.statusCode, 200);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, addVehicle, hello, batch } = require('./helpers');
const rules = require('../lib/rules');

test('reglene', async t => {
  const T = await setup();
  t.after(() => T.close());
  const kv08 = await addVehicle(T.db, 'kv08');

  await t.test('GET /rules: standardsettet, ETag og 304', async () => {
    let r = await T.get('/rules?vehicle=kv07');
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.version, 1);
    assert.deepEqual(j.recording, { events: true, eventsMin: 'info', rules: [{ tags: '*', mode: 'change' }], pauses: [] });
    assert.equal(r.headers.etag, '"1"');
    r = await T.get('/rules?vehicle=kv07', { headers: { 'if-none-match': '"1"' } });
    assert.equal(r.statusCode, 304);
    r = await T.get('/rules?vehicle=kv07', { headers: { 'if-none-match': '"0"' } });
    assert.equal(r.statusCode, 200);
    r = await T.get('/rules?vehicle=kv08');
    assert.equal(r.statusCode, 403);
    r = await T.get('/rules');
    assert.equal(r.statusCode, 400);
  });

  await t.test('et nytt regelsett gir ny versjon til alle som bruker det', async () => {
    const set = { events: true, eventsMin: 'warning', rules: [{ tags: 'kv_1.spare*', mode: 'ignore' }, { tags: 'kv_1.reals_*', deadband: '1%', minInterval: 1, maxInterval: 60 }, { tags: '*' }] };
    const s = await rules.setRuleSet(T.db, 'default', set, 'test', 'første');
    assert.equal(s.version, 2);
    for (const [code, key] of [['kv07', T.key], ['kv08', kv08.key]]) {
      const r = await T.get(`/rules?vehicle=${code}`, { key });
      assert.equal(r.json().version, 2);
      assert.equal(r.json().recording.eventsMin, 'warning');
      assert.equal(r.json().recording.rules.length, 3);
      assert.equal(r.json().recording.rules[1].deadband, '1%');
    }
    const h = await T.post('/hello', hello('kv07'));
    assert.equal(h.json().rulesVersion, 2);
    const b = await T.post('/ingest', batch('kv07', 1, { 'kv_1.reals_0': i => i }, 3));
    assert.equal(b.json().rulesVersion, 2);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM rule_history')).rows[0].n, 1);
  });

  await t.test('et regelsett med feil lagres ikke', async () => {
    await assert.rejects(rules.setRuleSet(T.db, 'default', { rules: [{ mode: 'change' }, { tags: 'x', deadband: 'mye' }] }, 'test'), e => {
      assert.equal(e.statusCode, 400);
      assert.match(e.message, /Rule 1: name at least one tag/);
      assert.match(e.message, /Rule 2: the smallest change/);
      return true;
    });
    await assert.rejects(rules.setRuleSet(T.db, 'bad name!', { rules: [] }, 'test'), /name is letters/);
    assert.equal((await T.db.query('SELECT version FROM rule_set WHERE id = 1')).rows[0].version, 2);
  });

  await t.test('tillegget for ett kjøreverk går foran, og bare det kjøreverket får ny versjon', async () => {
    const r = await rules.setVehicleExtra(T.db, 'kv07', { rules: [{ tags: 'kv_1.bit1*', flickerChanges: 6, flickerSeconds: 2 }] }, 'test');
    assert.equal(r.version, 3);
    let a = await T.get('/rules?vehicle=kv07');
    assert.equal(a.json().version, 3);
    assert.equal(a.json().recording.rules.length, 4);
    assert.equal(a.json().recording.rules[0].tags, 'kv_1.bit1*');
    assert.equal(a.json().recording.rules[0].flickerChanges, 6);
    assert.equal(a.json().recording.eventsMin, 'warning');   // fra settet
    a = await T.get('/rules?vehicle=kv08', { key: kv08.key });
    assert.equal(a.json().version, 2);
    // et annet regelsett til kv08
    await rules.setRuleSet(T.db, 'quiet', { rules: [{ tags: 'kv_1.bit*' }] }, 'test');
    await rules.setVehicleRuleSet(T.db, 'kv08', 'quiet', 'test');
    a = await T.get('/rules?vehicle=kv08', { key: kv08.key });
    assert.equal(a.json().recording.rules.length, 1);
    assert.ok(a.json().version > 3);
    await assert.rejects(rules.deleteRuleSet(T.db, 'quiet', 'test'), /used by kv08/);
    await rules.setVehicleExtra(T.db, 'kv07', null, 'test');
    a = await T.get('/rules?vehicle=kv07');
    assert.equal(a.json().recording.rules.length, 3);
  });

  await t.test('pauser: legges til og avsluttes', async () => {
    const p = await rules.addPause(T.db, { vehicle: 'kv07' }, { tags: '*', reason: 'maintenance' }, 'test');
    assert.equal(p.pause.tags, '*');
    assert.equal(p.pause.until, null);
    let a = await T.get('/rules?vehicle=kv07');
    assert.equal(a.json().recording.pauses.length, 1);
    assert.equal(a.json().recording.pauses[0].reason, 'maintenance');
    assert.equal((await T.get('/rules?vehicle=kv08', { key: kv08.key })).json().recording.pauses.length, 0);
    const q = await rules.addPause(T.db, { set: 'default' }, { tags: 'kv_1.reals_*', untilMs: Date.now() + 3600000 }, 'test');
    assert.equal((await T.get('/rules?vehicle=kv07')).json().recording.pauses.length, 2);
    await assert.rejects(rules.addPause(T.db, { set: 'default' }, { untilMs: Date.now() - 1 }, 'test'), /ends before it begins/);
    const r = await rules.resumePause(T.db, { vehicle: 'kv07' }, p.pause.id, 'test');
    assert.equal(r.resumed, 1);
    a = await T.get('/rules?vehicle=kv07');
    const mine = a.json().recording.pauses.find(x => x.id === p.pause.id);
    assert.ok(mine.until <= Date.now());
    await assert.rejects(rules.resumePause(T.db, { vehicle: 'kv07' }, 'all', 'test'), /no pause is active/);
    const all = await rules.resumePause(T.db, { set: 'default' }, 'all', 'test');
    assert.equal(all.resumed, 1);
    assert.ok(q.pause.id);
  });
});

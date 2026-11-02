'use strict';
/*
 * Kjøreverk-database: visningene (lagre, konflikt når to lagrer, slette, innlogging) og dataene widgetene henter
 * utover /series og /events: katalogen til ett kjøreverk, siste verdier og tekstverdiene i et tidsrom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, browser, BOOT } = require('./helpers');
const admin = require('../lib/admin');

const MIN = 60000;

test('Kjøreverk-database: visningene og dataene', async t => {
  const T = await setup({ web: { enabled: true } });
  t.after(() => T.close());
  await admin.addUser(T.db, { name: 'ola', password: 'ola sitt passord', role: 'view', who: 'test' });
  await admin.addUser(T.db, { name: 'kari', password: 'kari sitt passord', role: 'admin', who: 'test' });
  const anon = browser(T), ola = browser(T), kari = browser(T);
  await ola.login('ola', 'ola sitt passord');
  await kari.login('kari', 'kari sitt passord');

  const config = { canvas: { width: 1600, height: 900 }, fit: 'width', span: 3600000,
    widgets: [{ id: 'w1', type: 'timeline', x: 0, y: 0, w: 600, h: 300, props: { title: 'Bitene' }, data: [{ vehicle: 'kv07', tags: [{ tag: 'pls.bit*', color: '' }] }] }] };
  let id;

  await t.test('lage: krever innlogging, hvilken som helst rolle', async () => {
    let r = await anon.post('/dashboards', { name: 'Oversikt', config });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().login, true);
    r = await ola.post('/dashboards', { name: '  Oversikt ', config });
    assert.equal(r.statusCode, 201, r.body);
    id = r.json().id;
    assert.equal(r.json().name, 'Oversikt');
    assert.equal(r.json().version, 1);
    assert.equal(r.json().created_by, 'web:ola');
    r = await kari.post('/dashboards', { name: 'oversikt', config: {} });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error, /there is a view named oversikt already/);
    r = await ola.post('/dashboards', { name: '   ' });
    assert.equal(r.statusCode, 400);
  });

  await t.test('lese: uten innlogging, som resten av web-siden', async () => {
    let r = await anon.get('/dashboards');
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().dashboards.map(d => [d.name, d.widgets]), [['Oversikt', 1]]);
    r = await anon.get(`/dashboards/${id}`);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().config, config);
    assert.equal((await anon.get('/dashboards/999')).statusCode, 404);
    assert.equal((await anon.get('/dashboards/abc')).statusCode, 400);
  });

  await t.test('lagre, og to som lagrer samme versjon', async () => {
    const next = Object.assign({}, config, { span: 86400000 });
    let r = await ola.put(`/dashboards/${id}`, { name: 'Oversikt', config: next, version: 1 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().version, 2);
    // kari åpnet versjon 1 og lagrer: 409 med hvem som lagret, så web-siden kan spørre
    r = await kari.put(`/dashboards/${id}`, { name: 'Oversikt', config, version: 1 });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().conflict, true);
    assert.equal(r.json().current.version, 2);
    assert.equal(r.json().current.updated_by, 'web:ola');
    // hun velger å lagre over
    r = await kari.put(`/dashboards/${id}`, { name: 'Bitene', config, version: 2 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().version, 3);
    assert.equal(r.json().name, 'Bitene');
    assert.equal((await anon.put(`/dashboards/${id}`, { name: 'x', config, version: 3 })).statusCode, 401);
    assert.equal((await kari.put('/dashboards/999', { name: 'x', config, version: 1 })).statusCode, 404);
    const big = { widgets: [{ props: { text: 'x'.repeat(1000001) } }] };
    r = await kari.put(`/dashboards/${id}`, { name: 'Bitene', config: big, version: 3 });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /larger than/);
  });

  await t.test('slette, og alt står i audit_log', async () => {
    const r2 = await ola.post('/dashboards', { name: 'Kladd', config: {} });
    assert.equal((await anon.del(`/dashboards/${r2.json().id}`)).statusCode, 401);
    assert.equal((await ola.del(`/dashboards/${r2.json().id}`)).statusCode, 200);
    assert.equal((await ola.del(`/dashboards/${r2.json().id}`)).statusCode, 404);
    const log = (await T.db.query("SELECT who, action, target FROM audit_log WHERE action LIKE 'dashboard.%' ORDER BY id")).rows;
    assert.deepEqual(log.map(l => `${l.who} ${l.action} ${l.target}`), [
      'web:ola dashboard.create Oversikt', 'web:ola dashboard.save Oversikt', 'web:kari dashboard.save Bitene',
      'web:ola dashboard.create Kladd', 'web:ola dashboard.delete Kladd']);
  });

  // ---- dataene
  const end = Math.floor(Date.now() / MIN) * MIN - 5 * MIN;
  const at = m => end - 60 * MIN + m * MIN;
  const tags = [
    { name: 'pls.bit00', dataType: 'boolean', label: 'Motor går' },
    { name: 'pls.reals_0', dataType: 'number', unit: 'rpm', label: 'Hastighet' },
    { name: 'pls.state', dataType: 'string', label: 'Tilstand' },
  ];
  const r0 = await T.post('/ingest', { vehicle: 'kv07', boot: BOOT, seq: 1, clock: { synced: true }, tags,
    series: { 'pls.bit00': [[at(0), 0], [at(10), 1], [at(20), 0]], 'pls.reals_0': [[at(0), 100], [at(30), 250.5]] },
    text: { 'pls.state': [[at(0), 'idle'], [at(10), 'running'], [at(40), 'stopped']] } });
  assert.equal(r0.statusCode, 200, r0.body);

  await t.test('katalogen til ett kjøreverk, med siste verdi', async () => {
    const r = await anon.get('/catalog?vehicle=kv07');
    assert.equal(r.statusCode, 200);
    const byTag = new Map(r.json().tags.map(x => [x.tag, x]));
    assert.deepEqual([...byTag.keys()].sort(), ['pls.bit00', 'pls.reals_0', 'pls.state']);
    assert.equal(byTag.get('pls.reals_0').unit, 'rpm');
    assert.equal(byTag.get('pls.reals_0').value, 250.5);
    assert.equal(byTag.get('pls.state').text, 'stopped');
    assert.equal(byTag.get('pls.bit00').dataType, 'boolean');
    assert.equal((await anon.get('/catalog?vehicle=kv99')).statusCode, 404);
  });

  await t.test('siste verdier for en liste', async () => {
    const r = await anon.post('/latest', { items: [{ vehicle: 'kv07', tag: 'pls.reals_0' }, { vehicle: 'kv07', tag: 'pls.state' }, { vehicle: 'kv07', tag: 'finnes.ikke' }, { vehicle: 'kv99', tag: 'pls.bit00' }] });
    assert.equal(r.statusCode, 200, r.body);
    const v = r.json().values;
    assert.equal(v.length, 2);
    assert.deepEqual(v.find(x => x.tag === 'pls.reals_0'), { vehicle: 'kv07', tag: 'pls.reals_0', dataType: 'number', unit: 'rpm', label: 'Hastighet', ts: at(30), value: 250.5, text: null });
    assert.equal(v.find(x => x.tag === 'pls.state').text, 'stopped');
  });

  await t.test('tekstverdiene i et tidsrom, med verdien ved from først', async () => {
    let r = await anon.post('/text', { series: [{ vehicle: 'kv07', tag: 'pls.state' }, { vehicle: 'kv07', tag: 'finnes.ikke' }], from: at(5), to: at(50) });
    assert.equal(r.statusCode, 200, r.body);
    const [state, none] = r.json().series;
    assert.deepEqual(state.points, [[at(5), 'idle'], [at(10), 'running'], [at(40), 'stopped']]);
    assert.equal(state.truncated, false);
    assert.equal(none.missing, true);
    r = await anon.post('/text', { series: [{ vehicle: 'kv99', tag: 'pls.state' }], from: at(5), to: at(50) });
    assert.equal(r.statusCode, 404);
    r = await anon.post('/text', { series: [{ vehicle: 'kv07', tag: 'pls.state' }], from: at(50), to: at(5) });
    assert.equal(r.statusCode, 400);
  });

});

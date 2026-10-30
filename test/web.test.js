'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, batch, hello } = require('./helpers');
const admin = require('../lib/admin');

// en nettleser: husker cookien, sender JSON og Origin som web-siden gjør
function browser(T) {
  let cookie = null;
  const req = async (method, url, body, extra) => {
    const headers = Object.assign({ host: 'dbserver:8090', origin: 'http://dbserver:8090' }, extra || {});
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await T.app.inject({ method, url: `/api/web${url}`, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers['set-cookie'];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    return r;
  };
  return {
    get: url => req('GET', url),
    post: (url, body, extra) => req('POST', url, body === undefined ? {} : body, extra),
    patch: (url, body) => req('PATCH', url, body),
    del: url => req('DELETE', url),
    login: (name, password) => req('POST', '/login', { name, password }),
    get cookie() { return cookie; },
  };
}

test('web: innlogging og Kjøreverk-siden', async t => {
  const T = await setup({ web: { enabled: true } });
  t.after(() => T.close());
  const anon = browser(T);

  await t.test('uten brukere: se går, endre krever innlogging', async () => {
    let r = await anon.get('/me');
    assert.deepEqual(r.json(), { user: null, hasUsers: false, loginToView: false });
    r = await anon.get('/vehicles');
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().vehicles.map(v => v.code), ['kv07']);
    assert.deepEqual(r.json().ruleSets, ['default']);
    r = await anon.post('/vehicles', { code: 'kv08' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().login, true);
  });

  await admin.addUser(T.db, { name: 'storm', password: 'hemmelig passord', role: 'admin', who: 'test' });
  await admin.addUser(T.db, { name: 'ola', password: 'ola sitt passord', role: 'view', who: 'test' });
  await admin.addUser(T.db, { name: 'kari', password: 'kari sitt passord', role: 'rules', who: 'test' });
  const storm = browser(T), ola = browser(T), kari = browser(T);

  await t.test('innlogging, feil passord og utlogging', async () => {
    let r = await storm.login('storm', 'feil');
    assert.equal(r.statusCode, 401);
    assert.equal(storm.cookie, null);
    r = await storm.login('storm', 'hemmelig passord');
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().user, { id: r.json().user.id, name: 'storm', role: 'admin' });
    assert.match(String(r.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    r = await storm.get('/me');
    assert.equal(r.json().user.name, 'storm');
    assert.equal(r.json().hasUsers, true);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM web_session')).rows[0].n, 1);
    // tokenet lagres bare som hash
    const token = decodeURIComponent(storm.cookie.split('=')[1]);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM web_session WHERE token_hash::text LIKE $1', [`%${token}%`])).rows[0].n, 0);
    await ola.login('ola', 'ola sitt passord');
    await kari.login('kari', 'kari sitt passord');
  });

  let key;
  await t.test('legge til et kjøreverk med nøkkel, som så kan sende', async () => {
    let r = await ola.post('/vehicles', { code: 'kv52' });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /needs the role admin; ola has the role view/);
    r = await storm.post('/vehicles', { code: 'kv 52' });
    assert.equal(r.statusCode, 400);
    r = await storm.post('/vehicles', { code: 'kv52', name: 'Kjøreverk 52', silentAfter: 600, notes: 'Hall B', makeKey: true });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().code, 'kv52');
    key = r.json().key;
    assert.equal(key.length, 40);
    assert.equal(r.json().prefix, key.slice(0, 6));
    r = await storm.post('/vehicles', { code: 'kv52' });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /exists already/);
    r = await storm.post('/vehicles', { code: 'kv53', bogus: 1 });
    assert.equal(r.statusCode, 400);
    // recorderen med den nye nøkkelen
    r = await T.post('/hello', hello('kv52'), { key });
    assert.equal(r.statusCode, 200);
    const v = (await storm.get('/vehicles/kv52')).json();
    assert.equal(v.name, 'Kjøreverk 52');
    assert.equal(v.silent_after_s, 600);
    assert.equal(v.notes, 'Hall B');
    assert.equal(v.key_prefix, key.slice(0, 6));
    assert.equal(v.last_ip, '127.0.0.1');
    assert.equal(v.recorder_version, '1.0.0');
    assert.equal(v.has_data, false);
    assert.equal(v.key_hash, undefined);
  });

  await t.test('redigere: admin alt, rules bare regelsettet', async () => {
    await T.db.query("INSERT INTO rule_set (name, recording) VALUES ('stille', '{\"rules\":[]}')");
    let r = await kari.patch('/vehicles/kv52', { name: 'Nytt navn' });
    assert.equal(r.statusCode, 403);
    r = await kari.patch('/vehicles/kv52', { ruleSet: 'stille' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().rule_set, 'stille');
    r = await ola.patch('/vehicles/kv52', { ruleSet: 'default' });
    assert.equal(r.statusCode, 403);
    r = await storm.patch('/vehicles/kv52', { name: 'Kjøreverk 52 B', notes: '', silentAfter: 3600, active: false });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual([r.json().name, r.json().notes, r.json().silent_after_s, r.json().active], ['Kjøreverk 52 B', '', 3600, false]);
    assert.equal((await T.post('/hello', hello('kv52'), { key })).statusCode, 403, 'slått av: recorderen får 403');
    r = await storm.patch('/vehicles/kv52', { active: true });
    assert.equal(r.json().active, true);
    r = await storm.patch('/vehicles/kv52', { silentAfter: 5 });
    assert.equal(r.statusCode, 400);
    r = await storm.patch('/vehicles/kv52', {});
    assert.equal(r.statusCode, 400);
    r = await storm.patch('/vehicles/kv99', { name: 'x' });
    assert.equal(r.statusCode, 404);
    r = await storm.patch('/vehicles/kv52', { ruleSet: 'finnes-ikke' });
    assert.equal(r.statusCode, 404);
  });

  await t.test('nøkkelen: ny og trukket tilbake', async () => {
    let r = await ola.post('/vehicles/kv52/key');
    assert.equal(r.statusCode, 403);
    r = await storm.post('/vehicles/kv52/key');
    assert.equal(r.statusCode, 200);
    const key2 = r.json().key;
    assert.notEqual(key2, key);
    assert.equal((await T.post('/hello', hello('kv52'), { key })).statusCode, 403, 'den gamle virker ikke');
    assert.equal((await T.post('/hello', hello('kv52'), { key: key2 })).statusCode, 200);
    r = await storm.del('/vehicles/kv52/key');
    assert.equal(r.statusCode, 200);
    assert.equal((await T.post('/hello', hello('kv52'), { key: key2 })).statusCode, 403);
    assert.equal((await storm.get('/vehicles/kv52')).json().key_prefix, null);
  });

  await t.test('slette: bare uten data', async () => {
    let r = await storm.del('/vehicles/kv07');   // kv07 har ikke sendt noe i denne testen
    assert.equal(r.statusCode, 200, r.body);
    const b = await T.post('/ingest', batch('kv07', 1, { 'kv_1.x': i => i }, 3));
    assert.equal(b.statusCode, 403, 'slettet: nøkkelen virker ikke lenger');
    await storm.post('/vehicles', { code: 'kv60', makeKey: true });
    const k60 = (await storm.post('/vehicles/kv60/key')).json().key;
    assert.equal((await T.post('/ingest', Object.assign(batch('kv60', 1, { 'kv_1.x': i => i }, 3), { vehicle: 'kv60' }), { key: k60 })).statusCode, 200);
    assert.equal((await storm.get('/vehicles/kv60')).json().has_data, true);
    r = await storm.del('/vehicles/kv60');
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /has stored data.*disable it instead/);
    r = await ola.del('/vehicles/kv52');
    assert.equal(r.statusCode, 403);
    r = await storm.del('/vehicles/kv52');   // har sagt hello (økter), men aldri lagret data
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await storm.get('/vehicles/kv52')).statusCode, 404);
  });

  await t.test('vern: Origin, JSON, utlogging, audit', async () => {
    let r = await storm.post('/vehicles', { code: 'kv70' }, { origin: 'http://evil.example' });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /own web page/);
    r = await T.app.inject({ method: 'POST', url: '/api/web/vehicles', headers: { host: 'dbserver:8090', cookie: storm.cookie, 'content-type': 'text/plain' }, payload: '{"code":"kv70"}' });
    assert.equal(r.statusCode, 415);
    assert.equal((await storm.get('/vehicles/kv70')).statusCode, 404);
    const actions = (await T.db.query("SELECT who, action, target FROM audit_log WHERE who LIKE 'web:%' ORDER BY id")).rows;
    assert.ok(actions.some(a => a.who === 'web:storm' && a.action === 'vehicle.add' && a.target === 'kv52'));
    assert.ok(actions.some(a => a.who === 'web:kari' && a.action === 'vehicle.ruleset'));
    assert.ok(actions.some(a => a.who === 'web:storm' && a.action === 'vehicle.delete' && a.target === 'kv52'));
    assert.ok(actions.some(a => a.action === 'user.login' && a.target === 'ola'));
    r = await storm.post('/logout');
    assert.equal(r.statusCode, 200);
    r = await storm.get('/me');
    assert.equal(r.json().user, null);
    r = await storm.post('/vehicles', { code: 'kv71' });
    assert.equal(r.statusCode, 401);
  });

  await t.test('for mange feilede innlogginger', async () => {
    const x = browser(T);
    for (let i = 0; i < 5; i++) assert.equal((await x.login('storm', 'feil' + i)).statusCode, 401);
    const r = await x.login('storm', 'hemmelig passord');
    assert.equal(r.statusCode, 429);
    assert.ok(r.json().retryAfter > 0);
  });
});

test('web: loginToView krever innlogging for å se', async t => {
  const T = await setup({ web: { enabled: true, loginToView: true } });
  t.after(() => T.close());
  const b = browser(T);
  let r = await b.get('/overview');
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().login, true);
  r = await b.get('/me');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().loginToView, true);
  await admin.addUser(T.db, { name: 'ola', password: 'ola sitt passord', role: 'view', who: 'test' });
  await b.login('ola', 'ola sitt passord');
  r = await b.get('/overview');
  assert.equal(r.statusCode, 200);
  // web-siden selv lastes uten innlogging; det er dataene som krever den
  r = await T.app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
});

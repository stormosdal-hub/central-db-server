'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { overSocket, dbUser, explain } = require('../lib/run-as');

test('kommandolinjen kobler til som tjenesten', () => {
  // unix-socket (peer-innlogging) eller TCP
  assert.equal(overSocket({ host: '/var/run/postgresql', user: 'kjoreverk' }), true);
  assert.equal(overSocket({ user: 'kjoreverk' }), true);
  assert.equal(overSocket({ host: 'localhost' }), false);
  assert.equal(overSocket({ host: '10.0.0.5' }), false);
  assert.equal(overSocket({ url: 'postgres://kjoreverk:pw@localhost:5432/kjoreverk' }), false);
  assert.equal(overSocket({ url: 'postgres://kjoreverk@/kjoreverk?host=/var/run/postgresql' }), true);
  assert.equal(dbUser({ user: 'kjoreverk' }), 'kjoreverk');
  assert.equal(dbUser({ url: 'postgres://ola%40x:pw@localhost/db' }), 'ola@x');

  // feilmeldingene sier hva som skal til
  const e1 = explain(new Error("The server's settings in /etc/kjoreverk-server/config.json can't be read: EACCES: permission denied, open '/etc/kjoreverk-server/config.json'"));
  assert.match(e1, /EACCES/);
  assert.match(e1, /sudo kv-admin/);
  const e2 = explain(new Error('Peer authentication failed for user "kjoreverk"'));
  assert.match(e2, /Peer authentication failed/);
  assert.ok(e2.split('\n').length === 2, 'en forklaring på linjen under');
  assert.equal(explain(new Error('no vehicle named kv99')), 'no vehicle named kv99');
});

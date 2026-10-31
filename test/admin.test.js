'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const path = require('path');
const { setup } = require('./helpers');
const admin = require('../lib/admin');
const { retention } = require('../lib/jobs');

const CLI = path.join(__dirname, '..', 'bin', 'kv-admin.js');
const URL = process.env.KV_TEST_DB || 'postgres://kjoreverk:kjoreverk@localhost:5432/kjoreverk_test';

function cli(...args) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, { KV_SERVER_CONFIG: path.join(__dirname, 'cli-config.json') });
    execFile(process.execPath, [CLI, ...args], { env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}

test('kjøreverk, brukere og kommandolinjen', async t => {
  const T = await setup();
  t.after(() => T.close());
  require('fs').writeFileSync(path.join(__dirname, 'cli-config.json'), JSON.stringify({ db: { url: URL }, log: 'warn' }));
  t.after(() => require('fs').unlinkSync(path.join(__dirname, 'cli-config.json')));

  await t.test('kjøreverk', async () => {
    await assert.rejects(admin.addVehicle(T.db, { code: 'kv07', who: 'test' }), /exists already/);
    await assert.rejects(admin.addVehicle(T.db, { code: 'kv 7', who: 'test' }), /letters, digits/);
    // som navnet på Pi-en (hmi-core/lib/vehicle.js): en bokstav eller _ først
    for (const code of ['52', '7kv', '-kv', '.kv', 'k'.repeat(33)]) {
      await assert.rejects(admin.addVehicle(T.db, { code, who: 'test' }), /a letter or _ first/, code);
    }
    await assert.rejects(admin.renameVehicle(T.db, 'kv07', '52', 'test'), /a letter or _ first/);
    assert.equal((await admin.getVehicle(T.db, 'kv07')).code, 'kv07');
    await admin.addVehicle(T.db, { code: '_52', who: 'test' });
    await admin.deleteVehicle(T.db, '_52', 'test');
    await admin.addVehicle(T.db, { code: 'kv08', name: 'Kjøreverk 8', silentAfter: 600, who: 'test' });
    const v = await admin.getVehicle(T.db, 'kv08');
    assert.equal(v.name, 'Kjøreverk 8');
    assert.equal(v.silent_after_s, 600);
    assert.equal(v.key_prefix, null);
    assert.equal(v.rule_set, 'default');
    await admin.updateVehicle(T.db, 'kv08', { name: 'Åtte', notes: 'test' }, 'test');
    assert.equal((await admin.getVehicle(T.db, 'kv08')).name, 'Åtte');
    assert.equal((await admin.listVehicles(T.db)).length, 2);
  });

  await t.test('koden i databasen, og migreringen 005', async () => {
    await assert.rejects(T.db.query("UPDATE vehicle SET code = '52' WHERE code = 'kv08'"), /vehicle_code_check/);
    // en kode fra før som Pi-en ikke godtar: migreringen advarer og lar den gamle sjekken stå, i stedet for å feile
    // (da ville verken serveren eller kv-admin startet)
    const sql = require('fs').readFileSync(path.join(__dirname, '..', 'db', 'migrations', '005_vehicle_code.sql'), 'utf8');
    const rollback = new Error('rollback');
    await assert.rejects(T.db.tx(async c => {
      await c.query('ALTER TABLE vehicle DROP CONSTRAINT vehicle_code_check');
      await c.query("ALTER TABLE vehicle ADD CONSTRAINT vehicle_code_check CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$')");
      await c.query("UPDATE vehicle SET code = '08' WHERE code = 'kv08'");
      await c.query(sql);
      const def = (await c.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'vehicle_code_check'")).rows[0].d;
      assert.match(def, /\[A-Za-z0-9\]\[/);
      await c.query("UPDATE vehicle SET last_seen = now() WHERE code = '08'");
      throw rollback;
    }), e => e === rollback);
    assert.equal((await admin.getVehicle(T.db, 'kv08')).code, 'kv08');
  });

  await t.test('brukere', async () => {
    await assert.rejects(admin.addUser(T.db, { name: 'ola', password: 'kort', role: 'view', who: 'test' }), /at least 8/);
    await assert.rejects(admin.addUser(T.db, { name: 'ola', password: 'langt nok', role: 'boss', who: 'test' }), /role is one of/);
    const u = await admin.addUser(T.db, { name: 'ola', password: 'langt nok', role: 'rules', who: 'test' });
    assert.equal(u.created, true);
    assert.deepEqual(await admin.verifyUser(T.db, 'ola', 'langt nok'), { id: u.id, name: 'ola', role: 'rules' });
    assert.equal(await admin.verifyUser(T.db, 'ola', 'feil'), null);
    assert.equal(await admin.verifyUser(T.db, 'kari', 'langt nok'), null);
    const again = await admin.addUser(T.db, { name: 'ola', password: 'nytt passord', role: 'admin', who: 'test' });
    assert.equal(again.created, false);
    assert.equal((await admin.verifyUser(T.db, 'ola', 'nytt passord')).role, 'admin');
    await admin.removeUser(T.db, 'ola', 'test');
    assert.equal((await admin.listUsers(T.db)).length, 0);
  });

  await t.test('kv-admin', async () => {
    let r = await cli('vehicle', 'add', 'kv09', '--name', 'Ni');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /kv09 added/);
    r = await cli('vehicle', 'key', 'kv09');
    assert.equal(r.code, 0, r.out);
    const key = r.out.match(/\n\s+(\S{40})\n/)[1];
    const h = await T.post('/hello', { protocol: 1, vehicle: 'kv09', boot: 'abcd-1234', recorder: '1.0.0' }, { key });
    assert.equal(h.statusCode, 200, h.body);
    r = await cli('vehicle', 'list');
    assert.match(r.out, /kv09\s+Ni\s+yes/);
    r = await cli('rules', 'set', 'quiet', path.join(__dirname, '..', 'docs', 'examples', 'rules-example.json'));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /saved as version/);
    r = await cli('vehicle', 'rules', 'kv09', '--set', 'quiet');
    assert.equal(r.code, 0, r.out);
    r = await cli('rules', 'effective', 'kv09');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /spare\*/);
    r = await cli('rules', 'pause', 'vehicle:kv09', '--minutes', '30', '--reason', 'service');
    assert.equal(r.code, 0, r.out);
    const id = r.out.match(/pause (\w+) on/)[1];
    r = await cli('rules', 'resume', 'vehicle:kv09', id);
    assert.equal(r.code, 0, r.out);
    r = await cli('rules', 'set', 'bad', path.join(__dirname, 'helpers.js'));
    assert.equal(r.code, 1);
    assert.match(r.out, /can't be read as JSON/);
    r = await cli('vehicle', 'rename', 'kv09', 'kv_09');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /kv09 is now kv_09/);
    r = await cli('vehicle', 'rename', 'kv_09', 'kv09');
    assert.equal(r.code, 0, r.out);
    r = await cli('vehicle', 'disable', 'kv09');
    assert.equal(r.code, 0);
    r = await cli('status');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /3 vehicles \(2 active, 2 with a key\)/);
    r = await cli('audit', '--limit', '5');
    assert.match(r.out, /vehicle.disable/);
    r = await cli('nonsense');
    assert.equal(r.code, 1);
  });

  await t.test('sletting etter alder (uten TimescaleDB) og opprydding', async () => {
    if (T.db.timescale) return;
    const old = Date.UTC(2020, 0, 1);
    const r = await T.post('/ingest', { vehicle: 'kv07', boot: 'b-old', seq: 1, clock: { synced: true }, series: { 'kv_1.x': [[old, 1], [Date.now() - 1000, 2]] } });
    assert.equal(r.statusCode, 200);
    await T.db.query("UPDATE batch SET received_at = now() - interval '30 days'");
    await retention(T.db, { retention: { rawDays: 30, batchDays: 7, clockDays: 7 } }, null);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM sample')).rows[0].n, 1);
    assert.equal((await T.db.query('SELECT count(*) AS n FROM batch')).rows[0].n, 0);
  });
});

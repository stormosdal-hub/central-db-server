'use strict';
/*
 * API-ene bak sidene Finn data, Trend, Eksport, Hendelser og Regler, mot kjente data:
 *   kv07: kv_1.speed hvert sekund i 2 timer (1000 + 500·sin), kv_1.bit03 på 10 min og 5 min, tekst, alarmer, et hull
 *   kv08: kv_1.speed = 50 hvert 10. sekund i 2 timer, kv_1.bit03 alltid av, og et brudd mellom to økter
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { setup, addVehicle, browser, BOOT } = require('./helpers');
const admin = require('../lib/admin');
const { rollupOnce } = require('../lib/jobs');

const MIN = 60000, HOUR = 3600000;
const speed = i => Math.round((1000 + 500 * Math.sin(i / 60)) * 1000) / 1000;

test('sidene: Finn data, Trend, Eksport, Hendelser, Regler', async t => {
  const T = await setup({ web: { enabled: true } });
  t.after(() => T.close());
  const kv08 = await addVehicle(T.db, 'kv08');
  const end = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
  const start = end - 2 * HOUR;
  const at = m => start + m * MIN;

  // ---- data
  const tags = [
    { name: 'kv_1.speed', dataType: 'number', unit: 'rpm', label: 'Hastighet' },
    { name: 'kv_1.bit03', dataType: 'boolean', unit: '', label: 'Nødstopp OK' },
    { name: 'kv_1.state', dataType: 'string', unit: '', label: 'Tilstand' },
  ];
  for (let k = 0; k < 2; k++) {
    const series = { 'kv_1.speed': [] };
    for (let i = k * 3600; i < (k + 1) * 3600; i++) series['kv_1.speed'].push([start + i * 1000, speed(i)]);
    if (k === 0) series['kv_1.bit03'] = [[at(0), 0], [at(10), 1], [at(20), 0]];
    else series['kv_1.bit03'] = [[at(60), 1], [at(65), 0]];
    const body = { vehicle: 'kv07', boot: BOOT, seq: k + 1, clock: { synced: true }, tags, series,
      text: { 'kv_1.state': k === 0 ? [[at(0), 'idle'], [at(10), 'running; fast']] : [[at(70), 'stopped']] } };
    if (k === 0) {
      body.events = [{ ts: at(15), source: 'kv_1.words_0', severity: 'alarm', message: 'Drive fault F7900' }, { ts: at(1), source: 'kv_1', severity: 'info', message: 'Adapter connected' }];
      body.gaps = [{ from: at(30), to: at(31), tags: ['kv_1.speed'], reason: 'queue-full' }];
    }
    assert.equal((await T.post('/ingest', body)).statusCode, 200);
  }
  // kv08: to økter med 30 min mellom
  const b1 = '3f2b9c1e-0000-4000-8000-0000000000b1', b2 = '3f2b9c1e-0000-4000-8000-0000000000b2';
  const s8 = (from, to) => { const a = []; for (let x = from; x < to; x += 10000) a.push([x, 50]); return a; };
  let r = await T.post('/ingest', { vehicle: 'kv08', boot: b1, seq: 1, clock: { synced: true }, tags, series: { 'kv_1.speed': s8(at(0), at(45)), 'kv_1.bit03': [[at(0), 0]] } }, { key: kv08.key });
  assert.equal(r.statusCode, 200, r.body);
  r = await T.post('/ingest', { vehicle: 'kv08', boot: b2, seq: 1, clock: { synced: true }, series: { 'kv_1.speed': s8(at(75), at(120)) } }, { key: kv08.key });
  assert.equal(r.statusCode, 200, r.body);
  await rollupOnce(T.db);

  const web = browser(T);
  const find = body => web.post('/find', Object.assign({ from: start, to: end }, body));

  await t.test('Finn data: har taggen', async () => {
    let r = await find({ tags: 'kv_1.speed' });
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json().rows;
    assert.deepEqual(rows.map(x => x.code), ['kv07', 'kv08']);
    assert.equal(rows[0].hits, 7200);
    assert.equal(rows[1].hits, 540);
    assert.equal(rows[0].first, start);
    assert.equal(rows[0].unit, 'rpm');
    assert.equal(rows[0].label, 'Hastighet');
    // et tidsrom som ikke starter på en hel time: kantene fra minuttene
    r = await find({ tags: 'kv_1.speed', vehicles: ['kv07'], from: at(5), to: at(15) - 1 });
    assert.equal(r.json().rows[0].hits, 600);
    r = await find({ label: 'hastig' });
    assert.deepEqual(r.json().rows.map(x => x.tag), ['kv_1.speed', 'kv_1.speed']);
    r = await find({ tags: 'kv_1.*', dataType: 'boolean' });
    assert.deepEqual(r.json().rows.map(x => `${x.code} ${x.tag}`), ['kv07 kv_1.bit03', 'kv08 kv_1.bit03']);
    r = await find({ tags: 'kv_1.state' });
    assert.equal(r.json().rows[0].hits, 3);
  });

  await t.test('Finn data: var på, over, under, endret seg, hendelse', async () => {
    let r = await find({ tags: 'kv_1.bit03', condition: { kind: 'on' } });
    let j = r.json();
    assert.equal(j.method, 'raw');
    assert.deepEqual(j.rows.map(x => x.code), ['kv07']);
    assert.equal(j.rows[0].hits, 2);
    assert.equal(j.rows[0].seconds, 15 * 60);
    assert.equal(j.rows[0].first, at(10));
    assert.equal(j.rows[0].last, at(65));
    // på ved from: telles fra from
    r = await find({ tags: 'kv_1.bit03', condition: { kind: 'on' }, from: at(15), to: at(30) });
    assert.equal(r.json().rows[0].hits, 1);
    assert.equal(r.json().rows[0].seconds, 5 * 60);
    assert.equal(r.json().rows[0].first, at(15));

    r = await find({ tags: 'kv_1.speed', condition: { kind: 'above', value: '1400,5' } });
    j = r.json();
    assert.deepEqual(j.rows.map(x => x.code), ['kv07']);
    let crossings = 0, secs = 0;
    for (let i = 0; i < 7200; i++) { if (speed(i) > 1400.5) { secs++; if (i === 0 || !(speed(i - 1) > 1400.5)) crossings++; } }
    assert.equal(j.rows[0].hits, crossings);
    assert.equal(j.rows[0].seconds, secs);
    r = await find({ tags: 'kv_1.speed', condition: { kind: 'below', value: 100 } });
    assert.deepEqual(r.json().rows.map(x => x.code), ['kv08']);
    r = await find({ tags: 'kv_1.speed', condition: { kind: 'above' } });
    assert.equal(r.statusCode, 400);

    r = await find({ tags: 'kv_1.*', condition: { kind: 'changed' } });
    assert.deepEqual(r.json().rows.map(x => `${x.code} ${x.tag}`), ['kv07 kv_1.bit03', 'kv07 kv_1.speed', 'kv07 kv_1.state']);

    r = await find({ condition: { kind: 'event', text: 'f7900' } });
    j = r.json();
    assert.deepEqual(j.rows.map(x => [x.code, x.hits, x.latest]), [['kv07', 1, 'Drive fault F7900']]);
    r = await find({ condition: { kind: 'event', severity: 'warning' } });
    assert.deepEqual(r.json().rows.map(x => x.hits), [1]);
  });

  await t.test('Trend: flere kjøreverk og tagger', async () => {
    const r = await web.post('/series', { series: [{ vehicle: 'kv07', tag: 'kv_1.speed' }, { vehicle: 'kv08', tag: 'kv_1.speed' }, { vehicle: 'kv07', tag: 'kv_1.bit03' }, { vehicle: 'kv08', tag: 'kv_1.nope' }],
      from: start, to: end, points: 300 });
    assert.equal(r.statusCode, 200, r.body);
    const s = r.json().series;
    assert.deepEqual(s.map(x => `${x.vehicle} ${x.tag}`), ['kv07 kv_1.speed', 'kv08 kv_1.speed', 'kv07 kv_1.bit03', 'kv08 kv_1.nope']);
    assert.ok(s[0].points.length > 100 && s[0].points.length <= 2 * 300 + 5, `${s[0].points.length}`);   // to per bøtte, pluss første punkt og hull
    assert.equal(s[0].unit, 'rpm');
    assert.equal(s[2].dataType, 'boolean');
    assert.deepEqual(s[2].points.filter(p => p[1] !== null).map(p => p[1]), [0, 1, 0, 1, 0]);
    assert.ok(s[1].points.some(p => p[1] === null), 'bruddet mellom øktene til kv08 er et hull');
    assert.equal(s[3].missing, true);
    assert.equal((await web.post('/series', { series: [{ vehicle: 'kv99', tag: 'x' }], from: start, to: end })).statusCode, 404);
  });

  const dl = async q => T.app.inject({ method: 'GET', url: `/api/web/export?from=${start}&to=${end}&${q}` });

  await t.test('Eksport: lang, med desimalkomma og lokal tid', async () => {
    const r = await dl('tags=kv_1.speed,kv_1.state&vehicles=kv07&tz=Europe/Oslo');
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /attachment; filename="kjoreverk-verdier-\d{8}-\d{4}\.csv"/);
    const text = r.body;
    assert.equal(text.charCodeAt(0), 0xFEFF, 'BOM for Excel');
    const lines = text.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'tid;kjøreverk;tag;navn;verdi;enhet;kvalitet;kilde');
    assert.equal(lines.length, 1 + 7200 + 3);
    const first = lines.find(l => l.includes('kv_1.speed')).split(';');
    const d = new Date(start);
    const oslo = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'medium' }).format(d);
    assert.equal(first[0], `${oslo},000`);
    assert.equal(first[4], String(speed(0)).replace('.', ','));
    assert.ok(lines.some(l => l.includes('"running; fast"')), 'tekst med ; i anførselstegn');
  });

  await t.test('Eksport: bred, fylt inn, og per minutt', async () => {
    let r = await dl('tags=kv_1.bit03,kv_1.state&vehicles=kv07&format=wide&fill=1&style=intl&tz=UTC');
    let lines = r.body.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'tid,kv_1.bit03 (Nødstopp OK),kv_1.state (Tilstand)');
    assert.deepEqual(lines.slice(1).map(l => l.split(',').slice(1).join(',')), ['0,idle', '1,running; fast', '0,running; fast', '1,running; fast', '0,running; fast', '0,stopped']);
    assert.equal(lines[1].split(',')[0], new Date(start).toISOString().replace('T', ' ').replace('Z', ''));
    r = await dl('tags=kv_1.speed&format=long&resolution=1m&tz=UTC');
    lines = r.body.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'tid;kjøreverk;tag;navn;snitt;minste;største;antall;enhet');
    assert.equal(lines.filter(l => l.includes(';kv07;')).length, 120);
    assert.equal(lines.filter(l => l.includes(';kv08;')).length, 90);
    r = await dl('tags=kv_1.speed&format=wide&resolution=1h&tz=UTC');
    lines = r.body.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'kjøreverk;tid;kv_1.speed (Hastighet, rpm)');
    const est = await T.app.inject({ method: 'GET', url: `/api/web/export/estimate?from=${start}&to=${end}&tags=kv_1.speed` });
    assert.equal(est.json().rows, 7200 + 540);
    assert.equal(est.json().vehicles, 2);
    r = await dl('tags=finnes.ikke');
    assert.equal(r.statusCode, 400);
    r = await dl('tz=Mars/Olympus');
    assert.equal(r.statusCode, 400);
  });

  await t.test('Eksport: zip med én fil per kjøreverk', async () => {
    const r = await dl('tags=kv_1.*&files=zip&format=wide&tz=UTC');
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/zip');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvzip-'));
    const file = path.join(dir, 'x.zip');
    fs.writeFileSync(file, r.rawPayload);
    const out = execFileSync('python3', ['-I', '-c', `import zipfile,sys
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for n in z.namelist():
    d = z.read(n).decode('utf-8-sig').splitlines()
    print(n, len(d), d[0])`, file]).toString().trim().split('\n');
    fs.rmSync(dir, { recursive: true });
    assert.equal(out.length, 2);
    assert.match(out[0], /^kv07\.csv 7201 tid;kv_1\.bit03 \(Nødstopp OK\);kv_1\.speed \(Hastighet, rpm\);kv_1\.state \(Tilstand\)$/);
    // kv08 meldte kv_1.state i tagoversikten, så kolonnen er med, tom
    assert.match(out[1], /^kv08\.csv 541 tid;kv_1\.bit03 \(Nødstopp OK\);kv_1\.speed \(Hastighet, rpm\);kv_1\.state \(Tilstand\)$/);
  });

  await t.test('Eksport: hendelser og hull', async () => {
    let r = await dl('kind=events&tz=UTC');
    let lines = r.body.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'tid;kjøreverk;alvorlighet;kilde;melding;fra');
    assert.deepEqual(lines.slice(1).map(l => l.split(';')[4]), ['Adapter connected', 'Drive fault F7900']);
    r = await dl('kind=gaps&tz=UTC');
    lines = r.body.slice(1).trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /;60;kv07;kv_1\.speed;queue-full;/);
  });

  await t.test('Hendelser og hull', async () => {
    let r = await web.get(`/events?from=${start}&to=${end}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().events.map(e => e.message), ['Drive fault F7900', 'Adapter connected']);
    assert.deepEqual(r.json().counts, { alarm: 1, info: 1 });
    r = await web.get(`/events?from=${start}&to=${end}&severity=warning`);
    assert.deepEqual(r.json().events.map(e => e.severity), ['alarm']);
    assert.deepEqual(r.json().counts, { alarm: 1, info: 1 }, 'tellingen ser bort fra alvorlighetsfilteret');
    r = await web.get(`/events?from=${start}&to=${end}&q=adapter&vehicles=kv07`);
    assert.equal(r.json().events.length, 1);
    r = await web.get(`/events?from=${start}&to=${end}&limit=1`);
    assert.equal(r.json().more, true);
    r = await web.get(`/gaps?from=${start}&to=${end}`);
    const g = r.json().gaps;
    assert.deepEqual(g.map(x => [x.kind, x.code]), [['session', 'kv08'], ['reported', 'kv07']]);
    assert.equal(g[0].to_ts - g[0].from_ts, 30 * MIN + 10000);
    r = await web.get(`/gaps?from=${start}&to=${end}&reason=queue-full`);
    assert.deepEqual(r.json().gaps.map(x => x.kind), ['reported']);
  });

  await t.test('Regler: regelsett, tillegg, pauser, historikk', async () => {
    await admin.addUser(T.db, { name: 'kari', password: 'kari sitt passord', role: 'rules', who: 'test' });
    const set = { events: true, eventsMin: 'warning', rules: [{ tags: 'kv_1.speed', deadband: '10%', minInterval: 5 }, { tags: '*' }], pauses: [] };
    let r = await web.put('/rulesets/default', { recording: set });
    assert.equal(r.statusCode, 401);
    await web.login('kari', 'kari sitt passord');
    r = await web.put('/rulesets/default', { recording: { rules: [{ mode: 'nope', tags: 'x' }] } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Rule 1: mode is one of/);
    r = await web.post('/rules/check', { recording: { rules: [{ tags: '' }] } });
    assert.equal(r.json().ok, false);
    r = await web.put('/rulesets/default', { recording: set, note: 'dødbånd på hastigheten' });
    assert.equal(r.statusCode, 200, r.body);
    r = await web.get('/rulesets/default');
    assert.equal(r.json().recording.rules[0].deadband, '10%');
    assert.deepEqual(r.json().vehicles, ['kv07', 'kv08']);
    r = await web.put('/rulesets/stille', { recording: { rules: [] } });
    assert.equal(r.statusCode, 200);
    r = await web.put('/vehicles/kv08/rules', { extra: { rules: [{ tags: 'kv_1.bit*', mode: 'ignore' }] }, note: 'test' });
    assert.equal(r.statusCode, 200, r.body);
    r = await web.get('/vehicles/kv08/rules');
    assert.equal(r.json().effective.rules.length, 3);
    assert.equal(r.json().effective.rules[0].mode, 'ignore');
    r = await web.post('/rules/pause', { target: { vehicle: 'kv08' }, tags: '*', minutes: 30, reason: 'service' });
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().pause.id;
    r = await web.post('/rules/resume', { target: { vehicle: 'kv08' }, id });
    assert.equal(r.json().resumed, 1);
    r = await web.put('/vehicles/kv08/rules', { extra: { rules: [], pauses: [] } });
    assert.equal(r.statusCode, 200);
    assert.equal((await web.get('/vehicles/kv08/rules')).json().extra, null, 'et tomt tillegg fjernes');
    r = await web.get('/rules/history?set=default');
    assert.equal(r.json().history[0].note, 'dødbånd på hastigheten');
    r = await web.get(`/rules/history/${r.json().history[0].id}`);
    assert.equal(r.json().recording.rules[0].minInterval, 5);
    r = await web.get('/rules/history?vehicle=kv08');
    assert.equal(r.json().history.length, 4);
    r = await web.del('/rulesets/stille');
    assert.equal(r.statusCode, 200);
  });

  await t.test('Oversikt: lagring, vekst og serverens klokke', async () => {
    const { recordStorage } = require('../lib/storage');
    await recordStorage(T.db);
    // et døgn gammel måling, så veksten kan regnes ut
    await T.db.query("INSERT INTO storage_log (day, bytes, at) VALUES (current_date - 1, 1000, now() - interval '1 day') ON CONFLICT (day) DO UPDATE SET bytes = 1000, at = now() - interval '1 day'");
    const r = await web.get('/overview');
    assert.equal(r.statusCode, 200, r.body);
    const st = r.json().storage;
    assert.ok(st.dbBytes > 1000000);
    assert.ok(st.growthPerDay > 0);
    assert.ok(st.pointsPerDay > 0);
    assert.ok(st.disk === null || st.disk.total > 0);
    if (st.disk) assert.ok(st.daysLeft > 0);
    assert.ok('synced' in r.json().clock);
  });

  await t.test('Regler: forhåndsvisning med regelmotoren', async () => {
    const strict = { rules: [{ tags: '${pls}.speed', deadband: '10%' }, { tags: '${pls}.bit*' }] };
    const r = await web.post('/rules/preview', { recording: strict, vehicle: 'kv07', hours: 3 });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    assert.deepEqual(j.vars, { pls: 'kv_1' });
    const sp = j.tags.find(x => x.tag === 'kv_1.speed');
    assert.equal(sp.now, 7200);
    assert.ok(sp.would > 10 && sp.would < 1000, `${sp.would}`);
    assert.equal(j.tags.find(x => x.tag === 'kv_1.bit03').would, 5);
    assert.equal(j.tags.find(x => x.tag === 'kv_1.state').rule, null, 'ingen regel: lagres ikke');
    assert.equal(j.rules[0].now, 7200);
    assert.equal(j.rules[j.rules.length - 1].index, null);
    assert.equal(j.total.now, 7200 + 5 + 3);
  });
});

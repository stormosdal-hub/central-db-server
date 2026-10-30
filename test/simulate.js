#!/usr/bin/env node
'use strict';
/*
 * test/simulate.js - later som det er mange kjøreverk, mot en kjørende server (docs/PLAN.md §5.2).
 *
 * Hvert kjøreverk gjør det recorderen gjør: /hello, henter reglene, sender batcher hvert 10. sekund,
 * én om gangen, venter ved 503 (retryAfter), prøver igjen etter brudd, deler ved 413, og kaster ved
 * 400. I tillegg: brudd (køen vokser, så sendes alt), omstarter (ny boot, etterfylling med src 2 som
 * gir duplikater), og en batch sendt to ganger. Noen spør også /history. Til slutt skrives tallene:
 * batcher, punkter, duplikater, 503-er, feil og svartider.
 *
 *   node test/simulate.js [--server http://localhost:8090] [--vehicles 42] [--seconds 120] [--rate 5]
 *                         [--send 10] [--tags 80] [--outage 0.02] [--restart 0.005] [--dup 0.02]
 *                         [--history 30] [--prefix sim] [--config <serverens oppsettfil>]
 *
 * Kjøreverkene (sim01 …) og nøklene lages i databasen, med serverens oppsett (--config, KV_SERVER_CONFIG
 * eller /etc/kjoreverk-server/config.json). De blir stående; slett dem med kv-admin om du vil.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { load } = require('../lib/config');
const Db = require('../lib/db');
const admin = require('../lib/admin');
const { becomeDbUser, explain } = require('../lib/run-as');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SERVER = String(opt('server', 'http://localhost:8090')).replace(/\/+$/, '');
const N = Number(opt('vehicles', 42));
const SECONDS = Number(opt('seconds', 120));
const RATE = Number(opt('rate', 5));            // punkter i sekundet per kjøreverk, omtrent
const SEND = Number(opt('send', 10));           // sekunder mellom batcher
const TAGS = Number(opt('tags', 80));
const P_OUTAGE = Number(opt('outage', 0.02));   // per kjøreverk per batch
const P_RESTART = Number(opt('restart', 0.005));
const P_DUP = Number(opt('dup', 0.02));
const HISTORY_EVERY = Number(opt('history', 30));
const PREFIX = String(opt('prefix', 'sim'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rnd = (a, b) => a + Math.random() * (b - a);
const pct = (list, p) => { if (!list.length) return 0; const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const uuid = () => { const b = crypto.randomBytes(16).toString('hex'); return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`; };

const stats = { batches: 0, replays: 0, points: 0, stored: 0, duplicates: 0, busy: 0, rejected: 0, errors: 0, splits: 0, hellos: 0, outages: 0, restarts: 0, ingestMs: [], historyMs: [], historyErrors: 0, maxQueue: 0 };
const agent = new (SERVER.startsWith('https') ? https : http).Agent({ keepAlive: true, maxSockets: 64 });

function call(method, route, key, body, timeoutMs, headers) {
  return new Promise(resolve => {
    const u = new URL(SERVER + '/api/v1' + route);
    const h = Object.assign({ Accept: 'application/json', 'Accept-Encoding': 'gzip', Authorization: 'Bearer ' + key }, headers || {});
    let data = null;
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      if (data.length > 4096) { data = zlib.gzipSync(data); h['Content-Encoding'] = 'gzip'; }
      h['Content-Length'] = data.length;
    }
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const req = (u.protocol === 'https:' ? https : http).request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h, agent }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try { if (/gzip/.test(res.headers['content-encoding'] || '')) buf = zlib.gunzipSync(buf); } catch (e) { return finish({ error: 'bad gzip' }); }
        let json = null;
        try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch (e) { /* ikke JSON */ }
        finish({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', e => finish({ error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------- et kjøreverk
class Vehicle {
  constructor(code, key) {
    this.code = code; this.key = key;
    this.boot = uuid(); this.seq = 0;
    this.queue = []; this.inflight = null;
    this.helloOk = false; this.waitUntil = 0; this.backoff = 0;
    this.outageUntil = 0;
    this.catalogDirty = true;
    this.lastGen = Date.now();
    this.recent = [];                     // de siste punktene, til etterfyllingen etter en omstart
    // taggene: reals som endrer seg hele tiden, words av og til, bits sjelden
    this.tags = [];
    const nReals = Math.max(1, Math.round(RATE)), nWords = Math.max(1, Math.round(TAGS * 0.2)), nBits = Math.max(1, TAGS - nReals - nWords);
    for (let i = 0; i < nBits; i++) this.tags.push({ name: `kv_1.bit${String(i).padStart(2, '0')}`, kind: 'bit', dataType: 'boolean', v: Math.random() < 0.3 ? 1 : 0, every: rnd(20, 900), next: 0 });
    for (let i = 0; i < nWords; i++) this.tags.push({ name: `kv_1.words_${i}`, kind: 'word', dataType: 'number', v: 0, every: rnd(5, 120), next: 0 });
    for (let i = 0; i < nReals; i++) this.tags.push({ name: `kv_1.reals_${i}`, kind: 'real', dataType: 'number', unit: 'rpm', label: `Måling ${i}`, phase: Math.random() * 100, v: 0 });
    this.tags.push({ name: 'kv_1.state', kind: 'text', dataType: 'string', v: 'idle', every: 60, next: 0 });
  }

  // punktene fra lastGen til nå, ett sekund om gangen
  generate(now) {
    const series = {}, text = {}, events = [];
    for (let t = Math.floor(this.lastGen / 1000) * 1000 + 1000; t <= now; t += 1000) {
      for (const tag of this.tags) {
        let v;
        if (tag.kind === 'real') v = Math.round((1000 + 400 * Math.sin((t / 1000 + tag.phase) / 30) + rnd(-5, 5)) * 10) / 10;
        else if (t >= tag.next) {
          tag.next = t + tag.every * 1000 * rnd(0.5, 1.5);
          if (tag.kind === 'bit') v = tag.v ? 0 : 1;
          else if (tag.kind === 'word') v = Math.floor(rnd(0, 65535));
          else v = ['idle', 'running', 'stopped', 'fault'][Math.floor(rnd(0, 4))];
          if (tag.kind === 'word' && tag.name === 'kv_1.words_0' && Math.random() < 0.2) events.push({ ts: t, source: 'kv_1', severity: 'alarm', message: `Drive fault F${v}` });
        } else continue;
        tag.v = v;
        if (tag.kind === 'text') (text[tag.name] || (text[tag.name] = [])).push([t, v]);
        else (series[tag.name] || (series[tag.name] = [])).push([t, v]);
        this.recent.push([tag.name, t, v]);
      }
    }
    this.lastGen = now;
    while (this.recent.length > 20000) this.recent.shift();
    return { series, text, events };
  }

  enqueue(now) {
    const g = this.generate(now);
    const b = { vehicle: this.code, boot: this.boot, seq: ++this.seq, clock: { synced: true, piTime: Date.now() } };
    if (this.catalogDirty) { b.tags = this.tags.map(t => ({ name: t.name, dataType: t.dataType, unit: t.unit || '', label: t.label || '', description: '' })); this.catalogDirty = false; }
    if (Object.keys(g.series).length) b.series = g.series;
    if (Object.keys(g.text).length) b.text = g.text;
    if (g.events.length) b.events = g.events;
    if (this.gaps && this.gaps.length) { b.gaps = this.gaps; this.gaps = []; }
    b._n = Object.values(g.series).reduce((n, a) => n + a.length, 0) + Object.values(g.text).reduce((n, a) => n + a.length, 0) + g.events.length;
    this.queue.push(b);
    stats.maxQueue = Math.max(stats.maxQueue, this.queue.length);
  }

  // en omstart: ny boot, og de siste to minuttene en gang til fra «hubens minne» (src 2)
  restart() {
    stats.restarts++;
    this.boot = uuid(); this.seq = 0; this.helloOk = false; this.catalogDirty = true;
    this.queue = []; this.inflight = null;
    const since = Date.now() - 120000;
    const series = {};
    for (const [name, t, v] of this.recent) if (t >= since && typeof v === 'number') (series[name] || (series[name] = [])).push([t, v, 0, 2]);
    const b = { vehicle: this.code, boot: this.boot, seq: ++this.seq, clock: { synced: true, piTime: Date.now() }, series };
    b._n = Object.values(series).reduce((n, a) => n + a.length, 0);
    b.tags = this.tags.map(t => ({ name: t.name, dataType: t.dataType, unit: t.unit || '', label: t.label || '' }));
    this.catalogDirty = false;
    if (b._n) this.queue.push(b);
  }

  failed(r, what) {
    if (r.error || (r.status >= 500 && r.status !== 503)) {
      this.helloOk = false;
      this.backoff = Math.min(60, this.backoff ? this.backoff * 2 : 2);
      this.waitUntil = Date.now() + this.backoff * 1000;
      stats.errors++;
      if (stats.errors <= 20) log(`${this.code}: ${what} failed: ${r.error || r.status} ${(r.json && r.json.error) || ''}`);
    } else if (r.status === 429 || r.status === 503) {
      const s = Number((r.json && r.json.retryAfter) || r.headers['retry-after']) || 10;
      this.waitUntil = Date.now() + s * 1000;
      stats.busy++;
    } else {
      this.waitUntil = Date.now() + 60000;
      stats.errors++;
      log(`${this.code}: ${what}: ${r.status} ${(r.json && r.json.error) || ''}`);
    }
  }

  async pump() {
    if (this.busy) return;
    const now = Date.now();
    if (now < this.waitUntil || now < this.outageUntil) return;
    this.busy = true;
    try {
      if (!this.helloOk) {
        const r = await call('POST', '/hello', this.key, { protocol: 1, vehicle: this.code, boot: this.boot, recorder: 'sim', clock: { synced: true, piTime: Date.now() } }, 15000);
        if (r.status !== 200) return this.failed(r, '/hello');
        this.helloOk = true; this.backoff = 0; stats.hellos++;
        const rules = await call('GET', '/rules?vehicle=' + this.code, this.key, undefined, 15000);
        if (rules.status !== 200) return this.failed(rules, '/rules');
        return;
      }
      if (!this.inflight) {
        if (!this.queue.length) return;
        this.inflight = this.queue[0];
      }
      const b = this.inflight;
      const t0 = Date.now();
      b.clock = { synced: true, piTime: t0 };   // klokka leses når batchen sendes, som recorderen gjør
      const r = await call('POST', '/ingest', this.key, b, 30000);
      if (r.status === 200) {
        stats.ingestMs.push(Date.now() - t0);
        if (b._sent) stats.replays++;
        else { stats.batches++; stats.points += b._n || 0; stats.stored += r.json.stored; stats.duplicates += r.json.duplicates; }
        if (!b._sent && Math.random() < P_DUP) { b._sent = true; return; }   // sendes en gang til, som etter et tidsavbrudd
        this.queue.shift(); this.inflight = null; this.backoff = 0;
        return;
      }
      if (r.status === 413 && b.series) {
        // deles i to: halvparten av hver serie i en ny batch rett etter
        stats.splits++;
        const second = Object.assign({}, b, { seq: ++this.seq, series: {} });
        for (const [k, arr] of Object.entries(b.series)) { const h = Math.ceil(arr.length / 2); second.series[k] = arr.slice(h); b.series[k] = arr.slice(0, h); }
        this.queue.splice(1, 0, second);
        return;
      }
      if (r.status === 400 || r.status === 413) {
        stats.rejected++;
        log(`${this.code}: batch ${b.seq} rejected: ${(r.json && r.json.error) || r.status}`);
        this.queue.shift(); this.inflight = null;
        return;
      }
      this.failed(r, '/ingest');
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------- kjøringen
async function main() {
  const { config } = load(opt('config', null));
  becomeDbUser(config.db);   // med sudo: koble til som brukeren kjoreverk, som kv-admin
  const db = new Db(config.db);
  await db.init();
  const vehicles = [];
  for (let i = 1; i <= N; i++) {
    const code = `${PREFIX}${String(i).padStart(2, '0')}`;
    try { await admin.addVehicle(db, { code, name: `Simulert ${i}`, who: 'simulate' }); } catch (e) { /* finnes */ }
    const { key } = await admin.makeKey(db, code, 'simulate');
    vehicles.push(new Vehicle(code, key));
  }
  await db.close();
  log(`${N} vehicles against ${SERVER} for ${SECONDS} s: ~${RATE} points/s each, a batch every ${SEND} s, ${TAGS} tags`);

  const health = await new Promise(resolve => http.get(SERVER + '/api/health', res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve(s)); }).on('error', e => resolve(e.message)));
  log('server:', health);

  const started = Date.now();
  // batchene: jevnt fordelt over sendeintervallet, som 42 recordere som startet til ulik tid
  for (const [i, v] of vehicles.entries()) {
    setTimeout(() => {
      v.enqueue(Date.now());
      v.timer = setInterval(() => {
        const now = Date.now();
        if (now < v.outageUntil) { v.enqueue(now); return; }   // under et brudd vokser køen
        if (Math.random() < P_RESTART) { v.restart(); return; }
        if (Math.random() < P_OUTAGE) { v.outageUntil = now + rnd(20, 90) * 1000; stats.outages++; }
        v.enqueue(now);
      }, SEND * 1000);
    }, (i / N) * SEND * 1000);
  }
  const pumps = setInterval(() => { for (const v of vehicles) v.pump(); }, 250);

  // historikk: et tilfeldig kjøreverk spør om 8 tagger over det siste døgnet
  let hist = null;
  if (HISTORY_EVERY > 0) {
    hist = setInterval(async () => {
      const v = vehicles[Math.floor(Math.random() * vehicles.length)];
      const tags = v.tags.filter(t => t.kind !== 'text').sort(() => Math.random() - 0.5).slice(0, 8).map(t => t.name);
      const hours = [1, 8, 24, 168][Math.floor(Math.random() * 4)];
      const t0 = Date.now();
      const r = await call('POST', '/history', v.key, { vehicle: v.code, tags, from: t0 - hours * 3600000, to: t0, points: 1500 }, 10000);
      if (r.status === 200) { stats.historyMs.push(Date.now() - t0); log(`${v.code}: history ${hours} h, ${tags.length} tags: ${Date.now() - t0} ms (server ${r.json.ms} ms, ${Object.values(r.json.series).reduce((n, s) => n + s.length, 0)} points)`); }
      else { stats.historyErrors++; log(`${v.code}: history failed: ${r.error || r.status} ${(r.json && r.json.error) || ''}`); }
    }, HISTORY_EVERY * 1000);
  }

  const report = final => {
    const secs = (Date.now() - started) / 1000;
    const q = vehicles.reduce((n, v) => n + v.queue.length, 0);
    const out = vehicles.filter(v => Date.now() < v.outageUntil).length;
    log(`${final ? 'DONE' : 'so far'}: ${Math.round(secs)} s, ${stats.batches} batches (${stats.replays} sent twice), ${stats.points} points sent, ${stats.stored} stored, ${stats.duplicates} duplicates, `
      + `${Math.round(stats.stored / secs)} stored/s; ingest p50 ${pct(stats.ingestMs, 0.5)} ms, p95 ${pct(stats.ingestMs, 0.95)} ms, max ${pct(stats.ingestMs, 1)} ms; `
      + `503: ${stats.busy}, rejected: ${stats.rejected}, errors: ${stats.errors}, splits: ${stats.splits}, hellos: ${stats.hellos}, outages: ${stats.outages} (${out} now), restarts: ${stats.restarts}, `
      + `queued: ${q} (max ${stats.maxQueue}); history: ${stats.historyMs.length} ok p50 ${pct(stats.historyMs, 0.5)} ms p95 ${pct(stats.historyMs, 0.95)} ms max ${pct(stats.historyMs, 1)} ms, ${stats.historyErrors} failed`);
  };
  const reporter = setInterval(() => report(false), 30000);

  await new Promise(resolve => setTimeout(resolve, SECONDS * 1000));
  for (const v of vehicles) { clearInterval(v.timer); v.outageUntil = 0; }
  // send det som ligger igjen, i høyst 30 sekunder
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && vehicles.some(v => v.queue.length || v.inflight)) await new Promise(resolve => setTimeout(resolve, 250));
  clearInterval(pumps); clearInterval(reporter); if (hist) clearInterval(hist);
  report(true);
  agent.destroy();
  process.exit(stats.errors > stats.batches / 10 ? 1 : 0);
}

main().catch(e => { console.error(explain(e, 'node test/simulate.js')); process.exit(1); });

'use strict';
/*
 * lib/clock.js - serverens egen klokke: er den synkronisert, og mot hvilken NTP-server (docs/PLAN.md §3.7).
 * Alle enhetene på nettet, også denne serveren og Pi-ene i kjøreverkene, bruker den samme NTP-serveren,
 * så en server med feil tid gir feil i alt den sammenligner med kjøreverkene. Svaret huskes i ett minutt.
 */

const { execFile } = require('child_process');

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 3000 }, (err, out) => resolve(err ? null : String(out || '').trim()));
});

let cached = null, cachedAt = 0;

async function serverClock() {
  if (cached && Date.now() - cachedAt < 60000) return cached;
  const r = { synced: null, source: null, how: null };
  const s = await run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']);
  if (s === 'yes' || s === 'no') {
    r.synced = s === 'yes';
    r.how = 'timedatectl';
    r.source = await run('timedatectl', ['show-timesync', '-p', 'ServerName', '--value']) || null;
  }
  // chrony: kilden er feltene 2 (navn eller adresse) og leap-status til slutt
  const c = await run('chronyc', ['-c', 'tracking']);
  if (c) {
    const f = c.split(',');
    if (f.length > 5) {
      r.how = 'chronyc';
      if (f[1] && f[1] !== '127.127.1.1') r.source = f[1];
      if (r.synced === null) r.synced = !/not synchroni/i.test(f[f.length - 1]) && f[0] !== '00000000';
    }
  }
  cached = r;
  cachedAt = Date.now();
  return r;
}

module.exports = { serverClock };

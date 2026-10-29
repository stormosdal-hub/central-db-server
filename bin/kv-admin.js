#!/usr/bin/env node
'use strict';
/*
 * kv-admin - kommandolinjen for serveren: kjøreverk, nøkler, regler og brukere (docs/PLAN.md §5.3).
 * Det samme kommer på web-siden etter hvert; alt her logges i audit_log.
 *
 *   kv-admin migrate                              kjør migreringene (serveren gjør det også ved oppstart)
 *   kv-admin status                               databasen og kjøreverkene i korte trekk
 *
 *   kv-admin vehicle list
 *   kv-admin vehicle add <code> [--name "…"] [--rules <set>] [--silent-after <s>] [--notes "…"]
 *   kv-admin vehicle show <code>
 *   kv-admin vehicle key <code>                   en ny nøkkel; vises én gang. Legg den i /etc/hmi-recorder.json på Pi-en
 *   kv-admin vehicle revoke <code>                nøkkelen slutter å virke
 *   kv-admin vehicle enable|disable <code>
 *   kv-admin vehicle set <code> [--name "…"] [--silent-after <s>] [--notes "…"]
 *   kv-admin vehicle rules <code> --set <name>    hvilket regelsett kjøreverket bruker
 *   kv-admin vehicle extra <code> <fil.json>|--none   tillegget for kjøreverket (regler og pauser foran settets)
 *
 *   kv-admin rules list
 *   kv-admin rules show [<set>]                   regelsettet som JSON (default når navnet mangler)
 *   kv-admin rules set <set> <fil.json> [--note "…"]   lagrer (og lager) et regelsett; sjekkes først
 *   kv-admin rules delete <set>
 *   kv-admin rules effective <code>               det kjøreverket får fra GET /rules
 *   kv-admin rules pause <set>|vehicle:<code> [--tags "*"] [--until <ISO-tid>|--minutes <n>] [--reason "…"]
 *   kv-admin rules resume <set>|vehicle:<code> <pauseId>|all
 *
 *   kv-admin user add <name> --role view|rules|admin [--password …]   (spør etter passordet ellers)
 *   kv-admin user list
 *   kv-admin user remove <name>
 *
 *   kv-admin audit [--limit 50]
 *
 * --config <fil> velger oppsettfilen, som for serveren.
 */

const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { load } = require('../lib/config');
const Db = require('../lib/db');
const admin = require('../lib/admin');
const rules = require('../lib/rules');

const args = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) { flags[k] = args[++i]; } else flags[k] = true;
  } else words.push(a);
}
const WHO = `cli:${process.env.SUDO_USER || os.userInfo().username}@${os.hostname()}`;

const fmtTime = ms => (ms === null || ms === undefined ? '-' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19));
const ago = ms => {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
function table(rows, cols) {
  if (!rows.length) { console.log('(none)'); return; }
  const w = cols.map(c => Math.max(c.h.length, ...rows.map(r => String(c.f(r)).length)));
  console.log(cols.map((c, i) => c.h.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(c.f(r)).padEnd(w[i])).join('  '));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`${file} can't be read as JSON: ${e.message}`); }
}
function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(question); };
    }
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}
const target = s => (String(s).startsWith('vehicle:') ? { vehicle: String(s).slice(8) } : { set: String(s) });

async function main() {
  const [cmd, sub, ...rest] = words;
  if (!cmd || cmd === 'help' || flags.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(3).map(l => l.replace(/^ \*( |$)/, '')).join('\n')); return; }
  const { config, file } = load(flags.config);
  const db = new Db(config.db);
  try {
    if (cmd === 'migrate') {
      const applied = await db.init();
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'the database is up to date');
      console.log(`TimescaleDB: ${db.timescale ? 'in use' : 'not installed (plain tables)'}`);
      return;
    }
    await db.init();
    switch (cmd) {
      case 'status': {
        const v = await admin.listVehicles(db);
        const size = (await db.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS s')).rows[0].s;
        const counts = await db.query(`SELECT (SELECT count(*) FROM tag) AS tags, (SELECT count(*) FROM session) AS sessions,
          (SELECT count(*) FROM rollup_dirty) AS dirty, (SELECT coalesce(sum(n + nnull), 0) FROM sample_1h WHERE bucket >= now() - interval '24 hours') AS points_24h`);
        const c = counts.rows[0];
        console.log(`settings: ${file || 'defaults'}; database ${size}, TimescaleDB ${db.timescale ? 'in use' : 'not installed'}`);
        console.log(`${v.length} vehicles (${v.filter(x => x.active).length} active, ${v.filter(x => x.key_prefix).length} with a key), ${c.tags} tags, ${c.sessions} sessions, ${c.points_24h} points the last 24 h, ${c.dirty} ranges waiting for rollup`);
        table(v, [{ h: 'code', f: r => r.code }, { h: 'name', f: r => r.name }, { h: 'last batch', f: r => ago(r.last_batch_at) }, { h: 'recorder', f: r => r.recorder_version || '-' }, { h: 'clock', f: r => (r.clock_synced === null ? '-' : r.clock_synced ? 'synced' : 'NOT synced') }]);
        return;
      }
      case 'vehicle': return await vehicle(db, sub, rest);   // await: finally lukker databasen
      case 'rules': return await rulesCmd(db, sub, rest);
      case 'user': return await user(db, sub, rest);
      case 'audit': {
        const r = await db.query('SELECT at, who, action, target, details FROM audit_log ORDER BY id DESC LIMIT $1', [Number(flags.limit) || 50]);
        table(r.rows.reverse(), [{ h: 'when', f: x => fmtTime(x.at) }, { h: 'who', f: x => x.who }, { h: 'action', f: x => x.action }, { h: 'target', f: x => x.target }, { h: 'details', f: x => (x.details ? JSON.stringify(x.details) : '') }]);
        return;
      }
      default: throw new Error(`unknown command ${cmd}; try kv-admin help`);
    }
  } finally {
    await db.close();
  }
}

async function vehicle(db, sub, [code, extra]) {
  switch (sub) {
    case 'list': {
      const v = await admin.listVehicles(db);
      table(v, [{ h: 'code', f: r => r.code }, { h: 'name', f: r => r.name }, { h: 'active', f: r => (r.active ? 'yes' : 'no') }, { h: 'key', f: r => (r.key_prefix ? r.key_prefix + '…' : '-') },
        { h: 'rules', f: r => `${r.rule_set}${r.has_extra ? '+extra' : ''} v${r.rules_version}` }, { h: 'last batch', f: r => ago(r.last_batch_at) }, { h: 'data until', f: r => fmtTime(r.last_ts) },
        { h: 'recorder', f: r => r.recorder_version || '-' }, { h: 'clock', f: r => (r.clock_synced === null ? '-' : r.clock_synced ? `synced (${r.clock_offset_ms > 0 ? '+' : ''}${r.clock_offset_ms} ms)` : 'NOT synced') }]);
      return;
    }
    case 'add': {
      if (!code) throw new Error('kv-admin vehicle add <code> [--name …] [--rules <set>]');
      await admin.addVehicle(db, { code, name: flags.name, ruleSet: flags.rules, silentAfter: Number(flags['silent-after']), notes: flags.notes, who: WHO });
      console.log(`${code} added. Make its key with: kv-admin vehicle key ${code}`);
      return;
    }
    case 'show': {
      const v = await admin.getVehicle(db, code);
      if (!v) throw new Error(`no vehicle named ${code}`);
      const { sessions, rule_extra, ...rest } = v;
      console.log(JSON.stringify(rest, null, 2));
      if (rule_extra) console.log('extra rules:', JSON.stringify(rule_extra, null, 2));
      console.log('\nlast sessions:');
      table(sessions, [{ h: 'boot', f: s => s.boot.slice(0, 8) }, { h: 'started', f: s => fmtTime(s.started_at) }, { h: 'last batch', f: s => fmtTime(s.last_batch_at) }, { h: 'batches', f: s => s.batches }, { h: 'points', f: s => s.points }, { h: 'data from', f: s => fmtTime(s.first_ts) }, { h: 'to', f: s => fmtTime(s.last_ts) }, { h: 'recorder', f: s => s.recorder_version || '-' }]);
      return;
    }
    case 'key': {
      const { key } = await admin.makeKey(db, code, WHO);
      console.log(`The new key for ${code} (shown only now; the old one no longer works):\n\n  ${key}\n`);
      console.log(`On the Pi, in /etc/hmi-recorder.json:  { "vehicle": "${code}", "server": "http://<this server>:8090", "token": "${key}" }`);
      return;
    }
    case 'revoke': await admin.revokeKey(db, code, WHO); console.log(`${code}: the key is revoked`); return;
    case 'enable': await admin.setActive(db, code, true, WHO); console.log(`${code} is enabled`); return;
    case 'disable': await admin.setActive(db, code, false, WHO); console.log(`${code} is disabled: its recorder gets 403 until it is enabled again`); return;
    case 'set': {
      await admin.updateVehicle(db, code, { name: flags.name, silentAfter: flags['silent-after'] !== undefined ? Number(flags['silent-after']) : undefined, notes: flags.notes }, WHO);
      console.log(`${code} updated`);
      return;
    }
    case 'rules': {
      if (!flags.set) throw new Error('kv-admin vehicle rules <code> --set <name>');
      const r = await rules.setVehicleRuleSet(db, code, flags.set, WHO);
      console.log(`${code} uses the rule set ${flags.set} (rules version ${r.version})`);
      return;
    }
    case 'extra': {
      if (flags.none) { const r = await rules.setVehicleExtra(db, code, null, WHO); console.log(`${code}: the extra rules are removed (rules version ${r.version})`); return; }
      if (!extra) throw new Error('kv-admin vehicle extra <code> <file.json> | --none');
      const r = await rules.setVehicleExtra(db, code, readJson(extra), WHO, `from ${extra}`);
      console.log(`${code}: extra rules set (rules version ${r.version})`);
      return;
    }
    default: throw new Error('kv-admin vehicle list|add|show|key|revoke|enable|disable|set|rules|extra');
  }
}

async function rulesCmd(db, sub, [name, file]) {
  switch (sub) {
    case 'list': {
      const r = await rules.listRuleSets(db);
      table(r, [{ h: 'name', f: x => x.name }, { h: 'version', f: x => x.version }, { h: 'rules', f: x => x.rules }, { h: 'pauses', f: x => x.pauses }, { h: 'vehicles', f: x => x.vehicles }, { h: 'updated', f: x => fmtTime(x.updated_at) }, { h: 'by', f: x => x.updated_by }]);
      return;
    }
    case 'show': {
      const rs = await rules.getRuleSet(db, name || 'default');
      if (!rs) throw new Error(`no rule set named ${name}`);
      console.log(JSON.stringify(rs.recording, null, 2));
      return;
    }
    case 'set': {
      if (!name || !file) throw new Error('kv-admin rules set <set> <file.json> [--note …]');
      const r = await rules.setRuleSet(db, name, readJson(file), WHO, flags.note || `from ${file}`);
      console.log(`rule set ${name} saved as version ${r.version}; the vehicles using it fetch it within a few batches`);
      return;
    }
    case 'delete': await rules.deleteRuleSet(db, name, WHO); console.log(`rule set ${name} deleted`); return;
    case 'effective': {
      const { vehicleByCode } = require('../lib/auth');
      const v = await vehicleByCode(db, name);
      if (!v) throw new Error(`no vehicle named ${name}`);
      console.log(JSON.stringify(await rules.effectiveFor(db, v), null, 2));
      return;
    }
    case 'pause': {
      if (!name) throw new Error('kv-admin rules pause <set>|vehicle:<code> [--tags "*"] [--until <ISO>|--minutes <n>] [--reason …]');
      let untilMs = null;
      if (flags.until) { untilMs = Date.parse(flags.until); if (!Number.isFinite(untilMs)) throw new Error(`--until ${flags.until} is not a time`); }
      else if (flags.minutes) untilMs = Date.now() + Number(flags.minutes) * 60000;
      const r = await rules.addPause(db, target(name), { tags: flags.tags, untilMs, reason: flags.reason }, WHO);
      console.log(`pause ${r.pause.id} on ${name}: ${r.pause.tags} ${untilMs ? 'until ' + fmtTime(untilMs) : 'until it is resumed'} (rules version ${r.version})`);
      return;
    }
    case 'resume': {
      if (!name || !file) throw new Error('kv-admin rules resume <set>|vehicle:<code> <pauseId>|all');
      const r = await rules.resumePause(db, target(name), file, WHO);
      console.log(`${r.resumed} pause${r.resumed === 1 ? '' : 's'} ended on ${name} (rules version ${r.version})`);
      return;
    }
    default: throw new Error('kv-admin rules list|show|set|delete|effective|pause|resume');
  }
}

async function user(db, sub, [name]) {
  switch (sub) {
    case 'list': table(await admin.listUsers(db), [{ h: 'name', f: u => u.name }, { h: 'role', f: u => u.role }, { h: 'disabled', f: u => (u.disabled ? 'yes' : '') }, { h: 'last login', f: u => fmtTime(u.last_login) }]); return;
    case 'add': {
      if (!name || !flags.role) throw new Error('kv-admin user add <name> --role view|rules|admin');
      let password = flags.password;
      if (!password) {
        password = await ask(`Password for ${name}: `, true);
        if (password !== await ask('Again: ', true)) throw new Error('the passwords differ');
      }
      const r = await admin.addUser(db, { name, password, role: flags.role, who: WHO });
      console.log(`${name} ${r.created ? 'added' : 'updated'} with the role ${flags.role}`);
      return;
    }
    case 'remove': await admin.removeUser(db, name, WHO); console.log(`${name} removed`); return;
    default: throw new Error('kv-admin user list|add|remove');
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });

'use strict';
/*
 * lib/run-as.js - kommandolinjen (kv-admin, test/simulate.js) kobler til databasen slik tjenesten gjør.
 *
 * På serveren kobler tjenesten til PostgreSQL over unix-socket som databasebrukeren kjoreverk, med
 * peer-innlogging: PostgreSQL slipper bare inn OS-brukeren med samme navn. Oppsettfilen kan bare leses
 * av root og gruppen kjoreverk. Derfor kjøres kv-admin med sudo: den leser oppsettfilen (og filene på
 * kommandolinjen) som root, og bytter så til OS-brukeren kjoreverk før den kobler til.
 */

const fs = require('fs');

// kobler oppsettet til over en unix-socket (der peer-innloggingen gjelder)?
// En url som postgres://kjoreverk@/kjoreverk?host=/var/run/postgresql godtar pg, men ikke URL, så den leses for hånd.
function overSocket(db) {
  if (db.url) {
    const q = String(db.url).match(/[?&]host=([^&]*)/);
    if (q) return decodeURIComponent(q[1]).startsWith('/');
    const m = String(db.url).match(/^[a-z]+:\/\/(?:[^@/]*@)?([^/:?]*)/i);
    return !m || m[1] === '' || decodeURIComponent(m[1]).startsWith('/');
  }
  return !db.host || String(db.host).startsWith('/');
}

function dbUser(db) {
  if (db.url) {
    const m = String(db.url).match(/^[a-z]+:\/\/([^@/:]+)(?::[^@/]*)?@/i);
    return m ? decodeURIComponent(m[1]) : null;
  }
  return db.user || null;
}

// Kjører vi som root og kobler over socket: bli OS-brukeren med samme navn som databasebrukeren.
// Returnerer navnet når byttet ble gjort, ellers null (ikke root, TCP, eller ingen slik OS-bruker).
function becomeDbUser(db) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const name = dbUser(db);
  if (!name || name === 'root' || !overSocket(db)) return null;
  try {
    process.initgroups(name, name);
    process.setgid(name);
    process.setuid(name);
  } catch (e) {
    return null;   // ingen OS-bruker med det navnet: koble til som root, og la feilmeldingen forklare
  }
  return name;
}

// en feil fra oppsettfilen eller databasen, med det som skal til for å komme videre
function explain(err, cmd) {
  const msg = String(err && err.message || err);
  const run = cmd || 'kv-admin';
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  if (/settings in .* can't be read: EACCES/.test(msg)) {
    return `${msg}\nThe settings file holds the database settings, so only root and the group kjoreverk can read it. Run it with sudo: sudo ${run} …`;
  }
  const m = msg.match(/Peer authentication failed for user "([^"]+)"/);
  if (m) {
    const u = m[1];
    let user = null;
    try { user = fs.readFileSync('/etc/passwd', 'utf8').split('\n').some(l => l.split(':')[0] === u); } catch (e) { /* ikke Linux */ }
    if (!root) return `${msg}\nPostgreSQL lets only the OS user ${u} in as the database user ${u}. Run it with sudo (sudo ${run} …); it then switches to ${u} before it connects.`;
    if (user === false) return `${msg}\nThere is no OS user named ${u} on this machine to switch to. Make one (sudo useradd --system --shell /usr/sbin/nologin ${u}), or give the database user a password in "db" in the settings file.`;
    return `${msg}\nPostgreSQL lets only the OS user ${u} in as the database user ${u}, and switching to it didn't help. Check pg_hba.conf.`;
  }
  return msg;
}

module.exports = { becomeDbUser, explain, overSocket, dbUser };

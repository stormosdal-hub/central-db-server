'use strict';
/*
 * lib/log.js - én linje per melding, lesbar i journalctl: "15:12:26 info  mottak: ...".
 * Har det Fastify trenger av en logger (trace … fatal, child), så den også brukes der.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function stamp() { return new Date().toISOString().slice(11, 19); }

function text(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (a && typeof a === 'object') {
    // Fastifys { err, req, res, ... }-objekter
    if (a.err instanceof Error) return (a.err.stack || a.err.message) + (a.req ? ` (${a.req.method} ${a.req.url})` : '');
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  return String(a);
}

function makeLogger(level, bindings) {
  let min = LEVELS[level] || LEVELS.info;
  // Fastifys logger per forespørsel (child med reqId): "incoming request" og "request completed" er
  // bare interessante ved feilsøking, så de kommer bare med nivået debug
  if (bindings && bindings.reqId !== undefined && min > LEVELS.debug) min = LEVELS.warn;
  const prefix = bindings && bindings.mod ? `${bindings.mod}: ` : '';
  const out = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const line = `${stamp()} ${lvl.padEnd(5)} ${prefix}${args.map(text).join(' ')}\n`;
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
  };
  const l = { level };
  for (const k of Object.keys(LEVELS)) l[k] = (...a) => out(k, a);
  l.silent = () => {};
  l.child = b => makeLogger(level, Object.assign({}, bindings, b));
  return l;
}

module.exports = makeLogger;

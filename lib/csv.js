'use strict';
/*
 * lib/csv.js - CSV for eksporten (docs/PLAN.md §4.4): skilletegn, desimaltegn og tider.
 *
 *   'no'    ; mellom feltene og desimalkomma, som norsk Excel venter
 *   'intl'  , mellom feltene og desimalpunktum
 * Tider skrives i en tidssone (lokal tid i nettleseren som standard) eller UTC, som 2026-10-30 21:03:13,250.
 * Filen begynner med en BOM, så Excel leser æ, ø og å riktig.
 */

const BOM = '﻿';

// forskyvningen til en tidssone, regnet én gang per time (sommertid skifter på hele timer)
function zoneOffset(tz) {
  if (!tz || tz === 'UTC') return () => 0;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cache = new Map();
  return ms => {
    const hour = Math.floor(ms / 3600000);
    let off = cache.get(hour);
    if (off === undefined) {
      const p = {};
      for (const x of fmt.formatToParts(new Date(hour * 3600000))) p[x.type] = x.value;
      off = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - hour * 3600000;
      if (cache.size > 20000) cache.clear();
      cache.set(hour, off);
    }
    return off;
  };
}

function validZone(tz) {
  if (!tz || tz === 'UTC') return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

const pad = (n, w) => String(n).padStart(w || 2, '0');

// { sep, line(fields), num(v), time(ms), text(s) }
function csvFormat(style, tz) {
  const no = style !== 'intl';
  const sep = no ? ';' : ',';
  const dec = no ? ',' : '.';
  const offset = zoneOffset(tz);
  const needsQuote = new RegExp(`[${sep}"\\r\\n]`);
  const text = s => {
    if (s === null || s === undefined) return '';
    const v = String(s);
    return needsQuote.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const num = v => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '';
    const s = Math.abs(v) >= 1e21 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toFixed(12).replace(/0+$/, '') : String(v);
    return no ? s.replace('.', dec) : s;
  };
  const time = ms => {
    const d = new Date(ms + offset(ms));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${dec}${pad(d.getUTCMilliseconds(), 3)}`;
  };
  return { sep, num, time, text, line: fields => fields.join(sep) + '\r\n' };
}

module.exports = { csvFormat, validZone, zoneOffset, BOM };

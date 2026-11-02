/*
 * dash/charts.js - tegningen widgetene på Kjøreverk-database deler: tidsaksen, feltene i en tidslinje
 * (av/på, tall og tekst), hendelsene og markøren. Alt tegnes på <canvas> i lerretets egne piksler ganger
 * skaleringen i Run-modus, så det er skarpt også forstørret. Pekeren regnes om med størrelsen canvasen
 * faktisk har på skjermen, så flytting og zoom treffer uansett skalering.
 */
(function () {
  'use strict';
  const D = (window.Dash = window.Dash || {});
  const COLORS = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#ff7b72', '#e3b341', '#39c5cf', '#db61a2', '#a5d6ff', '#7ee787', '#ffa657', '#bc8cff'];
  const C = { text: '#e6e8eb', muted: '#8b93a1', faint: '#5c6470', grid: '#2a2f37', line: '#343a44', panel: '#1e2229', panel2: '#262b33', ok: '#3fb950', warn: '#d29922', bad: '#f85149', mark: '#f2b441' };
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const pad = n => String(n).padStart(2, '0');

  // tegneflaten: CSS-størrelsen (uten skaleringen) og en bakgrunn i ekte piksler
  function fit(cv, scale) {
    const w = cv.clientWidth, h = cv.clientHeight;
    const k = (window.devicePixelRatio || 1) * (scale || 1);
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }
  // pekeren i canvasens egne (uskalerte) piksler
  function local(cv, e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * cv.clientWidth / (r.width || 1), y: (e.clientY - r.top) * cv.clientHeight / (r.height || 1) };
  }

  // ---------------------------------------------------------------- tid
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].map(s => s * 1000);
  // tidspunktene for strekene på aksen, i lokal tid, med minst minGap piksler mellom
  function ticks(from, to, px, minGap) {
    const span = to - from;
    if (!(span > 0) || !(px > 0)) return { step: 0, list: [] };
    const step = STEPS.find(s => (span / s) * (minGap || 80) <= px) || STEPS[STEPS.length - 1];
    const list = [];
    if (step >= 86400000) {
      const d = new Date(from); d.setHours(0, 0, 0, 0);
      const days = step / 86400000;
      while (d.getTime() <= to && list.length < 500) { if (d.getTime() >= from) list.push(d.getTime()); d.setDate(d.getDate() + days); }
    } else {
      const off = -new Date(from).getTimezoneOffset() * 60000;
      for (let t = Math.ceil((from + off) / step) * step - off; t <= to && list.length < 500; t += step) list.push(t);
    }
    return { step, list };
  }
  const isMidnight = t => { const d = new Date(t); return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0; };
  function tickLabel(t, step) {
    const d = new Date(t);
    const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
    if (step >= 86400000 || (isMidnight(t) && step >= 60000)) return date;
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return step < 60000 ? `${hm}:${pad(d.getSeconds())}` : hm;
  }
  // et tidspunkt med så mye som trengs: 14:03:22, eller 02.11 14:03:22 når tidsrommet er mer enn et døgn
  function fmtAt(t, span) {
    const d = new Date(t);
    const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return span > 86400000 || !sameDay(t, Date.now()) ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hms}` : hms;
  }
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
    if (s < 86400) return `${Math.floor(s / 3600)} t ${pad(Math.floor((s % 3600) / 60))} min`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} t`;
  }

  // tidsaksen langs y (tekst under), og loddrette linjer opp til top
  function axis(g, x0, x1, y, from, to, top) {
    const { step, list } = ticks(from, to, x1 - x0, 84);
    const x = t => x0 + ((t - from) / (to - from)) * (x1 - x0);
    g.font = `11px ${FONT}`;
    g.textBaseline = 'top';
    g.textAlign = 'center';
    for (const t of list) {
      const px = Math.round(x(t)) + 0.5;
      if (top !== undefined) { g.strokeStyle = C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(px, top); g.lineTo(px, y); g.stroke(); }
      g.fillStyle = isMidnight(t) && step < 86400000 ? C.text : C.muted;
      g.fillText(tickLabel(t, step), Math.min(Math.max(px, x0 + 18), x1 - 18), y + 4);
    }
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(x0, y + 0.5); g.lineTo(x1, y + 0.5); g.stroke();
  }

  // ---------------------------------------------------------------- verdiene
  const isOn = v => v !== null && v !== undefined && v !== 0 && v !== false && v !== '0';
  // verdien i points ved t: den siste med tid <= t (undefined før det første punktet)
  function valueAt(points, t) {
    let lo = 0, hi = points.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (points[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? undefined : points[ans][1];
  }
  // segmentene [fra, til, verdi] mellom from og to; det siste varer til until (dataene rekker ikke lenger)
  function segments(points, from, to, until) {
    const out = [];
    const end = Math.min(to, until === undefined || until === null ? to : until);
    for (let i = 0; i < points.length; i++) {
      const a = points[i][0], b = i + 1 < points.length ? points[i + 1][0] : end;
      if (b < from || a > to || b <= a) continue;
      out.push([Math.max(a, from), Math.min(b, to), points[i][1]]);
    }
    return out;
  }
  // samme tekst får alltid samme farge
  function textColor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return COLORS[Math.abs(h) % COLORS.length];
  }
  function clipText(g, text, max) {
    if (g.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s.length > 1 ? s + '…' : '';
  }

  /*
   * Ett felt i en tidslinje mellom x0 og x1, fra y til y + h:
   *   av/på   en fylt stripe der signalet er på, en tynn linje der det er av
   *   tall    en liten trinnkurve mellom feltets minste og største verdi
   *   tekst   én flate per verdi, med teksten når den får plass
   * null er et hull: ingenting tegnes der.
   */
  function lane(g, item, pts, x0, x1, y, h, from, to, until) {
    const x = t => x0 + ((t - from) / (to - from)) * (x1 - x0);
    const segs = segments(pts, from, to, until);
    const color = item.color;
    if (item.dataType === 'boolean') {
      for (const [a, b, v] of segs) {
        if (v === null) continue;
        const xa = x(a), xb = Math.max(x(b), xa + 1);
        if (isOn(v)) { g.fillStyle = color; g.fillRect(xa, y + 2, xb - xa, h - 4); }
        else { g.fillStyle = C.line; g.fillRect(xa, y + h / 2 - 0.5, xb - xa, 1); }
      }
    } else if (item.dataType === 'string') {
      g.font = `11px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
      for (const [a, b, v] of segs) {
        if (v === null || v === undefined) continue;
        const xa = x(a), xb = Math.max(x(b), xa + 1), s = String(v);
        g.globalAlpha = 0.28; g.fillStyle = textColor(s); g.fillRect(xa, y + 2, xb - xa, h - 4);
        g.globalAlpha = 1; g.fillStyle = textColor(s); g.fillRect(xa, y + 2, 1.5, h - 4);
        const t = clipText(g, s, xb - xa - 8);
        if (t) { g.fillStyle = C.text; g.fillText(t, xa + 5, y + h / 2); }
      }
    } else {
      let lo = Infinity, hi = -Infinity;
      for (const [, , v] of segs) if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) return;
      if (lo === hi) { lo -= 1; hi += 1; }
      const yv = v => y + h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
      g.strokeStyle = color; g.lineWidth = 1.2;
      g.beginPath();
      let open = false;
      for (const [a, b, v] of segs) {
        if (typeof v !== 'number') { open = false; continue; }
        const xa = x(a), xb = x(b), yy = yv(v);
        if (open) g.lineTo(xa, yy); else g.moveTo(xa, yy);
        g.lineTo(xb, yy);
        open = true;
      }
      g.stroke();
    }
  }

  // hendelsene som små trekanter langs en linje; returnerer [{ x, ev }] til pekeren
  const SEV_COLOR = { info: C.muted, warning: C.warn, alarm: C.bad };
  function eventMarks(g, events, x0, x1, y, h, from, to) {
    const x = t => x0 + ((t - from) / (to - from)) * (x1 - x0);
    const out = [];
    const order = { info: 0, warning: 1, alarm: 2 };
    const sorted = events.filter(e => e.ts >= from && e.ts <= to).sort((a, b) => (order[a.severity] || 0) - (order[b.severity] || 0));
    for (const ev of sorted) {
      const px = x(ev.ts), s = Math.min(5, h / 2 - 1);
      g.fillStyle = SEV_COLOR[ev.severity] || C.muted;
      g.beginPath(); g.moveTo(px, y + h / 2 + s); g.lineTo(px - s, y + h / 2 - s); g.lineTo(px + s, y + h / 2 - s); g.closePath(); g.fill();
      out.push({ x: px, ev });
    }
    return out;
  }

  // markøren: en loddrett strek med tiden øverst
  function marker(g, t, x0, x1, top, bottom, from, to) {
    if (t === null || t === undefined || t < from || t > to) return;
    const px = Math.round(x0 + ((t - from) / (to - from)) * (x1 - x0)) + 0.5;
    g.strokeStyle = C.mark; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke();
  }

  // tall med norsk desimalkomma; decimals tom = inntil 3
  function fmtNum(v, decimals) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
    const d = decimals === '' || decimals === undefined || decimals === null ? null : Math.max(0, Math.min(6, Number(decimals) | 0));
    return v.toLocaleString('nb-NO', d === null ? { maximumFractionDigits: 3 } : { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // fine tall på en y-akse
  function niceTicks(lo, hi, n) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }

  D.charts = { COLORS, C, FONT, fit, local, ticks, axis, fmtAt, fmtDur, isOn, valueAt, segments, lane, eventMarks, marker, fmtNum, niceTicks, clipText, textColor, SEV_COLOR };
})();

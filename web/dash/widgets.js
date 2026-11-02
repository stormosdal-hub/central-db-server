/*
 * dash/widgets.js - widgetene på Kjøreverk-database. Hver registreres med D.register(type, def):
 *   name, hint   i paletten
 *   size         [bredde, høyde] når den legges på lerretet
 *   props        egenskapene: { key, label, type: text|textarea|number|select|bool|color, default, options, hint, showIf }
 *   data         dataene den viser, eller utelatt: { label, hint, tags: false (bare kjøreverk), max (kjøreverk),
 *                maxTags (per kjøreverk), types (de som passer, de andre vises grått i velgeren), empty }
 *   plate: false ingen tittellinje; back: true legges bak de andre
 *   mount(body, w, ctx) -> håndtaket (se dash/dash.js)
 * Ny widgettype: kopier en av blokkene nedenfor og registrer en ny nøkkel.
 */
(function () {
  'use strict';
  const D = window.Dash, S = window.Shell, K = D.charts;
  const { el, esc } = S;
  D.widgets = {};
  D.register = (type, def) => { D.widgets[type] = def; };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fsK = w => clamp((Number(w.props.textSize) || 100) / 100, 0.5, 4);
  const nameOf = it => it.label || it.tag;
  const unitOf = (it, p) => (p && p.unit) || it.unit || '';
  // en verdi som tekst: På/Av, tekst eller tall med desimalkomma
  function fmtValue(it, v, p) {
    if (v === undefined) return '–';
    if (v === null) return 'ingen data';
    if (it.dataType === 'boolean') return K.isOn(v) ? (p && p.onText) || 'På' : (p && p.offText) || 'Av';
    if (it.dataType === 'string') return String(v);
    return K.fmtNum(Number(v), p ? p.decimals : '');
  }
  const latestValue = x => (!x ? undefined : x.dataType === 'string' ? x.text : x.value);
  const hint = (body, text) => { body.innerHTML = `<div class="d-wempty">${text}</div>`; };
  const NO_DATA = 'Ingen data valgt ennå. Gå til <b>Edit</b>, klikk på widgeten, og legg til kjøreverk og tagger til høyre.';

  const P = {
    title: d => ({ key: 'title', label: 'Tittel', type: 'text', default: d, hint: 'Står øverst i widgeten. Tom: ingen tittellinje' }),
    textSize: () => ({ key: 'textSize', label: 'Tekststørrelse', type: 'select', options: [['80', 'Liten'], ['100', 'Normal'], ['125', 'Stor'], ['150', 'Større'], ['200', 'Størst']], default: '100' }),
    decimals: () => ({ key: 'decimals', label: 'Desimaler', type: 'number', default: '', min: 0, max: 6, hint: 'Tom: inntil 3' }),
    followMark: () => ({ key: 'followMark', label: 'Vis verdiene ved markøren', type: 'bool', default: true, hint: 'Når noen klikker på et tidspunkt i en tidslinje eller trend, viser widgeten verdiene da. Ellers den siste verdien' }),
    severity: () => ({ key: 'minSeverity', label: 'Hendelser fra', type: 'select', options: [['info', 'Info og oppover'], ['warning', 'Varsler og alarmer'], ['alarm', 'Bare alarmer']], default: 'info' }),
    laneSize: () => ({ key: 'laneSize', label: 'Høyden på hvert felt', type: 'select', options: [['small', 'Lav'], ['medium', 'Normal'], ['large', 'Høy']], default: 'medium' }),
  };
  const TIME_DATA = { label: 'Kjøreverk og tagger', hint: 'Legg til kjøreverk, og tagger under hvert. Et mønster som pls.bit* tar med alle taggene som passer, også nye.' };

  // ================================================================ data over tid, delt av tidslinjen, trenden og listen
  /*
   * Henter punktene (og hendelsene) for tidsrommet, og like mye på hver side, så det er noe å vise mens noen
   * drar. o: { max: tagger, events: () => { vehicles, severity, q, source } | null }
   */
  function timeSource(w, ctx, o) {
    const src = { items: [], series: new Map(), events: [], more: false, notes: [], approx: false, loaded: null, seq: 0, last: 0 };
    src.points = it => (src.series.get(it.key) || {}).points || [];
    src.end = it => { const u = ctx.until(it.vehicle); return u ? Math.min(ctx.now(), u) : ctx.now(); };
    src.fetch = async (reason, px) => {
      const r = ctx.range();
      if (reason === 'tick' && (!r.live || Date.now() - src.last < ctx.liveEvery())) return false;
      const my = ++src.seq;
      const items = await ctx.expand(w.data);
      const from = r.from - r.span / 2, to = Math.max(Math.min(ctx.now(), r.to + r.span / 2), from + 1000);
      const points = Math.round(clamp((px || 600) * 4, 300, 5000));
      const use = items.slice(0, o.max || 64);
      const ev = o.events ? o.events() : null;
      const [series, events] = await Promise.all([
        use.length ? ctx.series(use, from, to, points) : new Map(),
        ev ? ctx.events(Object.assign({ from, to, limit: 1000 }, ev)) : null,
      ]);
      if (my !== src.seq) return false;
      src.items = use;
      src.series = series;
      src.events = events ? events.events : [];
      src.more = !!(events && events.more);
      src.loaded = { from, to };
      src.last = Date.now();
      src.notes = [];
      if (items.length > use.length) src.notes.push(`Viser ${use.length} av ${items.length} tagger`);
      const missing = use.filter(it => it.missing);
      if (missing.length) src.notes.push(`Finnes ikke: ${missing.slice(0, 4).map(it => `${it.vehicle} ${it.tag}`).join(', ')}${missing.length > 4 ? ' …' : ''}`);
      if (src.more) src.notes.push('Bare de nyeste 1000 hendelsene: kort ned tidsrommet for å se alle');
      src.approx = use.some(it => { const s = series.get(it.key); return s && s.source && !/^raw/.test(s.source); });
      return true;
    };
    return src;
  }
  // hendelsene til en widget: kjøreverkene den har (alle, når den ikke har noen og allWhenEmpty)
  const eventOpts = (w, allWhenEmpty) => {
    const vehicles = [...new Set(w.data.map(d => d.vehicle))];
    if (!vehicles.length && !allWhenEmpty) return null;
    return { vehicles, severity: w.props.minSeverity === 'info' ? '' : w.props.minSeverity, q: (w.props.q || '').trim(), source: (w.props.source || '').trim() };
  };
  function footer(host) {
    const f = el('div', { class: 'd-foot' });
    host.appendChild(f);
    return (src, extra) => {
      const parts = (extra || []).concat(src.notes);
      if (src.approx) parts.push('Lange tidsrom vises fra sammendragene per minutt eller time: zoom inn for hver endring');
      f.textContent = parts.join(' · ');
      f.hidden = !parts.length;
    };
  }

  // pekeren i en tidslinje eller trend (Run-modus): dra sidelengs for å gå i tid, rull for å zoome, klikk for
  // markøren. geo() -> { x0, x1 }; scroll(dy) for felt som ruller opp og ned
  function timeControls(cv, ctx, geo, o) {
    let drag = null;
    const tAt = x => { const g = geo(), r = ctx.range(); return r.from + ((x - g.x0) / (g.x1 - g.x0)) * r.span; };
    cv.addEventListener('pointerdown', e => {
      if (ctx.mode() !== 'run' || e.button !== 0) return;
      const q = K.local(cv, e);
      drag = { x: q.x, y: q.y, r: ctx.range(), moved: false, labels: q.x < geo().x0 };
      if (o.scrollStart) o.scrollStart();
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      const q = K.local(cv, e);
      if (!drag) { if (ctx.mode() === 'run') o.hover(q, tAt(q.x)); return; }
      if (e.buttons === 0) { drag = null; return; }
      const dx = q.x - drag.x, dy = q.y - drag.y;
      if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      drag.moved = true;
      o.hover(null);
      if (o.scroll && Math.abs(dy) > Math.abs(dx) / 2) o.scroll(dy);
      if (!drag.labels && Math.abs(dx) >= 1) {
        const g = geo(), shift = -dx / (g.x1 - g.x0) * drag.r.span;
        ctx.setRange(drag.r.from + shift, drag.r.to + shift);
      }
    });
    const up = e => {
      const d = drag;
      drag = null;
      if (!d || d.moved || d.labels) return;
      const q = K.local(cv, e);
      if (q.x >= geo().x0 && q.x <= geo().x1) ctx.setMark(tAt(q.x));
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { drag = null; });
    cv.addEventListener('pointerleave', () => { if (!drag) o.hover(null); });
    cv.addEventListener('wheel', e => {
      if (ctx.mode() !== 'run') return;
      const q = K.local(cv, e);
      e.preventDefault();
      if (q.x < geo().x0 && o.wheelScroll) { o.wheelScroll(e.deltaY); return; }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { ctx.pan((e.deltaX || e.deltaY) > 0 ? 0.1 : -0.1); return; }
      ctx.zoom(tAt(q.x), e.deltaY > 0 ? 1.25 : 0.8);
    }, { passive: false });
    return { tAt };
  }
  // et lite vindu ved pekeren, inne i box (koordinatene er lerretets egne, så det følger skaleringen)
  function tipper(box) {
    const tip = el('div', { class: 'd-tip', hidden: '' });
    box.appendChild(tip);
    return (q, html) => {
      if (!q || !html) { tip.hidden = true; return; }
      tip.innerHTML = html;
      tip.hidden = false;
      const bw = box.clientWidth, bh = box.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = (q.x + 14 + tw > bw ? Math.max(0, q.x - tw - 10) : q.x + 14) + 'px';
      tip.style.top = (q.y + 14 + th > bh ? Math.max(0, q.y - th - 8) : q.y + 14) + 'px';
    };
  }
  const evHtml = (ev, span) => `<div class="d-tipev"><span class="sev ${esc(ev.severity)}"></span>${esc(K.fmtAt(ev.ts, span))} <b>${esc(ev.source)}</b> ${esc(ev.message)}</div>`;

  // ================================================================ tidslinjen
  function timelineView(host, w, ctx, src) {
    const p = w.props, k = fsK(w);
    const box = el('div', { class: 'd-canvasbox' });
    const cv = document.createElement('canvas');
    box.appendChild(cv);
    host.appendChild(box);
    const tip = tipper(box);
    const laneH = Math.round(({ small: 16, medium: 22, large: 30 }[p.laneSize] || 22) * Math.min(k, 2));
    const headH = Math.round(20 * Math.min(k, 2)), axisH = 22;
    let scrollY = 0, lay = { rows: [], x0: 100, x1: 200, avail: 0 };

    function rows() {
      const r = ctx.range(), byV = new Map(w.data.map(d => [d.vehicle, []]));
      for (const it of src.items) { if (!byV.has(it.vehicle)) byV.set(it.vehicle, []); byV.get(it.vehicle).push(it); }
      const out = [];
      for (const [code, items] of byV) {
        const shown = p.hideOff ? items.filter(it => it.dataType !== 'boolean' || K.segments(src.points(it), r.from, r.to, src.end(it)).some(s => K.isOn(s[2]))) : items;
        out.push({ head: true, code, events: p.events !== false ? src.events.filter(e => e.code === code) : [], marks: [] });
        for (const it of shown) out.push({ item: it });
      }
      return out;
    }
    function draw() {
      if (!cv.isConnected) return;
      const { g, w: W, h: H } = K.fit(cv, ctx.scale());
      const r = ctx.range();
      const x0 = Math.round(clamp(W * 0.28, 70, 230) * Math.min(k, 1.6)), x1 = W - 6, avail = H - axisH;
      const rs = rows();
      const total = rs.reduce((a, x) => a + (x.head ? headH : laneH), 0);
      scrollY = clamp(scrollY, 0, Math.max(0, total - avail));
      K.axis(g, x0, x1, avail, r.from, r.to, 0);
      g.save();
      g.beginPath(); g.rect(0, 0, W, avail); g.clip();
      let y = -scrollY;
      const out = [];
      for (const row of rs) {
        const h = row.head ? headH : laneH;
        if (y + h > 0 && y < avail) drawRow(g, row, y, h, x0, x1, r, W);
        out.push({ y, h, row });
        y += h;
      }
      K.marker(g, ctx.mark(), x0, x1, 0, avail, r.from, r.to);
      g.restore();
      if (total > avail) {
        const th = Math.max(20, avail * avail / total), ty = (avail - th) * scrollY / (total - avail);
        g.fillStyle = 'rgba(139,147,161,.35)'; g.fillRect(W - 4, ty, 3, th);
      }
      if (!w.data.length) {
        g.fillStyle = K.C.muted; g.font = `12px ${K.FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('Ingen data valgt ennå: legg til kjøreverk og tagger i Edit-modus', W / 2, avail / 2);
      }
      lay = { rows: out, x0, x1, avail };
    }
    function drawRow(g, row, y, h, x0, x1, r, W) {
      g.textBaseline = 'middle'; g.textAlign = 'left';
      if (row.head) {
        g.fillStyle = K.C.panel2; g.fillRect(0, y, W, h);
        g.font = `600 ${Math.round(12 * k)}px ${K.FONT}`; g.fillStyle = K.C.text;
        const code = K.clipText(g, row.code, x0 - 12);
        g.fillText(code, 6, y + h / 2);
        const cw = g.measureText(code).width;
        g.font = `${Math.round(11 * k)}px ${K.FONT}`; g.fillStyle = K.C.muted;
        const name = K.clipText(g, ctx.vehicleName(row.code), x0 - 18 - cw);
        if (name) g.fillText(name, 12 + cw, y + h / 2);
        row.marks = row.events.length ? K.eventMarks(g, row.events, x0, x1, y, h, r.from, r.to) : [];
        return;
      }
      const it = row.item;
      g.fillStyle = it.color; g.fillRect(6, y + h / 2 - 4, 3, 8);
      g.font = `${Math.round(11.5 * k)}px ${K.FONT}`; g.fillStyle = it.missing ? K.C.faint : K.C.text;
      g.fillText(K.clipText(g, nameOf(it), x0 - 22), 14, y + h / 2);
      g.strokeStyle = K.C.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, y + h - 0.5); g.lineTo(x1, y + h - 0.5); g.stroke();
      const lane = p.color && it.dataType === 'boolean' ? Object.assign({}, it, { color: p.color }) : it;
      K.lane(g, lane, src.points(it), x0, x1, y, h, r.from, r.to, src.end(it));
    }
    function hover(q, t) {
      if (!q || q.x < lay.x0 || q.y > lay.avail) { tip(null); return; }
      const hit = lay.rows.find(l => q.y >= l.y && q.y < l.y + l.h);
      if (!hit) { tip(null); return; }
      const r = ctx.range();
      if (hit.row.head) {
        const near = hit.row.marks.filter(m => Math.abs(m.x - q.x) <= 6).map(m => m.ev);
        tip(q, near.length ? near.slice(0, 6).map(ev => evHtml(ev, r.span)).join('') + (near.length > 6 ? `<div class="muted">… og ${near.length - 6} til</div>` : '') : '');
        return;
      }
      const it = hit.row.item, pts = src.points(it);
      const seg = K.segments(pts, src.loaded ? src.loaded.from : r.from, r.to + r.span, src.end(it)).find(s => s[0] <= t && t < s[1]);
      const head = `<b>${esc(it.vehicle)} · ${esc(nameOf(it))}</b>${it.label ? ` <span class="muted">${esc(it.tag)}</span>` : ''}`;
      if (!seg) { tip(q, `${head}<div class="muted">ingen data her</div>`); return; }
      const v = fmtValue(it, seg[2], p) + (it.dataType === 'number' && it.unit ? ' ' + it.unit : '');
      tip(q, `${head}<div><b>${esc(v)}</b> · ${esc(K.fmtAt(seg[0], r.span))} – ${esc(K.fmtAt(seg[1], r.span))} <span class="muted">(${esc(K.fmtDur(seg[1] - seg[0]))})</span></div>`);
    }
    const scroll = { start: 0 };
    timeControls(cv, ctx, () => lay, {
      hover,
      scrollStart: () => { scroll.start = scrollY; },
      scroll: dy => { scrollY = scroll.start - dy; draw(); },
      wheelScroll: dy => { scrollY += dy; draw(); },
    });
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    return { draw, destroy: () => ro.disconnect() };
  }

  // ================================================================ hendelseslisten
  /*
   * Hendelsene fra recorderne og endringene i taggene, nyeste først. Av/på og tekst er med; tall bare når
   * numbers er krysset av (de endrer seg ofte). Et klikk på en rad setter markøren der.
   */
  function eventListView(host, w, ctx, src) {
    const p = w.props;
    const list = el('div', { class: 'd-evlist' });
    host.appendChild(list);
    let rows = [], raf = 0, hovering = false;
    const same = (it, a, b) => (it.dataType === 'boolean' ? K.isOn(a) === K.isOn(b) : a === b);
    function build() {
      const r = ctx.range(), out = [];
      for (const e of src.events) if (e.ts >= r.from && e.ts <= r.to) out.push({ ts: e.ts, code: e.code, sev: e.severity, ev: e });
      if (p.changes !== false) {
        for (const it of src.items) {
          if (it.dataType === 'number' && !p.numbers) continue;
          let prev;
          for (const [t, v] of src.points(it)) {
            if (v === null) continue;
            if (prev !== undefined && !same(it, prev, v) && t >= r.from && t <= r.to) out.push({ ts: t, code: it.vehicle, item: it, from: prev, to: v });
            prev = v;
          }
        }
      }
      return out.sort((a, b) => b.ts - a.ts);
    }
    function change(x) {
      const it = x.item;
      if (it.dataType === 'boolean') return K.isOn(x.to) ? `<span class="on">${esc(p.onText || 'på')}</span>` : `<span class="off">${esc(p.offText || 'av')}</span>`;
      if (it.dataType === 'string') return `→ «${esc(x.to)}»`;
      return `${esc(K.fmtNum(x.from))} → <b>${esc(K.fmtNum(x.to))}</b>${it.unit ? ' ' + esc(it.unit) : ''}`;
    }
    // de nyeste rows-radene, eller like mange rundt markøren når den står lenger bak
    let start = 0, shown = 0;
    const atIndex = () => { const m = ctx.mark(); return m === null ? -1 : rows.findIndex(x => x.ts <= m); };
    function render() {
      raf = 0;
      if (!w.data.length && !src.events.length) { list.innerHTML = `<div class="d-wempty">${NO_DATA}</div>`; return; }
      rows = build();
      const max = clamp(Number(p.rows) || 300, 10, 2000), span = ctx.range().span, at = atIndex();
      start = at >= max - 10 ? Math.min(at - Math.floor(max / 2), Math.max(0, rows.length - max)) : 0;
      shown = Math.min(max, rows.length - start);
      list.innerHTML = (start ? `<div class="d-more">… ${start} nyere</div>` : '') + rows.slice(start, start + max).map((x, j) => x.ev
        ? `<div class="d-evr" data-i="${j + start}"><time>${esc(K.fmtAt(x.ts, span))}</time><span class="code">${esc(x.code)}</span><span class="sev ${esc(x.sev)}"></span><span class="msg"><b>${esc(x.ev.source)}</b> ${esc(x.ev.message)}</span></div>`
        : `<div class="d-evr chg" data-i="${j + start}"><time>${esc(K.fmtAt(x.ts, span))}</time><span class="code">${esc(x.code)}</span><span class="sev chg" style="--c:${esc(x.item.color)}"></span><span class="msg"><b title="${esc(x.item.tag)}">${esc(nameOf(x.item))}</b> ${change(x)}</span></div>`).join('')
        + (rows.length > start + max ? `<div class="d-more">… og ${rows.length - start - max} eldre. Kort ned tidsrommet, sett markøren lenger bak, eller øk «Rader» i Edit-modus.</div>` : '')
        + (!rows.length ? '<div class="d-wempty">Ingen hendelser eller endringer i tidsrommet</div>' : '');
      mark();
    }
    // raden ved markøren: den siste som skjedde før (eller ved) markøren
    function mark() {
      const old = list.querySelector('.d-evr.at');
      if (old) old.classList.remove('at');
      const i = atIndex();
      if (i < 0) return;
      if (i < start || i >= start + shown) { render(); return; }
      const row = list.querySelector(`.d-evr[data-i="${i}"]`);
      if (row) { row.classList.add('at'); if (!hovering) row.scrollIntoView({ block: 'nearest' }); }
    }
    list.addEventListener('click', e => {
      const row = e.target.closest('.d-evr');
      if (!row || ctx.mode() !== 'run') return;
      const x = rows[Number(row.dataset.i)];
      if (x) ctx.setMark(x.ts);
    });
    list.addEventListener('mouseenter', () => { hovering = true; });
    list.addEventListener('mouseleave', () => { hovering = false; });
    return { draw: () => { if (!raf) raf = requestAnimationFrame(render); }, mark, count: () => rows.length };
  }

  // ================================================================ trenden
  function trendView(host, w, ctx, src) {
    const p = w.props, k = fsK(w);
    const legend = el('div', { class: 'd-legend' });
    const box = el('div', { class: 'd-canvasbox' });
    const cv = document.createElement('canvas');
    box.appendChild(cv);
    host.append(legend, box);
    let lay = { x0: 50, x1: 100 }, hoverT = null, legendKey = '';
    const shown = () => src.items.filter(it => it.dataType !== 'string');

    function draw() {
      if (!cv.isConnected) return;
      const { g, w: W, h: H } = K.fit(cv, ctx.scale());
      const r = ctx.range(), items = shown();
      const nums = items.filter(it => it.dataType !== 'boolean'), bools = items.filter(it => it.dataType === 'boolean');
      const units = p.oneAxis ? [''] : [...new Set(nums.map(it => it.unit || ''))];
      const unitOfIt = it => (p.oneAxis ? '' : it.unit || '');
      const fs = Math.round(11 * Math.min(k, 2));
      const axisL = Math.round(54 * Math.min(k, 1.6)), axisR = units.length > 1 ? axisL : 12;
      const axisY = H - 20, plotTop = 8;
      // av/på under kurvene: høyst 40 % av høyden når det også er tall, ellers hele
      const room = (axisY - plotTop) * (nums.length ? 0.4 : 1);
      const laneH = bools.length ? clamp(Math.floor(room / bools.length), 5, Math.round((nums.length ? 14 : 22) * Math.min(k, 2))) : 0;
      const plotBottom = axisY - (bools.length ? bools.length * laneH + (nums.length ? 6 : 0) : 0);
      const x0 = axisL, x1 = W - axisR;
      lay = { x0, x1 };
      K.axis(g, x0, x1, axisY, r.from, r.to, plotTop);
      // en skala per enhet: minste og største synlige verdi, eller Min/Maks fra egenskapene
      const scales = new Map();
      for (const u of units) {
        let lo = Infinity, hi = -Infinity;
        for (const it of nums.filter(x => unitOfIt(x) === u)) for (const [, , v] of K.segments(src.points(it), r.from, r.to, src.end(it))) if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (p.yMin !== '' && p.yMin !== undefined && p.yMin !== null) lo = Number(p.yMin);
        if (p.yMax !== '' && p.yMax !== undefined && p.yMax !== null) hi = Number(p.yMax);
        if (lo === Infinity || hi === -Infinity) { lo = 0; hi = 1; }
        if (lo === hi) { lo -= 1; hi += 1; }
        const padY = p.yMin === '' || p.yMax === '' ? (hi - lo) * 0.06 : 0;
        scales.set(u, { lo: p.yMin === '' ? lo - padY : lo, hi: p.yMax === '' ? hi + padY : hi });
      }
      const yOf = (u, v) => { const s = scales.get(u); return plotBottom - ((v - s.lo) / (s.hi - s.lo)) * (plotBottom - plotTop); };
      g.font = `${fs}px ${K.FONT}`; g.textBaseline = 'middle';
      (nums.length ? units.slice(0, 2) : []).forEach((u, i) => {
        const s = scales.get(u);
        for (const v of K.niceTicks(s.lo, s.hi, Math.max(2, Math.floor((plotBottom - plotTop) / 40)))) {
          const y = Math.round(yOf(u, v)) + 0.5;
          if (i === 0) { g.strokeStyle = K.C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
          g.fillStyle = K.C.muted; g.textAlign = i === 0 ? 'right' : 'left';
          g.fillText(K.fmtNum(v), i === 0 ? x0 - 5 : x1 + 5, y);
        }
        if (u) { g.save(); g.fillStyle = K.C.faint; g.textAlign = i === 0 ? 'left' : 'right'; g.textBaseline = 'top'; g.fillText(u, i === 0 ? 4 : W - 4, 0); g.restore(); }
      });
      g.save();
      g.beginPath(); g.rect(x0, plotTop - 2, x1 - x0, plotBottom - plotTop + 4); g.clip();
      const x = t => x0 + ((t - r.from) / r.span) * (x1 - x0);
      for (const it of nums) {
        const u = unitOfIt(it);
        g.strokeStyle = it.color; g.lineWidth = 1.6; g.lineJoin = 'round';
        g.beginPath();
        let open = false;
        for (const [a, b, v] of K.segments(src.points(it), r.from, r.to, src.end(it))) {
          if (typeof v !== 'number') { open = false; continue; }
          const y = yOf(u, v);
          if (open) g.lineTo(x(a), y); else g.moveTo(x(a), y);
          g.lineTo(x(b), y);
          open = true;
        }
        g.stroke();
      }
      g.restore();
      bools.forEach((it, i) => {
        const y = plotBottom + (nums.length ? 6 : 0) + i * laneH;
        K.lane(g, it, src.points(it), x0, x1, y, laneH, r.from, r.to, src.end(it));
        if (laneH < 9) return;
        g.fillStyle = K.C.muted; g.font = `${Math.min(laneH - 2, Math.round(10 * Math.min(k, 2)))}px ${K.FONT}`; g.textAlign = 'right'; g.textBaseline = 'middle';
        g.fillText(K.clipText(g, nameOf(it), axisL - 6), x0 - 5, y + laneH / 2);
      });
      if (hoverT !== null) { g.strokeStyle = K.C.muted; g.lineWidth = 1; g.setLineDash([3, 3]); const hx = Math.round(x(hoverT)) + 0.5; g.beginPath(); g.moveTo(hx, plotTop); g.lineTo(hx, axisY); g.stroke(); g.setLineDash([]); }
      K.marker(g, ctx.mark(), x0, x1, plotTop, axisY, r.from, r.to);
      if (!items.length) {
        g.fillStyle = K.C.muted; g.font = `12px ${K.FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(w.data.length ? 'Ingen tall eller av/på-signaler blant taggene' : 'Ingen data valgt ennå: legg til kjøreverk og tagger i Edit-modus', (x0 + x1) / 2, (plotTop + plotBottom) / 2);
      }
      renderLegend();
    }
    // forklaringen: fargen, navnet og verdien ved pekeren, markøren eller den siste i tidsrommet
    function renderLegend() {
      const items = shown(), r = ctx.range();
      const key = items.map(it => it.key + it.color).join();
      if (key !== legendKey) {
        legendKey = key;
        legend.innerHTML = items.map(it => `<span title="${esc(it.vehicle + ' ' + it.tag)}"><i style="background:${esc(it.color)}"></i>${w.data.length > 1 ? esc(it.vehicle) + ' · ' : ''}${esc(nameOf(it))} <b data-k="${esc(it.key)}"></b></span>`).join('');
      }
      const t = hoverT !== null ? hoverT : ctx.mark() !== null && ctx.mark() >= r.from && ctx.mark() <= r.to ? ctx.mark() : Math.min(r.to, ctx.now());
      for (const it of items) {
        const b = legend.querySelector(`b[data-k="${CSS.escape(it.key)}"]`);
        if (!b) continue;
        const v = K.valueAt(src.points(it), Math.min(t, src.end(it)));
        b.textContent = fmtValue(it, v, p) + (it.dataType === 'number' && it.unit && v !== undefined && v !== null ? ' ' + it.unit : '');
      }
    }
    timeControls(cv, ctx, () => lay, { hover: (q, t) => { hoverT = q && q.x >= lay.x0 && q.x <= lay.x1 ? t : null; draw(); } });
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    return { draw, destroy: () => ro.disconnect() };
  }

  // ================================================================ widgetene
  D.register('eventline', {
    name: 'Hendelser med tidslinje', hint: 'Tidslinje over, liste under: hendelser og endringer', size: [760, 460],
    data: TIME_DATA,
    props: [
      P.title('Hendelser'),
      { key: 'split', label: 'Tidslinjen tar', type: 'select', options: [['35', '35 %'], ['50', 'Halvparten'], ['65', '65 %']], default: '50' },
      { key: 'events', label: 'Hendelser fra recorderne i tidslinjen', type: 'bool', default: true, hint: 'Små trekanter på linjen til hvert kjøreverk. Hold pekeren over for å lese dem' },
      P.severity(),
      { key: 'q', label: 'Hendelser med teksten', type: 'text', default: '', hint: 'Tom: alle' },
      { key: 'changes', label: 'Endringene i taggene i listen', type: 'bool', default: true, hint: 'Når et av/på-signal slår seg av eller på, eller en tekst endres' },
      { key: 'numbers', label: 'Også tall i listen', type: 'bool', default: false, showIf: p => p.changes !== false, hint: 'Tall endrer seg ofte, så listen kan bli lang' },
      { key: 'hideOff', label: 'Skjul signaler som er av hele tiden', type: 'bool', default: false },
      P.laneSize(),
      { key: 'rows', label: 'Rader i listen', type: 'number', default: 300, min: 10, max: 2000 },
      { key: 'color', label: 'Farge for på', type: 'color', default: '', fallback: '#3fb950', hint: 'Standard: fargen til hver tag' },
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-split');
      const top = el('div', { class: 'd-part' }), bottom = el('div', { class: 'd-part d-list' });
      top.style.flex = `${Number(w.props.split) || 50} 1 0`;
      bottom.style.flex = `${100 - (Number(w.props.split) || 50)} 1 0`;
      body.append(top, bottom);
      const src = timeSource(w, ctx, { max: 64, events: () => eventOpts(w, false) });
      const tl = timelineView(top, w, ctx, src), list = eventListView(bottom, w, ctx, src);
      const foot = footer(body);
      const draw = () => { tl.draw(); list.draw(); };
      return {
        async refresh(reason) { if (await src.fetch(reason, top.clientWidth)) { draw(); foot(src); } },
        view: draw, redraw: tl.draw, mark: () => { tl.draw(); list.mark(); }, destroy: tl.destroy,
      };
    },
  });

  D.register('timeline', {
    name: 'Tidslinje', hint: 'Av/på, tall og tekst over tid, gruppert per kjøreverk', size: [640, 300],
    data: TIME_DATA,
    props: [
      P.title('Tidslinje'),
      { key: 'events', label: 'Hendelser fra recorderne', type: 'bool', default: true, hint: 'Små trekanter på linjen til hvert kjøreverk. Hold pekeren over for å lese dem' },
      { key: 'minSeverity', label: 'Hendelser fra', type: 'select', options: [['info', 'Info og oppover'], ['warning', 'Varsler og alarmer'], ['alarm', 'Bare alarmer']], default: 'info', showIf: p => p.events !== false },
      { key: 'hideOff', label: 'Skjul signaler som er av hele tiden', type: 'bool', default: false },
      P.laneSize(),
      { key: 'color', label: 'Farge for på', type: 'color', default: '', fallback: '#3fb950', hint: 'Standard: fargen til hver tag' },
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-col');
      const src = timeSource(w, ctx, { max: 96, events: () => (w.props.events !== false ? eventOpts(w, false) : null) });
      const tl = timelineView(body, w, ctx, src);
      const foot = footer(body);
      return {
        async refresh(reason) { if (await src.fetch(reason, body.clientWidth)) { tl.draw(); foot(src); } },
        view: tl.draw, redraw: tl.draw, mark: tl.draw, destroy: tl.destroy,
      };
    },
  });

  D.register('events', {
    name: 'Hendelsesliste', hint: 'Hendelser og alarmer, og endringer i taggene', size: [520, 300],
    data: Object.assign({}, TIME_DATA, { empty: 'Ingen kjøreverk valgt: hendelsene fra alle kjøreverkene. Legg til tagger for å få med endringene deres.' }),
    props: [
      P.title('Hendelser'),
      P.severity(),
      { key: 'q', label: 'Med teksten', type: 'text', default: '', hint: 'Tom: alle' },
      { key: 'source', label: 'Fra kilden', type: 'text', default: '', hint: 'Del av kilden, for eksempel pls.words_0. Tom: alle' },
      { key: 'changes', label: 'Endringene i taggene', type: 'bool', default: true, hint: 'Når et av/på-signal slår seg av eller på, eller en tekst endres' },
      { key: 'numbers', label: 'Også tall', type: 'bool', default: false, showIf: p => p.changes !== false, hint: 'Tall endrer seg ofte, så listen kan bli lang' },
      { key: 'rows', label: 'Rader', type: 'number', default: 300, min: 10, max: 2000 },
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-col');
      const src = timeSource(w, ctx, { max: 64, events: () => eventOpts(w, true) });
      const list = eventListView(body, w, ctx, src);
      const foot = footer(body);
      return {
        async refresh(reason) { if (await src.fetch(reason, 600)) { list.draw(); foot(src); } },
        view: list.draw, mark: list.mark,
      };
    },
  });

  D.register('trend', {
    name: 'Trend', hint: 'Tall som kurver, av/på som felt under', size: [640, 320],
    data: Object.assign({}, TIME_DATA, { types: ['number', 'boolean'] }),
    props: [
      P.title('Trend'),
      { key: 'oneAxis', label: 'Én felles y-akse', type: 'bool', default: false, hint: 'Ellers én skala per enhet, med de to første som akser til venstre og høyre' },
      { key: 'yMin', label: 'Min', type: 'number', default: '', hint: 'Tom: etter verdiene' },
      { key: 'yMax', label: 'Maks', type: 'number', default: '', hint: 'Tom: etter verdiene' },
      P.decimals(),
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-col');
      const src = timeSource(w, ctx, { max: 24 });
      const tr = trendView(body, w, ctx, src);
      const foot = footer(body);
      return {
        async refresh(reason) { if (await src.fetch(reason, body.clientWidth)) { tr.draw(); foot(src, src.items.some(it => it.dataType === 'string') ? ['Tekst vises i Tidslinje, ikke her'] : []); } },
        view: tr.draw, redraw: tr.draw, mark: tr.draw, destroy: tr.destroy,
      };
    },
  });

  // ---------------------------------------------------------------- siste verdi, eller verdien ved markøren
  // henter verdiene: { items, values: Map(key -> { v, ts }), at: markøren eller null }
  async function currentValues(w, ctx) {
    const items = await ctx.expand(w.data);
    const m = ctx.mark();
    if (m !== null && w.props.followMark !== false) {
      const got = await ctx.valuesAt(items, m);
      return { items, at: m, values: new Map([...got].map(([k, x]) => [k, { v: x.value, ts: m }])) };
    }
    const got = await ctx.latest(items);
    return { items, at: null, values: new Map(items.map(it => { const x = got.get(it.key); return [it.key, { v: latestValue(x), ts: x ? x.ts : null }]; })) };
  }
  // latest: hver tick; ved markøren: bare når markøren flyttes
  function valueWidget(w, ctx, render) {
    let seq = 0;
    const refresh = async reason => {
      if (reason === 'tick' && ctx.mark() !== null && w.props.followMark !== false) return;
      const my = ++seq;
      const r = await currentValues(w, ctx);
      if (my === seq) render(r);
    };
    return { refresh, mark: () => refresh('mark').catch(() => {}) };
  }
  const atText = (r, span) => (r.at !== null ? `ved ${K.fmtAt(r.at, span || 0)}` : '');

  D.register('value', {
    name: 'Verdi', hint: 'Én tag fra ett kjøreverk, stort', size: [240, 140],
    data: { label: 'Kjøreverk og tag', max: 1, maxTags: 1, hint: 'Ett kjøreverk og én tag' },
    props: [
      P.title(''),
      P.decimals(),
      { key: 'unit', label: 'Enhet', type: 'text', default: '', hint: 'Tom: enheten fra PLS-en' },
      { key: 'onText', label: 'Tekst for på', type: 'text', default: 'På' },
      { key: 'offText', label: 'Tekst for av', type: 'text', default: 'Av' },
      { key: 'warnAbove', label: 'Rød over', type: 'number', default: '' },
      { key: 'warnBelow', label: 'Rød under', type: 'number', default: '' },
      P.followMark(),
      { key: 'color', label: 'Farge', type: 'color', default: '', fallback: '#f2b441' },
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-value');
      if (!w.data.length || !w.data[0].tags.length) { hint(body, NO_DATA); return {}; }
      body.innerHTML = '<div class="d-read"><span class="d-lamp" hidden></span><span class="d-num">–</span><span class="d-unit"></span></div><div class="d-sub"></div>';
      const num = body.querySelector('.d-num'), unit = body.querySelector('.d-unit'), sub = body.querySelector('.d-sub'), lamp = body.querySelector('.d-lamp');
      const p = w.props;
      // et tall som er for bredt, krymper til det får plass: «1 128,…» leses som noe annet enn 1 128,94
      const fit = () => {
        num.style.fontSize = '';
        if (num.classList.contains('text')) return;
        const room = body.clientWidth - 20 - (unit.offsetWidth ? unit.offsetWidth + 6 : 0) - (lamp.hidden ? 0 : lamp.offsetWidth + 6);
        if (num.scrollWidth > room && room > 0) num.style.fontSize = Math.max(9, parseFloat(getComputedStyle(num).fontSize) * room / num.scrollWidth * 0.97) + 'px';
      };
      const ro = new ResizeObserver(fit);
      ro.observe(body);
      const h = valueWidget(w, ctx, r => {
        const it = r.items[0];
        if (!it) { num.textContent = '–'; sub.textContent = 'finnes ikke'; return; }
        const x = r.values.get(it.key) || {};
        num.textContent = fmtValue(it, x.v, p);
        unit.textContent = it.dataType === 'number' && x.v !== null && x.v !== undefined ? unitOf(it, p) : '';
        lamp.hidden = it.dataType !== 'boolean';
        lamp.classList.toggle('on', it.dataType === 'boolean' && K.isOn(x.v));
        const n = Number(x.v);
        const alarm = it.dataType === 'number' && typeof x.v === 'number' && ((p.warnAbove !== '' && n > Number(p.warnAbove)) || (p.warnBelow !== '' && n < Number(p.warnBelow)));
        num.classList.toggle('alarm', alarm);
        num.classList.toggle('text', it.dataType === 'string');
        num.classList.toggle('off', it.dataType === 'boolean' && !K.isOn(x.v));
        sub.textContent = `${it.vehicle} · ${nameOf(it)} · ${r.at !== null ? atText(r) : x.ts ? S.ago(x.ts) : 'ingen verdi'}`;
        sub.title = `${it.vehicle} ${it.tag}${x.ts ? '\n' + S.fmtTime(x.ts) : ''}`;
        fit();
      });
      h.destroy = () => ro.disconnect();
      return h;
    },
  });

  D.register('table', {
    name: 'Tabell', hint: 'Kjøreverk mot tagger: sammenlign verdiene', size: [560, 240],
    data: { label: 'Kjøreverk og tagger', hint: 'Én rad per kjøreverk og én kolonne per tag. Med «Samme tagger på alle» blir tabellen fullstendig.' },
    props: [
      P.title('Sammenligning'),
      { key: 'flip', label: 'Kjøreverkene som kolonner', type: 'bool', default: false },
      P.decimals(),
      { key: 'age', label: 'Vis når verdiene kom', type: 'bool', default: true },
      P.followMark(),
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-tablebox');
      if (!w.data.length) { hint(body, NO_DATA); return {}; }
      const p = w.props;
      return valueWidget(w, ctx, r => {
        const codes = [...new Set(w.data.map(d => d.vehicle))];
        const cols = [], byTag = new Map();
        for (const it of r.items) if (!byTag.has(it.tag)) { byTag.set(it.tag, it); cols.push(it.tag); }
        const cell = (code, tag) => {
          const it = r.items.find(x => x.vehicle === code && x.tag === tag);
          if (!it) return '<td class="muted">·</td>';
          const x = r.values.get(it.key) || {};
          const cls = it.dataType === 'boolean' && x.v !== undefined && x.v !== null ? (K.isOn(x.v) ? 'on' : 'off') : '';
          const u = it.dataType === 'number' && x.v !== undefined && x.v !== null && it.unit ? ` <small>${esc(it.unit)}</small>` : '';
          return `<td class="${it.dataType === 'number' ? 'num ' : ''}${cls}" title="${esc(x.ts ? S.fmtTime(x.ts) : '')}">${esc(fmtValue(it, x.v, p))}${u}</td>`;
        };
        const newest = code => Math.max(0, ...r.items.filter(x => x.vehicle === code).map(x => (r.values.get(x.key) || {}).ts || 0));
        const head = tag => { const it = byTag.get(tag); return `<span title="${esc(tag)}">${esc(nameOf(it))}</span>${it.unit && p.flip ? ` <small>${esc(it.unit)}</small>` : ''}`; };
        const numCol = tag => (byTag.get(tag).dataType === 'number' ? ' class="num"' : '');
        let html;
        if (!p.flip) {
          html = `<table><thead><tr><th>Kjøreverk</th>${cols.map(t => `<th${numCol(t)}>${head(t)}</th>`).join('')}${p.age && r.at === null ? '<th>Sist</th>' : ''}</tr></thead><tbody>`
            + codes.map(c => `<tr><th title="${esc(ctx.vehicleName(c))}">${esc(c)}</th>${cols.map(t => cell(c, t)).join('')}${p.age && r.at === null ? `<td class="muted">${esc(newest(c) ? S.ago(newest(c)) : '–')}</td>` : ''}</tr>`).join('') + '</tbody></table>';
        } else {
          html = `<table><thead><tr><th></th>${codes.map(c => `<th title="${esc(ctx.vehicleName(c))}">${esc(c)}</th>`).join('')}</tr></thead><tbody>`
            + cols.map(t => `<tr><th>${head(t)}</th>${codes.map(c => cell(c, t)).join('')}</tr>`).join('')
            + (p.age && r.at === null ? `<tr class="age"><th>Sist</th>${codes.map(c => `<td class="muted">${esc(newest(c) ? S.ago(newest(c)) : '–')}</td>`).join('')}</tr>` : '') + '</tbody></table>';
        }
        body.innerHTML = (r.at !== null ? `<div class="d-at">Verdiene ${esc(atText(r, ctx.range().span))}</div>` : '') + (cols.length ? html : `<div class="d-wempty">${NO_DATA}</div>`);
      });
    },
  });

  D.register('bars', {
    name: 'Søyler', hint: 'Én tallverdi per kjøreverk, side om side', size: [440, 240],
    data: { label: 'Kjøreverk og tagger', hint: 'Én søyle per kjøreverk og tag', types: ['number'] },
    props: [
      P.title('Søyler'),
      { key: 'min', label: 'Min', type: 'number', default: 0 },
      { key: 'max', label: 'Maks', type: 'number', default: '', hint: 'Tom: den største verdien' },
      P.decimals(),
      P.followMark(),
      { key: 'color', label: 'Farge', type: 'color', default: '', fallback: '#58a6ff', hint: 'Standard: fargen til hver tag' },
      P.textSize(),
    ],
    mount(body, w, ctx) {
      body.classList.add('d-bars');
      if (!w.data.length) { hint(body, NO_DATA); return {}; }
      const p = w.props;
      return valueWidget(w, ctx, r => {
        const rows = r.items.filter(it => it.dataType !== 'string').map(it => ({ it, v: (r.values.get(it.key) || {}).v }));
        const vals = rows.map(x => Number(x.v)).filter(Number.isFinite);
        const lo = p.min === '' ? Math.min(0, ...vals) : Number(p.min);
        let hi = p.max === '' ? Math.max(lo + 1e-9, ...vals) : Number(p.max);
        if (!(hi > lo)) hi = lo + 1;
        const many = new Set(rows.map(x => x.it.tag)).size > 1;
        body.innerHTML = (r.at !== null ? `<div class="d-at">${esc(atText(r, ctx.range().span))}</div>` : '') + rows.map(({ it, v }) => {
          const n = Number(v), ok = typeof v === 'number' || typeof v === 'boolean';
          const f = ok ? clamp((n - lo) / (hi - lo), 0, 1) : 0, z = clamp((0 - lo) / (hi - lo), 0, 1);
          const left = Math.min(f, z), width = Math.abs(f - z);
          return `<div class="d-barrow" title="${esc(it.vehicle + ' ' + it.tag)}"><span class="l">${esc(it.vehicle)}${many ? ` <small>${esc(nameOf(it))}</small>` : ''}</span>
            <span class="track"><span class="fill" style="left:${(left * 100).toFixed(2)}%;width:${(width * 100).toFixed(2)}%;background:${esc(p.color || it.color)}"></span></span>
            <span class="v">${esc(fmtValue(it, v, p))}${ok && it.unit ? ' <small>' + esc(it.unit) + '</small>' : ''}</span></div>`;
        }).join('') || `<div class="d-wempty">${NO_DATA}</div>`;
      });
    },
  });

  D.register('status', {
    name: 'Kjøreverk-status', hint: 'Sender de? Siste data og alarmer siste døgn', size: [460, 200],
    data: { label: 'Kjøreverk', tags: false, empty: 'Ingen valgt: alle kjøreverkene' },
    props: [P.title('Kjøreverk'), { key: 'details', label: 'Vis detaljer', type: 'bool', default: true, hint: 'Data fram til, alarmer siste døgn og recorder-versjonen' }, P.textSize()],
    mount(body, w, ctx) {
      body.classList.add('d-tablebox');
      const p = w.props;
      return {
        async refresh() {
          const list = await ctx.vehicles();
          const want = w.data.map(d => d.vehicle);
          const vs = want.length ? want.map(c => list.find(v => v.code === c) || { code: c, missing: true }) : list;
          body.innerHTML = `<table><thead><tr><th>Kjøreverk</th><th>Status</th>${p.details ? '<th>Data fram til</th><th class="num">Alarmer 24 t</th><th>Recorder</th>' : ''}</tr></thead><tbody>`
            + vs.map(v => {
              if (v.missing) return `<tr><th>${esc(v.code)}</th><td colspan="${p.details ? 4 : 1}" class="err">finnes ikke</td></tr>`;
              const [txt, cls, why] = S.vehicleStatus(v);
              return `<tr><th title="${esc(v.name || '')}">${esc(v.code)} <span class="muted">${esc(v.name || '')}</span></th><td><span class="badge ${cls}" title="${esc(why)}">${esc(txt)}</span></td>`
                + (p.details ? `<td title="${esc(v.last_ts ? S.fmtTime(v.last_ts) : '')}">${esc(v.last_ts ? S.ago(v.last_ts) : '–')}</td><td class="num${v.alarms_24h ? ' err' : ''}">${v.alarms_24h || 0}</td><td class="muted">${esc(v.recorder_version || '–')}</td>` : '') + '</tr>';
            }).join('') + '</tbody></table>';
        },
      };
    },
  });

  D.register('text', {
    name: 'Tekst', hint: 'En overskrift eller en forklaring', size: [300, 60], plate: false,
    props: [
      { key: 'text', label: 'Tekst', type: 'textarea', default: 'Overskrift' },
      { key: 'size', label: 'Størrelse', type: 'select', options: [['small', 'Liten'], ['medium', 'Normal'], ['large', 'Stor'], ['xlarge', 'Større'], ['xxlarge', 'Størst']], default: 'large' },
      { key: 'align', label: 'Plassering', type: 'select', options: [['left', 'Venstre'], ['center', 'Midten'], ['right', 'Høyre']], default: 'left' },
      { key: 'color', label: 'Farge', type: 'color', default: '', fallback: '#e6e8eb' },
    ],
    mount(body, w) {
      body.classList.add('d-text', 'size-' + (w.props.size || 'large'), 'align-' + (w.props.align || 'left'));
      body.textContent = w.props.text || '';
      return {};
    },
  });

  D.register('frame', {
    name: 'Ramme', hint: 'En ramme med navn rundt en gruppe widgeter', size: [480, 320], plate: false, back: true,
    props: [{ key: 'title', label: 'Navn', type: 'text', default: 'Gruppe' }, { key: 'color', label: 'Farge', type: 'color', default: '', fallback: '#343a44' }],
    mount(body, w) {
      body.classList.add('d-frame');
      body.innerHTML = w.props.title ? `<span>${esc(w.props.title)}</span>` : '';
      return {};
    },
  });
})();

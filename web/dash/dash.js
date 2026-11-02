/*
 * dash/dash.js - Kjøreverk-database (#/visning?id=3): visningene. Hver visning er widgeter på et lerret, som i
 * HMI-en i kjøreverkene: velg en widget i paletten til venstre, flytt den og endre størrelsen på lerretet, og gi
 * den kjøreverk og tagger i egenskapene til høyre. Edit for å bygge, Run for å bruke.
 *
 * Visningene velges i listen øverst til venstre, i toppfeltet. En visning har én eller flere faner (Drifts-
 * alarmer, Nettverk-alarmer …), hver med sitt lerret, og fanene står i linjen under toppfeltet.
 *
 * Visningene lagres på serveren (routes/web/dashboards.js), så de er like i alle nettlesere. Tidsrommet er
 * felles for widgetene i en visning, også på tvers av fanene: flytt eller zoom i én tidslinje eller trend, så
 * følger resten. Et klikk i en tidslinje eller trend setter en markør; verdiene, tabellene og søylene viser da
 * verdiene ved markøren.
 *
 * Oppsettet (config) som lagres:
 *   { fit: 'width' | 'window' | 'none', span: ms, tabs: [{ id, name, canvas: { width, height }, widgets: [w] }] }
 *   w = { id, type, x, y, w, h, props: {…}, data: [{ vehicle: 'kv_52', tags: [{ tag: 'pls.bit00', color: '' }] }] }
 * En tag kan være et mønster (pls.bit*): da gjelder den alle taggene kjøreverket har som passer. Visninger
 * lagret før fanene kom (canvas og widgets rett i oppsettet) åpnes med én fane, og lagres med fanene.
 *
 * Widgetene (dash/widgets.js) får ctx (se makeCtx nedenfor) og svarer med et håndtak:
 *   { refresh(reason) -> Promise, view(), mark(t), redraw(), destroy() }, alle valgfrie.
 *   refresh: hent data på nytt (reason: mount, range, tick, force); view: tidsrommet er flyttet, tegn med det
 *   som er hentet; mark: markøren er flyttet; redraw: skaleringen er endret.
 */
(function () {
  'use strict';
  const S = window.Shell, D = window.Dash, K = D.charts;
  const { api, el, esc } = S;
  const GRID = 10;
  const SPANS = [[600000, '10 min'], [3600000, '1 t'], [28800000, '8 t'], [86400000, '24 t'], [604800000, '7 d'], [2592000000, '30 d']];
  const SPAN_MIN = 10000;
  const FITS = [['width', 'Tilpass til bredden'], ['window', 'Tilpass til vinduet'], ['none', 'Faktisk størrelse']];
  const TICK = 10000;   // så ofte siste verdier hentes; tidslinjene og trendene sjeldnere når tidsrommet er langt
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* privat vindu */ } } };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const snap = v => Math.round(v / GRID) * GRID;
  const uid = () => 'w' + Math.random().toString(36).slice(2, 9);
  const tid = () => 't' + Math.random().toString(36).slice(2, 9);
  const copy = v => JSON.parse(JSON.stringify(v));
  const who = s => String(s || '').replace(/^web:/, '');   // audit-navnet web:ola som ola
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // base, eller base 2, base 3 … når navnet er tatt
  const freeIn = (names, base) => { const has = n => names.some(x => x.toLowerCase() === n.toLowerCase()); let n = base, i = 2; while (has(n)) n = `${base} ${i++}`; return n; };
  const TAB_NAME = 60;

  let st = null;   // alt mens siden er åpen

  // ================================================================ oppsettet
  const blankTab = name => ({ id: tid(), name: name || 'Fane 1', canvas: { width: 1600, height: 900 }, widgets: [] });
  const blank = () => ({ fit: 'width', span: 86400000, tabs: [blankTab()] });
  function defaults(def) { const p = {}; for (const f of def.props || []) p[f.key] = copy(f.default === undefined ? '' : f.default); return p; }
  function normalize(cfg) {
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    const c = { fit: FITS.some(f => f[0] === src.fit) ? src.fit : 'width', span: clamp(Number(src.span) || 86400000, SPAN_MIN, 400 * 86400000) };
    // lagret før fanene: lerretet og widgetene rett i oppsettet blir den første fanen
    const tabs = Array.isArray(src.tabs) ? src.tabs.filter(t => t && typeof t === 'object') : [];
    if (!tabs.length) tabs.push({ id: 't1', name: 'Fane 1', canvas: src.canvas, widgets: src.widgets });
    c.tabs = tabs.map((t, i) => ({
      id: String(t.id || tid()),
      name: String(t.name || '').trim().slice(0, TAB_NAME) || `Fane ${i + 1}`,
      canvas: { width: clamp(Number(t.canvas && t.canvas.width) || 1600, 400, 8000), height: clamp(Number(t.canvas && t.canvas.height) || 900, 300, 8000) },
      widgets: normalizeWidgets(t.widgets),
    }));
    // id-ene er unike i hele visningen, så en widget kan flyttes til en annen fane
    const tabIds = new Set(), seen = new Set();
    for (const t of c.tabs) {
      while (tabIds.has(t.id)) t.id = tid();
      tabIds.add(t.id);
      for (const w of t.widgets) { while (seen.has(w.id)) w.id = uid(); seen.add(w.id); }
    }
    return c;
  }
  function normalizeWidgets(list) {
    return (Array.isArray(list) ? list : []).filter(w => w && typeof w === 'object').map(w => {
      const def = D.widgets[w.type];
      const out = { id: String(w.id || uid()), type: String(w.type || ''), x: Math.max(0, Number(w.x) || 0), y: Math.max(0, Number(w.y) || 0) };
      out.w = Math.max(40, Number(w.w) || (def ? def.size[0] : 200));
      out.h = Math.max(30, Number(w.h) || (def ? def.size[1] : 120));
      out.props = Object.assign(def ? defaults(def) : {}, w.props && typeof w.props === 'object' ? w.props : {});
      out.data = (Array.isArray(w.data) ? w.data : []).filter(d => d && d.vehicle).map(d => ({
        vehicle: String(d.vehicle),
        tags: (Array.isArray(d.tags) ? d.tags : []).filter(t => t && t.tag).map(t => ({ tag: String(t.tag), color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '' })),
      }));
      return out;
    });
  }

  // ================================================================ tidsrommet og markøren
  const maxSpan = () => Math.max(1, Math.floor(st.maxDays / 2)) * 86400000;   // det som hentes, er inntil dobbelt så langt
  function range() {
    const r = st.range;
    if (r.live) return { from: st.now - r.span, to: st.now, live: true, span: r.span };
    return { from: r.from, to: r.to, live: false, span: r.to - r.from };
  }
  function setRange(from, to) {
    const now = Date.now(), span = clamp(to - from, SPAN_MIN, maxSpan());
    st.now = now;
    if (from + span >= now) st.range = st.mark === null ? { live: true, span } : { live: false, from: now - span, to: now };
    else st.range = { live: false, from, to: from + span };
    rangeChanged();
  }
  function setSpan(span) {
    // med en markør: tidsrommet rundt den, ellers det siste, live
    const now = Date.now();
    st.now = now;
    if (st.mark === null) { st.range = { live: true, span: Math.min(span, maxSpan()) }; rangeChanged(); return; }
    const from = st.mark >= now - span ? now - span : st.mark - span / 2;
    setRange(from, from + span);
  }
  // factor > 1 zoomer ut. Live står nå fast i høyre kant; ellers står tiden ved anchor stille (markøren eller midten)
  function zoom(anchor, factor) {
    const r = range(), ns = clamp(r.span * factor, SPAN_MIN, maxSpan());
    if (ns === r.span) return;
    if (st.range.live) { st.range = { live: true, span: ns }; rangeChanged(); return; }
    const a = anchor !== null && anchor !== undefined ? anchor : st.mark !== null && st.mark >= r.from && st.mark <= r.to ? st.mark : (r.from + r.to) / 2;
    const from = a - (a - r.from) * ns / r.span;
    setRange(from, from + ns);
  }
  const pan = f => { const r = range(); setRange(r.from + f * r.span, r.to + f * r.span); };
  const liveEvery = () => { const s = range().span; return s <= 3600000 ? 10000 : s <= 86400000 ? 30000 : 120000; };

  let refreshTimer = 0;
  function rangeChanged() {
    renderTime();
    params();
    each(h => h.view && h.view());
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshAll('range'), 250);
  }
  function setMark(t) {
    const before = JSON.stringify(st.range);
    st.mark = t === null || t === undefined || !Number.isFinite(t) ? null : Math.round(t);
    if (st.mark !== null) {
      const r = range();
      if (st.mark < r.from || st.mark > r.to) { const from = Math.min(st.mark - r.span / 2, Date.now() - r.span); st.range = { live: false, from, to: from + r.span }; }
      else if (st.range.live) st.range = { live: false, from: r.from, to: r.to };
    }
    renderTime();
    params();
    each(h => h.mark && h.mark(st.mark));
    if (JSON.stringify(st.range) !== before) rangeChanged();
  }

  // ================================================================ dataene widgetene henter
  function cached(key, ttl, fn) {
    const c = st.cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.p;
    const p = fn();
    st.cache.set(key, { at: Date.now(), p });
    p.catch(() => { if (st && st.cache.get(key) && st.cache.get(key).p === p) st.cache.delete(key); });
    if (st.cache.size > 300) for (const [k, v] of st.cache) if (Date.now() - v.at > 60000) st.cache.delete(k);
    return p;
  }
  // kjøreverkene, med «data fram til» (until) for hvert: hentes høyst hvert 10. sekund
  function vehicles() {
    if (!st.vehiclesP || Date.now() - st.vehiclesAt > 10000) {
      st.vehiclesAt = Date.now();
      st.vehiclesP = S.vehicles(true).then(list => { if (st) st.vehicleMap = new Map(list.map(v => [v.code, v])); return list; });
      st.vehiclesP.catch(() => { if (st) st.vehiclesAt = 0; });
    }
    return st.vehiclesP;
  }
  function until(code) {
    const v = st.vehicleMap && st.vehicleMap.get(code);
    if (!v) return null;
    const t = Math.max(v.last_ts || 0, v.last_batch_at || 0);
    return t || null;
  }
  // taggene til ett kjøreverk: navn -> { dataType, unit, label, ts, value, text }
  function catalog(code) {
    return cached('c|' + code, 60000, () => api('/catalog?vehicle=' + encodeURIComponent(code))
      .then(r => new Map(r.tags.map(t => [t.tag, t])))
      .catch(e => { if (e.status === 404) return new Map(); throw e; }));
  }
  const patternRx = p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  // dataene til en widget -> en liste med ett element per kjøreverk og tag, mønstrene løst opp med katalogen
  async function expand(data) {
    const list = data || [];
    await vehicles().catch(() => null);
    const cats = await Promise.all(list.map(d => catalog(d.vehicle).catch(() => new Map())));
    const out = [];
    let ci = 0;
    list.forEach((d, di) => {
      const cat = cats[di], v = st.vehicleMap && st.vehicleMap.get(d.vehicle), seen = new Set();
      for (const t of d.tags) {
        const pattern = t.tag.includes('*');
        const names = pattern ? [...cat.keys()].filter(n => patternRx(t.tag).test(n)).sort() : [t.tag];
        for (const name of names) {
          if (seen.has(name)) continue;
          seen.add(name);
          const info = cat.get(name);
          out.push({
            key: `${d.vehicle}|${name}`, vehicle: d.vehicle, vehicleName: v ? v.name || '' : '', tag: name,
            label: info ? info.label || '' : '', unit: info ? info.unit || '' : '', dataType: info ? info.dataType : 'number', missing: !info,
            color: t.color || K.COLORS[ci % K.COLORS.length],
          });
          ci++;
        }
      }
    });
    return out;
  }
  const keyList = items => items.map(i => i.key).join(',');
  // punktene i et tidsrom: Map(key -> { points, source, missing }). Tall og av/på fra /series, tekst fra /text
  async function series(items, from, to, points) {
    from = Math.floor(from / 1000) * 1000; to = Math.ceil(to / 1000) * 1000;
    if (!(to > from)) to = from + 1000;
    const out = new Map(), jobs = [];
    const nums = items.filter(i => i.dataType !== 'string'), texts = items.filter(i => i.dataType === 'string');
    for (let i = 0; i < nums.length; i += 24) {
      const part = nums.slice(i, i + 24);
      jobs.push(cached(`s|${from}|${to}|${points}|${keyList(part)}`, 4000, () => api('/series', { method: 'POST', body: { series: part.map(p => ({ vehicle: p.vehicle, tag: p.tag })), from, to, points } }))
        .then(r => { for (const s of r.series) out.set(`${s.vehicle}|${s.tag}`, { points: s.points, source: s.source, missing: s.missing }); }));
    }
    for (let i = 0; i < texts.length; i += 50) {
      const part = texts.slice(i, i + 50);
      jobs.push(cached(`t|${from}|${to}|${keyList(part)}`, 4000, () => api('/text', { method: 'POST', body: { series: part.map(p => ({ vehicle: p.vehicle, tag: p.tag })), from, to } }))
        .then(r => { for (const s of r.series) out.set(`${s.vehicle}|${s.tag}`, { points: s.points, source: s.truncated ? 'raw (truncated)' : 'raw', missing: s.missing }); }));
    }
    await Promise.all(jobs);
    return out;
  }
  // siste verdi: Map(key -> { value, text, ts, dataType, unit, label })
  async function latest(items) {
    if (!items.length) return new Map();
    const r = await cached('l|' + keyList(items), 3000, () => api('/latest', { method: 'POST', body: { items: items.map(i => ({ vehicle: i.vehicle, tag: i.tag })) } }));
    return new Map(r.values.map(v => [`${v.vehicle}|${v.tag}`, v]));
  }
  // verdien ved t: Map(key -> { value, ts }); null i et hull, undefined når det ikke finnes noen verdi før t
  async function valuesAt(items, t) {
    const s = await series(items, t - 1000, t, 50);
    const out = new Map();
    for (const it of items) {
      const pts = (s.get(it.key) || {}).points || [];
      out.set(it.key, { value: K.valueAt(pts, t), ts: t });
    }
    return out;
  }
  // hendelsene: { events, more }
  function events(o) {
    const q = new URLSearchParams({ from: String(Math.floor(o.from / 1000) * 1000), to: String(Math.ceil(o.to / 1000) * 1000), limit: String(o.limit || 1000) });
    if (o.vehicles && o.vehicles.length) q.set('vehicles', o.vehicles.join(','));
    if (o.severity) q.set('severity', o.severity);
    if (o.q) q.set('q', o.q);
    if (o.source) q.set('source', o.source);
    return cached('e|' + q, 4000, () => api('/events?' + q));
  }

  function makeCtx() {
    return {
      mode: () => st.mode, scale: () => st.scale, now: () => st.now,
      range, setRange, zoom, pan, liveEvery, mark: () => st.mark, setMark,
      vehicles, until, catalog, expand, series, latest, valuesAt, events,
      vehicleName: code => { const v = st.vehicleMap && st.vehicleMap.get(code); return v ? v.name || '' : ''; },
    };
  }

  // ================================================================ widgetene på lerretet
  const each = fn => { for (const m of st.mounted.values()) { try { fn(m.handle, m); } catch (e) { console.error(e); } } };
  function refreshAll(reason) {
    if (!st) return;
    st.now = Date.now();
    for (const m of st.mounted.values()) refreshOne(m, reason);
  }
  function refreshOne(m, reason) {
    if (!m.handle.refresh) return;
    Promise.resolve().then(() => m.handle.refresh(reason)).then(() => showErr(m, ''), e => { if (st) showErr(m, e.status === 401 ? 'Logg inn for å se dataene' : e.message); });
  }
  function showErr(m, text) {
    let e = m.root.querySelector(':scope > .d-err');
    if (!text) { if (e) e.remove(); return; }
    if (!e) { e = el('div', { class: 'd-err' }); m.root.appendChild(e); }
    e.textContent = text;
  }
  const findW = id => st.tab.widgets.find(w => w.id === id);
  const canvasEl = () => st.root.querySelector('.d-canvas');

  function mountWidget(w, before) {
    const def = D.widgets[w.type];
    const root = el('div', { class: `d-w d-w-${esc(w.type)}` });
    root.dataset.id = w.id;
    geometry(root, w);
    if (st.selection.has(w.id)) root.classList.add('sel');
    let handle = {};
    if (!def) root.appendChild(el('div', { class: 'd-body d-unknown' }, `Ukjent widget: ${esc(w.type)}`));
    else {
      if (def.plate !== false && String(w.props.title || '').trim()) root.appendChild(el('div', { class: 'd-plate' }, esc(w.props.title)));
      const body = el('div', { class: 'd-body' });
      root.appendChild(body);
      if (/^#[0-9a-f]{6}$/i.test(w.props.color || '')) root.style.setProperty('--wc', w.props.color);
      const fs = Number(w.props.textSize) || 100;
      if (fs !== 100) root.style.setProperty('--fs', String(clamp(fs, 50, 400) / 100));
      try { handle = def.mount(body, w, st.ctx) || {}; } catch (e) { console.error(e); body.textContent = 'Feil i widgeten: ' + e.message; }
    }
    if (st.mode === 'edit') root.appendChild(el('div', { class: 'd-handle', title: 'Dra for å endre størrelsen' }));
    canvasEl().insertBefore(root, before || null);
    const m = { root, handle, w };
    st.mounted.set(w.id, m);
    refreshOne(m, 'mount');
    return m;
  }
  function unmountWidget(id) {
    const m = st.mounted.get(id);
    if (!m) return;
    try { if (m.handle.destroy) m.handle.destroy(); } catch (e) { /* uansett */ }
    m.root.remove();
    st.mounted.delete(id);
  }
  function remount(w) {
    const old = st.mounted.get(w.id);
    const next = old ? old.root.nextSibling : null;
    unmountWidget(w.id);
    mountWidget(w, next);
  }
  function geometry(root, w) { Object.assign(root.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' }); }

  function renderCanvas() {
    for (const id of [...st.mounted.keys()]) unmountWidget(id);
    const c = canvasEl();
    c.innerHTML = '';
    c.style.width = st.tab.canvas.width + 'px';
    c.style.height = st.tab.canvas.height + 'px';
    c.classList.toggle('edit', st.mode === 'edit');
    for (const w of st.tab.widgets) mountWidget(w);
    if (!st.tab.widgets.length) {
      c.appendChild(el('div', { class: 'd-hint' }, st.mode === 'edit'
        ? '<b>Tomt lerret.</b> Velg en widget i listen til venstre. Den kommer her, og så gir du den kjøreverk og tagger til høyre.'
        : '<b>Ingen widgeter ennå.</b> Trykk <b>Edit</b> øverst til høyre for å bygge visningen.'));
    }
    fitCanvas();
  }
  function fitCanvas() {
    const vp = st.root.querySelector('.d-viewport'), c = canvasEl();
    const cw = st.tab.canvas.width, ch = st.tab.canvas.height;
    let s = 1;
    if (st.mode === 'run') {
      const aw = vp.clientWidth - 16, ah = vp.clientHeight - 16;
      if (st.cfg.fit === 'width') s = aw / cw;
      else if (st.cfg.fit === 'window') s = Math.min(aw / cw, ah / ch);
      s = clamp(s, 0.2, 3);
    }
    const changed = Math.abs(s - st.scale) > 1e-3;
    st.scale = s;
    c.style.transform = s === 1 ? '' : `scale(${s})`;
    c.style.marginRight = (cw * (s - 1)) + 'px';
    c.style.marginBottom = (ch * (s - 1)) + 'px';
    if (changed) each(h => h.redraw && h.redraw());
  }

  // ================================================================ verktøylinjen
  function renderAll() {
    st.root.classList.toggle('run', st.mode === 'run');
    st.root.classList.toggle('edit', st.mode === 'edit');
    st.root.classList.toggle('none', !st.dash);
    renderPicker();
    renderTabs();
    renderTime();
    renderMode();
    renderPalette();
    if (st.dash) renderCanvas();
    renderInspector();
  }

  // ---------------------------------------------------------------- visningene: listen øverst til venstre
  function setupPicker() {
    const slot = document.getElementById('pageHead');
    if (!slot) return;
    st.picker = el('span', { class: 'd-vpick' }, `<button class="d-vbtn" aria-haspopup="true" aria-expanded="false" title="Velg visning"><span class="n"></span><span class="car" aria-hidden="true">▾</span></button>
      <div class="d-vmenu" hidden><input type="search" class="q" placeholder="Søk i visningene og fanene"><div class="d-vlist"></div><button class="d-vnew" title="Lag en ny visning">+ Ny visning</button></div>`);
    slot.appendChild(st.picker);
    const btn = st.picker.querySelector('.d-vbtn'), menu = st.picker.querySelector('.d-vmenu'), q = menu.querySelector('.q');
    btn.onclick = () => (menu.hidden ? openMenu() : closeMenu());
    q.oninput = renderMenu;
    q.onkeydown = e => { if (e.key === 'Enter') { const b = menu.querySelector('.d-vlist [data-id]'); if (b) b.click(); } };
    menu.querySelector('.d-vnew').onclick = () => { closeMenu(); newView(); };
    menu.querySelector('.d-vlist').onclick = e => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      closeMenu();
      switchTo(Number(b.dataset.id), b.dataset.tab || null);
    };
    // Escape lukker, og pilene går i listen
    st.picker.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); e.stopPropagation(); closeMenu(); btn.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (menu.hidden) { if (e.key === 'ArrowDown') openMenu(); return; }
      const items = [q, ...menu.querySelectorAll('.d-vlist button, .d-vnew')].filter(x => !x.hidden);
      const i = items.indexOf(document.activeElement);
      items[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1)].focus();
    });
    renderPicker();
  }
  const onDocDown = e => { if (st && st.picker && !st.picker.contains(e.target)) closeMenu(); };
  function openMenu() {
    const menu = st.picker.querySelector('.d-vmenu'), q = menu.querySelector('.q');
    q.value = '';
    q.hidden = st.list.length < 8;
    menu.hidden = false;
    st.picker.querySelector('.d-vbtn').setAttribute('aria-expanded', 'true');
    renderMenu();
    // på en smal skjerm: flytt den inn så den ikke går ut over høyre kant
    menu.style.left = '0px';
    const over = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
    if (over > 0) menu.style.left = -over + 'px';
    (q.hidden ? menu.querySelector('.d-vitem.on') || menu.querySelector('button') : q).focus();
    // noen andre kan ha laget, endret eller slettet visninger siden
    const mine = st;
    loadList().then(() => { if (st === mine && !menu.hidden) renderMenu(); }).catch(() => {});
  }
  function closeMenu() {
    if (!st || !st.picker) return;
    st.picker.querySelector('.d-vmenu').hidden = true;
    st.picker.querySelector('.d-vbtn').setAttribute('aria-expanded', 'false');
  }
  function renderMenu() {
    const menu = st.picker.querySelector('.d-vmenu'), list = menu.querySelector('.d-vlist');
    const s = menu.querySelector('.q').value.trim().toLowerCase();
    const keyOf = b => `${b.dataset.id}|${b.dataset.tab || ''}`;
    const focused = list.contains(document.activeElement) ? keyOf(document.activeElement) : null;
    // den som er åpen, med navnet og fanene slik de er her, også før de er lagret
    const rows = st.list.map(d => (st.dash && d.id === st.dash.id
      ? Object.assign({}, d, { name: st.dash.name, tabs: st.cfg.tabs, widgets: st.cfg.tabs.reduce((n, t) => n + t.widgets.length, 0), on: true })
      : d));
    const hits = rows.filter(d => !s || d.name.toLowerCase().includes(s) || (d.tabs || []).some(t => String(t.name || '').toLowerCase().includes(s)));
    list.innerHTML = hits.map(d => {
      const tabs = d.tabs || [];
      const meta = (tabs.length > 1 ? plural(tabs.length, 'fane', 'faner') + ' · ' : '') + plural(d.widgets, 'widget', 'widgeter');
      return `<div class="d-vrow${d.on ? ' on' : ''}"><button class="d-vitem${d.on ? ' on' : ''}" data-id="${d.id}" title="${esc(d.updated_by ? `Lagret av ${who(d.updated_by)} ${S.fmtTime(d.updated_at)}` : '')}"><b>${esc(d.name)}</b><small>${meta}</small></button>`
        + (tabs.length > 1 ? `<div class="d-vtabs">${tabs.map((t, i) => `<button data-id="${d.id}" data-tab="${esc(t.id || '')}" class="${d.on && t.id === st.tab.id ? 'on' : ''}" title="Gå rett til fanen">${esc(t.name || `Fane ${i + 1}`)}</button>`).join('')}</div>` : '')
        + '</div>';
    }).join('') || `<p class="muted">${st.list.length ? 'Ingen visninger passer.' : 'Ingen visninger ennå.'}</p>`;
    if (focused) { const b = [...list.querySelectorAll('[data-id]')].find(x => keyOf(x) === focused); if (b) b.focus(); }
  }
  function renderPicker() {
    if (!st.picker) return;
    st.picker.querySelector('.d-vbtn .n').textContent = st.dash ? st.dash.name : st.list.length ? 'Velg visning' : 'Ingen visninger';
    document.title = `${st.dash ? st.dash.name : 'Kjøreverk-database'} · Kjøreverk`;
    if (!st.picker.querySelector('.d-vmenu').hidden) renderMenu();
  }

  // ---------------------------------------------------------------- fanene i visningen
  function renderTabs() {
    const box = st.root.querySelector('.d-tabs'), edit = st.mode === 'edit';
    box.innerHTML = '';
    // én fane i Run: ingen linje, navnet på visningen står øverst
    if (!st.dash || (st.cfg.tabs.length < 2 && !edit)) return;
    let dragged = null;
    st.cfg.tabs.forEach(t => {
      const b = el('button', { class: 'd-tab' + (t === st.tab ? ' on' : ''), role: 'tab', 'aria-selected': String(t === st.tab) }, esc(t.name));
      b.onclick = () => switchTab(t.id);
      if (edit) {
        b.title = 'Dobbeltklikk for å gi fanen nytt navn, dra den for å flytte den';
        b.draggable = true;
        b.ondblclick = () => renameTab(t);
        b.ondragstart = e => { dragged = t; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.name); };
        b.ondragend = () => { dragged = null; };
        // til høyre for fanen når den dras mot høyre, ellers til venstre
        b.ondragover = e => {
          if (!dragged || dragged === t) return;
          e.preventDefault();
          b.classList.add(st.cfg.tabs.indexOf(dragged) < st.cfg.tabs.indexOf(t) ? 'drop-r' : 'drop-l');
        };
        b.ondragleave = () => b.classList.remove('drop-l', 'drop-r');
        b.ondrop = e => { e.preventDefault(); b.classList.remove('drop-l', 'drop-r'); if (dragged && dragged !== t) moveTab(dragged, st.cfg.tabs.indexOf(t)); };
      }
      box.appendChild(b);
    });
    if (edit) {
      const add = el('button', { class: 'd-tab d-new', title: 'Legg til en fane i visningen' }, '+ Ny fane');
      add.onclick = addTab;
      box.appendChild(add);
    }
  }
  function switchTab(id) {
    const t = st.cfg.tabs.find(x => x.id === id);
    if (!t || t === st.tab) return;
    st.tab = t;
    st.selection.clear();
    store.set('dash.tab.' + st.dash.id, t.id);
    renderTabs();
    renderCanvas();
    renderInspector();
    renderPicker();
    params();
    const vp = st.root.querySelector('.d-viewport');
    vp.scrollTop = vp.scrollLeft = 0;
  }
  function moveTab(t, to) {
    const tabs = st.cfg.tabs, from = tabs.indexOf(t);
    if (from < 0 || to < 0 || to >= tabs.length || from === to) return;
    tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    markDirty();
    renderTabs();
    renderInspector();
  }
  async function addTab() {
    let i = st.cfg.tabs.length + 1;
    while (st.cfg.tabs.some(t => t.name.toLowerCase() === `fane ${i}`)) i++;
    const name = await askName('Ny fane', `Fane ${i}`, 'Lag', TAB_NAME);
    if (!name || !st || !st.dash) return;
    const t = blankTab(name);
    t.canvas.width = st.tab.canvas.width;
    st.cfg.tabs.push(t);
    markDirty();
    switchTab(t.id);
  }
  async function renameTab(t) {
    const name = await askName('Gi fanen nytt navn', t.name, 'OK', TAB_NAME);
    if (!name || !st || name === t.name) return;
    t.name = name;
    markDirty();
    renderTabs();
    renderInspector();
    renderPicker();
  }
  function duplicateTab() {
    const src = st.tab, t = copy(src);
    t.id = tid();
    t.name = freeIn(st.cfg.tabs.map(x => x.name), `${src.name} (kopi)`).slice(0, TAB_NAME);
    for (const w of t.widgets) w.id = uid();
    st.cfg.tabs.splice(st.cfg.tabs.indexOf(src) + 1, 0, t);
    markDirty();
    switchTab(t.id);
    flash(`Kopien «${t.name}» er laget`);
  }
  async function deleteTab() {
    const t = st.tab, tabs = st.cfg.tabs;
    if (tabs.length < 2) return;
    if (t.widgets.length && !(await S.confirm('Slett fanen', `Slette fanen «${esc(t.name)}» med ${plural(t.widgets.length, 'widget', 'widgeter')}? Den er borte for alle når du lagrer visningen.`, 'Slett', true))) return;
    if (!st || st.tab !== t) return;
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    markDirty();
    st.tab = null;
    switchTab(tabs[Math.min(i, tabs.length - 1)].id);
  }
  // widgetene med ids flyttes til fanen tabId, på samme plass på lerretet
  function moveToTab(ids, tabId) {
    const to = st.cfg.tabs.find(t => t.id === tabId);
    if (!to || to === st.tab) return;
    const moving = st.tab.widgets.filter(w => ids.has(w.id));
    st.tab.widgets = st.tab.widgets.filter(w => !ids.has(w.id));
    for (const w of moving) { if (D.widgets[w.type] && D.widgets[w.type].back) to.widgets.unshift(w); else to.widgets.push(w); }
    const bottom = Math.max(0, ...to.widgets.map(w => w.y + w.h));
    if (bottom > to.canvas.height) to.canvas.height = snap(bottom + 40);
    for (const w of moving) unmountWidget(w.id);
    st.selection.clear();
    markDirty();
    if (!st.tab.widgets.length) renderCanvas();
    renderInspector();
    flash(`${plural(moving.length, 'widget', 'widgeter')} flyttet til «${to.name}»`);
  }
  function moveSelect(ids) {
    const s = el('select', { class: 'd-moveto', title: 'Flytt til en annen fane i visningen, på samme plass' },
      '<option value="">Flytt til fane …</option>' + st.cfg.tabs.filter(t => t !== st.tab).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join(''));
    s.onchange = () => moveToTab(new Set(ids), s.value);
    return s;
  }
  function renderTime() {
    const box = st.root.querySelector('.d-time');
    if (!st.dash) { box.innerHTML = ''; return; }
    const r = range();
    const spanBtn = SPANS.map(([ms, t]) => `<button data-span="${ms}" class="${r.live && r.span === ms ? 'on' : ''}" title="${st.mark === null ? `De siste ${t}, live` : `${t} rundt markøren`}">${t}</button>`).join('');
    const preset = SPANS.find(s => s[0] === r.span);
    const label = r.live ? `Siste ${preset ? preset[1] : S.duration(r.span / 1000)}` : rangeLabel(r);
    box.innerHTML = `<div class="d-spans">${spanBtn}</div>
      <button data-a="back" title="Tilbake i tid">◀</button><button data-a="fwd" title="Fram i tid"${r.live ? ' disabled' : ''}>▶</button>
      <button data-a="out" title="Zoom ut">−</button><button data-a="in" title="Zoom inn">+</button>
      <button data-a="live" class="${r.live ? 'on live' : ''}" title="Tilbake til nå, og følg med">Live</button>
      <button data-a="pick" class="d-range" title="Velg fra og til">${esc(label)}</button>
      ${st.mark !== null ? `<span class="d-markchip" title="Markøren: verdiene og tabellene viser verdiene da">▼ ${esc(K.fmtAt(st.mark, 0))}<button data-a="unmark" title="Ta bort markøren">✕</button></span>` : ''}
      <button data-a="reload" class="d-reload" title="Hent dataene på nytt">⟳</button>`;
    box.querySelectorAll('[data-span]').forEach(b => { b.onclick = () => setSpan(Number(b.dataset.span)); });
    box.querySelectorAll('[data-a]').forEach(b => {
      b.onclick = () => ({
        back: () => pan(-0.5), fwd: () => pan(0.5), out: () => zoom(null, 2), in: () => zoom(null, 0.5),
        live: () => { st.mark = null; each(h => h.mark && h.mark(null)); st.range = { live: true, span: range().span }; st.now = Date.now(); rangeChanged(); },
        pick: pickRange, unmark: () => setMark(null), reload: () => { st.cache.clear(); refreshAll('force'); },
      })[b.dataset.a]();
    });
  }
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  // 02.11 13:00 – 14:30, eller 01.11 13:00 – 02.11 13:00; sekundene bare når tidsrommet er under 10 minutter
  function rangeLabel(r) {
    const pad = n => String(n).padStart(2, '0');
    const day = t => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`; };
    const hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}${r.span < 600000 ? ':' + pad(d.getSeconds()) : ''}`; };
    return `${day(r.from)} ${hm(r.from)} – ${sameDay(r.from, r.to) ? '' : day(r.to) + ' '}${hm(r.to)}`;
  }
  function pickRange() {
    const r = range();
    const m = S.modal(`<h2>Tidsrom</h2><form class="form">
      <div class="row2"><label>Fra<input type="datetime-local" name="from" required value="${S.localInput(r.from)}"></label>
      <label>Til<input type="datetime-local" name="to" required value="${S.localInput(r.to)}"></label></div>
      <p class="hint">Alle widgetene i visningen følger tidsrommet. Lengst ${Math.floor(st.maxDays / 2)} døgn.</p>
      <p class="err" hidden></p>
      <div class="actions"><button type="button" class="cancel">Avbryt</button><button type="submit" class="primary">Vis</button></div></form>`);
    const f = m.box.querySelector('form');
    m.box.querySelector('.cancel').onclick = () => m.close();
    f.onsubmit = e => {
      e.preventDefault();
      const from = new Date(f.from.value).getTime(), to = new Date(f.to.value).getTime();
      if (!(to > from)) { const er = f.querySelector('.err'); er.textContent = 'Til må være etter fra.'; er.hidden = false; return; }
      m.close();
      setRange(from, to);
    };
  }
  function renderMode() {
    const box = st.root.querySelector('.d-right');
    box.querySelector('[data-m=edit]').classList.toggle('on', st.mode === 'edit');
    box.querySelector('[data-m=run]').classList.toggle('on', st.mode === 'run');
    renderDirty();
  }
  function renderDirty() {
    const d = st.root.querySelector('.d-dirty'), b = st.root.querySelector('.d-save');
    d.textContent = st.dirty ? '● Ikke lagret' : '';
    b.disabled = !st.dash || !st.dirty;
    b.title = S.user ? 'Lagre visningen på serveren (Ctrl+S)' : 'Lagre visningen på serveren. Du blir bedt om å logge inn';
  }
  function setMode(mode) {
    if (mode === st.mode) return;
    st.mode = mode;
    store.set('dash.mode', mode);
    if (mode === 'run') st.selection.clear();
    renderAll();
  }
  function markDirty() { if (!st.dirty) { st.dirty = true; renderDirty(); } }
  let flashTimer = 0;
  function flash(text, bad) {
    const f = st.root.querySelector('.d-flash');
    f.textContent = text;
    f.className = 'd-flash' + (bad ? ' bad' : '');
    f.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (st) f.hidden = true; }, bad ? 6000 : 2500);
  }
  function params() {
    if (!st.dash) return;
    const p = { id: st.dash.id };
    if (st.cfg.tabs.length > 1) p.tab = st.tab.id;
    if (st.range.live) { if (st.range.span !== st.cfg.span) p.span = st.range.span; } else { p.from = Math.round(st.range.from); p.to = Math.round(st.range.to); }
    if (st.mark !== null) p.mark = st.mark;
    S.setParams(p);
  }

  // ================================================================ paletten
  function renderPalette() {
    const box = st.root.querySelector('.d-palette');
    box.innerHTML = '<h3>Legg til widget</h3>' + Object.entries(D.widgets).map(([type, def]) =>
      `<button data-type="${esc(type)}"><b>${esc(def.name)}</b><small>${esc(def.hint || '')}</small></button>`).join('');
    box.querySelectorAll('button').forEach(b => { b.onclick = () => addWidget(b.dataset.type); });
  }
  function addWidget(type) {
    if (!st.dash) return;
    const def = D.widgets[type], vp = st.root.querySelector('.d-viewport');
    let x = snap(vp.scrollLeft / st.scale + 20), y = snap(vp.scrollTop / st.scale + 20);
    while (st.tab.widgets.some(o => o.x === x && o.y === y)) { x += 2 * GRID; y += 2 * GRID; }
    const w = { id: uid(), type, x: Math.max(0, Math.min(x, st.tab.canvas.width - def.size[0])), y, w: def.size[0], h: def.size[1], props: defaults(def), data: [] };
    if (def.back) st.tab.widgets.unshift(w); else st.tab.widgets.push(w);
    if (y + w.h > st.tab.canvas.height) st.tab.canvas.height = snap(y + w.h + 40);
    markDirty();
    renderCanvas();
    select([w.id]);
  }

  // ================================================================ velge, flytte, endre størrelse
  function select(ids) {
    st.selection = new Set(ids);
    for (const [id, m] of st.mounted) m.root.classList.toggle('sel', st.selection.has(id));
    renderInspector();
  }
  function setupCanvas() {
    const c = canvasEl();
    let drag = null;
    c.addEventListener('pointerdown', e => {
      if (st.mode !== 'edit' || e.button !== 0) return;
      // preventDefault nedenfor hindrer at fokuset flyttes: ta det fra feltet eller knappen det står i, så tastene
      // virker på widgetene (og et felt som er endret, lagres i widgeten)
      const f = document.activeElement;
      if (f && f !== document.body && !c.contains(f)) f.blur();
      const root = e.target.closest('.d-w');
      const w = root && findW(root.dataset.id);
      if (!w) { if (e.target === c) select([]); return; }
      if (e.shiftKey) {
        const ids = new Set(st.selection);
        if (ids.has(w.id)) ids.delete(w.id); else ids.add(w.id);
        select([...ids]);
        e.preventDefault();
        return;
      }
      const resize = e.target.classList.contains('d-handle');
      if (!st.selection.has(w.id)) select([w.id]);
      const group = resize ? [w] : [...st.selection].map(findW).filter(Boolean);
      drag = { w, resize, sx: e.clientX, sy: e.clientY, ww: w.w, wh: w.h, start: group.map(g => ({ g, x: g.x, y: g.y })), moved: false };
      c.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      if (e.buttons === 0) { end(); return; }
      const dx = (e.clientX - drag.sx) / st.scale, dy = (e.clientY - drag.sy) / st.scale;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      drag.moved = true;
      if (drag.resize) {
        drag.w.w = Math.max(60, snap(drag.ww + dx));
        drag.w.h = Math.max(40, snap(drag.wh + dy));
        geometry(st.mounted.get(drag.w.id).root, drag.w);
        return;
      }
      for (const s of drag.start) {
        s.g.x = clamp(snap(s.x + dx), 0, st.tab.canvas.width - Math.min(s.g.w, st.tab.canvas.width));
        s.g.y = Math.max(0, snap(s.y + dy));
        const m = st.mounted.get(s.g.id);
        if (m) geometry(m.root, s.g);
      }
    });
    const end = () => {
      const d = drag;
      drag = null;
      if (!d || !d.moved) return;
      // lerretet vokser nedover når noe legges under kanten
      const bottom = Math.max(...st.tab.widgets.map(w => w.y + w.h));
      if (bottom > st.tab.canvas.height) { st.tab.canvas.height = snap(bottom + 40); canvasEl().style.height = st.tab.canvas.height + 'px'; }
      if (d.resize) { const m = st.mounted.get(d.w.id); if (m && m.handle.redraw) m.handle.redraw(); }
      markDirty();
      renderInspector();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);
  }
  function deleteSelection() {
    if (!st.selection.size) return;
    st.tab.widgets = st.tab.widgets.filter(w => !st.selection.has(w.id));
    for (const id of st.selection) unmountWidget(id);
    st.selection.clear();
    markDirty();
    if (!st.tab.widgets.length) renderCanvas();
    renderInspector();
  }
  function pasteWidgets(list, offset) {
    const ids = [];
    for (const src of list) {
      const w = copy(src);
      w.id = uid();
      w.x = Math.min(w.x + offset, st.tab.canvas.width - w.w);
      w.y += offset;
      st.tab.widgets.push(w);
      ids.push(w.id);
    }
    markDirty();
    renderCanvas();
    select(ids);
  }
  function onKey(e) {
    if (!st || !st.dash) return;
    const t = e.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (document.querySelector('.modal-back') || (st.picker && st.picker.contains(t))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (st.dirty) save(); return; }
    if (!typing && st.mode === 'run' && e.key === 'Escape' && st.mark !== null) { setMark(null); return; }
    if (typing || st.mode !== 'edit') return;
    const sel = [...st.selection].map(findW).filter(Boolean);
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); deleteSelection(); }
    else if (e.key === 'Escape') select([]);
    else if (mod && e.key.toLowerCase() === 'c' && sel.length) { st.clipboard = copy(sel); flash(`${sel.length} widget${sel.length === 1 ? '' : 'er'} kopiert`); }
    else if (mod && e.key.toLowerCase() === 'v' && st.clipboard) { e.preventDefault(); pasteWidgets(st.clipboard, 2 * GRID); }
    else if (mod && e.key.toLowerCase() === 'd' && sel.length) { e.preventDefault(); pasteWidgets(sel, 2 * GRID); }
    else if (e.key.startsWith('Arrow') && sel.length) {
      e.preventDefault();
      const step = e.shiftKey ? 1 : GRID;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      for (const w of sel) { w.x = Math.max(0, w.x + dx); w.y = Math.max(0, w.y + dy); const m = st.mounted.get(w.id); if (m) geometry(m.root, w); }
      markDirty();
      renderInspector();
    }
  }

  // ================================================================ egenskapene
  function renderInspector() {
    const box = st.root.querySelector('.d-inspector');
    box.innerHTML = '';
    if (st.mode !== 'edit' || !st.dash) return;
    const sel = [...st.selection].map(findW).filter(Boolean);
    if (!sel.length) viewSettings(box);
    else if (sel.length > 1) {
      box.appendChild(el('h3', {}, `${sel.length} widgeter valgt`));
      box.appendChild(el('p', { class: 'muted' }, 'Dra én av dem for å flytte alle. Shift-klikk legger til eller tar bort en widget.'));
      const a = el('div', { class: 'd-actions' }, '<button class="dup">Dupliser</button><button class="danger del">Slett</button>');
      a.querySelector('.dup').onclick = () => pasteWidgets(sel, 2 * GRID);
      a.querySelector('.del').onclick = deleteSelection;
      if (st.cfg.tabs.length > 1) a.appendChild(moveSelect(sel.map(w => w.id)));
      box.appendChild(a);
    } else widgetSettings(box, sel[0]);
  }
  // ett felt: { key, label, type, options, hint, showIf, min, max }
  function field(f, value, onChange) {
    const row = el('div', { class: 'd-field' });
    let input;
    if (f.type === 'bool') {
      row.innerHTML = `<label class="check"><input type="checkbox"${value ? ' checked' : ''}> ${esc(f.label)}</label>`;
      input = row.querySelector('input');
      input.onchange = () => onChange(input.checked);
    } else {
      row.appendChild(el('label', {}, esc(f.label)));
      if (f.type === 'select') {
        input = el('select', {}, (f.options || []).map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`; }).join(''));
      } else if (f.type === 'textarea') {
        input = el('textarea', { rows: '3' });
        input.value = value === undefined || value === null ? '' : value;
      } else if (f.type === 'color') {
        const wrap = el('div', { class: 'd-color' }, `<input type="color" value="${/^#[0-9a-f]{6}$/i.test(value || '') ? value : f.fallback || '#58a6ff'}"><button type="button" class="link">${value ? 'Standard' : ''}</button>`);
        const c = wrap.querySelector('input'), reset = wrap.querySelector('button');
        c.oninput = () => { reset.textContent = 'Standard'; onChange(c.value); };
        reset.onclick = () => { reset.textContent = ''; onChange(''); };
        row.appendChild(wrap);
        if (f.hint) row.appendChild(el('div', { class: 'hint' }, esc(f.hint)));
        return row;
      } else {
        input = el('input', { type: f.type === 'number' ? 'number' : 'text' });
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.placeholder) input.placeholder = f.placeholder;
        input.value = value === undefined || value === null ? '' : value;
      }
      input.onchange = () => onChange(f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value);
      row.appendChild(input);
    }
    if (f.hint) row.appendChild(el('div', { class: 'hint' }, esc(f.hint)));
    return row;
  }
  function widgetSettings(box, w) {
    const def = D.widgets[w.type] || { name: w.type, props: [] };
    box.appendChild(el('h3', {}, esc(def.name)));
    if (def.hint) box.appendChild(el('p', { class: 'muted d-lead' }, esc(def.hint)));
    if (def.data) dataEditor(box, w, def);
    const props = el('div', { class: 'd-group' }, '<h4>Egenskaper</h4>');
    for (const f of def.props || []) {
      if (f.showIf && !f.showIf(w.props)) continue;
      props.appendChild(field(f, w.props[f.key], v => {
        w.props[f.key] = v;
        markDirty();
        remount(w);
        if ((def.props || []).some(o => o.showIf)) renderInspector();
      }));
    }
    box.appendChild(props);
    const geo = el('div', { class: 'd-group' }, `<h4>Plassering</h4><div class="d-grid4">${['x', 'y', 'w', 'h'].map(k => `<label>${{ x: 'X', y: 'Y', w: 'Bredde', h: 'Høyde' }[k]}<input type="number" data-k="${k}" value="${w[k]}" step="${GRID}"></label>`).join('')}</div>`);
    geo.querySelectorAll('input').forEach(i => {
      i.onchange = () => {
        const k = i.dataset.k, v = Math.round(Number(i.value) || 0);
        w[k] = k === 'w' ? Math.max(60, v) : k === 'h' ? Math.max(40, v) : Math.max(0, v);
        markDirty();
        remount(w);
      };
    });
    box.appendChild(geo);
    const a = el('div', { class: 'd-actions' }, '<button class="front" title="Legg den over de andre">Fremst</button><button class="back" title="Legg den under de andre">Bakerst</button><button class="dup" title="Ctrl+D">Dupliser</button><button class="danger del" title="Delete">Slett</button>');
    const order = toFront => {
      st.tab.widgets = st.tab.widgets.filter(x => x !== w);
      if (toFront) st.tab.widgets.push(w); else st.tab.widgets.unshift(w);
      markDirty();
      renderCanvas();
    };
    a.querySelector('.front').onclick = () => order(true);
    a.querySelector('.back').onclick = () => order(false);
    a.querySelector('.dup').onclick = () => pasteWidgets([w], 2 * GRID);
    a.querySelector('.del').onclick = deleteSelection;
    if (st.cfg.tabs.length > 1) a.appendChild(moveSelect([w.id]));
    box.appendChild(a);
  }

  // ---------------------------------------------------------------- dataene: kjøreverk, og tagger under hvert
  function dataEditor(box, w, def) {
    const spec = def.data, tagsToo = spec.tags !== false;
    const g = el('div', { class: 'd-group d-data' }, `<h4>${esc(spec.label || 'Data')}</h4>${spec.hint ? `<p class="hint">${esc(spec.hint)}</p>` : ''}`);
    const list = el('div', { class: 'd-dlist' });
    g.appendChild(list);
    const changed = () => { markDirty(); remount(w); renderInspector(); };
    let ci = 0;
    w.data.forEach((d, di) => {
      const dv = el('div', { class: 'd-dv' });
      const name = st.ctx.vehicleName(d.vehicle);
      dv.innerHTML = `<div class="d-dvh"><b>${esc(d.vehicle)}</b> <span class="muted">${esc(name)}</span><button class="x" title="Ta bort ${esc(d.vehicle)} fra widgeten">✕</button></div>`;
      dv.querySelector('.x').onclick = () => { w.data.splice(di, 1); changed(); };
      if (tagsToo) {
        const tl = el('div', { class: 'd-dtags' });
        d.tags.forEach((t, ti) => {
          const auto = K.COLORS[ci % K.COLORS.length];
          ci++;
          const row = el('div', { class: 'd-dt' }, `<input type="color" value="${t.color || auto}" title="Fargen${t.tag.includes('*') ? ' (alle taggene mønsteret passer med)' : ''}"><span class="t" title="${esc(t.tag)}">${esc(t.tag)}</span><button class="x" title="Ta bort">✕</button>`);
          row.querySelector('input').onchange = e => { t.color = e.target.value; markDirty(); remount(w); };
          row.querySelector('.x').onclick = () => { d.tags.splice(ti, 1); changed(); };
          tl.appendChild(row);
          catalog(d.vehicle).then(cat => {
            const info = cat.get(t.tag), span = row.querySelector('.t');
            if (t.tag.includes('*')) { const n = [...cat.keys()].filter(k => patternRx(t.tag).test(k)).length; span.insertAdjacentHTML('beforeend', ` <small class="muted">${n} tagger</small>`); }
            else if (info && info.label) span.insertAdjacentHTML('beforeend', ` <small class="muted">${esc(info.label)}${info.unit ? ' [' + esc(info.unit) + ']' : ''}</small>`);
            else if (!info) span.insertAdjacentHTML('beforeend', ' <small class="err">finnes ikke</small>');
          }).catch(() => {});
        });
        if (!spec.maxTags || d.tags.length < spec.maxTags) {
          const add = el('button', { class: 'small d-addtag' }, '+ Tag');
          add.onclick = () => pickTags(w, d, spec, changed);
          tl.appendChild(add);
        }
        dv.appendChild(tl);
      }
      list.appendChild(dv);
    });
    const tools = el('div', { class: 'd-dtools' });
    if (!spec.max || w.data.length < spec.max) {
      const b = el('button', { class: 'small' }, '+ Kjøreverk');
      b.onclick = () => pickVehicles(w, spec, changed);
      tools.appendChild(b);
    }
    if (tagsToo && w.data.length > 1 && w.data[0].tags.length && spec.max !== 1) {
      const b = el('button', { class: 'small link', title: `Gi alle kjøreverkene i widgeten de samme taggene som ${w.data[0].vehicle}` }, `Samme tagger som ${esc(w.data[0].vehicle)} på alle`);
      b.onclick = () => { for (const d of w.data.slice(1)) d.tags = copy(w.data[0].tags).map(t => Object.assign(t, { color: '' })); changed(); };
      tools.appendChild(b);
    }
    // fra alle fanene, med navnet på fanen når det er flere
    const others = [];
    for (const t of st.cfg.tabs) for (const o of t.widgets) if (o !== w && o.data && o.data.length && D.widgets[o.type] && D.widgets[o.type].data) others.push([o, t]);
    if (others.length) {
      const s = el('select', { class: 'd-copyfrom', title: 'Ta dataene fra en annen widget i visningen' }, '<option value="">Kopier data fra …</option>' + others.map(([o, t]) => `<option value="${esc(o.id)}">${esc((D.widgets[o.type].name) + (o.props.title ? ': ' + o.props.title : ''))}${st.cfg.tabs.length > 1 ? ' · ' + esc(t.name) : ''} (${esc(o.data.map(d => d.vehicle).join(', '))})</option>`).join(''));
      s.onchange = () => {
        const hit = others.find(([o]) => o.id === s.value), o = hit && hit[0];
        if (!o) return;
        w.data = copy(o.data);
        if (spec.max) w.data = w.data.slice(0, spec.max);
        if (!tagsToo) for (const d of w.data) d.tags = [];
        if (spec.maxTags) for (const d of w.data) d.tags = d.tags.slice(0, spec.maxTags);
        changed();
      };
      tools.appendChild(s);
    }
    g.appendChild(tools);
    if (!w.data.length && spec.empty) g.appendChild(el('p', { class: 'hint' }, esc(spec.empty)));
    box.appendChild(g);
  }

  async function pickVehicles(w, spec, done) {
    let list = [];
    try { list = await vehicles(); } catch (e) { flash(e.message, true); return; }
    const have = new Set(w.data.map(d => d.vehicle));
    const first = w.data.find(d => d.tags.length);
    const one = spec.max === 1 || (spec.max && spec.max - w.data.length === 1);
    const m = S.modal(`<h2>Legg til kjøreverk</h2>
      <input type="search" class="q" placeholder="Søk i kode og navn">
      <div class="d-pick">${list.map(v => {
        const [txt, cls] = S.vehicleStatus(v);
        return `<label class="check${have.has(v.code) ? ' dim' : ''}"><input type="${one ? 'radio' : 'checkbox'}" name="v" value="${esc(v.code)}"${have.has(v.code) ? ' disabled checked' : ''}> <b>${esc(v.code)}</b> <span class="muted">${esc(v.name || '')}</span> <span class="badge ${cls}">${esc(txt)}</span> <span class="muted">${v.tags} tagger</span></label>`;
      }).join('') || '<p class="muted">Ingen kjøreverk er registrert.</p>'}</div>
      ${spec.tags !== false && first && spec.max !== 1 ? `<label class="check d-same"><input type="checkbox" class="same" checked> Med de samme taggene som ${esc(first.vehicle)}</label>` : ''}
      <div class="actions"><button class="cancel">Avbryt</button><button class="primary ok">Legg til</button></div>`);
    const q = m.box.querySelector('.q');
    q.oninput = () => { const s = q.value.trim().toLowerCase(); m.box.querySelectorAll('.d-pick label').forEach(l => { l.hidden = !!s && !l.textContent.toLowerCase().includes(s); }); };
    m.box.querySelector('.cancel').onclick = () => m.close();
    m.box.querySelector('.ok').onclick = () => {
      const same = m.box.querySelector('.same');
      const picked = [...m.box.querySelectorAll('.d-pick input:checked:not(:disabled)')].map(i => i.value);
      for (const code of picked) {
        if (spec.max && w.data.length >= spec.max) break;
        w.data.push({ vehicle: code, tags: same && same.checked ? copy(first.tags).map(t => Object.assign(t, { color: '' })) : [] });
      }
      m.close();
      if (picked.length) done();
    };
  }

  async function pickTags(w, d, spec, done) {
    let cat;
    try { cat = await catalog(d.vehicle); } catch (e) { flash(e.message, true); return; }
    const one = spec.maxTags === 1;
    const want = spec.types || null;   // ['number'] osv.: de andre vises, men grått
    const have = new Set(d.tags.map(t => t.tag));
    const tags = [...cat.values()];
    const typeText = { boolean: 'av/på', number: 'tall', string: 'tekst' };
    const fmt = t => t.dataType === 'string' ? (t.text === null || t.text === undefined ? '–' : `"${t.text}"`) : t.dataType === 'boolean' ? (t.value === null || t.value === undefined ? '–' : K.isOn(t.value) ? 'på' : 'av') : K.fmtNum(t.value);
    const m = S.modal(`<h2>Tagger på ${esc(d.vehicle)} <span class="muted">${esc(st.ctx.vehicleName(d.vehicle))}</span></h2>
      <div class="d-tpbar"><input type="search" class="q" placeholder="Søk i navn, navn fra PLS-en og enhet">
        <select class="ty"><option value="">Alle typer</option><option value="boolean">Av/på</option><option value="number">Tall</option><option value="string">Tekst</option></select></div>
      <div class="d-pick d-tags"></div>
      ${one ? '' : `<div class="d-pattern"><label>Eller et mønster, som gjelder alle taggene som passer, også nye: <input class="pat" placeholder="pls.bit*"></label><span class="muted n"></span></div>`}
      <div class="actions"><span class="muted cnt"></span><button class="link all"${one ? ' hidden' : ''}>Velg alle viste</button><button class="cancel">Avbryt</button><button class="primary ok">OK</button></div>`, null);
    m.box.classList.add('wide');
    const listEl = m.box.querySelector('.d-tags'), q = m.box.querySelector('.q'), ty = m.box.querySelector('.ty');
    const chosen = new Set([...have].filter(t => !t.includes('*')));
    const count = () => { m.box.querySelector('.cnt').textContent = one ? '' : `${chosen.size} valgt`; };
    function render() {
      const s = q.value.trim().toLowerCase(), type = ty.value;
      const hits = tags.filter(t => (!type || t.dataType === type) && (!s || t.tag.toLowerCase().includes(s) || (t.label || '').toLowerCase().includes(s) || (t.unit || '').toLowerCase().includes(s)));
      listEl.innerHTML = hits.slice(0, 600).map(t => `<label class="check${want && !want.includes(t.dataType) ? ' dim' : ''}"><input type="${one ? 'radio' : 'checkbox'}" name="t" value="${esc(t.tag)}"${chosen.has(t.tag) ? ' checked' : ''}>
        <code>${esc(t.tag)}</code> <span>${esc(t.label || '')}</span> <span class="muted">${t.unit ? '[' + esc(t.unit) + '] ' : ''}${typeText[t.dataType] || ''}</span>
        <span class="v" title="${t.ts ? 'Siste verdi, ' + esc(S.fmtTime(t.ts)) : ''}">${esc(fmt(t))}</span></label>`).join('')
        + (hits.length > 600 ? `<p class="muted">… og ${hits.length - 600} til. Søk for å finne dem.</p>` : '')
        + (!hits.length ? '<p class="muted">Ingen tagger passer.</p>' : '');
      count();
    }
    listEl.addEventListener('change', e => {
      const i = e.target;
      if (one) { chosen.clear(); chosen.add(i.value); } else if (i.checked) chosen.add(i.value); else chosen.delete(i.value);
      count();
    });
    q.oninput = render; ty.onchange = render;
    const pat = m.box.querySelector('.pat');
    if (pat) pat.oninput = () => { const p = pat.value.trim(); m.box.querySelector('.n').textContent = p.includes('*') ? `passer med ${tags.filter(t => patternRx(p).test(t.tag)).length} tagger nå` : p ? 'et mønster har en *' : ''; };
    m.box.querySelector('.all').onclick = () => { listEl.querySelectorAll('input').forEach(i => { i.checked = true; chosen.add(i.value); }); count(); };
    m.box.querySelector('.cancel').onclick = () => m.close();
    m.box.querySelector('.ok').onclick = () => {
      const keep = d.tags.filter(t => t.tag.includes('*') || chosen.has(t.tag));
      const kept = new Set(keep.map(t => t.tag));
      for (const name of tags.map(t => t.tag)) if (chosen.has(name) && !kept.has(name)) keep.push({ tag: name, color: '' });
      const p = pat && pat.value.trim();
      if (p && p.includes('*') && !kept.has(p)) keep.push({ tag: p, color: '' });
      d.tags = spec.maxTags ? keep.slice(-spec.maxTags) : keep;
      m.close();
      done();
    };
    render();
    setTimeout(() => q.focus(), 0);
  }

  // ---------------------------------------------------------------- selve visningen
  function viewSettings(box) {
    const c = st.cfg, t = st.tab, i = c.tabs.indexOf(t);
    box.appendChild(el('h3', {}, 'Fanen og visningen'));
    box.appendChild(el('p', { class: 'muted d-lead' }, 'Klikk på en widget for å endre den. Ingen valgt: her er innstillingene for fanen du står i, og for hele visningen.'));

    const tg = el('div', { class: 'd-group' }, '<h4>Fanen</h4>');
    tg.appendChild(field({ key: 'tab', label: 'Navn', type: 'text' }, t.name, v => {
      v = String(v).trim().slice(0, TAB_NAME);
      if (!v) return;
      t.name = v;
      markDirty();
      renderTabs();
      renderPicker();
    }));
    const size = el('div', { class: 'd-field' }, `<label>Lerretet (bredde × høyde)</label><div class="d-grid2"><input type="number" class="cw" value="${t.canvas.width}" step="10" min="400"><input type="number" class="ch" value="${t.canvas.height}" step="10" min="300"></div><div class="hint">Lerretet vokser nedover av seg selv når du legger noe under kanten</div>`);
    size.querySelector('.cw').onchange = e => { t.canvas.width = clamp(Number(e.target.value) || 1600, 400, 8000); markDirty(); renderCanvas(); };
    size.querySelector('.ch').onchange = e => { t.canvas.height = clamp(Number(e.target.value) || 900, 300, 8000); markDirty(); renderCanvas(); };
    tg.appendChild(size);
    const ta = el('div', { class: 'd-actions' }, `<button class="left" title="Flytt fanen til venstre"${i === 0 ? ' disabled' : ''}>◀ Flytt</button><button class="right" title="Flytt fanen til høyre"${i === c.tabs.length - 1 ? ' disabled' : ''}>Flytt ▶</button>
      <button class="dup" title="Lag en kopi av fanen med widgetene">Dupliser</button><button class="danger del"${c.tabs.length < 2 ? ' disabled title="En visning har minst én fane"' : ''}>Slett</button>`);
    ta.querySelector('.left').onclick = () => moveTab(t, i - 1);
    ta.querySelector('.right').onclick = () => moveTab(t, i + 1);
    ta.querySelector('.dup').onclick = duplicateTab;
    ta.querySelector('.del').onclick = deleteTab;
    tg.appendChild(ta);
    box.appendChild(tg);

    const g = el('div', { class: 'd-group' }, '<h4>Hele visningen</h4>');
    const fields = [
      [{ key: 'name', label: 'Navn', type: 'text' }, st.dash.name, v => { if (String(v).trim()) { st.dash.name = String(v).trim(); renderPicker(); } }],
      [{ key: 'fit', label: 'I Run-modus', type: 'select', options: FITS, hint: 'Hvor stort lerretet vises når du bruker visningen' }, c.fit, v => { c.fit = v; }],
      [{ key: 'span', label: 'Tidsrom når visningen åpnes', type: 'select', options: SPANS.map(([ms, x]) => [String(ms), 'Siste ' + x]) }, String(c.span), v => { c.span = Number(v); }],
    ];
    for (const [f, v, set] of fields) g.appendChild(field(f, v, x => { set(x); markDirty(); }));
    const a = el('div', { class: 'd-actions' }, '<button class="dup">Lag en kopi</button><button class="danger del">Slett visningen</button>');
    a.querySelector('.dup').onclick = duplicateView;
    a.querySelector('.del').onclick = deleteView;
    g.appendChild(a);
    box.appendChild(g);
    box.appendChild(el('details', { class: 'd-help' }, `<summary>Tastene</summary><ul>
      <li><b>Dra</b> en widget for å flytte den, hjørnet nede til høyre for å endre størrelsen</li>
      <li><b>Shift-klikk</b> velger flere</li>
      <li><b>Piltastene</b> flytter 10 px (med Shift 1 px)</li>
      <li><b>Delete</b> sletter, <b>Ctrl+D</b> dupliserer, <b>Ctrl+C / Ctrl+V</b> kopierer, også til en annen fane eller visning</li>
      <li><b>Fanene:</b> dobbeltklikk på en fane for å gi den nytt navn, dra den for å flytte den</li>
      <li><b>Ctrl+S</b> lagrer</li></ul>
      <p class="muted">I Run-modus: dra sidelengs i en tidslinje eller trend for å gå i tid, rull for å zoome, og klikk for å sette markøren (Escape tar den bort).</p>`));
  }

  // ================================================================ visningene på serveren
  async function loadList() { st.list = (await api('/dashboards')).dashboards; }
  // tab: fanen som skal vises; ellers den i adressen, eller den du sist så på i denne visningen
  async function openView(id, mode, tab) {
    const mine = st;
    const r = await api('/dashboards/' + id);
    if (st !== mine) return;
    st.dash = { id: r.id, name: r.name, version: r.version };
    st.cfg = normalize(r.config);
    st.selection.clear();
    st.dirty = false;
    st.cache.clear();
    const p = S.params(), here = Number(p.get('id')) === r.id;
    const want = tab || (here && p.get('tab')) || store.get('dash.tab.' + r.id);
    st.tab = st.cfg.tabs.find(t => t.id === want) || st.cfg.tabs[0];
    const from = Number(p.get('from')), to = Number(p.get('to')), span = Number(p.get('span')), mark = Number(p.get('mark'));
    st.now = Date.now();
    if (here && from && to > from) st.range = { live: false, from, to };
    else if (here && span >= SPAN_MIN) st.range = { live: true, span };
    else st.range = { live: true, span: st.cfg.span };
    st.mark = here && mark ? mark : null;
    st.mode = mode || (st.cfg.tabs.some(t => t.widgets.length) ? store.get('dash.mode') || 'run' : 'edit');
    store.set('dash.last', String(r.id));
    renderAll();
    params();
  }
  async function switchTo(id, tab) {
    if (st.dash && id === st.dash.id) { if (tab) switchTab(tab); return; }
    if (st.dirty && !(await S.confirm('Endringer som ikke er lagret', `Du har endret «${esc(st.dash.name)}» uten å lagre. Gå til en annen visning og glem endringene?`, 'Glem endringene', true))) return;
    try { await openView(id, null, tab); } catch (e) { flash(e.message, true); }
  }
  function renderEmpty() {
    st.dash = null;
    st.cfg = blank();
    st.tab = st.cfg.tabs[0];
    renderAll();
    const c = canvasEl();
    c.style.transform = '';
    c.style.width = c.style.height = '';
    c.innerHTML = `<div class="d-empty"><h2>Ingen visninger ennå</h2>
      <p>En visning er widgeter på et lerret, som i HMI-en: tidslinjer, trender, hendelseslister, tabeller og verdier.
      For hver widget velger du kjøreverk, og tagger under hvert kjøreverk, så du kan se og sammenligne dataene.</p>
      <button class="primary">Lag den første visningen</button></div>`;
    c.querySelector('button').onclick = newView;
  }
  function askName(title, value, okText, max) {
    return new Promise(resolve => {
      let out = null;
      const m = S.modal(`<h2>${esc(title)}</h2><form class="form"><label>Navn<input name="name" maxlength="${max || 80}" required value="${esc(value)}"></label>
        <div class="actions"><button type="button" class="cancel">Avbryt</button><button type="submit" class="primary">${esc(okText)}</button></div></form>`, () => resolve(out));
      const f = m.box.querySelector('form');
      m.box.querySelector('.cancel').onclick = () => m.close();
      f.onsubmit = e => { e.preventDefault(); out = f.name.value.trim(); m.close(); };
      setTimeout(() => f.name.select(), 0);
    });
  }
  const freeName = base => freeIn(st.list.map(d => d.name), base);
  async function create(name, config) {
    const r = await api('/dashboards', { method: 'POST', body: { name, config } });
    await loadList();
    await openView(r.id, 'edit');
    return r;
  }
  async function newView() {
    if (st.dirty && !(await S.confirm('Endringer som ikke er lagret', `Du har endret «${esc(st.dash.name)}» uten å lagre. Lage en ny visning og glemme endringene?`, 'Glem endringene', true))) return;
    const name = await askName('Ny visning', freeName('Visning'), 'Lag');
    if (!name) return;
    try { await create(name, blank()); flash(`«${name}» er laget. Velg widgeter til venstre.`); } catch (e) { flash(e.message, true); }
  }
  async function duplicateView() {
    const name = await askName('Lag en kopi', freeName(`${st.dash.name} (kopi)`), 'Lag kopien');
    if (!name) return;
    try { await create(name, copy(st.cfg)); flash(`Kopien «${name}» er laget${st.dirty ? ', med endringene som ikke var lagret i originalen' : ''}.`); } catch (e) { flash(e.message, true); }
  }
  async function deleteView() {
    if (!(await S.confirm('Slett visningen', `Slette «${esc(st.dash.name)}» for alle? Dataene i databasen er ikke berørt, bare visningen.`, 'Slett', true))) return;
    try {
      await api('/dashboards/' + st.dash.id, { method: 'DELETE' });
      st.dirty = false;
      await loadList();
      if (st.list.length) await openView(st.list[0].id); else renderEmpty();
    } catch (e) { flash(e.message, true); }
  }
  async function save() {
    if (!st.dash || st.saving) return;
    st.saving = true;
    const btn = st.root.querySelector('.d-save');
    btn.disabled = true;
    const put = version => api('/dashboards/' + st.dash.id, { method: 'PUT', body: { name: st.dash.name, config: st.cfg, version } });
    try {
      let r;
      try { r = await put(st.dash.version); } catch (e) {
        if (!(e.status === 409 && e.body && e.body.conflict)) throw e;
        const cur = e.body.current;
        if (!(await S.confirm('Noen andre har lagret', `${esc(who(cur.updated_by) || 'Noen')} lagret «${esc(cur.name)}» ${esc(S.fmtTime(cur.updated_at))}, etter at du åpnet den. Lagre dine endringer over deres?`, 'Lagre over', true))) return;
        r = await put(cur.version);
      }
      if (!st) return;
      st.dash.version = r.version;
      st.dirty = false;
      const row = st.list.find(d => d.id === st.dash.id);
      if (row) Object.assign(row, { name: r.name, updated_by: r.updated_by, updated_at: r.updated_at, tabs: st.cfg.tabs.map(t => ({ id: t.id, name: t.name })), widgets: st.cfg.tabs.reduce((n, t) => n + t.widgets.length, 0) });
      renderPicker();
      flash('Lagret');
    } catch (e) { if (st) flash(e.status === 401 ? 'Ikke lagret: logg inn først' : `Ikke lagret: ${e.message}`, true); } finally {
      if (st) { st.saving = false; renderDirty(); }
    }
  }

  // ================================================================ siden
  const beforeUnload = e => { if (st && st.dirty) { e.preventDefault(); e.returnValue = ''; } };
  let resizeTimer = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (st && st.dash) { fitCanvas(); each(h => h.redraw && h.redraw()); } }, 120); };

  S.page('visning', {
    title: 'Kjøreverk-database',
    section: 'dash',
    canLeave: () => !st || !st.dirty,
    onUser: () => { if (st) renderDirty(); },
    async mount(main) {
      st = {
        root: null, picker: null, list: [], dash: null, cfg: blank(), tab: null, mode: 'run', selection: new Set(), dirty: false, saving: false, mounted: new Map(),
        range: { live: true, span: 86400000 }, now: Date.now(), mark: null, scale: 1, clipboard: null, cache: new Map(),
        vehiclesP: null, vehiclesAt: 0, vehicleMap: null, maxDays: 400, ctx: null, timer: 0,
      };
      st.tab = st.cfg.tabs[0];
      st.ctx = makeCtx();
      const mine = st;
      st.root = el('div', { class: 'dash run' }, `
        <div class="d-bar">
          <div class="d-tabs" role="tablist" aria-label="Fanene i visningen"></div>
          <div class="d-ctl">
          <div class="d-time"></div>
          <div class="d-right">
            <span class="d-flash" hidden></span>
            <span class="d-dirty edit-only"></span>
            <button class="d-save primary edit-only" disabled>Lagre</button>
            <div class="d-mode" role="group" aria-label="Modus"><button data-m="edit" title="Bygg visningen: legg til, flytt og endre widgeter">Edit</button><button data-m="run" title="Bruk visningen">Run</button></div>
          </div>
          </div>
        </div>
        <div class="d-work">
          <aside class="d-palette edit-only" aria-label="Widgeter"></aside>
          <section class="d-viewport"><div class="d-canvas"></div></section>
          <aside class="d-inspector edit-only" aria-label="Egenskaper"></aside>
        </div>`);
      main.appendChild(st.root);
      st.root.querySelectorAll('.d-mode button').forEach(b => { b.onclick = () => setMode(b.dataset.m); });
      st.root.querySelector('.d-save').onclick = save;
      setupCanvas();
      setupPicker();
      document.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onDocDown);
      window.addEventListener('beforeunload', beforeUnload);
      window.addEventListener('resize', onResize);
      // live: flytt tidsrommet fram og hent det som er nytt, så lenge fanen synes
      st.timer = setInterval(() => {
        if (!st || !st.dash || document.hidden) return;
        st.now = Date.now();
        if (st.range.live) { renderTime(); each(h => h.view && h.view()); }
        refreshAll('tick');
      }, TICK);
      try { const c = await api('/config'); if (st === mine) st.maxDays = (c.history && c.history.maxDays) || 400; } catch (e) { /* standarden */ }
      try {
        await loadList();
        if (st !== mine) return;
        const want = Number(S.params().get('id')) || Number(store.get('dash.last'));
        const id = st.list.some(d => d.id === want) ? want : st.list.length ? st.list[0].id : null;
        if (id) await openView(id); else renderEmpty();
        vehicles().catch(() => {});
      } catch (e) {
        if (st !== mine) return;
        renderEmpty();
        flash(e.message, true);
      }
    },
    unmount() {
      if (!st) return;
      clearInterval(st.timer);
      clearTimeout(refreshTimer);
      for (const id of [...st.mounted.keys()]) unmountWidget(id);
      if (st.picker) st.picker.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('resize', onResize);
      st = null;
    },
  });
})();

/*
 * pages/trend.js - Trend og tidslinje (docs/PLAN.md §4.3): flere kjøreverk og tagger i samme graf.
 *
 *   - Tall tegnes med uPlot som trinn (en verdi gjelder til den neste, som i HMI-en), én akse per enhet.
 *   - Av/på-signaler vises som felt i en tidslinje under grafen, med samme tidsakse.
 *   - Dra for å zoome inn, rull med musehjulet for å zoome rundt pekeren, ◀ ▶ flytter et halvt tidsrom.
 *     Hver endring henter punktene på nytt, så detaljene kommer fram når man zoomer.
 *   - null fra serveren er et hull (enheten var borte, eller et brudd mellom økter), og tegnes som et brudd.
 * Seriene og tidsrommet står i adressen: #/trend?s=kv52|kv_1.reals_0,kv53|kv_1.reals_0&from=…&to=…
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, el, esc, fmtTime } = S;
  const COLORS = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#ff7b72', '#e3b341', '#39c5cf', '#db61a2', '#a5d6ff', '#7ee787', '#ffa657', '#bc8cff'];
  const SPANS = [[3600000, '1 t'], [28800000, '8 t'], [86400000, '24 t'], [604800000, '7 d'], [2592000000, '30 d']];
  const MAX = 24, LANE = 24;
  const pad = n => String(n).padStart(2, '0');
  const num = v => (v === null || v === undefined ? '–' : Number(v).toLocaleString('nb-NO', { maximumFractionDigits: 3 }));

  let root = null, series = [], range = null, live = false, plot = null, data = null, seq = 0, liveTimer = null, wheelTimer = null, resizeTimer = null, vp = null;

  const key = s => `${s.vehicle}|${s.tag}`;
  // plass til navnene på signalene og tallene på aksen; mindre på en mobil
  const gutter = () => (root && root.querySelector('.chartbox').clientWidth < 600 ? 90 : 150);
  const colorOf = s => COLORS[series.findIndex(x => key(x) === key(s)) % COLORS.length];

  function params() {
    const p = { s: series.map(s => `${encodeURIComponent(s.vehicle)}|${encodeURIComponent(s.tag)}`).join(',') };
    if (live) p.span = range.to - range.from; else { p.from = Math.round(range.from); p.to = Math.round(range.to); }
    return p;
  }

  // ---------------------------------------------------------------- tid på aksene
  function axisValues(u, splits) {
    const span = u.scales.x.max - u.scales.x.min;
    return splits.map(s => {
      const d = new Date(s * 1000);
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (span < 900) return `${hm}:${pad(d.getSeconds())}`;
      if (span < 2 * 86400) return d.getHours() === 0 && d.getMinutes() === 0 ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : hm;
      return span < 10 * 86400 ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
    });
  }
  function niceStep(spanMs, px) {
    const steps = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400, 172800, 604800].map(s => s * 1000);
    return steps.find(s => (spanMs / s) * 90 <= px) || steps[steps.length - 1];
  }

  // ---------------------------------------------------------------- tegningen
  function render() {
    const box = root.querySelector('.chartbox');
    const chartEl = box.querySelector('.chart');
    if (plot) { plot.destroy(); plot = null; }
    chartEl.innerHTML = '';
    if (!data) return;
    const width = box.clientWidth;
    const shown = data.series.filter(s => !s.missing && !s.text);
    const numeric = shown.filter(s => s.dataType !== 'boolean');
    const bools = shown.filter(s => s.dataType === 'boolean');
    root.querySelector('.empty-chart').hidden = shown.length > 0;

    if (numeric.length) {
      // én felles x-akse: alle tidene, og undefined der en serie ikke har en verdi (null er et ekte hull)
      const times = [...new Set(numeric.flatMap(s => s.points.map(p => p[0])))].sort((a, b) => a - b);
      const idx = new Map(times.map((t, i) => [t, i]));
      const cols = numeric.map(s => { const c = new Array(times.length).fill(undefined); for (const [t, v] of s.points) c[idx.get(t)] = v; return c; });
      const units = [...new Set(numeric.map(s => s.unit || ''))];
      const scaleOf = s => `u${units.indexOf(s.unit || '')}`;
      const scales = { x: { time: true, range: () => [range.from / 1000, range.to / 1000] } };
      units.forEach((u, i) => { scales[`u${i}`] = { auto: true }; });
      const axes = [{ stroke: '#8b93a1', grid: { stroke: '#2a2f37' }, ticks: { stroke: '#343a44' }, values: axisValues, space: 70 }];
      units.slice(0, 2).forEach((u, i) => axes.push({ scale: `u${i}`, side: i === 0 ? 3 : 1, size: i === 0 ? gutter() : 56, label: u || undefined, labelSize: 16, stroke: '#8b93a1',
        grid: { show: i === 0, stroke: '#2a2f37' }, ticks: { stroke: '#343a44' }, values: (u2, v) => v.map(num) }));
      const opts = {
        width, height: 380,
        scales, axes,
        series: [{ label: 'Tid', value: (u, v) => (v === null ? '–' : fmtTime(v * 1000)) }].concat(numeric.map(s => ({
          label: `${s.vehicle} · ${s.label || s.tag}`, stroke: colorOf(s), width: 1.6, scale: scaleOf(s),
          paths: uPlot.paths.stepped({ align: 1 }), points: { show: false }, spanGaps: false,
          value: (u, v) => (v === null || v === undefined ? '–' : `${num(v)}${s.unit ? ' ' + s.unit : ''}`),
        }))),
        cursor: { drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
        legend: { live: true },
        hooks: {
          setSelect: [u => {
            if (u.select.width > 6) zoomTo(u.posToVal(u.select.left, 'x') * 1000, u.posToVal(u.select.left + u.select.width, 'x') * 1000);
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          }],
          setCursor: [u => drawTimeline(u.cursor.left >= 0 ? u.posToVal(u.cursor.left, 'x') * 1000 : null)],
        },
      };
      plot = new uPlot(opts, [times.map(t => t / 1000), ...cols], chartEl);
    }
    drawTimeline(null, bools);
  }

  // av/på-signalene: ett felt per signal, med samme tidsakse som grafen
  let lanes = [];
  function drawTimeline(cursorT, bools) {
    if (bools) lanes = bools;
    const box = root && root.querySelector('.chartbox');
    if (!box) return;
    const cv = box.querySelector('.timeline');
    if (!lanes.length) { cv.hidden = true; return; }
    cv.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const width = box.clientWidth;
    const axis = plot ? 0 : 26;
    const height = lanes.length * LANE + axis + 8;
    cv.style.width = width + 'px'; cv.style.height = height + 'px';
    cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const left = plot ? plot.bbox.left / dpr : gutter();
    const w = plot ? plot.bbox.width / dpr : width - left - 16;
    const span = range.to - range.from;
    const x = t => left + ((t - range.from) / span) * w;
    g.font = '12px system-ui, sans-serif';
    g.textBaseline = 'middle';
    lanes.forEach((s, i) => {
      const y = 4 + i * LANE;
      g.fillStyle = '#1e2229';
      g.fillRect(left, y, w, LANE - 6);
      g.fillStyle = '#c9d1d9';
      g.textAlign = 'right';
      let label = `${s.vehicle} · ${s.label || s.tag}`;
      while (g.measureText(label).width > left - 14 && label.length > 4) label = label.slice(0, -2);
      if (label !== `${s.vehicle} · ${s.label || s.tag}`) label += '…';
      g.fillText(label, left - 8, y + (LANE - 6) / 2);
      const pts = s.points;
      for (let k = 0; k < pts.length; k++) {
        const [t, v] = pts[k];
        const t2 = k + 1 < pts.length ? pts[k + 1][0] : Math.min(range.to, Date.now());
        if (t2 <= range.from || t >= range.to) continue;
        const a = Math.max(left, x(t)), b = Math.min(left + w, x(t2));
        if (v === null) {   // hull: skravert
          g.fillStyle = 'rgba(139,147,161,.18)';
          g.fillRect(a, y, Math.max(1, b - a), LANE - 6);
        } else if (v) {
          g.fillStyle = colorOf(s);
          g.fillRect(a, y + 2, Math.max(1.5, b - a), LANE - 10);
        }
      }
    });
    if (!plot) {   // egen tidsakse når det ikke er noen graf over
      const step = niceStep(span, w);
      g.fillStyle = '#8b93a1'; g.textAlign = 'center';
      const y = lanes.length * LANE + 18;
      for (let t = Math.ceil(range.from / step) * step; t <= range.to; t += step) {
        const fake = { scales: { x: { min: range.from / 1000, max: range.to / 1000 } } };
        g.fillText(axisValues(fake, [t / 1000])[0], x(t), y);
      }
    }
    if (cursorT !== null && cursorT !== undefined && cursorT >= range.from && cursorT <= range.to) {
      g.strokeStyle = '#c9d1d9'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x(cursorT)) + 0.5, 0); g.lineTo(Math.round(x(cursorT)) + 0.5, lanes.length * LANE + 4); g.stroke();
    }
    cv._map = { left, w, x, t: px => range.from + ((px - left) / w) * span };
  }

  // verdien til et signal ved en tid
  function valueAt(s, t) {
    let v;
    for (const p of s.points) { if (p[0] > t) break; v = p[1]; }
    return v;
  }

  // ---------------------------------------------------------------- henting og tidsrom
  async function load() {
    S.setParams(params());
    root.querySelector('.range').textContent = `${fmtTime(range.from)} – ${fmtTime(range.to)}`;
    root.querySelectorAll('.spans button').forEach(b => b.classList.toggle('on', live && Number(b.dataset.span) === range.to - range.from));
    renderChips();
    if (!series.length) { data = null; render(); root.querySelector('.empty-chart').hidden = false; return; }
    const my = ++seq;
    const status = root.querySelector('.tstatus');
    status.textContent = 'henter …';
    try {
      const width = root.querySelector('.chartbox').clientWidth;
      const r = await api('/series', { method: 'POST', body: { series, from: Math.round(range.from), to: Math.round(range.to), points: Math.max(200, Math.min(3000, Math.round(width))) } });
      if (my !== seq || !root) return;   // en nyere henting er på vei
      data = r;
      status.textContent = `${r.series.reduce((n, s) => n + s.points.length, 0).toLocaleString('nb-NO')} punkter · ${r.ms} ms`;
      renderChips();
      render();
    } catch (e) { if (my === seq && root) status.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  }

  function zoomTo(from, to) {
    if (to - from < 10000) { const c = (from + to) / 2; from = c - 5000; to = c + 5000; }
    live = false;
    range = { from, to };
    load();
  }
  function setLive(span) {
    live = true;
    const now = Date.now();
    range = { from: now - span, to: now };
    load();
  }

  // ---------------------------------------------------------------- seriene
  function renderChips() {
    const bar = root.querySelector('.chips');
    const info = new Map((data ? data.series : []).map(s => [key(s), s]));
    bar.innerHTML = series.map(s => {
      const d = info.get(key(s));
      const note = d && d.missing ? ' <span class="muted">(finnes ikke)</span>' : d && d.text ? ' <span class="muted">(tekst vises ikke)</span>' : '';
      const name = d ? `${d.label || s.tag}${d.unit ? ' [' + d.unit + ']' : ''}${d.dataType === 'boolean' ? ' · av/på' : ''}` : s.tag;
      return `<span class="chip${d && (d.missing || d.text) ? ' dim' : ''}" title="${esc(s.vehicle)} ${esc(s.tag)}"><i style="background:${colorOf(s)}"></i>${esc(s.vehicle)} · ${esc(name)}${note}<button class="link x" data-k="${esc(key(s))}" title="Fjern">✕</button></span>`;
    }).join('') || '<span class="muted">Ingen serier valgt ennå.</span>';
  }

  async function addSeries() {
    const box = root.querySelector('.addrow');
    const tags = box.querySelector('input[name=tags]').value.trim();
    const err = box.querySelector('.err');
    err.hidden = true;
    if (!tags) { err.textContent = 'Skriv minst én tag.'; err.hidden = false; return; }
    try {
      // katalogen sier hvilke kjøreverk som har taggene
      const r = await api('/find', { method: 'POST', body: { vehicles: vp.get(), tags, from: Math.round(range.from), to: Math.round(range.to) } });
      const rows = r.rows.filter(x => x.dataType !== 'string');
      if (!rows.length) { err.textContent = 'Ingen av kjøreverkene har tagger (tall eller av/på) som passer.'; err.hidden = false; return; }
      let added = 0;
      for (const x of rows) {
        if (series.length >= MAX) break;
        if (!series.some(s => s.vehicle === x.code && s.tag === x.tag)) { series.push({ vehicle: x.code, tag: x.tag }); added++; }
      }
      if (series.length >= MAX && added < rows.length) { err.textContent = `Høyst ${MAX} serier i én graf; resten ble ikke lagt til.`; err.hidden = false; }
      box.querySelector('input[name=tags]').value = '';
      if (!err.hidden) { load(); return; }
      box.hidden = true;
      load();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  // ---------------------------------------------------------------- siden
  S.page('trend', {
    title: 'Trend',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Trend og tidslinje</h1>
        <div class="bar"><div class="chips"></div><button class="primary addbtn">+ Legg til</button></div>
        <div class="addrow section" hidden>
          <div class="form"><div class="grid3">
            <label>Kjøreverk<div class="vp"></div></label>
            <label>Tagger <span class="hint">navn eller mønstre: <code>kv_1.reals_0, kv_1.bit0*</code></span><input name="tags" placeholder="kv_1.reals_0"></label>
            <div class="actions" style="align-self:end;justify-content:flex-start"><button class="primary doadd">Legg til</button><button class="cancel">Lukk</button></div>
          </div><p class="err" hidden></p>
          <p class="hint">Hver tag legges til for hvert av de valgte kjøreverkene som har den. Ingen kjøreverk valgt = alle. Høyst ${MAX} serier.</p></div>
        </div>
        <div class="bar timebar">
          <span class="spans">${SPANS.map(([ms, t]) => `<button data-span="${ms}">${t}</button>`).join('')}</span>
          <button class="back" title="Bakover et halvt tidsrom">◀</button><button class="fwd" title="Framover et halvt tidsrom">▶</button>
          <button class="out" title="Zoom ut">−</button>
          <label class="check"><input type="checkbox" class="live"> Live</label>
          <span class="range muted"></span><span class="tstatus muted"></span>
        </div>
        <div class="chartbox"><div class="chart"></div><canvas class="timeline" hidden></canvas><div class="tip" hidden></div>
          <div class="empty empty-chart">Velg kjøreverk og tagger med «+ Legg til», eller åpne en trend fra <a href="#/find">Finn data</a>.</div></div>
        <p class="hint">Dra over grafen eller tidslinjen for å zoome inn. Musehjulet zoomer rundt pekeren. Tall tegnes som trinn: en verdi gjelder til den neste. Et brudd i linjen, eller skravert felt, er et hull i dataene.</p>`;
      main.appendChild(root);

      const p = S.params();
      series = (p.get('s') || '').split(',').filter(Boolean).map(x => { const [v, t] = x.split('|'); return { vehicle: decodeURIComponent(v || ''), tag: decodeURIComponent(t || '') }; }).filter(x => x.vehicle && x.tag).slice(0, MAX);
      const span = Number(p.get('span'));
      if (p.get('from') && p.get('to')) { range = { from: Number(p.get('from')), to: Number(p.get('to')) }; live = false; } else { const sp = span || 28800000; range = { from: Date.now() - sp, to: Date.now() }; live = true; }
      root.querySelector('.live').checked = live;

      vp = S.vehiclePicker(root.querySelector('.vp'), {});
      S.tagInput(root.querySelector('input[name=tags]'), { vehicles: () => vp.get() });
      const addrow = root.querySelector('.addrow');
      root.querySelector('.addbtn').onclick = () => { addrow.hidden = !addrow.hidden; if (!addrow.hidden) root.querySelector('input[name=tags]').focus(); };
      root.querySelector('.cancel').onclick = () => { addrow.hidden = true; };
      root.querySelector('.doadd').onclick = addSeries;
      root.querySelector('input[name=tags]').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); addSeries(); } });
      root.querySelector('.chips').addEventListener('click', e => {
        const b = e.target.closest('button.x');
        if (!b) return;
        series = series.filter(s => key(s) !== b.dataset.k);
        load();
      });
      root.querySelectorAll('.spans button').forEach(b => { b.onclick = () => { root.querySelector('.live').checked = true; setLive(Number(b.dataset.span)); }; });
      const shift = f => { const d = (range.to - range.from) * f; root.querySelector('.live').checked = false; zoomTo(range.from + d, range.to + d); };
      root.querySelector('.back').onclick = () => shift(-0.5);
      root.querySelector('.fwd').onclick = () => shift(0.5);
      root.querySelector('.out').onclick = () => { const c = (range.from + range.to) / 2, h = range.to - range.from; root.querySelector('.live').checked = false; zoomTo(c - h, c + h); };
      root.querySelector('.live').onchange = e => { if (e.target.checked) setLive(range.to - range.from); else { live = false; load(); } };

      // musehjulet: zoom rundt tiden under pekeren, og hent når hjulet har stoppet
      const box = root.querySelector('.chartbox');
      box.addEventListener('wheel', e => {
        if (!data || e.target.closest('.u-legend')) return;
        const cv = box.querySelector('.timeline');
        const r = box.getBoundingClientRect();
        const left = plot ? plot.bbox.left / (window.devicePixelRatio || 1) : gutter();
        const w = plot ? plot.bbox.width / (window.devicePixelRatio || 1) : (cv._map ? cv._map.w : r.width - gutter() - 16);
        const px = e.clientX - r.left;
        if (px < left || px > left + w) return;
        e.preventDefault();
        const tc = range.from + ((px - left) / w) * (range.to - range.from);
        const f = e.deltaY > 0 ? 1.35 : 1 / 1.35;
        const from = tc - (tc - range.from) * f, to = tc + (range.to - tc) * f;
        if (to - from < 10000) return;
        live = false; root.querySelector('.live').checked = false;
        range = { from, to };
        if (plot) plot.setScale('x', { min: from / 1000, max: to / 1000 });
        drawTimeline(null);
        root.querySelector('.range').textContent = `${fmtTime(from)} – ${fmtTime(to)}`;
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(load, 300);
      }, { passive: false });

      // tidslinjen: dra for å zoome, og pek for å se tilstanden
      const cv = box.querySelector('.timeline'), tip = box.querySelector('.tip');
      let dragFrom = null;
      cv.addEventListener('mousedown', e => { if (cv._map) dragFrom = e.offsetX; });
      cv.addEventListener('mousemove', e => {
        const m = cv._map;
        if (!m) return;
        const t = m.t(e.offsetX);
        if (plot) plot.setCursor({ left: -10, top: -10 });
        drawTimeline(t);
        if (dragFrom !== null) {
          const g = cv.getContext('2d'); const dpr = window.devicePixelRatio || 1;
          g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = 'rgba(124,92,255,.2)';
          g.fillRect(Math.min(dragFrom, e.offsetX), 0, Math.abs(e.offsetX - dragFrom), cv.height / dpr); g.restore();
        }
        const lane = lanes[Math.floor((e.offsetY - 4) / LANE)];
        if (lane && t >= range.from && t <= range.to) {
          const v = valueAt(lane, t);
          tip.hidden = false;
          tip.innerHTML = `<b>${esc(lane.vehicle)} · ${esc(lane.label || lane.tag)}</b><br>${fmtTime(t)}: ${v === undefined ? 'ingen data' : v === null ? 'hull' : v ? '<span style="color:var(--ok)">på</span>' : 'av'}`;
          tip.style.left = Math.min(e.offsetX + 14, box.clientWidth - 220) + 'px';
          tip.style.top = (cv.offsetTop + e.offsetY + 14) + 'px';
        } else tip.hidden = true;
      });
      cv.addEventListener('mouseleave', () => { tip.hidden = true; drawTimeline(null); });
      window.addEventListener('mouseup', root._up = e => {
        if (dragFrom === null) return;
        const m = cv._map, a = dragFrom, b = e.clientX - cv.getBoundingClientRect().left;
        dragFrom = null;
        if (m && Math.abs(b - a) > 6) zoomTo(m.t(Math.min(a, b)), m.t(Math.max(a, b))); else drawTimeline(null);
      });
      window.addEventListener('resize', root._resize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 200); });

      liveTimer = setInterval(() => { if (live && !document.hidden) { const sp = range.to - range.from, now = Date.now(); range = { from: now - sp, to: now }; load(); } }, 15000);
      if (!series.length) addrow.hidden = false;
      load();
    },
    unmount() {
      clearInterval(liveTimer); clearTimeout(wheelTimer); clearTimeout(resizeTimer);
      if (root) { window.removeEventListener('mouseup', root._up); window.removeEventListener('resize', root._resize); }
      if (plot) plot.destroy();
      if (vp) vp.destroy();
      plot = null; root = null; data = null; lanes = []; vp = null;
    },
  });
})();

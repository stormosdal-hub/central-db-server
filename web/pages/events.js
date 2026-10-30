/*
 * pages/events.js - Hendelser og hull (docs/PLAN.md §4.6 og §5.7) på tvers av kjøreverkene, med filtre, og
 * varslene øverst: kjøreverk som har stilnet, og klokker som ikke er synkronisert.
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, el, esc, fmtTime, fmtNum, ago, duration } = S;
  const SEV = { info: ['info', ''], warning: ['advarsel', 'warn'], alarm: ['alarm', 'bad'] };
  const REASON = {
    'queue-full': 'Køen i Pi-ens minne ble full, og de eldste verdiene ble kastet (lenge uten forbindelse)',
    rejected: 'Serveren avviste en batch (feil i dataene)',
    paused: 'Lagringen var satt på pause i reglene',
    session: 'Ingen data mellom to oppstarter av recorderen (Pi-en eller recorderen var borte)',
  };
  let root = null, vp = null, tp = null, tab = 'events', offset = 0;

  async function alerts() {
    const box = root.querySelector('.alerts');
    try {
      const vs = await S.vehicles();
      const silent = vs.filter(v => v.active && v.key_prefix && v.silent);
      const clock = vs.filter(v => v.active && v.last_batch_at && (v.clock_synced === false || Math.abs(v.clock_offset_ms || 0) > 2000));
      const gaps = vs.reduce((n, v) => n + v.gaps_24h, 0);
      const card = (title, cls, items) => `<div class="card alert ${cls}"><div class="k">${title}</div><div class="v ${cls}">${items.length}</div>${items.length ? `<div class="list">${items.join('')}</div>` : ''}</div>`;
      box.innerHTML = card('Stille for lenge', silent.length ? 'bad' : 'ok', silent.map(v => `<a href="#/vehicles" title="grense ${duration(v.silent_after_s)}">${esc(v.code)} <span class="muted">${ago(v.last_batch_at)}</span></a>`))
        + card('Klokke ikke synkronisert eller > 2 s av', clock.length ? 'warn' : 'ok', clock.map(v => `<span>${esc(v.code)} <span class="muted">${v.clock_synced === false ? 'ikke synk' : `${v.clock_offset_ms > 0 ? '+' : ''}${v.clock_offset_ms} ms`}</span></span>`))
        + `<div class="card"><div class="k">Hull meldt siste døgn</div><div class="v ${gaps ? 'warn' : ''}">${gaps}</div></div>`;
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  function query(extra) {
    const f = root.querySelector('form');
    const r = tp.refresh();
    const q = new URLSearchParams({ from: Math.round(r.from), to: Math.round(r.to) });
    if (vp.get().length) q.set('vehicles', vp.get().join(','));
    if (tab === 'events') {
      if (f.severity.value) q.set('severity', f.severity.value);
      if (f.q.value.trim()) q.set('q', f.q.value.trim());
      if (f.source.value.trim()) q.set('source', f.source.value.trim());
    } else if (f.reason.value) q.set('reason', f.reason.value);
    for (const [k, v] of Object.entries(extra || {})) q.set(k, v);
    return q;
  }

  async function loadEvents(more) {
    const out = root.querySelector('.list-events');
    if (!more) offset = 0;
    const q = query({ offset, limit: 200 });
    S.setParams(Object.assign({ tab }, Object.fromEntries(query())));
    try {
      const r = await api(`/events?${q}`);
      const c = r.counts;
      root.querySelector('.counts').innerHTML = ['alarm', 'warning', 'info'].map(s => `<span class="badge ${SEV[s][1]}">${SEV[s][0]}: ${fmtNum(c[s] || 0)}</span>`).join(' ');
      const rows = r.events.map(e => `<tr><td>${fmtTime(e.ts)}</td><td><b>${esc(e.code)}</b></td><td><span class="badge ${SEV[e.severity] ? SEV[e.severity][1] : ''}">${esc(SEV[e.severity] ? SEV[e.severity][0] : e.severity)}</span></td>
        <td class="muted">${esc(e.source)}</td><td class="wrap">${esc(e.message)}${e.src ? ` <span class="muted" title="Fylt inn etterpå">(${e.src === 1 ? 'fra PLS-en' : 'etterfylt'})</span>` : ''}${e.unsynced ? ' <span class="badge warn" title="Klokka på Pi-en var ikke synkronisert">ikke synk</span>' : ''}</td></tr>`).join('');
      const tbody = out.querySelector('tbody');
      if (more) tbody.insertAdjacentHTML('beforeend', rows); else tbody.innerHTML = rows || '<tr><td colspan="5" class="muted">Ingen hendelser i tidsrommet.</td></tr>';
      offset += r.events.length;
      out.querySelector('.more').hidden = !r.more;
    } catch (e) { out.querySelector('tbody').innerHTML = `<tr><td colspan="5" class="err">${esc(e.message)}</td></tr>`; }
  }

  async function loadGaps() {
    const out = root.querySelector('.list-gaps');
    S.setParams(Object.assign({ tab }, Object.fromEntries(query())));
    try {
      const r = await api(`/gaps?${query()}`);
      out.querySelector('tbody').innerHTML = r.gaps.map(g => {
        const tags = !g.tags ? 'alle' : g.tags.length > 4 ? `${g.tags.slice(0, 4).join(', ')} … (${g.tags.length})` : g.tags.join(', ');
        const trend = g.tags && g.tags.length ? `<a href="#/trend?s=${encodeURIComponent(g.tags.slice(0, 8).map(t => `${encodeURIComponent(g.code)}|${encodeURIComponent(t)}`).join(','))}&from=${g.from_ts - (g.to_ts - g.from_ts)}&to=${g.to_ts + (g.to_ts - g.from_ts)}">Trend</a>` : '';
        return `<tr><td>${fmtTime(g.from_ts)}</td><td>${fmtTime(g.to_ts)}</td><td class="num">${duration((g.to_ts - g.from_ts) / 1000)}</td><td><b>${esc(g.code)}</b></td>
          <td class="wrap">${esc(tags)}</td><td><span title="${esc(REASON[g.reason] || '')}">${esc(g.reason === 'session' ? 'brudd mellom økter' : g.reason)}</span></td><td>${trend}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="muted">Ingen hull i tidsrommet.</td></tr>';
      out.querySelector('.trunc').hidden = !r.truncated;
    } catch (e) { out.querySelector('tbody').innerHTML = `<tr><td colspan="7" class="err">${esc(e.message)}</td></tr>`; }
  }

  function showTab(t) {
    tab = t;
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    root.querySelector('.list-events').hidden = t !== 'events';
    root.querySelector('.list-gaps').hidden = t !== 'gaps';
    for (const x of root.querySelectorAll('.f-events')) x.hidden = t !== 'events';
    for (const x of root.querySelectorAll('.f-gaps')) x.hidden = t !== 'gaps';
    if (t === 'events') loadEvents(); else loadGaps();
  }

  function exportLink() {
    const q = query();
    const p = new URLSearchParams({ kind: tab === 'events' ? 'events' : 'gaps', from: q.get('from'), to: q.get('to') });
    if (q.get('vehicles')) p.set('v', q.get('vehicles'));
    return `#/export?${p}`;
  }

  S.page('events', {
    title: 'Hendelser',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Hendelser og hull</h1>
        <div class="cards alerts"></div>
        <div class="tabs"><button data-tab="events">Hendelser og alarmer</button><button data-tab="gaps">Hull</button></div>
        <form class="form evform">
          <div class="grid3">
            <label>Kjøreverk<div class="vp"></div></label>
            <label>Tidsrom<div class="tp"></div></label>
            <div class="row2 f-events">
              <label>Alvorlighet<select name="severity"><option value="">alle</option><option value="warning">advarsel og alarm</option><option value="alarm">bare alarm</option></select></label>
              <label>Melding inneholder<input name="q" placeholder="F7900"></label>
            </div>
            <label class="f-gaps" hidden>Grunn<select name="reason"><option value="">alle</option><option value="queue-full">køen var full</option><option value="rejected">avvist</option><option value="paused">pause</option><option value="session">brudd mellom økter</option></select></label>
          </div>
          <div class="grid3 f-events"><label>Kilde inneholder<input name="source" placeholder="kv_1.words_0"></label><div></div><div></div></div>
          <div class="actions" style="justify-content:flex-start"><button type="submit" class="primary">Vis</button><a class="btn exp" href="#/export">Eksporter</a><span class="counts f-events"></span></div>
        </form>
        <div class="list-events"><table><thead><tr><th>Tid</th><th>Kjøreverk</th><th>Alvorlighet</th><th>Kilde</th><th>Melding</th></tr></thead><tbody></tbody></table>
          <div class="actions" style="justify-content:center"><button class="more" hidden>Vis flere</button></div></div>
        <div class="list-gaps" hidden><table><thead><tr><th>Fra</th><th>Til</th><th class="num">Varighet</th><th>Kjøreverk</th><th>Tagger</th><th>Grunn</th><th></th></tr></thead><tbody></tbody></table>
          <p class="muted trunc" hidden>Bare de 1000 nyeste vises. Velg et kortere tidsrom.</p>
          <p class="hint">Grunnene: ${Object.entries(REASON).map(([k, v]) => `<b>${k === 'session' ? 'brudd mellom økter' : k}</b>: ${esc(v)}`).join('. ')}.</p></div>`;
      main.appendChild(root);
      const p = S.params();
      const f = root.querySelector('form');
      vp = S.vehiclePicker(root.querySelector('.vp'), { selected: (p.get('v') || p.get('vehicles') || '').split(',').filter(Boolean) });
      tp = S.timePicker(root.querySelector('.tp'), p.get('from') ? { from: Number(p.get('from')), to: Number(p.get('to')) } : { span: 86400000 });
      for (const k of ['severity', 'q', 'source', 'reason']) if (p.get(k)) f[k].value = p.get(k);
      f.onsubmit = e => { e.preventDefault(); showTab(tab); };
      root.querySelector('.exp').onclick = e => { e.preventDefault(); location.hash = exportLink(); };
      root.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
      root.querySelector('.more').onclick = () => loadEvents(true);
      alerts();
      showTab(p.get('tab') === 'gaps' ? 'gaps' : 'events');
    },
    unmount() { if (vp) vp.destroy(); root = null; vp = null; tp = null; },
  });
})();

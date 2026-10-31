/*
 * components.js - velgerne sidene deler (docs/PLAN.md §4: «tidsvelgeren og velgeren for kjøreverk»):
 *   Shell.timePicker(el, { from, to, onChange })       tidsrom: hurtigvalg og fra/til
 *   Shell.vehiclePicker(el, { selected, onChange })    kjøreverk: ingen valgt = alle
 *   Shell.tagInput(input, { vehicles })                tagmønstre med forslag fra katalogen
 *   Shell.vehicles(force)                              kjøreverkene (huskes i 30 s; force henter på nytt)
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { esc, el, api } = S;
  const pad = n => String(n).padStart(2, '0');
  const local = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const PRESETS = [['600000', 'Siste 10 min'], ['3600000', 'Siste time'], ['28800000', 'Siste 8 timer'], ['86400000', 'Siste døgn'], ['604800000', 'Siste 7 dager'], ['2592000000', 'Siste 30 dager'], ['', 'Egendefinert']];

  let vehiclesCache = null, vehiclesAt = 0;
  async function vehicles(force) {
    if (force || !vehiclesCache || Date.now() - vehiclesAt > 30000) { vehiclesCache = (await api('/vehicles')).vehicles; vehiclesAt = Date.now(); }
    return vehiclesCache;
  }

  // ---------------------------------------------------------------- tidsrom
  function timePicker(host, o) {
    const span = o && o.from && o.to ? null : (o && o.span) || 86400000;
    host.classList.add('timepicker');
    host.innerHTML = `<select class="preset">${PRESETS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
      <input type="datetime-local" class="from" aria-label="Fra"><span class="muted">–</span><input type="datetime-local" class="to" aria-label="Til">`;
    const preset = host.querySelector('.preset'), f = host.querySelector('.from'), t = host.querySelector('.to');
    const change = () => { if (o && o.onChange) o.onChange(api_.get()); };
    const api_ = {
      get() { const from = new Date(f.value).getTime(), to = new Date(t.value).getTime(); return { from, to, span: preset.value ? Number(preset.value) : null }; },
      set(from, to, spanMs) {
        f.value = local(from); t.value = local(to);
        preset.value = spanMs && PRESETS.some(p => p[0] === String(spanMs)) ? String(spanMs) : '';
      },
      // et hurtigvalg flyttes fram til nå når det brukes
      refresh() { if (preset.value) { const now = Date.now(); api_.set(now - Number(preset.value), now, Number(preset.value)); } return api_.get(); },
    };
    preset.onchange = () => { if (preset.value) api_.refresh(); change(); };
    f.onchange = t.onchange = () => { preset.value = ''; change(); };
    if (span) api_.set(Date.now() - span, Date.now(), span); else api_.set(o.from, o.to, o.spanMs);
    return api_;
  }

  // ---------------------------------------------------------------- kjøreverk
  function vehiclePicker(host, o) {
    let selected = new Set((o && o.selected) || []);
    let list = [];
    host.classList.add('vpick');
    host.innerHTML = `<button type="button" class="vbtn">Alle kjøreverk</button><div class="vpanel" hidden>
      <input type="search" placeholder="Søk i kode og navn">
      <div class="vrow"><button type="button" class="link all">Velg alle viste</button><button type="button" class="link none">Ingen (= alle)</button></div>
      <div class="vlist"></div></div>`;
    const btn = host.querySelector('.vbtn'), panel = host.querySelector('.vpanel'), search = panel.querySelector('input'), box = panel.querySelector('.vlist');
    const label = () => {
      btn.textContent = !selected.size ? `Alle kjøreverk${list.length ? ` (${list.length})` : ''}` : selected.size <= 3 ? [...selected].join(', ') : `${selected.size} kjøreverk`;
    };
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const vs = list.filter(v => !q || v.code.toLowerCase().includes(q) || String(v.name || '').toLowerCase().includes(q));
      box.innerHTML = vs.map(v => `<label class="check"><input type="checkbox" value="${esc(v.code)}"${selected.has(v.code) ? ' checked' : ''}> <b>${esc(v.code)}</b> <span class="muted">${esc(v.name || '')}</span></label>`).join('') || '<p class="muted">ingen treff</p>';
    };
    const change = () => { label(); if (o && o.onChange) o.onChange([...selected]); };
    box.addEventListener('change', e => { const c = e.target; if (c.checked) selected.add(c.value); else selected.delete(c.value); change(); });
    search.oninput = render;
    panel.querySelector('.all').onclick = () => { for (const c of box.querySelectorAll('input')) { c.checked = true; selected.add(c.value); } change(); };
    panel.querySelector('.none').onclick = () => { selected.clear(); render(); change(); };
    btn.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) { render(); search.focus(); } };
    const outside = e => { if (!host.contains(e.target)) panel.hidden = true; };
    document.addEventListener('mousedown', outside);
    vehicles().then(v => { list = v; label(); }).catch(() => {});
    label();
    return {
      get: () => [...selected],
      set(codes) { selected = new Set(codes || []); label(); },
      destroy() { document.removeEventListener('mousedown', outside); },
    };
  }

  // ---------------------------------------------------------------- tagmønstre med forslag
  // input: et tekstfelt med mønstre som "kv_1.bit*, kv_1.reals_0". Forslagene gjelder det siste ordet.
  function tagInput(input, o) {
    const wrap = el('div', { class: 'tagwrap' });
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = el('div', { class: 'suggest', hidden: '' });
    wrap.appendChild(list);
    let tags = [], loadedFor = null, active = -1, timer = null;
    const vehiclesNow = () => (o && o.vehicles ? o.vehicles() : []);
    async function load() {
      const key = vehiclesNow().join(',');
      if (loadedFor === key) return;
      loadedFor = key;
      try { tags = (await api(`/tags?limit=2000${key ? '&vehicles=' + encodeURIComponent(key) : ''}`)).tags; } catch (e) { tags = []; }
    }
    const lastToken = () => { const m = input.value.slice(0, input.selectionStart || input.value.length).match(/([^,\s]*)$/); return m ? m[1] : ''; };
    function show() {
      // forslagene kan komme fra serveren etter at feltet har mistet fokus: da vises de ikke
      if (document.activeElement !== input) { list.hidden = true; return; }
      const q = lastToken().toLowerCase().replace(/\*/g, '');
      const hits = tags.filter(t => !q || t.tag.toLowerCase().includes(q) || String(t.label || '').toLowerCase().includes(q)).slice(0, 40);
      active = -1;
      if (!hits.length) { list.hidden = true; return; }
      list.innerHTML = hits.map((t, i) => `<div class="opt" data-i="${i}" data-tag="${esc(t.tag)}"><b>${esc(t.tag)}</b> <span class="muted">${esc(t.label || '')}${t.unit ? ' [' + esc(t.unit) + ']' : ''}${t.data_type === 'boolean' ? ' · av/på' : t.data_type === 'string' ? ' · tekst' : ''} · ${t.vehicles} kv</span></div>`).join('');
      list.hidden = false;
    }
    function pick(tag) {
      const pos = input.selectionStart || input.value.length;
      const before = input.value.slice(0, pos).replace(/([^,\s]*)$/, tag);
      const after = input.value.slice(pos).replace(/^[^,\s]*/, '');
      input.value = before + (after.trim() ? after : ', ');
      list.hidden = true;
      input.focus();
      input.dispatchEvent(new Event('change'));
    }
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('focus', async () => { await load(); show(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => { await load(); show(); }, 120); });
    input.addEventListener('keydown', e => {
      const opts = list.querySelectorAll('.opt');
      if (list.hidden || !opts.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        opts.forEach((x, i) => x.classList.toggle('on', i === active));
        opts[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(opts[active].dataset.tag); } else if (e.key === 'Escape') list.hidden = true;
    });
    list.addEventListener('mousedown', e => { const x = e.target.closest('.opt'); if (x) { e.preventDefault(); pick(x.dataset.tag); } });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    return { reload() { loadedFor = null; } };
  }

  // ---------------------------------------------------------------- varighet i ord
  function duration(s) {
    if (s === null || s === undefined) return '–';
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${pad(Math.round(s % 60))} s`;
    if (s < 86400) return `${Math.floor(s / 3600)} t ${pad(Math.floor((s % 3600) / 60))} min`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} t`;
  }

  // statusen til et kjøreverk: [tekst, klasse, forklaring]. Avvist: serveren har avvist recorderen etter siste
  // gang den slapp inn, for eksempel fordi navnet på Pi-en ikke er likt koden her.
  function vehicleStatus(v) {
    const refused = v.last_refused_at && (!v.last_seen || v.last_refused_at > v.last_seen);
    if (!v.active) return ['Slått av', '', 'Aktiv er ikke krysset av: recorderen får 403'];
    if (!v.key_prefix) return ['Ingen nøkkel', 'warn', 'Lag en nøkkel på siden Kjøreverk'];
    if (refused) return ['Avvist', 'bad', `Serveren avviste den ${S.fmtTime(v.last_refused_at)} fra ${v.last_refused_ip || '?'}: ${v.last_refused_reason || ''}`];
    if (v.last_batch_at === null) return v.last_seen ? ['Har hilst, ikke sendt', 'warn', 'Recorderen kommer gjennom, men har ikke sendt data ennå'] : ['Aldri hørt fra', 'warn', 'Ingen recorder har koblet til med nøkkelen'];
    if (v.sending) return ['Sender', 'ok', ''];
    if (v.silent) return ['Stille', 'bad', `Ingenting på lenger enn ${duration(v.silent_after_s)}`];
    return ['Venter', 'info', 'Har sendt før, men ikke de siste 90 sekundene'];
  }

  Object.assign(S, { timePicker, vehiclePicker, tagInput, vehicles, duration, localInput: local, vehicleStatus });
})();

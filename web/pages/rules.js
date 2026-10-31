/*
 * pages/rules.js - Regler (docs/PLAN.md §4.5): rediger regelsettene og tillegget per kjøreverk, pauser,
 * forhåndsvisning med regelmotoren, og historikken. Formatet er docs/PROTOKOLL.md §7; serveren sjekker alt med
 * lib/record-rules.js fra hmi-core før det lagres. Alle kan se; å endre krever rollen rules.
 *
 * Pauser lagres med en gang (de skal virke nå), mens endringer i reglene lagres med «Lagre».
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, el, esc, fmtTime, fmtNum } = S;
  const MODES = { change: 'Ved endring', interval: 'Fast takt', ignore: 'Lagres ikke' };
  const SEV = { info: 'info og oppover (alt)', warning: 'advarsel og alarm', alarm: 'bare alarm' };
  const PAUSE_FOR = [[30, '30 min'], [60, '1 time'], [120, '2 timer'], [240, '4 timer'], [480, '8 timer'], [1440, '1 døgn'], [0, 'til den oppheves']];

  let root = null, sets = [], vehicles = [];
  let ed = null;   // { target: { set } | { vehicle }, rec, original, version, usedBy, setName, setRec, isNew }
  let checkTimer = null;

  const can = () => S.can('rules');
  const dirty = () => ed && (ed.isNew || JSON.stringify(ed.rec) !== ed.original);
  const targetName = t => (t.set ? `regelsettet ${t.set}` : `tillegget for ${t.vehicle}`);
  const onUnload = e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };

  function summary(r) {
    if (r.mode === 'ignore') return '<span class="muted">lagres ikke</span>';
    if (r.mode === 'interval') return `siste verdi hvert ${r.every} s`;
    const p = ['hver endring'];
    if (r.deadband !== undefined && r.deadband !== '' && r.deadband !== 0) p.push(`dødbånd ${esc(r.deadband)}`);
    if (r.bits) p.push(`bare bit ${esc(r.bits)}`);
    if (r.ignoreBits) p.push(`uten bit ${esc(r.ignoreBits)}`);
    if (r.minInterval) p.push(`høyst én per ${r.minInterval} s`);
    if (r.maxInterval) p.push(`minst hvert ${r.maxInterval} s`);
    if (r.flickerChanges) p.push(`flimring: over ${r.flickerChanges} på ${r.flickerSeconds} s`);
    return p.join(' · ');
  }

  // ---------------------------------------------------------------- venstre: regelsett og tillegg
  async function loadTargets() {
    [sets, vehicles] = await Promise.all([api('/rulesets'), S.vehicles(true)]);
    const box = root.querySelector('.targets');
    const cur = ed && ed.target;
    box.innerHTML = `<h3>Regelsett</h3>
      ${sets.map(s => `<button class="target${cur && cur.set === s.name ? ' on' : ''}" data-set="${esc(s.name)}"><b>${esc(s.name)}</b><span class="muted">v${s.version} · ${s.rules} regler${s.pauses ? ` · ${s.pauses} pauser` : ''} · ${s.vehicles} kv</span></button>`).join('')}
      ${can() ? '<button class="link newset">+ Nytt regelsett</button>' : ''}
      <h3>Tillegg per kjøreverk</h3>
      <p class="hint">Regler og pauser for ett kjøreverk, som går foran regelsettet det bruker.</p>
      <select class="vsel"><option value="">Velg kjøreverk …</option>${vehicles.map(v => `<option value="${esc(v.code)}"${cur && cur.vehicle === v.code ? ' selected' : ''}>${esc(v.code)}${v.has_extra ? ' (har tillegg)' : ''} · ${esc(v.rule_set)}</option>`).join('')}</select>`;
    box.querySelectorAll('button.target').forEach(b => { b.onclick = () => open({ set: b.dataset.set }); });
    box.querySelector('.vsel').onchange = e => { if (e.target.value) open({ vehicle: e.target.value }); };
    const ns = box.querySelector('.newset');
    if (ns) ns.onclick = newSet;
  }

  async function newSet() {
    if (dirty() && !(await S.confirm('Forkaste endringene?', `Du har endringer i ${targetName(ed.target)} som ikke er lagret.`, 'Forkast', true))) return;
    const m = S.modal(`<h2>Nytt regelsett</h2><form class="form"><label>Navn<input name="name" required maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]*" placeholder="f.eks. stille"></label>
      <label class="check"><input type="checkbox" name="copy" checked> Begynn med en kopi av ${ed && ed.target.set ? esc(ed.target.set) : 'default'}</label>
      <div class="actions"><button type="button" class="cancel">Avbryt</button><button class="primary">Lag</button></div></form>`);
    const f = m.box.querySelector('form');
    m.box.querySelector('.cancel').onclick = () => m.close();
    f.onsubmit = async e => {
      e.preventDefault();
      const name = f.name.value.trim();
      if (sets.some(s => s.name === name)) { alert(`${name} finnes allerede`); return; }
      let rec = { events: true, eventsMin: 'info', rules: [{ tags: '*', mode: 'change' }], pauses: [] };
      if (f.copy.checked) { const from = await api(`/rulesets/${encodeURIComponent(ed && ed.target.set ? ed.target.set : 'default')}`); rec = Object.assign({}, from.recording, { pauses: [] }); }
      m.close();
      ed = { target: { set: name }, rec, original: '', version: null, usedBy: [], isNew: true };
      renderEditor();
      loadTargets();
    };
  }

  // ---------------------------------------------------------------- å åpne et regelsett eller et tillegg
  async function open(target, force) {
    if (!force && dirty() && !(await S.confirm('Forkaste endringene?', `Du har endringer i ${targetName(ed.target)} som ikke er lagret.`, 'Forkast', true))) { loadTargets(); return; }
    S.setParams(target.set ? { set: target.set } : { vehicle: target.vehicle });
    if (target.set) {
      const r = await api(`/rulesets/${encodeURIComponent(target.set)}`);
      ed = { target, rec: r.recording, original: JSON.stringify(r.recording), version: r.version, usedBy: r.vehicles, updated: r.updated_at, by: r.updated_by };
    } else {
      const r = await api(`/vehicles/${encodeURIComponent(target.vehicle)}/rules`);
      const set = await api(`/rulesets/${encodeURIComponent(r.ruleSet)}`);
      const rec = { rules: (r.extra && r.extra.rules) || [], pauses: (r.extra && r.extra.pauses) || [] };
      ed = { target, rec, original: JSON.stringify(rec), version: r.version, setName: r.ruleSet, setRec: set.recording };
    }
    renderEditor();
    loadTargets();
  }

  // ---------------------------------------------------------------- editoren
  function renderEditor() {
    const box = root.querySelector('.editor');
    const t = ed.target, w = can();
    const ro = w ? '' : ' disabled';
    const head = t.set
      ? `<h2>Regelsett <b>${esc(t.set)}</b> ${ed.isNew ? '<span class="badge warn">nytt, ikke lagret</span>' : `<span class="muted">versjon ${ed.version} · endret ${fmtTime(ed.updated)} av ${esc(ed.by || '–')}</span>`}</h2>
         <p class="muted">${ed.usedBy && ed.usedBy.length ? `Brukes av ${ed.usedBy.length} kjøreverk: ${ed.usedBy.slice(0, 12).map(esc).join(', ')}${ed.usedBy.length > 12 ? ' …' : ''}.` : 'Ingen kjøreverk bruker det ennå. Velg det på siden Kjøreverk.'}</p>`
      : `<h2>Tillegg for <b>${esc(t.vehicle)}</b> <span class="muted">regelversjon ${ed.version}</span></h2>
         <p class="muted">Disse reglene og pausene går foran regelsettet <a href="#/rules?set=${encodeURIComponent(ed.setName)}" class="setlink">${esc(ed.setName)}</a>. Første regel som treffer, gjelder. Tomt tillegg = bare regelsettet.</p>`;
    box.innerHTML = `${head}
      <div class="savebar section"${w ? '' : ' hidden'}>
        <input class="note" placeholder="Hva endret du? (kommer i historikken)" maxlength="300">
        <button class="primary save">Lagre</button><button class="revert">Angre endringer</button>
        <span class="dirty muted"></span>
      </div>
      <div class="errors"></div>
      ${t.set ? `<div class="section evrow form"><label class="check"><input type="checkbox" class="events"${ed.rec.events !== false ? ' checked' : ''}${ro}> Send hendelser og alarmer fra kjøreverkene</label>
        <label>Fra alvorlighetsgrad<select class="eventsMin"${ro}>${Object.entries(SEV).map(([k, v]) => `<option value="${k}"${(ed.rec.eventsMin || 'info') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div>` : ''}
      <div class="tabs"><button data-tab="table" class="on">Regler</button><button data-tab="json">JSON</button></div>
      <div class="tab-table">
        <table class="ruletable"><thead><tr><th>#</th><th>Tagger</th><th>Hva som lagres</th><th>Notat</th><th></th></tr></thead><tbody></tbody></table>
        <div class="actions" style="justify-content:flex-start">${w ? '<button class="addrule">+ Ny regel</button>' : ''}<span class="hint">Første regel som treffer en tag, gjelder. En tag ingen regel treffer, lagres ikke. <code>\${pls}</code> byttes ut på Pi-en med prosjektets variabel (<code>vars</code> i <code>hmi.json</code>; i kjøreverkene <code>pls</code>).</span></div>
      </div>
      <div class="tab-json" hidden><textarea class="json" spellcheck="false" rows="18"${ro}></textarea>
        <div class="actions" style="justify-content:flex-start">${w ? '<button class="applyjson">Bruk JSON-en</button>' : ''}<span class="hint">Formatet står i docs/PROTOKOLL.md §7.</span></div></div>
      <h2>Pauser</h2>
      <div class="pauses"></div>
      <h2>Forhåndsvisning</h2>
      <div class="section preview form"></div>
      <h2>Historikk</h2>
      <div class="history"></div>
      ${t.set && t.set !== 'default' && w && !ed.isNew ? '<div class="actions" style="justify-content:flex-start;margin-top:14px"><button class="danger delset">Slett regelsettet</button></div>' : ''}`;

    box.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => {
      box.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      box.querySelector('.tab-table').hidden = b.dataset.tab !== 'table';
      box.querySelector('.tab-json').hidden = b.dataset.tab !== 'json';
      if (b.dataset.tab === 'json') box.querySelector('.json').value = JSON.stringify(ed.rec, null, 2);
    }; });
    const sl = box.querySelector('.setlink');
    if (sl) sl.onclick = e => { e.preventDefault(); open({ set: ed.setName }); };
    if (t.set) {
      box.querySelector('.events').onchange = e => { ed.rec.events = e.target.checked; changed(); };
      box.querySelector('.eventsMin').onchange = e => { ed.rec.eventsMin = e.target.value; changed(); };
    }
    const add = box.querySelector('.addrule');
    if (add) add.onclick = () => editRule(-1);
    const aj = box.querySelector('.applyjson');
    if (aj) aj.onclick = () => {
      try {
        const v = JSON.parse(box.querySelector('.json').value);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('JSON-en må være et objekt med rules (og pauses)');
        ed.rec = t.set ? { events: v.events !== false, eventsMin: v.eventsMin || 'info', rules: v.rules || [], pauses: ed.rec.pauses } : { rules: v.rules || [], pauses: ed.rec.pauses };
        renderEditor();
        changed();
      } catch (e) { box.querySelector('.errors').innerHTML = `<p class="err">JSON-en kan ikke leses: ${esc(e.message)}</p>`; }
    };
    if (w) {
      box.querySelector('.save').onclick = save;
      box.querySelector('.revert').onclick = () => { if (ed.isNew) { ed = null; root.querySelector('.editor').innerHTML = ''; loadTargets(); return; } ed.rec = JSON.parse(ed.original); renderEditor(); changed(); };
    }
    const del = box.querySelector('.delset');
    if (del) del.onclick = async () => {
      if (!(await S.confirm(`Slette regelsettet ${t.set}?`, 'Historikken for det slettes også. Det kan bare slettes når ingen kjøreverk bruker det.', 'Slett', true))) return;
      try { await api(`/rulesets/${encodeURIComponent(t.set)}`, { method: 'DELETE' }); ed = null; root.querySelector('.editor').innerHTML = ''; S.setParams({}); loadTargets(); } catch (e) { alert(e.message); }
    };
    renderRules();
    renderPauses();
    renderPreview();
    loadHistory();
    changed(true);
  }

  function renderRules() {
    const tbody = root.querySelector('.ruletable tbody');
    const w = can();
    const n = ed.rec.rules.length;
    tbody.innerHTML = ed.rec.rules.map((r, i) => `<tr data-i="${i}"><td class="muted">${i + 1}</td><td><code>${esc(r.tags)}</code></td><td>${summary(r)}</td><td class="muted wrap">${esc(r.note || '')}</td>
      <td class="links">${w ? `<button class="link edit">Endre</button><button class="link up"${i === 0 ? ' disabled' : ''} title="Flytt opp">↑</button><button class="link down"${i === n - 1 ? ' disabled' : ''} title="Flytt ned">↓</button><button class="link del" title="Slett">✕</button>` : ''}</td></tr>`).join('')
      || `<tr><td colspan="5" class="muted">${ed.target.set ? 'Ingen regler: ingenting lagres.' : 'Ingen regler i tillegget: regelsettet gjelder alene.'}</td></tr>`;
    tbody.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      const i = Number(b.closest('tr').dataset.i);
      const rules = ed.rec.rules;
      if (b.classList.contains('edit')) return editRule(i);
      if (b.classList.contains('up') && i > 0) [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
      if (b.classList.contains('down') && i < rules.length - 1) [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
      if (b.classList.contains('del')) rules.splice(i, 1);
      renderRules();
      changed();
    };
  }

  // en regel i et vindu: feltene som gjelder for hva som lagres
  function editRule(i) {
    const r = i >= 0 ? Object.assign({}, ed.rec.rules[i]) : { tags: '', mode: 'change' };
    const bitsKind = r.bits ? 'bits' : r.ignoreBits ? 'ignoreBits' : '';
    const v = k => (r[k] === undefined || r[k] === null ? '' : esc(r[k]));
    const m = S.modal(`<h2>${i >= 0 ? `Regel ${i + 1}` : 'Ny regel'}</h2>
      <form class="form ruleform">
        <label>Tagger <span class="hint">mønstre med komma mellom: <code>\${pls}.reals_0, \${pls}.bit*</code>; <code>*</code> passer med alt</span><input name="tags" required value="${v('tags')}"></label>
        <label>Hva som lagres<select name="mode">${Object.entries(MODES).map(([k, t]) => `<option value="${k}"${r.mode === k ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <div class="m-change">
          <div class="row2">
            <label>Dødbånd <span class="hint">minste endring som lagres: et tall (50) eller prosent (2%)</span><input name="deadband" value="${v('deadband')}" placeholder="0 = hver endring"></label>
            <label>Biter i et ord<select name="bitsKind"><option value="">alle teller</option><option value="bits"${bitsKind === 'bits' ? ' selected' : ''}>bare disse teller</option><option value="ignoreBits"${bitsKind === 'ignoreBits' ? ' selected' : ''}>alle unntatt disse</option></select></label>
          </div>
          <label class="bitsrow">Bitene <span class="hint">0 til 31, som <code>0-7, 11</code></span><input name="bitList" value="${esc(r.bits || r.ignoreBits || '')}"></label>
          <div class="row2">
            <label>Høyst én verdi per (s) <span class="hint">siste verdi lagres når tiden er ute</span><input name="minInterval" inputmode="decimal" value="${v('minInterval')}"></label>
            <label>Lagre på nytt etter (s) <span class="hint">selv om ingenting er endret</span><input name="maxInterval" inputmode="decimal" value="${v('maxInterval')}"></label>
          </div>
          <div class="row2">
            <label>Flimring: flere enn så mange endringer <span class="hint">stopper lagringen til det roer seg</span><input name="flickerChanges" inputmode="numeric" value="${v('flickerChanges')}"></label>
            <label>… innen så mange sekunder<input name="flickerSeconds" inputmode="decimal" value="${v('flickerSeconds')}"></label>
          </div>
        </div>
        <div class="m-interval"><label>Hvert (s) <span class="hint">siste verdi, endret eller ikke</span><input name="every" inputmode="decimal" value="${v('every')}" placeholder="60"></label></div>
        <label>Notat<input name="note" maxlength="300" value="${v('note')}"></label>
        <p class="hint">Uansett regel lagres en tags første verdi og hver endring i kvalitet (god, usikker, dårlig), unntatt når den ikke lagres.</p>
        <div class="actions"><button type="button" class="cancel">Avbryt</button><button class="primary">${i >= 0 ? 'Bruk' : 'Legg til'}</button></div>
      </form>`);
    m.box.classList.add('wide');
    const f = m.box.querySelector('form');
    S.tagInput(f.tags, { vehicles: () => (ed.target.vehicle ? [ed.target.vehicle] : (ed.usedBy || [])) });
    const sync = () => {
      m.box.querySelector('.m-change').hidden = f.mode.value !== 'change';
      m.box.querySelector('.m-interval').hidden = f.mode.value !== 'interval';
      m.box.querySelector('.bitsrow').hidden = !f.bitsKind.value;
    };
    f.mode.onchange = f.bitsKind.onchange = sync;
    sync();
    m.box.querySelector('.cancel').onclick = () => m.close();
    f.onsubmit = e => {
      e.preventDefault();
      const out = { tags: f.tags.value.trim().replace(/,\s*$/, ''), mode: f.mode.value };
      const numOf = k => { const s = f[k].value.trim().replace(',', '.'); return s === '' ? undefined : Number(s); };
      if (out.mode === 'change') {
        if (f.deadband.value.trim()) out.deadband = /%$/.test(f.deadband.value.trim()) ? f.deadband.value.trim().replace(',', '.').replace(/\s/g, '') : numOf('deadband');
        if (f.bitsKind.value && f.bitList.value.trim()) out[f.bitsKind.value] = f.bitList.value.trim();
        for (const k of ['minInterval', 'maxInterval', 'flickerChanges', 'flickerSeconds']) { const x = numOf(k); if (x !== undefined) out[k] = x; }
      }
      if (out.mode === 'interval') { const x = numOf('every'); if (x !== undefined) out.every = x; }
      if (f.note.value.trim()) out.note = f.note.value.trim();
      if (i >= 0) ed.rec.rules[i] = out; else ed.rec.rules.push(out);
      m.close();
      renderRules();
      changed();
    };
  }

  // etter hver endring: lagre-knappen, og feilene fra serveren (den samme sjekken som lagringen)
  function changed(initial) {
    const box = root.querySelector('.editor');
    if (!box || !ed) return;
    const d = dirty();
    const ds = box.querySelector('.dirty');
    if (ds) ds.textContent = d ? 'Endringer som ikke er lagret' : 'Lagret';
    const sb = box.querySelector('.save');
    if (sb) sb.disabled = !d;
    const rv = box.querySelector('.revert');
    if (rv) rv.disabled = !d;
    if (initial) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      try {
        const rec = ed.target.set ? ed.rec : { rules: ed.rec.rules, pauses: ed.rec.pauses };
        const r = await api('/rules/check', { method: 'POST', body: { recording: rec } });
        box.querySelector('.errors').innerHTML = r.ok ? '' : `<div class="note warn"><b>Dette må rettes før det kan lagres:</b><ul>${r.errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
      } catch (e) { /* sjekkes igjen ved lagring */ }
    }, 300);
  }

  async function save() {
    const box = root.querySelector('.editor');
    const note = box.querySelector('.note').value.trim();
    try {
      if (ed.target.set) await api(`/rulesets/${encodeURIComponent(ed.target.set)}`, { method: 'PUT', body: { recording: ed.rec, note } });
      else await api(`/vehicles/${encodeURIComponent(ed.target.vehicle)}/rules`, { method: 'PUT', body: { extra: { rules: ed.rec.rules, pauses: ed.rec.pauses }, note } });
      await open(ed.target, true);
      const ds = root.querySelector('.editor .dirty');
      if (ds) ds.textContent = 'Lagret ✓ Kjøreverkene henter de nye reglene med neste batch.';
    } catch (e) {
      box.querySelector('.errors').innerHTML = `<div class="note warn"><b>Ikke lagret:</b> ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- pauser (lagres med en gang)
  function renderPauses() {
    const box = root.querySelector('.pauses');
    const now = Date.now(), w = can();
    const ps = (ed.rec.pauses || []).slice().sort((a, b) => b.since - a.since);
    const state = p => (p.since > now ? ['kommer', 'info'] : p.until === null || p.until > now ? ['aktiv', 'warn'] : ['over', '']);
    box.innerHTML = `${ps.length ? `<table><thead><tr><th>Status</th><th>Tagger</th><th>Fra</th><th>Til</th><th>Grunn</th><th></th></tr></thead><tbody>
      ${ps.map(p => { const [txt, cls] = state(p); return `<tr class="${txt === 'over' ? 'dim' : ''}"><td><span class="badge ${cls}">${txt}</span></td><td><code>${esc(p.tags)}</code></td><td>${fmtTime(p.since)}</td>
        <td>${p.until === null ? 'til den oppheves' : fmtTime(p.until)}</td><td>${esc(p.reason || '')}</td><td>${w && txt !== 'over' ? `<button class="link end" data-id="${esc(p.id)}">Avslutt nå</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table>` : '<p class="muted">Ingen pauser.</p>'}
      ${w && !ed.isNew ? `<form class="form section pauseform"><div class="grid3">
        <label>Tagger<input name="tags" value="*" placeholder="* = alle"></label>
        <label>Hvor lenge<select name="for">${PAUSE_FOR.map(([m, t]) => `<option value="${m}">${t}</option>`).join('')}</select></label>
        <label>Grunn<input name="reason" placeholder="f.eks. vedlikehold" maxlength="200"></label></div>
        <div class="actions" style="justify-content:flex-start"><button class="primary">Start pausen nå</button>
        <span class="hint">Pausen lagres med en gang. Recorderen setter et merke der pausen begynner, så trenden viser et hull, og lagrer verdien igjen når den er over.</span></div></form>` : ''}`;
    box.querySelectorAll('button.end').forEach(b => { b.onclick = async () => {
      try { await api('/rules/resume', { method: 'POST', body: { target: ed.target, id: b.dataset.id } }); await refreshPauses(); } catch (e) { alert(e.message); }
    }; });
    const f = box.querySelector('.pauseform');
    if (f) f.onsubmit = async e => {
      e.preventDefault();
      const body = { target: ed.target, tags: f.tags.value.trim() || '*' };
      if (Number(f.for.value)) body.minutes = Number(f.for.value);
      if (f.reason.value.trim()) body.reason = f.reason.value.trim();
      try { await api('/rules/pause', { method: 'POST', body }); await refreshPauses(); } catch (ex) { alert(ex.message); }
    };
  }
  // serverens pauser inn i editoren, uten å røre regelendringer som ikke er lagret
  async function refreshPauses() {
    const t = ed.target;
    const fresh = t.set ? (await api(`/rulesets/${encodeURIComponent(t.set)}`)).recording.pauses : (((await api(`/vehicles/${encodeURIComponent(t.vehicle)}/rules`)).extra || {}).pauses || []);
    ed.rec.pauses = fresh;
    const orig = JSON.parse(ed.original || '{}');
    orig.pauses = fresh;
    ed.original = JSON.stringify(Object.assign(t.set ? {} : { rules: [] }, orig));
    renderPauses();
    loadHistory();
    loadTargets();
    changed(true);
  }

  // ---------------------------------------------------------------- forhåndsvisning
  function renderPreview() {
    const box = root.querySelector('.preview');
    const list = ed.target.vehicle ? [ed.target.vehicle] : (ed.usedBy && ed.usedBy.length ? ed.usedBy : vehicles.map(v => v.code));
    box.innerHTML = `<p class="hint">Hva reglene i editoren (også det som ikke er lagret) ville lagret for et kjøreverk, regnet med regelmotoren fra recorderen på det som er lagret.
      Det som er lagret, er allerede valgt ut av reglene som gjaldt da, så forhåndsvisningen viser hva strengere regler ville spart, ikke hva løsere regler ville tatt med i tillegg.</p>
      <div class="grid3"><label>Kjøreverk<select name="pv">${list.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
      <label>Siste<select name="hours"><option value="1">time</option><option value="8">8 timer</option><option value="24" selected>døgn</option><option value="72">3 døgn</option><option value="168">7 døgn</option></select></label>
      <label><span><code>\${pls}</code> er</span><input name="pls" placeholder="gjettes fra taggene"></label></div>
      <div class="actions" style="justify-content:flex-start"><button class="run">Forhåndsvis</button><span class="muted status"></span></div><div class="out"></div>`;
    box.querySelector('.run').onclick = async () => {
      const status = box.querySelector('.status'), out = box.querySelector('.out');
      const rec = ed.target.set ? Object.assign({}, ed.rec, { pauses: [] })
        : { events: ed.setRec.events, eventsMin: ed.setRec.eventsMin, rules: ed.rec.rules.concat(ed.setRec.rules || []), pauses: [] };
      const body = { recording: rec, vehicle: box.querySelector('[name=pv]').value, hours: Number(box.querySelector('[name=hours]').value) };
      const pls = box.querySelector('[name=pls]').value.trim();
      if (pls) body.vars = { pls };
      status.textContent = 'regner …';
      out.innerHTML = '';
      try {
        const r = await api('/rules/preview', { method: 'POST', body });
        status.textContent = `${r.ms} ms`;
        const pct = r.total.now ? Math.round((r.total.would - r.total.now) / r.total.now * 100) : 0;
        const ruleNo = i => (i === null ? '–' : i + 1);
        out.innerHTML = `<p>${esc(r.vehicle)}, siste ${r.hours} t (<code>\${pls}</code> = ${esc(r.vars.pls || '–')}): <b>${fmtNum(r.total.now)}</b> lagret nå, <b>${fmtNum(r.total.would)}</b> med disse reglene
          <span class="badge ${pct < 0 ? 'ok' : pct > 0 ? 'warn' : ''}">${pct > 0 ? '+' : ''}${pct} %</span>${r.flickers ? ` · ${r.flickers} flimreepisoder` : ''}</p>
          <div class="sections"><div><h3 class="muted">Per regel</h3><table><thead><tr><th>#</th><th>Tagger</th><th class="num">Tagger truffet</th><th class="num">Nå</th><th class="num">Med reglene</th></tr></thead><tbody>
          ${r.rules.filter(x => x.tagCount).map(x => `<tr><td>${x.index === null ? '–' : x.index + 1}</td><td><code>${esc(x.tags)}</code></td><td class="num">${x.tagCount}</td><td class="num">${fmtNum(x.now)}</td><td class="num">${fmtNum(x.would)}</td></tr>`).join('')}</tbody></table></div>
          <div><h3 class="muted">Taggene med flest verdier</h3><table><thead><tr><th>Tag</th><th>Regel</th><th class="num">Nå</th><th class="num">Med reglene</th></tr></thead><tbody>
          ${r.tags.slice(0, 25).map(x => `<tr><td>${esc(x.tag)}</td><td>${ruleNo(x.rule)}</td><td class="num">${fmtNum(x.now)}</td><td class="num">${fmtNum(x.would)}</td></tr>`).join('')}</tbody></table></div></div>
          ${ed.target.vehicle ? '<p class="hint">Regelnumrene teller tilleggets regler først, så regelsettets.</p>' : ''}`;
      } catch (e) { status.textContent = ''; out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    };
  }

  // ---------------------------------------------------------------- historikk
  async function loadHistory() {
    const box = root.querySelector('.history');
    if (ed.isNew) { box.innerHTML = '<p class="muted">Ingen ennå.</p>'; return; }
    try {
      const q = ed.target.set ? `set=${encodeURIComponent(ed.target.set)}` : `vehicle=${encodeURIComponent(ed.target.vehicle)}`;
      const r = await api(`/rules/history?${q}`);
      box.innerHTML = r.history.length ? `<table><thead><tr><th>Versjon</th><th>Når</th><th>Hvem</th><th>Notat</th><th class="num">Regler</th><th class="num">Pauser</th><th></th></tr></thead><tbody>
        ${r.history.map(h => `<tr><td>${h.version}</td><td>${fmtTime(h.changed_at)}</td><td>${esc(h.changed_by)}</td><td class="wrap">${h.removed ? '<span class="muted">tillegget fjernet</span> ' : ''}${esc(h.note)}</td>
          <td class="num">${h.rules}</td><td class="num">${h.pauses}</td><td class="links"><button class="link show" data-id="${h.id}">Vis</button>${can() && !h.removed ? `<button class="link use" data-id="${h.id}">Hent inn</button>` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">Ingen endringer ennå.</p>';
      box.onclick = async e => {
        const b = e.target.closest('button');
        if (!b) return;
        const h = await api(`/rules/history/${b.dataset.id}`);
        if (b.classList.contains('show')) {
          const m = S.modal(`<h2>Versjon ${h.version} <span class="muted">${fmtTime(h.changed_at)} · ${esc(h.changed_by)}</span></h2><pre class="code">${esc(JSON.stringify(h.recording, null, 2))}</pre>`);
          m.box.classList.add('wide');
        } else {
          // reglene fra den versjonen inn i editoren; pausene er de som gjelder nå
          const old = h.recording || { rules: [] };
          ed.rec = ed.target.set ? { events: old.events !== false, eventsMin: old.eventsMin || 'info', rules: old.rules || [], pauses: ed.rec.pauses } : { rules: old.rules || [], pauses: ed.rec.pauses };
          renderEditor();
          changed();
          root.querySelector('.editor .note').value = `Tilbake til versjon ${h.version}`;
          root.querySelector('.editor').scrollIntoView({ behavior: 'smooth' });
        }
      };
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  S.page('rules', {
    title: 'Regler',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Regler</h1><p class="muted lead">Hva recorderen i hvert kjøreverk sender til serveren. Kjøreverkene henter nye regler med neste batch, innen noen sekunder.${can() ? '' : ' Logg inn med rollen rules for å endre.'}</p>
        <div class="rules-layout"><aside class="targets section"></aside><div class="editor"><p class="muted">Velg et regelsett eller et kjøreverk til venstre.</p></div></div>`;
      main.appendChild(root);
      window.addEventListener('beforeunload', onUnload);
      const p = S.params();
      loadTargets().then(() => open(p.get('vehicle') ? { vehicle: p.get('vehicle') } : { set: p.get('set') || 'default' }, true)).catch(e => { root.querySelector('.editor').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
    },
    unmount() { window.removeEventListener('beforeunload', onUnload); clearTimeout(checkTimer); root = null; ed = null; },
  });
})();

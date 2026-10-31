/*
 * pages/vehicles.js - Kjøreverk: registrer et kjøreverk, lag eller trekk tilbake nøkkelen, endre navn, notater,
 * regelsett og grensen for stille-varselet, slå av og på, og se øktene og hullene (docs/PLAN.md §4.7).
 *
 * Alle kan se. Å endre krever innlogging: admin for alt, rules for regelsettet. Nøkkelen vises bare én gang,
 * rett etter at den er laget, sammen med kommandoen Pi-en i kjøreverket trenger.
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, el, esc, fmtTime, ago, fmtNum, fmtDuration } = S;
  const SILENT = [600, 1800, 3600, 7200, 21600, 43200, 86400, 259200, 604800];
  let root = null, data = null, selected = null, filter = '', timer = null;

  const status = v => S.vehicleStatus(v);
  const serverUrl = () => `${location.protocol}//${location.host}`;

  // ---------------------------------------------------------------- oppsettet på Pi-en i kjøreverket
  // Kodeblokker med en Kopier-knapp. Teksten ligger i en liste, så den ikke må stå i et attributt.
  function copyable() {
    const texts = [];
    return {
      block(text) { texts.push(text); return `<div class="codeline"><pre class="code">${esc(text)}</pre><button class="small" data-ci="${texts.length - 1}">Kopier</button></div>`; },
      wire(box) { box.addEventListener('click', e => { const b = e.target.closest('button[data-ci]'); if (b) S.copy(texts[Number(b.dataset.ci)], b); }); },
    };
  }

  // install.sh i hmi-core skriver /etc/kjoreverk/vehicle og /etc/kjoreverk/recorder.json, og starter tjenestene
  function piSteps(code, key, c) {
    const token = key || '<nøkkelen>';
    const json = JSON.stringify({ server: serverUrl(), token }, null, 2);
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    return `<ol class="steps">
      <li>Logg inn på Pi-en i kjøreverket (ssh), og kjør <code>install.sh</code> i prosjektmappen med koden, serveren og nøkkelen:
        ${c.block(`sudo bash /opt/kjoreverk/install.sh --vehicle ${code} --server ${serverUrl()} --token ${token}`)}
        <div class="hint">${local ? '<b>Du har åpnet denne siden på serveren selv:</b> bytt <code>localhost</code> med serverens navn eller faste IP-adresse på nettet. ' : ''}<code>--server</code> er adressen kjøreverkene når denne serveren på. Bruk serverens faste navn eller IP-adresse hvis den er en annen enn i nettleseren din.${key ? '' : ' <code>&lt;nøkkelen&gt;</code> er nøkkelen fra «Lag ny nøkkel»: den vises bare når den lages.'}
        Skriptet spør etter det som mangler (PLS-ens adresse), og viser hva det vil gjøre før det endrer noe. Det skriver kjøreverkets navn i <code>/etc/kjoreverk/vehicle</code> og serveren og nøkkelen i <code>/etc/kjoreverk/recorder.json</code>, og starter tjenestene på nytt. Ligger prosjektet et annet sted enn <code>/opt/kjoreverk</code>, bruk den mappen.</div></li>
      <li>Sjekk loggen. Første linje sier <code>recorder … for ${esc(code)}</code>, så <code>the central server answers</code> og <code>Recording rules version …</code>, og her blir statusen «Sender» innen et halvt minutt:
        ${c.block('journalctl -u kjoreverk@recorder.service -n 30 --no-pager')}</li>
    </ol>
    <details class="section"><summary>Uten install.sh, for hånd</summary>
      <ol class="steps">
        <li>Kjøreverkets navn, nøyaktig som koden her. Adapteren og huben bruker det som kilde i alarmlisten, og recorderen som kjøreverkets id:
          ${c.block(`echo ${code} | sudo tee /etc/kjoreverk/vehicle`)}</li>
        <li>Oppsettfilen til recorderen:
          ${c.block('sudo nano /etc/kjoreverk/recorder.json')}
          Rett <code>server</code> og <code>token</code>, eller lim inn dette hvis filen er ny. Lagre (Ctrl+O, Enter) og lukk (Ctrl+X):
          ${c.block(json)}</li>
        <li>Bare root og brukeren tjenestene kjører som, skal kunne lese den:
          ${c.block('sudo chown root:"$(systemctl show -p User --value kjoreverk@recorder.service)" /etc/kjoreverk/recorder.json\nsudo chmod 640 /etc/kjoreverk/recorder.json')}</li>
        <li>Start tjenestene på nytt, så de leser navnet og oppsettet:
          ${c.block("sudo systemctl restart 'kjoreverk@*'")}</li>
      </ol>
      <div class="hint">Recorderen leser <code>/etc/kjoreverk/recorder.json</code> først. <code>/etc/hmi-recorder.json</code>, fra en Pi som ble satt opp før install.sh, leses bare når den nye mangler, og install.sh flytter den. Står det <code>"vehicle"</code> i filen, går det foran <code>/etc/kjoreverk/vehicle</code>.</div>
    </details>`;
  }

  function showKey(code, key) {
    const c = copyable();
    const m = S.modal(`<h2>Nøkkelen til ${esc(code)}</h2>
      <p class="note warn">Nøkkelen vises <b>bare nå</b>. Legg den inn på Pi-en i kjøreverket før du lukker vinduet. Mister du den, lag en ny.</p>
      ${c.block(key)}
      <h3 class="muted" style="margin:14px 0 4px;font-size:13px">På Pi-en i kjøreverket</h3>
      ${piSteps(code, key, c)}
      <div class="actions"><button class="primary done">Ferdig, lukk</button></div>`);
    m.box.classList.add('wide');
    c.wire(m.box);
    m.box.querySelector('.done').onclick = () => m.close();
  }

  // ---------------------------------------------------------------- nytt kjøreverk
  function silentOptions(current) {
    const list = SILENT.includes(current) ? SILENT : SILENT.concat([current]).sort((a, b) => a - b);
    return list.map(s => `<option value="${s}"${s === current ? ' selected' : ''}>${fmtDuration(s)}</option>`).join('');
  }

  function addForm() {
    const next = (() => {
      const found = data.vehicles.map(v => v.code.match(/^(.*?)(\d+)$/)).filter(Boolean);
      if (!found.length) return 'kv_01';
      const count = new Map();
      for (const m of found) count.set(m[1], (count.get(m[1]) || 0) + 1);
      const prefix = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const mine = found.filter(m => m[1] === prefix);
      const width = Math.max(...mine.map(m => m[2].length));
      return prefix + String(Math.max(...mine.map(m => Number(m[2]))) + 1).padStart(width, '0');
    })();
    const m = S.modal(`<h2>Nytt kjøreverk</h2>
      <form class="form">
        <div class="row2">
          <label>Kode (det kjøreverket heter på serveren)<input name="code" required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]*" placeholder="${next}" value="${next}"></label>
          <label>Navn<input name="name" maxlength="100" placeholder="Kjøreverk ${esc(String(Number((next.match(/(\d+)$/) || [])[1]) || ''))}"></label>
        </div>
        <div class="hint">Koden må være nøyaktig lik kjøreverkets navn på Pi-en: <code>/etc/kjoreverk/vehicle</code> (eller <code>"vehicle"</code> i <code>/etc/kjoreverk/recorder.json</code>). Ellers avviser serveren nøkkelen.</div>
        <div class="row2">
          <label>Regelsett<select name="ruleSet">${data.ruleSets.map(r => `<option${r === 'default' ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          <label>Varsel når det har vært stille i<select name="silentAfter">${silentOptions(7200)}</select></label>
        </div>
        <label>Notater<textarea name="notes" maxlength="2000" placeholder="Hvor det står, hvem som har ansvaret …"></textarea></label>
        <label class="check"><input type="checkbox" name="makeKey" checked> Lag nøkkelen med en gang</label>
        <p class="err" hidden></p>
        <div class="actions"><button type="button" class="cancel">Avbryt</button><button type="submit" class="primary">Legg til</button></div>
      </form>`);
    const f = m.box.querySelector('form');
    m.box.querySelector('.cancel').onclick = () => m.close();
    f.code.select();
    f.onsubmit = async e => {
      e.preventDefault();
      const err = f.querySelector('.err');
      err.hidden = true;
      const body = { code: f.code.value.trim(), ruleSet: f.ruleSet.value, silentAfter: Number(f.silentAfter.value), makeKey: f.makeKey.checked };
      if (f.name.value.trim()) body.name = f.name.value.trim();
      if (f.notes.value.trim()) body.notes = f.notes.value.trim();
      try {
        const r = await api('/vehicles', { method: 'POST', body });
        m.close();
        await load();
        await showVehicle(r.code, true);
        if (r.key) showKey(r.code, r.key);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    };
  }

  // ---------------------------------------------------------------- listen
  function renderList() {
    const admin = S.can('admin');
    const head = root.querySelector('.bar');
    head.innerHTML = `${admin ? '<button class="primary add">+ Nytt kjøreverk</button>' : ''}
      <input type="search" placeholder="Søk i kode, navn, notater" value="${esc(filter)}">
      <span class="muted">${S.user ? (admin ? '' : `Du er logget inn som ${esc(S.user.name)} (${esc(S.user.role)}). Det trengs rollen admin for å legge til og endre.`) : 'Logg inn som admin for å legge til og endre kjøreverk.'}</span>`;
    if (admin) head.querySelector('.add').onclick = addForm;
    const search = head.querySelector('input');
    search.oninput = () => { filter = search.value; renderRows(); };
    renderRows();
  }

  function renderRows() {
    const q = filter.trim().toLowerCase();
    const vs = data.vehicles.filter(v => !q || [v.code, v.name, v.notes].some(s => String(s || '').toLowerCase().includes(q)));
    root.querySelector('h1 .muted').textContent = `(${data.vehicles.length})`;
    const tbody = root.querySelector('tbody');
    if (!data.vehicles.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty">Ingen kjøreverk ennå. ${S.can('admin') ? 'Trykk «+ Nytt kjøreverk».' : 'Logg inn som admin for å legge til, eller bruk <code>sudo kv-admin vehicle add kv01</code> på databasemaskinen.'}</td></tr>`;
      return;
    }
    tbody.innerHTML = vs.map(v => {
      const [txt, cls] = status(v);
      return `<tr data-code="${esc(v.code)}" class="${selected === v.code ? 'sel' : ''}">
        <td><b>${esc(v.code)}</b></td><td>${esc(v.name)}</td><td><span class="badge ${cls}">${txt}</span></td>
        <td>${v.key_prefix ? `<code>${esc(v.key_prefix)}…</code>` : '<span class="muted">ingen</span>'}</td>
        <td>${esc(v.rule_set)}${v.has_extra ? '+' : ''}</td>
        <td title="${fmtTime(v.last_batch_at)}">${ago(v.last_batch_at)}</td><td>${esc(v.last_ip || '–')}</td><td>${esc(v.recorder_version || '–')}</td>
        <td class="num">${fmtNum(v.tags)}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="muted">Ingen treff.</td></tr>';
  }

  // ---------------------------------------------------------------- ett kjøreverk
  // scroll: rull panelet fram (når en rad klikkes; ikke når det tegnes på nytt etter en lagring)
  async function showVehicle(code, scroll) {
    selected = code;
    renderRows();
    const box = root.querySelector('.detail');
    const opening = box.style.display === 'none' || box.dataset.code !== code;
    box.style.display = 'block';
    box.dataset.code = code;
    let v;
    try { v = await api(`/vehicles/${encodeURIComponent(code)}`); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const admin = S.can('admin'), rules = S.can('rules');
    // listen har sending og silent; resten er ferskest i v
    const [txt, cls, why] = status(Object.assign({}, data.vehicles.find(x => x.code === code) || {}, v));
    const refused = txt === 'Avvist';
    const c = copyable();
    const ro = admin ? '' : ' disabled';
    box.innerHTML = `<span class="close" title="Lukk">✕</span>
      <h2>${esc(v.code)} <span class="muted">${esc(v.name)}</span> <span class="badge ${cls}" title="${esc(why)}">${txt}</span></h2>
      ${refused ? `<div class="note warn"><b>Serveren avviste ${esc(v.code)}</b> ${fmtTime(v.last_refused_at)} fra ${esc(v.last_refused_ip || '?')}:<br><code>${esc(v.last_refused_reason || '')}</code>
        ${/belongs to/.test(v.last_refused_reason || '') ? `<br>Navnet på Pi-en er ikke likt koden her. Gi Pi-en koden <code>${esc(v.code)}</code> (se «Oppsett på Pi-en» under), eller gi kjøreverket det nye navnet som kode i feltet <b>Kode</b>.` : ''}
        ${/unknown or has been revoked/.test(v.last_refused_reason || '') ? '<br>Nøkkelen på Pi-en er ikke den serveren har. Lag en ny nøkkel og legg den inn på Pi-en.' : ''}</div>` : ''}
      <div class="sections">
        <div class="section">
          <h3>Innstillinger</h3>
          <form class="form settings">
            <div class="row2">
              <label>Kode <span class="hint">lik navnet på Pi-en</span><input name="code" maxlength="32" value="${esc(v.code)}"${ro}></label>
              <label>Navn<input name="name" maxlength="100" value="${esc(v.name)}"${ro}></label>
            </div>
            <div class="row2">
              <label>Regelsett<select name="ruleSet"${rules ? '' : ' disabled'}>${data.ruleSets.map(r => `<option${r === v.rule_set ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
              <label>Varsel når det har vært stille i<select name="silentAfter"${ro}>${silentOptions(v.silent_after_s)}</select></label>
            </div>
            <label>Notater<textarea name="notes" maxlength="2000"${ro}>${esc(v.notes)}</textarea></label>
            <label class="check"><input type="checkbox" name="active"${v.active ? ' checked' : ''}${ro}> Aktiv (av: recorderen får 403 og prøver igjen hvert 5. minutt)</label>
            ${v.rule_extra ? '<div class="hint">Kjøreverket har også et tillegg til regelsettet (<code>sudo kv-admin vehicle extra</code>).</div>' : ''}
            <p class="err" hidden></p>
            ${rules ? '<div class="actions"><span class="muted saved" hidden>Lagret ✓</span><button type="submit" class="primary">Lagre</button></div>' : ''}
          </form>
        </div>
        <div class="section">
          <h3>Nøkkel</h3>
          <div class="kv">
            <span>Nøkkel</span><span>${v.key_prefix ? `<code>${esc(v.key_prefix)}…</code> laget ${fmtTime(v.key_made_at)}` : '<span class="badge warn">ingen</span> recorderen slipper ikke inn'}</span>
          </div>
          <p class="muted" style="font-size:12.5px">Serveren har bare et fingeravtrykk av nøkkelen, så den kan ikke vises igjen. Trengs den på nytt, lag en ny; den gamle slutter da å virke.</p>
          ${admin ? `<div class="actions" style="justify-content:flex-start"><button class="newkey primary">${v.key_prefix ? 'Lag ny nøkkel' : 'Lag nøkkel'}</button>${v.key_prefix ? '<button class="revoke danger">Trekk tilbake</button>' : ''}</div>` : ''}
          <h3 style="margin-top:16px">Siste kontakt</h3>
          <div class="kv">
            <span>Sist sett</span><span>${fmtTime(v.last_seen)} <span class="muted">${v.last_seen ? ago(v.last_seen) : ''}</span></span>
            <span>Fra</span><span>${esc(v.last_ip || '–')}</span>
            <span>Siste batch</span><span>${fmtTime(v.last_batch_at)}</span>
            <span>Data fram til</span><span>${fmtTime(v.last_ts)}</span>
            <span>Recorder</span><span>${esc(v.recorder_version || '–')}</span>
            <span>Klokke</span><span>${v.clock_synced === null ? '–' : v.clock_synced ? `synkronisert, ${v.clock_offset_ms > 0 ? '+' : ''}${v.clock_offset_ms} ms` : '<span class="badge bad">ikke synkronisert</span>'}</span>
            <span>Tagger</span><span>${fmtNum(v.tags)}</span>
            <span>Lagt til</span><span>${fmtTime(v.created_at)}</span>
          </div>
        </div>
      </div>
      <details class="section" style="margin-top:14px"${v.last_seen ? '' : ' open'}>
        <summary style="cursor:pointer;color:var(--muted);font-weight:600">Oppsett på Pi-en i kjøreverket</summary>
        ${piSteps(v.code, null, c)}
      </details>
      <h2>Siste økter <span class="muted">(hver oppstart av recorderen)</span></h2>
      <table><thead><tr><th>Boot</th><th>Startet</th><th>Siste batch</th><th class="num">Batcher</th><th class="num">Punkter</th><th>Data fra</th><th>til</th><th>Recorder</th></tr></thead><tbody>
      ${v.sessions.map(s => `<tr><td><code>${esc(s.boot.slice(0, 8))}</code></td><td>${fmtTime(s.started_at)}</td><td>${fmtTime(s.last_batch_at)}</td><td class="num">${fmtNum(s.batches)}</td><td class="num">${fmtNum(s.points)}</td><td>${fmtTime(s.first_ts)}</td><td>${fmtTime(s.last_ts)}</td><td>${esc(s.recorder_version || '–')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">ingen ennå</td></tr>'}
      </tbody></table>
      <h2>Siste hull</h2>
      <table><thead><tr><th>Fra</th><th>Til</th><th>Varighet</th><th>Tagger</th><th>Grunn</th></tr></thead><tbody>
      ${v.gaps.map(g => `<tr><td>${fmtTime(g.from_ts)}</td><td>${fmtTime(g.to_ts)}</td><td>${Math.round((g.to_ts - g.from_ts) / 1000)} s</td><td>${g.tags === null ? 'alle' : esc(g.tags.length > 5 ? `${g.tags.slice(0, 5).join(', ')} … (${g.tags.length})` : g.tags.join(', '))}</td><td>${esc(g.reason)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ingen</td></tr>'}
      </tbody></table>
      ${admin ? `<div class="actions" style="justify-content:flex-start;margin-top:16px">${v.has_data
    ? '<span class="muted">Kjøreverket har lagret data, så det kan ikke slettes. Slå det av i stedet (Aktiv).</span>'
    : '<button class="delete danger">Slett kjøreverket</button><span class="muted">Bare mulig så lenge det ikke har lagret data.</span>'}</div>` : ''}`;
    c.wire(box);
    if (scroll && opening) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.querySelector('.close').onclick = () => { box.style.display = 'none'; selected = null; renderRows(); };

    const f = box.querySelector('form.settings');
    f.onsubmit = async e => {
      e.preventDefault();
      const err = f.querySelector('.err');
      err.hidden = true;
      const body = {};
      if (admin) {
        if (f.name.value.trim() !== v.name) body.name = f.name.value.trim();
        if (f.notes.value !== v.notes) body.notes = f.notes.value;
        if (Number(f.silentAfter.value) !== v.silent_after_s) body.silentAfter = Number(f.silentAfter.value);
        if (f.active.checked !== v.active) body.active = f.active.checked;
        if (f.code.value.trim() !== v.code) body.code = f.code.value.trim();
      }
      if (f.ruleSet.value !== v.rule_set) body.ruleSet = f.ruleSet.value;
      if (!Object.keys(body).length) return;
      if (body.code && !(await S.confirm(`Ny kode for ${v.code}?`, `<b>${esc(v.code)}</b> blir <b>${esc(body.code)}</b>. Dataene, nøkkelen og reglene følger med. Recorderen på Pi-en må sende den nye koden: <code>/etc/kjoreverk/vehicle</code> (eller <code>"vehicle"</code> i <code>/etc/kjoreverk/recorder.json</code>) må være <code>${esc(body.code)}</code>.`, 'Endre koden'))) return;
      if (body.active === false && !(await S.confirm(`Slå av ${v.code}?`, 'Recorderen i kjøreverket får 403 og sender ingenting før det slås på igjen. Den holder dataene i RAM så lenge den har plass.', 'Slå av', true))) return;
      try {
        const r = await api(`/vehicles/${encodeURIComponent(v.code)}`, { method: 'PATCH', body });
        await load();
        await showVehicle(r.code);
        const s = root.querySelector('.detail .saved');
        if (s) { s.hidden = false; setTimeout(() => { s.hidden = true; }, 2000); }
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    };

    const nk = box.querySelector('.newkey');
    if (nk) nk.onclick = async () => {
      if (v.key_prefix && !(await S.confirm(`Ny nøkkel til ${v.code}?`, `Den gamle nøkkelen (<code>${esc(v.key_prefix)}…</code>) slutter å virke <b>med en gang</b>. Recorderen i kjøreverket får ikke sende før den nye er lagt inn der.`, 'Lag ny nøkkel'))) return;
      try {
        const r = await api(`/vehicles/${encodeURIComponent(v.code)}/key`, { method: 'POST', body: {} });
        await load();
        await showVehicle(v.code);
        showKey(v.code, r.key);
      } catch (ex) { alert(ex.message); }
    };
    const rv = box.querySelector('.revoke');
    if (rv) rv.onclick = async () => {
      if (!(await S.confirm(`Trekk tilbake nøkkelen til ${v.code}?`, 'Recorderen i kjøreverket slipper ikke inn før det lages en ny nøkkel og den legges inn på Pi-en. Bruk dette for en Pi som er borte eller byttet ut.', 'Trekk tilbake', true))) return;
      try { await api(`/vehicles/${encodeURIComponent(v.code)}/key`, { method: 'DELETE' }); await load(); await showVehicle(v.code); } catch (ex) { alert(ex.message); }
    };
    const del = box.querySelector('.delete');
    if (del) del.onclick = async () => {
      if (!(await S.confirm(`Slette ${v.code}?`, 'Kjøreverket, nøkkelen og øktene slettes. Det har ikke lagret noen data.', 'Slett', true))) return;
      try { await api(`/vehicles/${encodeURIComponent(v.code)}`, { method: 'DELETE' }); selected = null; box.style.display = 'none'; await load(); } catch (ex) { alert(ex.message); }
    };
  }

  async function load() {
    try {
      data = await api('/vehicles');
      S.serverStatus(true, '');
      renderList();
    } catch (e) {
      S.serverStatus(false, '· serveren svarer ikke');
      root.querySelector('tbody').innerHTML = `<tr><td colspan="9" class="err">Kunne ikke hente kjøreverkene: ${esc(e.message)}</td></tr>`;
    }
  }

  S.page('vehicles', {
    title: 'Kjøreverk',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Kjøreverk <span class="muted"></span></h1><div class="bar"></div>
        <table><thead><tr><th>Kode</th><th>Navn</th><th>Status</th><th>Nøkkel</th><th>Regelsett</th><th>Siste batch</th><th>Sist fra</th><th>Recorder</th><th class="num">Tagger</th></tr></thead>
        <tbody><tr><td colspan="9" class="muted">henter …</td></tr></tbody></table>
        <div class="detail" style="display:none"></div>`;
      root.querySelector('tbody').addEventListener('click', e => { const tr = e.target.closest('tr[data-code]'); if (tr) showVehicle(tr.dataset.code, true); });
      main.appendChild(root);
      load().then(() => { if (selected && data && data.vehicles.some(v => v.code === selected)) showVehicle(selected); });
      // listen holdes oppdatert, men detaljene ikke, så et skjema som redigeres, ikke skrives over
      timer = setInterval(() => { if (!document.querySelector('.modal-back')) api('/vehicles').then(d => { data = d; renderRows(); }).catch(() => {}); }, 15000);
    },
    unmount() { clearInterval(timer); timer = null; root = null; },
  });
})();

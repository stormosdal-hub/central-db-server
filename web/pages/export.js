/*
 * pages/export.js - Eksport (docs/PLAN.md §4.4): CSV, strømmet fra serveren, så store uttrekk ikke fyller minnet.
 * Skilletegn for norsk Excel (; og desimalkomma) eller internasjonalt (, og punktum), én fil eller én per
 * kjøreverk i en zip, alle verdier eller per minutt/time. Anslaget viser omtrent hvor mange rader det blir.
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, el, esc, fmtNum } = S;
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  let root = null, vp = null, tp = null, timer = null, seq = 0;

  function query(f) {
    const r = tp.get();
    const q = new URLSearchParams({ kind: f.kind.value, from: Math.round(r.from), to: Math.round(r.to), format: f.format.value, resolution: f.resolution.value,
      style: f.style.value, files: f.files.value, tz: f.time.value === 'utc' ? 'UTC' : TZ, fill: f.fill.checked ? '1' : '0' });
    if (vp.get().length) q.set('vehicles', vp.get().join(','));
    if (f.kind.value === 'values') {
      if (f.tags.value.trim()) q.set('tags', f.tags.value.trim());
      if (f.label.value.trim()) q.set('label', f.label.value.trim());
    }
    return q;
  }

  function sync(f) {
    const values = f.kind.value === 'values';
    for (const c of root.querySelectorAll('.onlyvalues')) c.hidden = !values;
    f.fill.disabled = f.format.value !== 'wide';
    root.querySelector('.fillrow').style.opacity = f.format.value === 'wide' ? 1 : 0.5;
  }

  function estimateSoon(f) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      const out = root.querySelector('.estimate');
      const dl = root.querySelector('.download');
      out.innerHTML = '<span class="muted">regner …</span>';
      try {
        const e = await api(`/export/estimate?${query(f)}`);
        if (my !== seq) return;
        const big = e.rows > 1000000;
        out.innerHTML = `Omtrent <b>${fmtNum(e.rows)}</b> ${f.kind.value === 'values' ? 'verdier' : f.kind.value === 'events' ? 'hendelser' : 'hull'}${e.vehicles ? ` fra <b>${e.vehicles}</b> kjøreverk og <b>${e.tags}</b> tagger` : ''}.`
          + (big ? ' <span class="badge warn">Excel tar høyst 1 048 576 rader per ark</span> Velg per minutt, bred form eller kortere tid.' : '');
        dl.disabled = e.rows === 0;
      } catch (ex) {
        if (my !== seq) return;
        out.innerHTML = `<span class="err">${esc(ex.message)}</span>`;
        dl.disabled = true;
      }
    }, 300);
  }

  S.page('export', {
    title: 'Eksport',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Eksport</h1><p class="muted lead">Last ned verdier, hendelser eller hull som CSV, for Excel eller andre programmer.</p>
      <form class="form exportform">
        <div class="grid3">
          <label>Hva<select name="kind"><option value="values">Verdier</option><option value="events">Hendelser og alarmer</option><option value="gaps">Hull</option></select></label>
          <label>Kjøreverk<div class="vp"></div></label>
          <label>Tidsrom<div class="tp"></div></label>
        </div>
        <div class="grid3 onlyvalues">
          <label>Tagger <span class="hint">mønstre: <code>kv_1.reals_*, calc.*</code>; tomt = alle</span><input name="tags" placeholder="alle"></label>
          <label>Navn fra PLS-en inneholder<input name="label" placeholder="f.eks. Hastighet"></label>
          <label>Oppløsning<select name="resolution"><option value="raw">Alle lagrede verdier</option><option value="1m">Per minutt (snitt, minste, største)</option><option value="1h">Per time (snitt, minste, største)</option></select></label>
        </div>
        <div class="grid3">
          <label class="onlyvalues">Form<select name="format"><option value="long">Lang: én rad per verdi</option><option value="wide">Bred: én kolonne per tag</option></select></label>
          <label>Skilletegn<select name="style"><option value="no">Norsk Excel: ; og desimalkomma</option><option value="intl">Internasjonalt: , og desimalpunktum</option></select></label>
          <label>Tid<select name="time"><option value="local">Lokal tid (${esc(TZ)})</option><option value="utc">UTC</option></select></label>
        </div>
        <div class="grid3">
          <label class="onlyvalues">Filer<select name="files"><option value="one">Alt i én fil</option><option value="zip">Én fil per kjøreverk (zip)</option></select></label>
          <label class="check onlyvalues fillrow"><input type="checkbox" name="fill"> Fyll tomme celler med siste kjente verdi (bred form)</label>
          <div></div>
        </div>
        <div class="section"><span class="estimate muted">velg hva som skal eksporteres</span></div>
        <div class="actions" style="justify-content:flex-start"><button type="submit" class="primary download">Last ned</button>
          <span class="hint">Filen lages mens den lastes ned. Store uttrekk tar litt tid.</span></div>
      </form>
      <details class="section help"><summary>Om kolonnene</summary>
        <ul>
          <li><b>Lang form:</b> <code>tid; kjøreverk; tag; navn; verdi; enhet; kvalitet; kilde</code>. Kvalitet: 0 god, 1 usikker, 2 dårlig (enheten var frakoblet), 3 pauset. Kilde: 0 sanntid, 1 fra ringen i PLS-en, 2 fylt inn fra hubens minne. Tom verdi er et hull.</li>
          <li><b>Bred form:</b> én kolonne per tag og én rad per tidspunkt. En tom celle betyr at taggen ikke ble lagret akkurat da (eller et hull); med «fyll tomme celler» står siste kjente verdi der, og første rad har verdiene ved starttidspunktet.</li>
          <li><b>Per minutt / per time:</b> snitt, minste og største av de lagrede verdiene i hvert minutt eller hver time. Teksttagger er ikke med.</li>
          <li>Av/på-signaler er 1 og 0. Tidene er tidspunktene fra Pi-en i kjøreverket.</li>
        </ul></details>`;
      main.appendChild(root);
      const f = root.querySelector('form');
      const p = S.params();
      vp = S.vehiclePicker(root.querySelector('.vp'), { selected: p.get('v') ? p.get('v').split(',') : [], onChange: () => estimateSoon(f) });
      tp = S.timePicker(root.querySelector('.tp'), Object.assign(p.get('from') ? { from: Number(p.get('from')), to: Number(p.get('to')) } : { span: 86400000 }, { onChange: () => estimateSoon(f) }));
      S.tagInput(f.tags, { vehicles: () => vp.get() });
      if (p.get('tags')) f.tags.value = p.get('tags');
      if (p.get('label')) f.label.value = p.get('label');
      if (p.get('kind')) f.kind.value = p.get('kind');
      f.addEventListener('change', () => { sync(f); estimateSoon(f); });
      f.addEventListener('input', e => { if (e.target.name === 'tags' || e.target.name === 'label') estimateSoon(f); });
      f.onsubmit = e => {
        e.preventDefault();
        tp.refresh();
        const a = el('a', { href: `/api/web/export?${query(f)}`, download: '' });
        document.body.appendChild(a); a.click(); a.remove();
      };
      sync(f);
      estimateSoon(f);
    },
    unmount() { clearTimeout(timer); if (vp) vp.destroy(); root = null; vp = null; tp = null; },
  });
})();

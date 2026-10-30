/*
 * pages/find.js - Finn data (docs/PLAN.md §4.2): velg tagger, tidsrom og eventuelt en betingelse, og få en liste
 * over kjøreverkene som har dataene, eller der betingelsen slo til, med antall treff og når. Fra listen: åpne en
 * trend eller eksporter. Valgene står i adressen, så et søk kan bokmerkes og deles.
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, el, esc, fmtTime, fmtNum, duration } = S;
  let root = null, vp = null, tp = null;

  const KINDS = [
    ['has', 'Har dataene'], ['on', 'Var på (≠ 0)'], ['above', 'Over en verdi'], ['below', 'Under en verdi'],
    ['changed', 'Endret seg'], ['event', 'Hendelse eller alarm med tekst'],
  ];
  const METHOD = { raw: 'regnet på rådataene', minutes: 'regnet på minuttene (for mye rådata)', hours: 'regnet på timene (for mye rådata)', catalog: 'fra katalogen og sammendragene', events: 'fra hendelsene' };

  function form() {
    return `<form class="form findform">
      <div class="grid3">
        <label>Kjøreverk<div class="vp"></div></label>
        <label>Tagger <span class="hint">mønstre, <code>*</code> passer med alt: <code>kv_1.bit*, calc.speed</code></span><input name="tags" placeholder="alle"></label>
        <label>Navn fra PLS-en inneholder<input name="label" placeholder="f.eks. Hastighet"></label>
      </div>
      <div class="grid3">
        <label>Tidsrom<div class="tp"></div></label>
        <div class="row2">
          <label>Type<select name="dataType"><option value="">alle</option><option value="boolean">av/på</option><option value="number">tall</option><option value="string">tekst</option></select></label>
          <label>Enhet<input name="unit" placeholder="f.eks. rpm"></label>
        </div>
        <div class="row2">
          <label>Betingelse<select name="kind">${KINDS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
          <label class="cv">Verdi<input name="value" inputmode="decimal" placeholder="80"></label>
          <label class="ct" hidden>Tekst<input name="text" placeholder="F7900"></label>
        </div>
      </div>
      <div class="actions" style="justify-content:flex-start"><button type="submit" class="primary">Søk</button><span class="muted status"></span></div>
    </form>
    <div class="results"></div>`;
  }

  function readForm(f) {
    const range = tp.refresh();
    const kind = f.kind.value;
    const body = { from: range.from, to: range.to, vehicles: vp.get(), tags: f.tags.value.trim(), label: f.label.value.trim(), dataType: f.dataType.value, unit: f.unit.value.trim(), condition: { kind } };
    if (kind === 'above' || kind === 'below') body.condition.value = f.value.value.trim();
    if (kind === 'event') body.condition.text = f.text.value.trim();
    return { body, span: range.span };
  }

  function toParams(body, span) {
    const p = {};
    if (body.vehicles.length) p.v = body.vehicles.join(',');
    for (const k of ['tags', 'label', 'dataType', 'unit']) if (body[k]) p[k] = body[k];
    if (span) p.span = span; else { p.from = body.from; p.to = body.to; }
    p.kind = body.condition.kind;
    if (body.condition.value !== undefined) p.value = body.condition.value;
    if (body.condition.text) p.text = body.condition.text;
    return p;
  }

  function syncKind(f) {
    const k = f.kind.value;
    f.querySelector('.cv').hidden = !(k === 'above' || k === 'below');
    f.querySelector('.ct').hidden = k !== 'event';
    for (const n of ['tags', 'label', 'dataType', 'unit']) f[n].disabled = k === 'event';
  }

  async function run(f) {
    const { body, span } = readForm(f);
    S.setParams(toParams(body, span));
    const status = f.querySelector('.status');
    const out = root.querySelector('.results');
    status.textContent = 'søker …';
    try {
      const r = await api('/find', { method: 'POST', body });
      status.textContent = '';
      render(out, body, r);
    } catch (e) {
      status.textContent = '';
      out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  // trend og eksport for et utvalg rader
  const trendLink = (rows, body) => {
    const s = rows.slice(0, 24).map(x => `${encodeURIComponent(x.code)}|${encodeURIComponent(x.tag)}`).join(',');
    return `#/trend?s=${encodeURIComponent(s)}&from=${body.from}&to=${body.to}`;
  };
  const exportLink = (codes, body) => {
    const p = new URLSearchParams({ from: body.from, to: body.to });
    if (codes.length) p.set('v', codes.join(','));
    if (body.tags) p.set('tags', body.tags);
    if (body.label) p.set('label', body.label);
    return `#/export?${p}`;
  };

  function render(out, body, r) {
    const kind = r.kind;
    if (!r.rows.length) {
      out.innerHTML = `<div class="empty">Ingen treff${kind === 'has' ? ': ingen kjøreverk har tagger som passer' : ' i tidsrommet'}.</div>`;
      return;
    }
    // per kjøreverk
    const groups = new Map();
    for (const x of r.rows) {
      if (!groups.has(x.code)) groups.set(x.code, { code: x.code, name: x.name, rows: [], hits: 0, first: null, last: null, seconds: 0 });
      const g = groups.get(x.code);
      g.rows.push(x);
      g.hits += x.hits || 0;
      g.seconds += x.seconds || 0;
      if (x.first !== null && (g.first === null || x.first < g.first)) g.first = x.first;
      if (x.last !== null && (g.last === null || x.last > g.last)) g.last = x.last;
    }
    const gs = [...groups.values()];
    const hitWord = { has: 'verdier', on: 'ganger på', above: 'ganger over', below: 'ganger under', changed: 'verdier', event: 'hendelser' }[kind];
    const timed = kind === 'on' || kind === 'above' || kind === 'below';
    const head = `<div class="bar"><b>${gs.length} kjøreverk</b><span class="muted">${kind === 'event' ? '' : `${r.rows.length} tagger · `}${METHOD[r.method] || ''} · ${r.ms} ms${r.truncated ? ' · <span class="badge warn">bare de første 3000 taggene</span>' : ''}</span>
      ${kind !== 'event' ? `<a class="btn" href="${trendLink(r.rows, body)}">Trend for alle${r.rows.length > 24 ? ' (de første 24)' : ''}</a><a class="btn" href="${exportLink(gs.map(g => g.code), body)}">Eksporter alle</a>` : ''}</div>`;
    let rows = '';
    if (kind === 'event') {
      rows = gs.map(g => { const x = g.rows[0]; return `<tr><td><b>${esc(g.code)}</b> <span class="muted">${esc(g.name || '')}</span></td><td class="num">${fmtNum(x.hits)}</td><td>${fmtTime(x.first)}</td><td>${fmtTime(x.last)}</td>
        <td><span class="badge ${x.severity === 'alarm' ? 'bad' : x.severity === 'warning' ? 'warn' : ''}">${esc(x.severity)}</span> ${esc(x.latest)}</td>
        <td><a href="#/events?v=${encodeURIComponent(g.code)}&q=${encodeURIComponent(body.condition.text || '')}&from=${body.from}&to=${body.to}">Vis hendelsene</a></td></tr>`; }).join('');
      out.innerHTML = head + `<table><thead><tr><th>Kjøreverk</th><th class="num">Hendelser</th><th>Første</th><th>Siste</th><th>Siste melding</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }
    for (const g of gs) {
      rows += `<tr class="grp"><td><b>${esc(g.code)}</b> <span class="muted">${esc(g.name || '')}</span></td><td class="muted">${g.rows.length} tag${g.rows.length === 1 ? '' : 'ger'}</td>
        <td class="num"><b>${fmtNum(g.hits)}</b></td>${timed ? `<td class="num">${duration(g.seconds)}</td>` : ''}<td>${fmtTime(g.first)}</td><td>${fmtTime(g.last)}</td><td></td>
        <td class="links"><a href="${trendLink(g.rows, body)}">Trend</a> <a href="${exportLink([g.code], body)}">Eksport</a></td></tr>`;
      for (const x of g.rows) {
        const val = x.lastValue === null || x.lastValue === undefined ? '–' : esc(typeof x.lastValue === 'number' ? fmtNum(x.lastValue) : x.lastValue) + (x.unit ? ' ' + esc(x.unit) : '');
        rows += `<tr class="sub${x.hits ? '' : ' dim'}"><td>&nbsp;&nbsp;${esc(x.tag)}</td><td>${esc(x.label || '')}${x.unit ? ` <span class="muted">[${esc(x.unit)}]</span>` : ''}</td>
          <td class="num">${fmtNum(x.hits)}</td>${timed ? `<td class="num">${duration(x.seconds)}</td>` : ''}<td>${fmtTime(x.first)}</td><td>${fmtTime(x.last)}</td>
          <td title="${fmtTime(x.lastTs)}">${val}</td><td class="links">${x.dataType !== 'string' ? `<a href="${trendLink([x], body)}">Trend</a>` : ''}</td></tr>`;
      }
    }
    out.innerHTML = head + `<table class="findtable"><thead><tr><th>Kjøreverk / tag</th><th>Navn</th><th class="num">${hitWord}</th>${timed ? `<th class="num">${kind === 'on' ? 'Tid på' : 'Tid'}</th>` : ''}<th>${timed ? 'Første gang' : 'Første'}</th><th>${timed ? 'Sist til' : 'Siste'}</th><th>Siste verdi</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  S.page('find', {
    title: 'Finn data',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Finn data</h1><p class="muted lead">Hvilke kjøreverk har disse dataene, eller hvor slo betingelsen til? Velg tagger og tidsrom, og eventuelt en betingelse.</p>${form()}`;
      main.appendChild(root);
      const f = root.querySelector('form');
      const p = S.params();
      vp = S.vehiclePicker(root.querySelector('.vp'), { selected: p.get('v') ? p.get('v').split(',') : [] });
      const span = Number(p.get('span')) || (p.get('from') ? null : 86400000);
      tp = S.timePicker(root.querySelector('.tp'), span ? { span } : { from: Number(p.get('from')), to: Number(p.get('to')) });
      S.tagInput(f.tags, { vehicles: () => vp.get() });
      for (const k of ['tags', 'label', 'dataType', 'unit', 'kind', 'value', 'text']) if (p.get(k)) f[k].value = p.get(k);
      syncKind(f);
      f.kind.onchange = () => syncKind(f);
      f.onsubmit = e => { e.preventDefault(); run(f); };
      if (p.get('kind') || p.get('tags')) run(f);
    },
    unmount() { if (vp) vp.destroy(); root = null; vp = null; tp = null; },
  });
})();

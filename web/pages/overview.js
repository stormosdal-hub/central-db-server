/*
 * pages/overview.js - Oversikt: alle kjøreverkene, med sist sett, om recorderen sender, klokka, versjonen,
 * mengden data siste døgn, hull og varsler (docs/PLAN.md §4.1). Oppdateres hvert 10. sekund.
 */
(function () {
  'use strict';
  const { api, el, esc, fmtTime, ago, fmtNum, fmtBytes } = window.Shell;
  let timer = null, root = null, selected = null;

  function status(v) {
    if (!v.active) return ['Slått av', ''];
    if (!v.key_prefix) return ['Ingen nøkkel', 'warn'];
    if (v.last_batch_at === null) return ['Aldri sendt', 'warn'];
    if (v.sending) return ['Sender', 'ok'];
    if (v.silent) return ['Stille', 'bad'];
    return ['Venter', 'info'];
  }

  function render(d) {
    const vs = d.vehicles;
    const sending = vs.filter(v => v.sending).length, silent = vs.filter(v => v.active && v.key_prefix && v.silent).length, unsynced = vs.filter(v => v.clock_synced === false).length;
    const points = vs.reduce((n, v) => n + v.points_24h, 0), gaps = vs.reduce((n, v) => n + v.gaps_24h, 0), alarms = vs.reduce((n, v) => n + v.alarms_24h, 0);
    root.querySelector('.cards').innerHTML = [
      ['Kjøreverk', vs.length, ''], ['Sender nå', sending, sending === vs.filter(v => v.active && v.key_prefix).length && sending ? 'ok' : ''],
      ['Stille for lenge', silent, silent ? 'bad' : 'ok'], ['Klokke ikke synkronisert', unsynced, unsynced ? 'warn' : ''],
      ['Punkter siste døgn', fmtNum(points), ''], ['Hull siste døgn', gaps, gaps ? 'warn' : ''], ['Alarmer siste døgn', alarms, alarms ? 'warn' : ''],
      ['Database', fmtBytes(d.dbBytes), ''],
    ].map(([k, v, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');

    const tbody = root.querySelector('tbody');
    if (!vs.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty">Ingen kjøreverk ennå. Legg til med <code>sudo kv-admin vehicle add kv01</code> og lag nøkkelen med <code>sudo kv-admin vehicle key kv01</code>.</td></tr>'; return; }
    tbody.innerHTML = vs.map(v => {
      const [txt, cls] = status(v);
      const clock = v.clock_synced === null ? '–' : v.clock_synced ? `<span class="badge ok">synk${v.clock_offset_ms !== null ? ` ${v.clock_offset_ms > 0 ? '+' : ''}${v.clock_offset_ms} ms` : ''}</span>` : '<span class="badge bad">ikke synk</span>';
      return `<tr data-code="${esc(v.code)}" class="${selected === v.code ? 'sel' : ''}">
        <td><b>${esc(v.code)}</b></td><td>${esc(v.name)}</td><td><span class="badge ${cls}">${txt}</span></td>
        <td title="${fmtTime(v.last_batch_at)}">${ago(v.last_batch_at)}</td><td>${fmtTime(v.last_ts)}</td>
        <td>${clock}</td><td>${esc(v.recorder_version || '–')}</td><td>${esc(v.rule_set)}${v.has_extra ? '+' : ''} <span class="muted">v${v.rules_version}</span></td>
        <td class="num">${fmtNum(v.tags)}</td><td class="num">${fmtNum(v.points_24h)}</td><td class="num">${v.gaps_24h ? `<span class="badge warn">${v.gaps_24h}</span>` : '0'}</td><td class="num">${v.alarms_24h ? `<span class="badge bad">${v.alarms_24h}</span>` : '0'}</td>
      </tr>`;
    }).join('');
  }

  async function refresh() {
    try {
      const d = await api('/overview');
      window.Shell.serverStatus(true, `· v${d.version} · PostgreSQL ${d.timescale ? 'med' : 'uten'} TimescaleDB${d.rollupPending ? ` · ${d.rollupPending} i sammendragskøen` : ''}`);
      render(d);
    } catch (e) {
      window.Shell.serverStatus(false, '· serveren svarer ikke');
      root.querySelector('tbody').innerHTML = `<tr><td colspan="12" class="err">Kunne ikke hente oversikten: ${esc(e.message)}</td></tr>`;
    }
  }

  async function showVehicle(code) {
    selected = code;
    const box = root.querySelector('.detail');
    box.style.display = 'block';
    box.innerHTML = `<span class="close" title="Lukk">✕</span><h2>${esc(code)}</h2><p class="muted">henter …</p>`;
    box.querySelector('.close').onclick = () => { box.style.display = 'none'; selected = null; };
    try {
      const v = await api(`/vehicles/${encodeURIComponent(code)}`);
      const row = (k, val) => `<div><span>${k}</span>${val}</div>`;
      box.innerHTML = `<span class="close" title="Lukk">✕</span><h2>${esc(v.code)} <span class="muted">${esc(v.name)}</span></h2>
        <div class="grid">
          ${row('Aktiv', v.active ? 'ja' : 'nei')}${row('Nøkkel', v.key_prefix ? `${esc(v.key_prefix)}… (${fmtTime(v.key_made_at)})` : 'ingen')}
          ${row('Regelsett', `${esc(v.rule_set)}${v.rule_extra ? ' + tillegg' : ''} v${v.rules_version_eff}`)}${row('Stille-varsel etter', `${v.silent_after_s} s`)}
          ${row('Sist sett', fmtTime(v.last_seen))}${row('Siste batch', fmtTime(v.last_batch_at))}${row('Data fram til', fmtTime(v.last_ts))}
          ${row('Recorder', esc(v.recorder_version || '–'))}${row('Klokke', v.clock_synced === null ? '–' : v.clock_synced ? `synkronisert, ${v.clock_offset_ms} ms` : 'ikke synkronisert')}
          ${row('Tagger', v.tags)}${row('Notater', esc(v.notes))}
        </div>
        <h2>Siste økter</h2>
        <table><thead><tr><th>Boot</th><th>Startet</th><th>Siste batch</th><th class="num">Batcher</th><th class="num">Punkter</th><th>Data fra</th><th>til</th><th>Recorder</th></tr></thead><tbody>
        ${v.sessions.map(s => `<tr><td><code>${esc(s.boot.slice(0, 8))}</code></td><td>${fmtTime(s.started_at)}</td><td>${fmtTime(s.last_batch_at)}</td><td class="num">${fmtNum(s.batches)}</td><td class="num">${fmtNum(s.points)}</td><td>${fmtTime(s.first_ts)}</td><td>${fmtTime(s.last_ts)}</td><td>${esc(s.recorder_version || '–')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">ingen</td></tr>'}
        </tbody></table>
        <h2>Siste hull</h2>
        <table><thead><tr><th>Fra</th><th>Til</th><th>Varighet</th><th>Tagger</th><th>Grunn</th><th>Meldt</th></tr></thead><tbody>
        ${v.gaps.map(g => `<tr><td>${fmtTime(g.from_ts)}</td><td>${fmtTime(g.to_ts)}</td><td>${Math.round((g.to_ts - g.from_ts) / 1000)} s</td><td>${g.tags === null ? 'alle' : esc(g.tags.length > 5 ? `${g.tags.slice(0, 5).join(', ')} … (${g.tags.length})` : g.tags.join(', '))}</td><td>${esc(g.reason)}</td><td>${fmtTime(g.reported_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">ingen</td></tr>'}
        </tbody></table>`;
      box.querySelector('.close').onclick = () => { box.style.display = 'none'; selected = null; };
    } catch (e) {
      box.innerHTML = `<span class="close">✕</span><p class="err">${esc(e.message)}</p>`;
      box.querySelector('.close').onclick = () => { box.style.display = 'none'; selected = null; };
    }
  }

  window.Shell.page('overview', {
    title: 'Oversikt',
    mount(main) {
      root = el('div');
      root.innerHTML = `<h1>Oversikt</h1><div class="cards"></div>
        <table><thead><tr><th>Kjøreverk</th><th>Navn</th><th>Status</th><th>Siste batch</th><th>Data fram til</th><th>Klokke</th><th>Recorder</th><th>Regler</th>
        <th class="num">Tagger</th><th class="num">Punkter 24 t</th><th class="num">Hull 24 t</th><th class="num">Alarmer 24 t</th></tr></thead><tbody><tr><td colspan="12" class="muted">henter …</td></tr></tbody></table>
        <div class="detail" style="display:none"></div>`;
      root.querySelector('tbody').addEventListener('click', e => { const tr = e.target.closest('tr[data-code]'); if (tr) showVehicle(tr.dataset.code); });
      main.appendChild(root);
      refresh();
      timer = setInterval(refresh, 10000);
    },
    unmount() { clearInterval(timer); timer = null; root = null; selected = null; },
  });
})();

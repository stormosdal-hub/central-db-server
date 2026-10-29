/*
 * shell.js - det felles skallet for web-siden: menyen, rutingen (#/side) og hjelpefunksjoner sidene deler.
 * Hver side er et skript i pages/ som registrerer seg med Shell.page('navn', { title, mount(el), unmount() }).
 * Innloggingen, tidsvelgeren og velgeren for kjøreverk kommer her når sidene som trenger dem, lages (docs/PLAN.md §4).
 */
(function () {
  'use strict';
  const pages = {};
  let current = null;
  const main = document.getElementById('main');

  const pad = n => String(n).padStart(2, '0');
  const fmtTime = ms => {
    if (ms === null || ms === undefined) return '–';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const ago = ms => {
    if (ms === null || ms === undefined) return 'aldri';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 0) return 'nå';
    if (s < 60) return `${s} s siden`;
    if (s < 3600) return `${Math.floor(s / 60)} min siden`;
    if (s < 86400) return `${Math.floor(s / 3600)} t ${pad(Math.floor((s % 3600) / 60))} min siden`;
    return `${Math.floor(s / 86400)} d siden`;
  };
  const fmtNum = n => (n === null || n === undefined ? '–' : Number(n).toLocaleString('nb-NO'));
  const fmtBytes = b => {
    if (!(b >= 0)) return '–';
    const u = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0; while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs, html) => { const e = document.createElement(tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (html !== undefined) e.innerHTML = html; return e; };

  async function api(path, opts) {
    const r = await fetch('/api/web' + path, Object.assign({ headers: { Accept: 'application/json' } }, opts || {}));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  }

  function route() {
    const name = (location.hash.replace(/^#\/?/, '') || 'overview').split('/')[0];
    if (current && current.name === name) return;
    if (current && current.unmount) current.unmount();
    main.innerHTML = '';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === name));
    const p = pages[name];
    if (!p) {
      const titles = { find: 'Finn data', trend: 'Trend og tidslinje', export: 'Eksport', rules: 'Regler', events: 'Hendelser og hull', vehicles: 'Kjøreverk' };
      main.appendChild(el('div', { class: 'soon' }, `<h1>${esc(titles[name] || name)}</h1><p class="muted">Denne siden er ikke laget ennå. Hva den skal gjøre, står i <code>docs/PLAN.md</code> §4. Fram til da gjør <code>kv-admin</code> det samme på kommandolinjen (kjøreverk, nøkler og regler).</p>`));
      current = { name };
      return;
    }
    current = { name, unmount: p.unmount };
    document.title = `${p.title} · Kjøreverk`;
    p.mount(main);
  }
  window.addEventListener('hashchange', route);

  setInterval(() => { document.getElementById('clock').textContent = fmtTime(Date.now()); }, 1000);

  window.Shell = {
    page(name, p) { pages[name] = p; if (document.readyState !== 'loading') route(); },
    api, el, esc, fmtTime, ago, fmtNum, fmtBytes,
    serverStatus(ok, text) {
      document.getElementById('serverDot').className = 'dot ' + (ok ? 'ok' : 'bad');
      document.getElementById('serverInfo').textContent = text || '';
    },
  };
  document.addEventListener('DOMContentLoaded', route);
})();

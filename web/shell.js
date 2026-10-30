/*
 * shell.js - det felles skallet for web-siden: menyen, rutingen (#/side), innloggingen og hjelpefunksjoner
 * sidene deler. Hver side er et skript i pages/ som registrerer seg med
 * Shell.page('navn', { title, mount(el), unmount() }). Siden monteres på nytt når noen logger inn eller ut.
 * Tidsvelgeren og velgeren for kjøreverk kommer her når sidene som trenger dem, lages (docs/PLAN.md §4).
 */
(function () {
  'use strict';
  const pages = {};
  let current = null;
  let started = false;
  const me = { user: null, hasUsers: true, loginToView: false };
  const main = document.getElementById('main');
  const RANK = { view: 1, rules: 2, admin: 3 };
  const ROLE_TEXT = { view: 'se', rules: 'regler', admin: 'admin' };

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
  const fmtDuration = s => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} t` : `${Math.round(s / 60)} min`);
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs, html) => { const e = document.createElement(tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (html !== undefined) e.innerHTML = html; return e; };

  // /api/web: opts.body sendes som JSON. Svarer serveren 401 og vil ha innlogging, åpnes innloggingen, og
  // forespørselen prøves på nytt når den lykkes.
  async function api(path, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    const init = { method: o.method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    const r = await fetch('/api/web' + path, init);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.login && !o.noLogin) {
      if (await login()) return api(path, Object.assign({}, o, { noLogin: true }));
    }
    if (!r.ok) { const e = new Error(j.error || `${r.status}`); e.status = r.status; throw e; }
    return j;
  }

  // ---------------------------------------------------------------- vinduer
  // et vindu over siden: { box, close }. onClose kalles når det lukkes (✕, Escape eller close()).
  function modal(html, onClose) {
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, `<span class="close" title="Lukk">✕</span>${html}`);
    back.appendChild(box);
    document.body.appendChild(back);
    const close = () => { if (!back.parentNode) return; back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    box.querySelector('.close').onclick = close;
    const first = box.querySelector('input:not([type=hidden]), select, textarea, button.primary');
    if (first) setTimeout(() => first.focus(), 0);
    return { box, close };
  }

  function confirmBox(title, text, okText, danger) {
    return new Promise(resolve => {
      let answer = false;
      const m = modal(`<h2>${esc(title)}</h2><p>${text}</p><div class="actions"><button class="cancel">Avbryt</button><button class="${danger ? 'danger' : 'primary'} ok">${esc(okText)}</button></div>`, () => resolve(answer));
      m.box.querySelector('.cancel').onclick = () => m.close();
      m.box.querySelector('.ok').onclick = () => { answer = true; m.close(); };
      setTimeout(() => m.box.querySelector('.cancel').focus(), 0);   // et tilfeldig Enter gjør ingenting
    });
  }

  // kopier til utklippstavlen; navigator.clipboard finnes bare over HTTPS, så over HTTP brukes en markert tekst
  async function copy(text, button) {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { /* prøv den gamle måten */ }
    if (!ok) {
      const ta = el('textarea', { style: 'position:fixed;top:-1000px;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    if (button) {
      const was = button.textContent;
      button.textContent = ok ? 'Kopiert ✓' : 'Marker og kopier selv';
      setTimeout(() => { button.textContent = was; }, 1800);
    }
    return ok;
  }

  // ---------------------------------------------------------------- innloggingen
  let loginOpen = null;
  function login() {
    if (loginOpen) return loginOpen;
    loginOpen = new Promise(resolve => {
      let done = false;
      const none = !me.hasUsers ? `<p class="note">Det finnes ingen brukere ennå. Lag den første på databasemaskinen:<br><code>sudo kv-admin user add &lt;navn&gt; --role admin</code></p>` : '';
      const m = modal(`<h2>Logg inn</h2>${none}
        <form class="form" autocomplete="on">
          <label>Brukernavn<input name="name" autocomplete="username" required></label>
          <label>Passord<input name="password" type="password" autocomplete="current-password" required></label>
          <p class="err" hidden></p>
          <div class="actions"><button type="button" class="cancel">Avbryt</button><button type="submit" class="primary">Logg inn</button></div>
        </form>`, () => { loginOpen = null; resolve(done); });
      const f = m.box.querySelector('form');
      m.box.querySelector('.cancel').onclick = () => m.close();
      f.onsubmit = async e => {
        e.preventDefault();
        const err = f.querySelector('.err');
        err.hidden = true;
        try {
          const r = await api('/login', { method: 'POST', body: { name: f.name.value.trim(), password: f.password.value }, noLogin: true });
          me.user = r.user;
          done = true;
          m.close();
          renderWho();
          remount();
        } catch (ex) {
          err.textContent = ex.status === 401 ? 'Feil brukernavn eller passord.' : ex.message;
          err.hidden = false;
          f.password.select();
        }
      };
    });
    return loginOpen;
  }

  async function logout() {
    try { await api('/logout', { method: 'POST', body: {} }); } catch (e) { /* uansett */ }
    me.user = null;
    renderWho();
    remount();
  }

  function renderWho() {
    const w = document.getElementById('who');
    if (me.user) {
      w.innerHTML = `<span title="Innlogget">${esc(me.user.name)} <span class="badge">${esc(ROLE_TEXT[me.user.role] || me.user.role)}</span></span> <button class="link" id="logoutBtn">Logg ut</button>`;
      document.getElementById('logoutBtn').onclick = logout;
    } else {
      w.innerHTML = '<button class="link" id="loginBtn">Logg inn</button>';
      document.getElementById('loginBtn').onclick = () => login();
    }
  }

  // ---------------------------------------------------------------- rutingen
  function route() {
    if (!started) return;
    const name = (location.hash.replace(/^#\/?/, '') || 'overview').split(/[/?]/)[0];
    if (current && current.name === name) return;
    if (current && current.unmount) current.unmount();
    main.innerHTML = '';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === name));
    if (me.loginToView && !me.user) {
      current = { name: '__login' };
      main.appendChild(el('div', { class: 'empty' }, 'Logg inn for å se web-siden.'));
      login();
      current = null;
      return;
    }
    const p = pages[name];
    if (!p) {
      const titles = { find: 'Finn data', trend: 'Trend og tidslinje', export: 'Eksport', rules: 'Regler', events: 'Hendelser og hull' };
      main.appendChild(el('div', { class: 'soon' }, `<h1>${esc(titles[name] || name)}</h1><p class="muted">Denne siden er ikke laget ennå. Hva den skal gjøre, står i <code>docs/PLAN.md</code> §4. Fram til da gjør <code>sudo kv-admin</code> det samme på kommandolinjen på databasemaskinen.</p>`));
      current = { name };
      return;
    }
    current = { name, unmount: p.unmount };
    document.title = `${p.title} · Kjøreverk`;
    p.mount(main);
  }
  function remount() { if (current && current.unmount) current.unmount(); current = null; route(); }
  window.addEventListener('hashchange', route);

  setInterval(() => { document.getElementById('clock').textContent = fmtTime(Date.now()); }, 1000);

  window.Shell = {
    page(name, p) { pages[name] = p; if (started && current === null) route(); },
    api, el, esc, fmtTime, ago, fmtNum, fmtBytes, fmtDuration, modal, confirm: confirmBox, copy, login,
    get user() { return me.user; },
    // #/side?a=1&b=2: parameterne til siden som vises, og å gå til en side med parametere
    params() { const h = location.hash; const i = h.indexOf('?'); return new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''); },
    go(page, params) { location.hash = `#/${page}${params && String(new URLSearchParams(params)) ? '?' + new URLSearchParams(params) : ''}`; },
    // oppdater adressen uten å laste siden på nytt, så den kan bokmerkes og deles
    setParams(params) {
      const name = (location.hash.replace(/^#\/?/, '') || 'overview').split(/[/?]/)[0];
      const q = String(new URLSearchParams(params));
      history.replaceState(null, '', `#/${name}${q ? '?' + q : ''}`);
    },
    can(role) { return !!me.user && (RANK[me.user.role] || 0) >= RANK[role]; },
    serverStatus(ok, text) {
      document.getElementById('serverDot').className = 'dot ' + (ok ? 'ok' : 'bad');
      document.getElementById('serverInfo').textContent = text || '';
    },
  };

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const r = await fetch('/api/web/me', { credentials: 'same-origin' }).then(x => x.json());
      Object.assign(me, r);
    } catch (e) { /* serveren svarer ikke: sidene sier fra */ }
    renderWho();
    started = true;
    route();
  });
})();

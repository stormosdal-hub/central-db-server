/*
 * pages/home.js - forsiden (#/): velg Kjøreverk-database (visningene med widgeter, dash/) eller Avansert (sidene
 * for å finne data, sette regler og styre serveren). Viser visningene som finnes, og hvor mange kjøreverk som sender.
 */
(function () {
  'use strict';
  const S = window.Shell;
  const { api, esc } = S;
  let alive = false;

  const ADV = [['overview', 'Oversikt', 'alle kjøreverkene og serveren'], ['find', 'Finn data', 'hvilke kjøreverk har dataene'], ['trend', 'Trend', 'flere kjøreverk i samme graf'],
    ['export', 'Eksport', 'CSV for Excel'], ['rules', 'Regler', 'hva recorderne sender'], ['events', 'Hendelser', 'alarmer og hull'], ['vehicles', 'Kjøreverk', 'registrere, nøkler']];

  S.page('home', {
    title: 'Forsiden',
    section: 'home',
    mount(main) {
      alive = true;
      main.innerHTML = `<div class="home">
        <p class="muted home-status">&nbsp;</p>
        <div class="home-tiles">
          <section class="home-tile dash-tile">
            <a class="home-main" href="#/visning">
              <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="6" width="18" height="14" rx="2"/><rect x="26" y="6" width="18" height="22" rx="2"/><rect x="4" y="24" width="18" height="18" rx="2"/><rect x="26" y="32" width="18" height="10" rx="2"/></svg>
              <h2>Kjøreverk-database</h2>
              <p>Bygg dine egne visninger: legg widgeter på et lerret, som i HMI-en, og velg kjøreverk, og tagger under hvert.
              Se og sammenlign i tidslinjer, trender, hendelseslister, tabeller og verdier. Edit for å bygge, Run for å bruke.</p>
              <span class="home-go">Åpne →</span>
            </a>
            <div class="home-list"><span class="muted">Visningene</span><div class="views muted">…</div></div>
          </section>
          <section class="home-tile adv-tile">
            <a class="home-main" href="#/overview">
              <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 10h36M6 24h36M6 38h36"/><circle cx="16" cy="10" r="4"/><circle cx="32" cy="24" r="4"/><circle cx="20" cy="38" r="4"/></svg>
              <h2>Avansert</h2>
              <p>Alt for å finne data og styre serveren: søk på tvers av kjøreverkene, trender, eksport til Excel, reglene for
              hva recorderne sender, hendelser og hull, og registrering av kjøreverk og nøkler.</p>
              <span class="home-go">Åpne →</span>
            </a>
            <div class="home-list">${ADV.map(([p, t, d]) => `<a href="#/${p}"><b>${t}</b> <span class="muted">${d}</span></a>`).join('')}</div>
          </section>
        </div></div>`;
      api('/dashboards').then(r => {
        if (!alive) return;
        const box = main.querySelector('.views');
        box.classList.remove('muted');
        box.innerHTML = r.dashboards.length
          ? r.dashboards.map(d => `<a href="#/visning?id=${d.id}"><b>${esc(d.name)}</b> <span class="muted">${d.tabs && d.tabs.length > 1 ? `${d.tabs.length} faner · ` : ''}${d.widgets} widget${d.widgets === 1 ? '' : 'er'}${d.updated_by ? ' · ' + esc(d.updated_by.replace(/^web:/, '')) : ''}</span></a>`).join('')
          : '<span class="muted">Ingen ennå. Åpne for å lage den første.</span>';
      }).catch(() => { if (alive) main.querySelector('.views').textContent = '–'; });
      S.vehicles(true).then(vs => {
        if (!alive) return;
        const sending = vs.filter(v => v.sending).length;
        main.querySelector('.home-status').textContent = `${vs.length} kjøreverk registrert · ${sending} sender nå`;
        S.serverStatus(true, '');
      }).catch(() => { if (alive) S.serverStatus(false, '· serveren svarer ikke'); });
    },
    unmount() { alive = false; },
  });
})();

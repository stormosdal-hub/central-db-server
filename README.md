# Kjøreverk: den sentrale serveren og databasen

Serveren som tar imot dataene fra recorderen i hvert av de 42 kjøreverkene, lagrer dem i PostgreSQL,
svarer HMI-ene med historikk, og holder reglene for hva som lagres. Den kjører på en Raspberry Pi 5
med 500 GB NVMe, og kan flyttes til en annen maskin uten at noe endres i kjøreverkene.

```
 42 × kjøreverk                                     denne serveren (Pi 5, NVMe)
 ┌──────────────────────────────┐   HTTP, gzip      ┌──────────────────────────────────────┐
 │ S7-1200 ─TcpLink─ Pi:        │  POST /ingest ──► │ server.js (Node, Fastify)            │
 │   hub.js ◄─► recorder.js     │  POST /hello  ──► │   /api/v1   mottaket, regler, historikk │
 │   HMI i nettleseren          │  GET  /rules  ──► │   /api/web + web/  oversikten        │
 │                              │ ◄── POST /history │ PostgreSQL (+ TimescaleDB)           │
 └──────────────────────────────┘                   │   sample, event, gap, session, rule_set │
                                   NTP (chrony) ◄── │ kv-admin  kjøreverk, nøkler, regler  │
                                                    └──────────────────────────────────────┘
```

- **Planen** står i [docs/PLAN.md](docs/PLAN.md), og **grensesnittet mot kjøreverkene** i
  [docs/PROTOKOLL.md](docs/PROTOKOLL.md) (versjon 1). Protokollfilen finnes også i HMI-prosjektet
  (`hmi-core/docs/PROTOKOLL.md`) og skal være lik begge steder.
- **Pi-siden** (`hub.js`, `recorder.js`, `lib/record-rules.js`) ligger i prosjektet
  HMI-user-interface. Regelformatet eies av `lib/record-rules.js` der; kopien her brukes til å sjekke
  regelsett før de lagres.

## Innhold

1. [Status](#1-status)
2. [Installasjon på Pi 5-en](#2-installasjon-på-pi-5-en)
3. [Oppsettfilen](#3-oppsettfilen)
4. [Kjøreverk og nøkler](#4-kjøreverk-og-nøkler)
5. [Reglene](#5-reglene)
6. [API-et og web-siden](#6-api-et-og-web-siden)
7. [Databasen](#7-databasen)
8. [Klokka](#8-klokka)
9. [Drift](#9-drift): logger, sikkerhetskopi, flytting, oppdatering
10. [Utvikling og test](#10-utvikling-og-test)
11. [Filene](#11-filene)

---

## 1. Status

Rekkefølgen fra planen (§5), og hvor langt det er kommet:

| # | Del | Status |
|---|---|---|
| 1 | Installasjon: PostgreSQL + TimescaleDB, skjemaet som migreringer | **bygd.** `deploy/install.sh`, `db/migrations/001_init.sql`. Installasjonsskriptet er skrevet for Debian på Pi 5, men er ennå ikke kjørt på en ekte Pi |
| 2 | Mottaket `/hello` og `/ingest`, testskript for 42 kjøreverk, måling | **bygd.** Idempotent på `boot` + `seq`, én transaksjon per batch, mottrykk med 503. `test/simulate.js`. Målt her på en x86-maskin: 3 300 punkter/s lagret med 25 ms per batch; Pi 5-en må måles |
| 3 | Kjøreverk og nøkler på kommandolinjen | **bygd.** `kv-admin vehicle …` |
| 4 | `/rules` og siden for reglene | **API-et er bygd**, med regelsett, tillegg per kjøreverk og pauser fra kommandolinjen. Web-siden gjenstår |
| 5 | `/history` | **bygd.** Rådata, `sample_1m` eller `sample_1h` etter mengden, første punkt ved `from`, tynning med minste og største, `null` i kjente hull og mellom økter |
| 6 | Web-siden: oversikten, Finn data, trend, eksport | **Skallet og Oversikt er bygd.** Finn data, trend, eksport og innlogging gjenstår |
| 7 | Hendelser, hull og varsler for stille kjøreverk | Hendelser og hull lagres og vises per kjøreverk i oversikten; «stille» vises med grensen `silent_after_s`. Egen side med filtre gjenstår |
| 8 | Klokka: chrony som tidsserver | **oppsett beskrevet** (§8, `deploy/chrony-kjoreverk.conf`). GPS senere |
| 9 | Sikkerhetskopi og flytting | **bygd og beskrevet** (§9), ikke prøvd på en Pi ennå |

**Avvik fra planen, med vilje:**

- **Sammendragene `sample_1m` og `sample_1h` lages av serveren**, ikke som Timescales *continuous
  aggregates*. Mottaket noterer tidsrommet til hver batch i `rollup_dirty`, og en jobb regner om de
  minuttene og timene hvert 20. sekund. Det gir samme resultat med og uten TimescaleDB, og tar med
  punkter som kommer i etterkant (ringen i PLS-en, hubens minne), som en refresh-policy ikke ville
  gjort for gamle tidsrom. TimescaleDB brukes fortsatt til det den er best på: oppdeling etter tid,
  komprimering og sletting av rådataene.
- **Uten TimescaleDB blir tabellene vanlige tabeller** med en BRIN-indeks på tiden, ikke
  partisjoner per måned. Det er enklere, og holder for å komme i gang; se [§7](#7-databasen).
- **Tider før 2001 eller mer enn et døgn fram i tid avvises** (400). En Pi uten batteri på RTC-en kan
  ha en tid ingen vet noe om, og lagrede tider skrives aldri om. Recorderen sender uansett ikke før
  klokka er synkronisert.

## 2. Installasjon på Pi 5-en

Raspberry Pi OS (64-bit) eller Debian, Bookworm eller Trixie, på en Pi 5 med NVMe-disken som
rotfilsystem (eller montert der PostgreSQL skal ligge). Alt er Debian-pakker og systemd; ingen Docker.

1. **Node.js (LTS).** Pi OS leveres med en gammel versjon. Den enkleste veien med internett:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node -v    # v22.x
   ```

   Uten internett: se «Installere uten internett» i HMI-prosjektets `hmi-core/README.md`; det samme
   gjelder her (pakk ut `node-v22.x-linux-arm64.tar.xz` i `/opt/node22` og lenk inn `node` og
   `npm`). Da må `ExecStart` i `deploy/kjoreverk-server.service` peke på den.
2. **Hent prosjektet** til Pi-en, for eksempel `git clone … ~/central-db-server`, og kjør
   installasjonsskriptet:

   ```bash
   cd ~/central-db-server
   sudo bash deploy/install.sh
   ```

   Det installerer PostgreSQL, prøver TimescaleDB (Timescales pakkebrønn for den Debian-utgaven og
   PostgreSQL-versjonen Pi-en har), lager databasebrukeren og databasen `kjoreverk`, kopierer
   programmet til `/opt/kjoreverk-server`, lager `/etc/kjoreverk-server/config.json`, kjører
   migreringene, og starter tjenesten `kjoreverk-server` og den nattlige sikkerhetskopien. Det kan
   kjøres på nytt, også for å oppdatere (§9).
   - **Finnes det ingen TimescaleDB-pakke** for kombinasjonen (skriptet sier fra), går alt videre
     uten. Se [§7](#7-databasen) for hva det betyr, og hvordan den legges til senere.
   - `NO_TIMESCALE=1 sudo bash deploy/install.sh` hopper over TimescaleDB med vilje.
3. **Sjekk:**

   ```bash
   systemctl status kjoreverk-server
   journalctl -u kjoreverk-server -n 30 --no-pager
   kv-admin status
   curl http://localhost:8090/api/health
   ```

   Web-siden er på `http://<pi-ip>:8090/`.
4. **Gi serveren et fast navn eller en fast IP-adresse** på nettet, for eksempel `dbserver`. Det er
   det kjøreverkene får i `/etc/hmi-recorder.json`, og det følger med til en ny maskin senere.
5. **Klokka:** sett opp chrony som tidsserver for kjøreverkene, [§8](#8-klokka).
6. **Legg til kjøreverkene** og lag nøklene, [§4](#4-kjøreverk-og-nøkler).

**For hånd, uten skriptet:** `apt install postgresql`, lag rollen og databasen
(`createuser kjoreverk; createdb -O kjoreverk kjoreverk`), eventuelt `CREATE EXTENSION timescaledb`
i den som superbruker, `npm ci --omit=dev` i prosjektmappen, kopier `config.example.json` til
`/etc/kjoreverk-server/config.json`, og `node bin/kv-admin.js migrate`. Tjenesten er
`deploy/kjoreverk-server.service`.

## 3. Oppsettfilen

Alt oppsett står i én fil, `/etc/kjoreverk-server/config.json` (eller `--config <fil>` /
`KV_SERVER_CONFIG`). [config.example.json](config.example.json) viser alt, og det som mangler i
filen, får standardverdien:

| Innstilling | Standard | Hva |
|---|---|---|
| `port`, `host` | 8090, `0.0.0.0` | Hvor serveren lytter. Kjøreverkene bruker `http://<server>:8090/api/v1` |
| `db` | unix-socket, database og bruker `kjoreverk` | Innstillingene til `pg`: `host`, `port`, `database`, `user`, `password`, eller `url` |
| `ingest.maxBatchBytes` | 5 000 000 | Største batch, pakket ut. Sendes til recorderen i `/hello`; større gir 413, og recorderen deler batchen |
| `ingest.maxConcurrent` | 4 | Batcher som lagres samtidig. Flere får 503 med `retryAfter` 2–10 s, så 42 kjøreverk som kommer tilbake etter et brudd, ikke velter serveren |
| `ingest.maxPointsPerBatch` | 200 000 | Flere punkter i én batch gir 400 |
| `history.maxRows` | 60 000 | Flere rader enn dette per tag, og `/history` bruker sammendragene i stedet for rådataene |
| `history.maxTags`, `maxPoints`, `maxDays` | 8, 10 000, 400 | Grensene for et spørsmål |
| `history.sessionGapSeconds` | 60 | Lengre opphold mellom to økter vises som et hull (`null`) |
| `rollup.everySeconds` | 20 | Hvor ofte sammendragene regnes om |
| `retention.rawDays` | 400 | Rådataene (`sample`) slettes etter så mange dager. 0: aldri |
| `retention.textDays`, `eventDays`, `aggDays` | 400, 0, 0 | Tekst, hendelser og sammendragene |
| `retention.batchDays`, `clockDays` | 7, 90 | Svarene på gamle batcher (til nye forsøk), og klokkeobservasjonene |
| `web.enabled` | true | Web-siden og `/api/web` |
| `log` | `info` | `debug` gir en linje per batch og per historikkspørsmål |

Etter en endring: `sudo systemctl restart kjoreverk-server`.

## 4. Kjøreverk og nøkler

Hvert kjøreverk registreres med en kort kode, gjerne `kv01` … `kv42`, lik vertsnavnet på Pi-en. Det får
sin egen nøkkel, som legges inn på Pi-en ved installasjonen og lagres bare som SHA-256 på serveren.

```bash
kv-admin vehicle add kv07 --name "Kjøreverk 7"
kv-admin vehicle key kv07          # skriver ut nøkkelen, én gang
```

På Pi-en i kjøreverket, i `/etc/hmi-recorder.json` (se `README_systemd-service.md` i HMI-prosjektet):

```json
{ "vehicle": "kv07", "server": "http://dbserver:8090", "token": "nøkkelen fra kv-admin" }
```

Recorderens logg skal så si `the central server answers` og `Recording rules version …`, og
`kv-admin vehicle list` viser kjøreverket med siste batch og recorder-versjon.

| Kommando | Gjør |
|---|---|
| `kv-admin vehicle list` | alle kjøreverkene: aktiv, nøkkel, regelsett og versjon, siste batch, data fram til, recorder, klokke |
| `kv-admin vehicle show kv07` | alt om ett, med de siste øktene |
| `kv-admin vehicle key kv07` | en ny nøkkel; den gamle slutter å virke med en gang |
| `kv-admin vehicle revoke kv07` | nøkkelen trekkes tilbake, for eksempel for en Pi som er borte. Recorderen får 403 og prøver igjen hvert 5. minutt |
| `kv-admin vehicle disable kv07` / `enable` | et kjøreverk som ikke skal sende en stund |
| `kv-admin vehicle set kv07 --name … --silent-after 7200 --notes …` | navn, grensen for «stille»-varselet (sekunder), notater |
| `kv-admin vehicle rules kv07 --set <navn>` | hvilket regelsett det bruker |
| `kv-admin vehicle extra kv07 <fil.json>` / `--none` | tillegget: regler og pauser som går foran settets |
| `kv-admin status`, `kv-admin audit` | serveren i korte trekk, og hvem som gjorde hva |

Alle endringer logges i `audit_log` med hvem (`cli:<bruker>@<maskin>`) og når.

## 5. Reglene

Reglene bestemmer hva recorderen i hvert kjøreverk sender: ved endring med dødbånd, bare noen biter i
et ord, minste og største tid mellom to verdier, vern mot flimring, fast takt, utelating og pauser.
Formatet står i [docs/PROTOKOLL.md](docs/PROTOKOLL.md) §7, og
[docs/examples/rules-example.json](docs/examples/rules-example.json) er et eksempel.

- **Et regelsett** (`rule_set`) deles av mange kjøreverk. `default` lagrer alt ved hver endring til
  noen lager noe bedre.
- **Et tillegg per kjøreverk** (`vehicle extra`) legges foran settets regler og pauser. `events` og
  `eventsMin` kommer alltid fra settet.
- **Første regel som treffer, gjelder.** `${kv}` i et mønster byttes ut på Pi-en med prosjektets
  variabler, så samme sett virker der enhetene heter forskjellig.
- **Hver endring får et nytt versjonsnummer.** Recorderen ser det i svaret på neste batch og henter
  reglene på nytt (`GET /rules` med `If-None-Match`). En endring i tillegget for kv07 får bare kv07
  til å hente.
- **Et regelsett med feil lagres ikke:** det sjekkes med `checkRecording` fra `lib/record-rules.js`,
  og feilene skrives ut (`Rule 2: the smallest change is a number, like 50, or a percentage, like 2%`).

```bash
kv-admin rules list
kv-admin rules show default > regler.json        # rediger
kv-admin rules set default regler.json --note "dødbånd på hastigheten"
kv-admin rules set stille docs/examples/rules-example.json
kv-admin vehicle rules kv07 --set stille
kv-admin rules effective kv07                     # det kv07 får fra GET /rules

# pauser, for eksempel under vedlikehold: alle tagger på kv07 i 2 timer
kv-admin rules pause vehicle:kv07 --tags "*" --minutes 120 --reason "service"
kv-admin rules pause default --tags "kv_1.reals_*" --until 2026-11-01T06:00:00Z
kv-admin rules resume vehicle:kv07 all
```

Pauser som har vært over i mer enn 7 dager, tas ut av listen ved neste lagring. Historikken ligger i
`rule_history`.

## 6. API-et og web-siden

**For recorderne**, under `/api/v1`, nøyaktig etter [docs/PROTOKOLL.md](docs/PROTOKOLL.md):

| Rute | Gjør |
|---|---|
| `POST /hello` | noterer økten (`boot`), recorder-versjonen og klokka, og svarer med `serverTime`, `rulesVersion`, `lastTs` (nyeste tidspunkt serveren har data fra, så recorderen kan fylle hullet fra hubens minne) og `maxBatchBytes` |
| `GET /rules?vehicle=kv07` | det ferdige regelsettet, med `ETag: "<versjon>"`; `If-None-Match` gir 304 |
| `POST /ingest` | én transaksjon: katalogen (`vehicle_tag`), punktene og teksten (`INSERT … ON CONFLICT DO NOTHING` med nøkkelen kjøreverk, tag, tid), hendelsene (kjøreverk, tid, kilde, melding), hullene, økten, klokkeobservasjonen, og svaret. Svarer `{ ok, seq, stored, duplicates, rulesVersion, lastTs }` etter COMMIT. Samme `boot` og `seq` en gang til gir samme svar uten å lagre noe |
| `POST /history` | historikk til trendene, se [§7](#7-databasen) om kildevalget |

- **Nøkkelen** går i `Authorization: Bearer <nøkkel>`; mangler den, 401, er den ukjent, trukket
  tilbake eller for et annet kjøreverk, 403.
- **Gzip:** `Content-Encoding: gzip` tas imot (grensen `maxBatchBytes` gjelder det utpakkede), og svar
  over 1 kB pakkes når forespørselen sa `Accept-Encoding: gzip`.
- **Feil** er alltid `{ "error": "tekst" }`: 400 for en batch som aldri blir godtatt (med tag og
  nummer på punktet), 413 for en for stor, 503 med `retryAfter` når for mange lagres samtidig.
- `GET /api/health` svarer `{ ok, version, time, timescale }` uten nøkkel.

**Web-siden** på `/` er vanlig HTML, CSS og JavaScript uten byggesteg (`web/`). Hver side er et skript i
`web/pages/` med sin del av `/api/web` i `routes/web.js`. Bygd nå: **Oversikt**, med alle kjøreverkene
(status, siste batch, data fram til, klokke med avvik, recorder-versjon, regelsett og versjon, tagger,
punkter, hull og alarmer siste døgn), og et klikk på et kjøreverk viser øktene og hullene. Den
oppdateres hvert 10. sekund. Menyen har plass til resten (Finn data, Trend, Eksport, Regler, Hendelser,
Kjøreverk), som er beskrevet i planen §4.

Web-siden har **ingen innlogging ennå**, og `/api/web` leser bare. Serveren skal stå på det lokale
nettet. Innloggingen med rollene *se*, *regler* og *admin* kommer med sidene som endrer noe; tabellene
`app_user` og `audit_log` og `kv-admin user add` finnes allerede.

## 7. Databasen

Skjemaet står i [db/migrations/001_init.sql](db/migrations/001_init.sql) og følger planen §3.3:

| Tabell | Innhold |
|---|---|
| `vehicle` | kjøreverkene: kode, navn, nøkkel (hash), aktiv, regelsett og tillegg, grensen for stille-varsel, sist sett, recorder-versjon, klokke |
| `tag`, `vehicle_tag` | tagnavnene (felles), og katalogen per kjøreverk med type, enhet, navn fra PLS-en, først og sist sett, siste verdi |
| `sample`, `sample_text` | punktene: `ts`, `vehicle_id`, `tag_id`, `value` (`null` er et hull), `q`, `src`, `unsynced`. Unik på (kjøreverk, tag, tid) |
| `event` | hendelser og alarmer, unik på (kjøreverk, tid, kilde, melding) |
| `gap` | hull recorderen har meldt: tidsrom, tagger, grunn (`queue-full`, `rejected`, `paused`) |
| `session`, `batch` | hver oppstart av en recorder, og svaret på hver batch (til nye forsøk; slettes etter `batchDays`) |
| `clock_obs` | Pi-ens tid mot serverens ved hver forespørsel |
| `sample_1m`, `sample_1h`, `rollup_dirty` | sammendragene per kjøreverk, tag og bøtte (antall, minste, største, sum, første, siste), og køen av tidsrom som skal regnes om |
| `rule_set`, `rule_history` | regelsettene (JSON) med versjon, og historikken |
| `app_user`, `audit_log`, `setting` | brukere på web-siden, hvem som gjorde hva, innstillinger |

**Med TimescaleDB** (anbefalt): `sample` er en hypertable med én chunk per døgn, komprimert etter 7
dager (delt etter kjøreverk og tag, sortert etter tid, vanligvis 10 ganger mindre); `sample_text`,
`event`, `sample_1m` og `sample_1h` likeså med lengre intervaller. Slettingen etter alder er en policy i
databasen, satt fra `retention` i oppsettfilen ved hver oppstart.

**Uten TimescaleDB:** de samme tabellene som vanlige tabeller, med BRIN-indekser på tiden. Alt virker
likt, men ingenting komprimeres (regn med omtrent 100 byte per punkt med indeks, altså 1,5–2 GB i
døgnet med 18 millioner punkter), og slettingen gjør serveren selv én gang i døgnet med `DELETE`, som
tar tid på store tabeller. 500 GB holder da i noen måneder; stram inn reglene, eller legg til
TimescaleDB. **Å legge den til senere** krever at tabellene bygges om: ta `pg_dump`, slett og lag
databasen på nytt med utvidelsen, kjør migreringene (`kv-admin migrate`), og last dataene inn igjen
med `pg_restore --data-only`. Gjør det mens mengden er liten.

**Historikken (`/history`)** velger kilde per tag etter hvor mange rader det blir: rådataene når
timesammendraget anslår færre enn `history.maxRows`, ellers `sample_1m`, ellers `sample_1h`. De siste to
minuttene er alltid rådata, for sammendragene ligger litt etter. Det første punktet er verdien som
gjaldt ved `from`. Er det mer enn 2 × `points` punkter, tynnes de med minste og største per bøtte, i
den rekkefølgen de kom. `null` settes inn der recorderen har meldt et hull og der det er mer enn
`sessionGapSeconds` mellom to økter. Målet er under 1 sekund også for 7 dager; her tok 7 dager med 8
tagger 20–50 ms, men med lite data.

**Hvor mye plass:** oversikten viser størrelsen på databasen og antall punkter per kjøreverk siste
døgn. `kv-admin status` viser det samme. Med TimescaleDB gir `SELECT * FROM hypertable_compression_stats('sample')`
i `psql` hvor mye komprimeringen sparer.

## 8. Klokka

Serveren er tidskilden for kjøreverkene (planen §3.7), så alle tider er like på tvers:

```bash
sudo apt install chrony
sudo cp deploy/chrony-kjoreverk.conf /etc/chrony/conf.d/kjoreverk.conf
sudo nano /etc/chrony/conf.d/kjoreverk.conf     # server-linjen: en NTP-server som finnes fra før, og allow: nettet kjøreverkene står på
sudo systemctl restart chrony
chronyc tracking                                 # vår egen kilde
chronyc clients                                  # kjøreverkene som spør
```

- **`local stratum 10`** gjør at serveren svarer kjøreverkene med sin egen klokke også når kilden
  faller ut, så alle holder samme tid.
- **Pi 5 har en RTC:** sett i batteriet, så tiden overlever et strømbrudd. `rtcsync` i oppsettet skriver
  klokka dit.
- **GPS senere:** en USB-mottaker (u-blox) med `gpsd`, og i chrony-oppsettet
  `refclock SHM 0 refid GPS precision 1e-1 offset 0.5` (og `refclock SHM 1 refid PPS` med PPS).
- **Kjøreverkene** peker på serveren: `NTP=dbserver` i `/etc/systemd/timesyncd.conf`, eller
  `server dbserver iburst` i chrony, se `README_systemd-service.md` i HMI-prosjektet. PLS-ene peker på
  sin Pi.
- **Serveren følger med:** `clock_obs` har Pi-ens tid mot serverens ved hver forespørsel, og
  oversikten viser avviket. Lagrede tider skrives aldri om, men en klokke som gikk feil, kan rettes
  senere ut fra dette.

## 9. Drift

**Loggen:** `journalctl -u kjoreverk-server -f`. Hver linje er `tid nivå modul: melding`. Med
`"log": "debug"` kommer en linje per batch og per historikkspørsmål.

**Sikkerhetskopi.** Én NVMe-disk er ingen sikkerhetskopi. `kjoreverk-backup.timer` kjører
`deploy/backup.sh` hver natt kl. 02:30: `pg_dump -Fc` til `/var/backups/kjoreverk/`, med oppsettfilen,
og beholder 14 døgn. Pek mappen på en USB-disk (endre stien i `kjoreverk-backup.service`), eller kopier
filene til en annen maskin:

```bash
sudo kjoreverk-backup                               # ta en nå
rsync -a /var/backups/kjoreverk/ bruker@annenmaskin:/backup/kjoreverk/
```

Prøv en gjenoppretting før det trengs:

```bash
sudo -u postgres createdb -O kjoreverk kjoreverk_test
sudo -u postgres psql -d kjoreverk_test -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'
sudo -u postgres pg_restore -d kjoreverk_test /var/backups/kjoreverk/kjoreverk-<dato>.dump
```

Med TimescaleDB: kjør `SELECT timescaledb_pre_restore();` før og `SELECT timescaledb_post_restore();`
etter `pg_restore`, i samme database. Større mengder: vurder pgBackRest.

**Flytte til en annen maskin:** installer på den nye med `deploy/install.sh`, stopp tjenesten på
begge, `pg_dump` på den gamle og `pg_restore` på den nye (eller `pg_basebackup`), kopier
`/etc/kjoreverk-server/config.json`, og gi den nye maskinen navnet eller IP-adressen kjøreverkene
bruker. Recorderne merker bare et brudd, og sender det som lå i køen.

**Oppdatere programmet:** hent den nye versjonen og kjør `sudo bash deploy/install.sh` igjen. Det
kopierer filene, installerer avhengighetene, kjører nye migreringer og starter tjenesten på nytt.
Oppsettfilen røres ikke. Recorderne tåler bruddet.

**Strøm:** PostgreSQL tåler strømbrudd så lenge `fsync` står på (`deploy/postgresql-kjoreverk.conf`
setter den uttrykkelig). En UPS på serveren er likevel lurt.

**Varsel om stille kjøreverk:** oversikten merker et kjøreverk rødt når det ikke har sendt på mer enn
`silent_after_s` (2 timer som standard, `kv-admin vehicle set kv07 --silent-after 600`).

## 10. Utvikling og test

```bash
npm install
createdb kjoreverk_test                    # en database bare for testene: skjemaet bygges på nytt hver gang
KV_TEST_DB=postgres://bruker:passord@localhost/kjoreverk_test npm test
```

Testene (`test/*.test.js`, Nodes egen `node:test`) kjører mot en ekte PostgreSQL, med og uten
TimescaleDB: mottaket (idempotens, duplikater, 400/401/403/413/503, gzip, klokkemerket), reglene
(ETag og 304, versjoner, tillegg, feil, pauser), historikken (første punkt, tynning, hull, økter,
sammendragene, punkter i etterkant) og kommandolinjen.

**Simulatoren** later som det er 42 kjøreverk mot en kjørende server, med brudd, nye forsøk, omstarter
med etterfylling og batcher sendt to ganger, og skriver tallene til slutt:

```bash
node server.js --config config.json &
node test/simulate.js --config config.json --vehicles 42 --seconds 300 --rate 5
node test/simulate.js --config config.json --vehicles 42 --seconds 120 --rate 100 --outage 0.1   # stress
```

`--rate` er punkter i sekundet per kjøreverk (planen regner med 5), `--outage` sannsynligheten for et
brudd per batch. Kjøreverkene heter `sim01` … og blir stående i databasen. Kjør den på Pi 5-en for å
måle hva den tåler; på en x86-maskin ga 42 × 100 punkter/s 3 300 lagrede punkter i sekundet med 25 ms
per batch og 0 feil.

**Mot den ekte recorderen:** legg til et kjøreverk, lag nøkkelen, legg den i `/etc/hmi-recorder.json`
på en Pi med hmi-core, og følg `journalctl -u kjoreverk@recorder -f` der og `journalctl -u kjoreverk-server -f`
her. En trend i HMI-en som ber om mer enn huben husker, skal da få det fra serveren.

**Protokollen og regelmotoren** deles med HMI-prosjektet: endres `docs/PROTOKOLL.md`, endres den
begge steder; endres `lib/record-rules.js` der, kopieres den hit (merket med commit øverst i filen).

## 11. Filene

```
server.js                 programmet: node server.js [--config fil]
bin/kv-admin.js           kommandolinjen
lib/
  app.js                  Fastify-appen: gzip inn og ut, feilsvar, rutene
  config.js               oppsettfilen og standardverdiene
  db.js                   PostgreSQL og migreringene
  auth.js                 nøklene (SHA-256) og preHandler-en for /api/v1
  ingest.js               mottaket: sjekken av batchen og transaksjonen
  history.js              /history: kildevalg, første punkt, tynning, hull
  rules.js                regelsett, tillegg, versjoner, pauser
  admin.js                kjøreverk, nøkler, brukere
  jobs.js                 sammendragene, slettingen, oppryddingen
  record-rules.js         kopi av hmi-core sin regelmotor (sjekken av regelsett)
  log.js, errors.js, audit.js
routes/v1.js              /api/v1: hello, rules, ingest, history
routes/web.js             /api/web: det web-siden spør om
web/                      web-siden: index.html, shell.js, style.css, pages/overview.js
db/migrations/            skjemaet, nummerert
deploy/                   install.sh, systemd-enhetene, backup.sh, postgresql- og chrony-oppsett
docs/                     PLAN.md, PROTOKOLL.md, examples/rules-example.json
test/                     testene, helpers.js og simulate.js
config.example.json       alle innstillingene
```

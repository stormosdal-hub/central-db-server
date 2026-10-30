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
                  NTP 10.0.0.104 (alle enhetene) ── │ kv-admin  kjøreverk, nøkler, regler  │
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
4. [Legge til et kjøreverk](#4-legge-til-et-kjøreverk): på databasemaskinen og på Pi-en, og feilsøking
5. [Reglene](#5-reglene)
6. [API-et og web-siden](#6-api-et-og-web-siden): også innlogging og roller
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
| 3 | Kjøreverk og nøkler: først på kommandolinjen, så på web-siden | **bygd.** `sudo kv-admin vehicle …`, og siden *Kjøreverk*, med innlogging og roller |
| 4 | `/rules` og siden for reglene | **bygd.** API-et, og siden *Regler* med editor, pauser, forhåndsvisning og historikk |
| 5 | `/history` | **bygd.** Rådata, `sample_1m` eller `sample_1h` etter mengden, første punkt ved `from`, tynning med minste og største, `null` i kjente hull og mellom økter |
| 6 | Web-siden: oversikten, Finn data, trend, eksport | **bygd.** Oversikt, Finn data, Trend, Eksport og Kjøreverk, med innlogging og roller |
| 7 | Hendelser, hull og varsler for stille kjøreverk | **bygd.** Siden *Hendelser*, med varsler, filtre og hull (meldte og brudd mellom økter) |
| 8 | Klokka | **ordnet:** alle enhetene bruker NTP-serveren 10.0.0.104; `install.sh` setter opp databasemaskinen (§8). Serverens klokke vises på Oversikt |
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
- **Klokka:** alle enhetene bruker NTP-serveren som finnes på nettet (10.0.0.104), i stedet for at
  databasemaskinen er tidskilde med GPS (planen §3.7). Se [§8](#8-klokka).
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
   sudo kv-admin status
   curl http://localhost:8090/api/health
   ```

   Web-siden er på `http://<pi-ip>:8090/`.
4. **Gi serveren et fast navn eller en fast IP-adresse** på nettet, for eksempel `dbserver`. Det er
   det kjøreverkene får som `server` i `/etc/hmi-recorder.json`, og det følger med til en ny maskin senere.
5. **Klokka:** `install.sh` har satt den mot NTP-serveren 10.0.0.104, som resten av nettet bruker ([§8](#8-klokka)).
6. **Lag en bruker for deg selv** (`sudo kv-admin user add <navn> --role admin`), og **legg til
   kjøreverkene** på siden *Kjøreverk*, [§4](#4-legge-til-et-kjøreverk).

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
| `web.loginToView` | false | `true`: innlogging også for å se web-siden, ikke bare for å endre |
| `web.sessionDays` | 14 | Hvor lenge en innlogging varer uten bruk |
| `web.maxExports` | 2 | Eksporter som kan lastes ned samtidig; flere får «prøv igjen om litt» |
| `storagePath` | `/var/lib/postgresql` | Disken Oversikt viser ledig plass på (der databasen ligger) |
| `log` | `info` | `debug` gir en linje per batch og per historikkspørsmål |

Etter en endring: `sudo systemctl restart kjoreverk-server`.

## 4. Legge til et kjøreverk

Et kjøreverk settes opp to steder: **på databasemaskinen** registreres det og får en nøkkel, og **på
Pi-en i kjøreverket** får recorderen vite hvem den er, hvor serveren er, og nøkkelen.

```
 Databasemaskinen (denne serveren)                 Pi-en i kjøreverket (hmi-core)
 ─────────────────────────────────                 ──────────────────────────────
 1. Registrer kjøreverket, f.eks. kv52             3. Lag /etc/hmi-recorder.json:
 2. Lag nøkkelen ──────── kopier nøkkelen ──────►     { "vehicle": "kv52",
                                                        "server": "http://dbserver:8090",
                                                        "token": "<nøkkelen>" }
                                                    4. Start recorderen på nytt
 6. «Sender» på Oversikt og Kjøreverk ◄── data ──  5. Loggen: "the central server answers"
```

**Første gang:** lag en bruker med rollen admin, så du kan logge inn på web-siden (se [§6](#6-api-et-og-web-siden)):

```bash
sudo kv-admin user add storm --role admin
```

### 4.1 På databasemaskinen: registrer kjøreverket og lag nøkkelen

**På web-siden:** åpne `http://<databasemaskinen>:8090/#/vehicles` (menyen *Kjøreverk*), logg inn,
og trykk **+ Nytt kjøreverk**:

- **Kode** er det kjøreverket heter på serveren, for eksempel `kv52`. Den må være nøyaktig den samme
  som `"vehicle"` på Pi-en, og den kan ikke endres senere. Bruk gjerne det samme som vertsnavnet til Pi-en.
- **Navn** og **notater** er bare for deg. **Regelsett** bestemmer hva recorderen lagrer ([§5](#5-reglene));
  `default` lagrer alt. **Varsel når det har vært stille** er hvor lenge det kan gå uten data før
  kjøreverket blir rødt på Oversikt.
- Med **Lag nøkkelen med en gang** avkrysset vises nøkkelen etterpå, sammen med den ferdige filen
  til Pi-en og kommandoene, med Kopier-knapper.

**Nøkkelen vises bare én gang.** Serveren lagrer bare et fingeravtrykk (SHA-256) av den, så den kan ikke
hentes fram igjen. Mister du den, trykk **Lag ny nøkkel** på kjøreverket. Den gamle slutter da å
virke med en gang.

**Eller på kommandolinjen** på databasemaskinen:

```bash
sudo kv-admin vehicle add kv52 --name "Kjøreverk 52"
sudo kv-admin vehicle key kv52          # skriver ut nøkkelen, én gang
```

### 4.2 På Pi-en i kjøreverket: oppsettfilen til recorderen

Recorderen (`hmi-core/recorder.js`) leser oppsettet sitt fra den første av disse filene som finnes:

| Fil | Leses |
|---|---|
| `/etc/hmi-recorder.json` | **først. Bruk denne.** |
| `hmi-core/config/recorder.json` | bare hvis filen i `/etc` mangler |
| `hmi-core/config/recorder.example.json` | **aldri.** Den viser bare hvilke innstillinger som finnes |

Finnes ingen av de to første, stopper recorderen med *«The recorder needs the central server's
address …»*, og systemd prøver å starte den igjen hvert 2. sekund. Filen hører hjemme i `/etc` fordi
nøkkelen da ikke ligger i prosjektmappen, der den kunne havne i git, og fordi den blir liggende når
du bytter ut `hmi-core` med en nyere versjon.

1. **Lag filen** (logg inn på Pi-en i kjøreverket, for eksempel med ssh):

   ```bash
   sudo nano /etc/hmi-recorder.json
   ```

   Lim inn, med dine verdier, lagre med Ctrl+O og Enter, og lukk med Ctrl+X:

   ```json
   {
     "vehicle": "kv52",
     "server": "http://dbserver:8090",
     "token": "nøkkelen fra databasemaskinen"
   }
   ```

   | Felt | Hva |
   |---|---|
   | `vehicle` | Koden fra 4.1, nøyaktig lik. Mangler feltet, brukes vertsnavnet til Pi-en |
   | `server` | Adressen Pi-en når databasemaskinen på: `http://` + navnet eller IP-adressen + `:8090`. Det du skriver i nettleseren for å åpne web-siden, virker som regel. Sjekk fra Pi-en med `curl http://dbserver:8090/api/health`; den skal svare `{"ok":true,…}` |
   | `token` | Nøkkelen, hele, uten mellomrom |

   `config/recorder.example.json` i `hmi-core` viser resten av innstillingene (køen i RAM, hvor ofte den
   sender). De trenger du vanligvis ikke.
2. **Bare root og brukeren recorderen kjører som, skal kunne lese den.** Brukeren står i `User=` i
   `kjoreverk@.service`; kommandoen under henter den derfra:

   ```bash
   sudo chown root:"$(systemctl show -p User --value kjoreverk@recorder.service)" /etc/hmi-recorder.json
   ```

   ```bash
   sudo chmod 640 /etc/hmi-recorder.json
   ```

3. **Har du skrevet nøkkelen inn i `recorder.example.json`**, ta den ut igjen, så den ikke havner i git.
   Er `hmi-core` hentet med git, setter dette filen tilbake (i mappen over `hmi-core`):

   ```bash
   git checkout -- hmi-core/config/recorder.example.json
   ```

4. **Start recorderen.** Kjører den allerede som tjeneste:

   ```bash
   sudo systemctl restart kjoreverk@recorder.service
   ```

   Første gang må tjenesten lages. Det står i `README_systemd-service.md` i HMI-prosjektet, avsnittet
   om recorderen. Kort fortalt: `/etc/kjoreverk/instances/recorder.env` med
   `SCRIPT_ARGS=hmi-core/recorder.js`, og `sudo systemctl enable --now kjoreverk@recorder.service`.
   Huben (`kjoreverk@hub.service`) må også kjøre: recorderen sender ingenting før den har fått
   taggene derfra.
5. **Klokka:** recorderen sender ingenting før Pi-ens klokke er synkronisert (den spør `timedatectl`).
   Pi-ene bruker NTP-serveren på nettet, 10.0.0.104 ([§8](#8-klokka)). Har
   serveren svart, men klokka ikke blitt synkronisert innen 10 minutter, sender den likevel, merket.
6. **Sjekk loggen:**

   ```bash
   journalctl -u kjoreverk@recorder.service -n 30 --no-pager
   ```

   Den skal si `the central server answers (http://dbserver:8090)` og
   `Recording rules version … from the central server in use`. På web-siden går statusen til
   **Sender** innen et halvt minutt, og *Kjøreverk* viser IP-adressen det sender fra og recorder-versjonen.

### 4.3 Feilsøking

**I recorderens logg** på Pi-en i kjøreverket (`journalctl -u kjoreverk@recorder.service -n 50 --no-pager`):

| Loggen sier | Hvorfor | Gjør |
|---|---|---|
| `The recorder needs the central server's address, like "server": … in /etc/hmi-recorder.json` | Ingen oppsettfil er lest, for eksempel fordi bare `recorder.example.json` er endret | Lag `/etc/hmi-recorder.json` (4.2) |
| `The recorder's settings in /etc/hmi-recorder.json can't be read: EACCES` | Brukeren recorderen kjører som, kan ikke lese filen | `chown` i 4.2, steg 2 |
| `… can't be read:` fulgt av noe om JSON (`Unexpected token`, `Expected …`) | Filen er ikke gyldig JSON: et komma for mye eller for lite, eller manglende anførselstegn | Sammenlign med eksempelet i 4.2 |
| `the central server can't be reached (connect ECONNREFUSED …)` | Feil port, eller serveren kjører ikke | `curl http://<server>:8090/api/health` fra Pi-en; `systemctl status kjoreverk-server` på databasemaskinen |
| `… (getaddrinfo ENOTFOUND dbserver)` | Pi-en kjenner ikke navnet | Bruk IP-adressen i `server`, eller legg navnet i `/etc/hosts` |
| `… (connect ETIMEDOUT …)` / `no answer in 15 s` | Feil IP-adresse, eller en brannmur | Sjekk adressen; `ping` den |
| `The central server refused this recorder's key for kv52: the key is unknown or has been revoked` | Nøkkelen er feil, ikke kopiert helt, eller en ny er laget siden | Lag en ny nøkkel (4.1) og legg den inn |
| `… the key belongs to kv52, not kv07` | `vehicle` på Pi-en er ikke koden nøkkelen ble laget for | Rett `vehicle`, eller lag nøkkelen for riktig kode |
| `… kv52 is disabled on the server` | Kjøreverket er slått av | Kryss av for *Aktiv* på siden Kjøreverk |
| `the clock isn't synchronized yet (timedatectl): nothing is sent until it is` | Se 4.2, steg 5 | [§8](#8-klokka) |

Etter et avslag på nøkkelen prøver recorderen igjen hvert 5. minutt. Vil du ikke vente, start den på
nytt.

**På databasemaskinen** står hver avviste nøkkel i serverens logg, med IP-adressen til Pi-en som prøvde:

```bash
journalctl -u kjoreverk-server -n 50 --no-pager | grep refused
```

for eksempel `refused POST /hello from 10.0.123.24 (says it is kv52): the key is unknown or has been revoked`.

**Statusen på web-siden:**

| Status | Betyr |
|---|---|
| Ingen nøkkel | Kjøreverket er registrert, men har ingen nøkkel. Lag en |
| Aldri hørt fra | Det har nøkkel, men ingen recorder har koblet til med den. Se recorderens logg |
| Har hilst, ikke sendt | Recorderen kommer gjennom, men har ikke sendt data. De første sekundene er det normalt. Varer det, er klokka på Pi-en ikke synkronisert, eller huben kjører ikke |
| Sender | Siste batch kom for under 90 sekunder siden |
| Venter | Det har sendt før, men ikke de siste 90 sekundene. Recorderen sender hvert 10. sekund, så det varer sjelden |
| Stille | Ingenting på lenger enn grensen for stille-varselet. Pi-en kan være av, uten nett, eller ha stoppet |
| Slått av | *Aktiv* er ikke krysset av: recorderen får 403 |

### 4.4 Endre, bytte nøkkel, slå av, slette

Alt gjøres på siden *Kjøreverk*: klikk på et kjøreverk. Navn, notater, grensen for stille-varselet og
*Aktiv* krever rollen admin. Regelsettet kan også en med rollen rules endre. Et kjøreverk kan bare
slettes så lenge det ikke har lagret data, for eksempel et som ble lagt til med feil kode. Ellers slås
det av.

Det samme på kommandolinjen på databasemaskinen. **Kjør `kv-admin` med sudo:** oppsettfilen har
databaseinnstillingene, så bare root og gruppen `kjoreverk` kan lese den, og PostgreSQL slipper bare inn
OS-brukeren `kjoreverk` som databasebrukeren `kjoreverk`. Med sudo leser `kv-admin` oppsettfilen og
filene du gir den som root, og bytter så til brukeren `kjoreverk` før den kobler til. I loggen står du
likevel som den som gjorde det (`cli:storm@…`). Uten sudo får du `EACCES` på oppsettfilen.

| Kommando (med `sudo` foran) | Gjør |
|---|---|
| `kv-admin vehicle list` | alle kjøreverkene: aktiv, nøkkel, regelsett og versjon, siste batch, data fram til, recorder, klokke |
| `kv-admin vehicle show kv52` | alt om ett, med de siste øktene |
| `kv-admin vehicle key kv52` | en ny nøkkel; den gamle slutter å virke med en gang |
| `kv-admin vehicle revoke kv52` | nøkkelen trekkes tilbake, for eksempel for en Pi som er borte. Recorderen får 403 og prøver igjen hvert 5. minutt |
| `kv-admin vehicle disable kv52` / `enable` | et kjøreverk som ikke skal sende en stund |
| `kv-admin vehicle delete kv52` | sletter et kjøreverk som aldri har lagret data |
| `kv-admin vehicle set kv52 --name … --silent-after 7200 --notes …` | navn, grensen for stille-varselet (sekunder), notater |
| `kv-admin vehicle rules kv52 --set <navn>` | hvilket regelsett det bruker |
| `kv-admin vehicle extra kv52 <fil.json>` / `--none` | tillegget: regler og pauser som går foran settets |
| `kv-admin status`, `kv-admin audit` | serveren i korte trekk, og hvem som gjorde hva |

Alle endringer logges i `audit_log` med hvem (`web:<bruker>` eller `cli:<bruker>@<maskin>`) og når.

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
sudo kv-admin rules list
sudo kv-admin rules show default > regler.json        # rediger
sudo kv-admin rules set default regler.json --note "dødbånd på hastigheten"
sudo kv-admin rules set stille docs/examples/rules-example.json
sudo kv-admin vehicle rules kv07 --set stille
sudo kv-admin rules effective kv07                     # det kv07 får fra GET /rules

# pauser, for eksempel under vedlikehold: alle tagger på kv07 i 2 timer
sudo kv-admin rules pause vehicle:kv07 --tags "*" --minutes 120 --reason "service"
sudo kv-admin rules pause default --tags "kv_1.reals_*" --until 2026-11-01T06:00:00Z
sudo kv-admin rules resume vehicle:kv07 all
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
`web/pages/` med sin del av `/api/web` i `routes/web/`. Grafene tegnes med uPlot fra en lokal kopi
(`node_modules/uplot`, servert på `/vendor/`), så serveren ikke trenger internett. Adressen viser hva
siden står på (`#/trend?s=…&from=…&to=…`), så et søk eller en trend kan bokmerkes og deles.

| Side | Hva |
|---|---|
| **Oversikt** | Alle kjøreverkene: status, siste batch, data fram til, klokke med avvik, recorder-versjon, regelsett, tagger, punkter, hull og alarmer siste døgn. Databasens størrelse, hvor fort den vokser, ledig disk og hvor lenge den rekker, og serverens egen klokke. Et klikk på et kjøreverk viser øktene og hullene |
| **Finn data** | Hvilke kjøreverk har disse dataene? Velg tagger (mønstre, navn fra PLS-en, type, enhet) og tidsrom, og eventuelt en betingelse: *var på*, *over* eller *under en verdi*, *endret seg*, eller *en hendelse med denne teksten*. Svaret er en liste per kjøreverk med antall treff, første og siste gang, og hvor lenge (for *var på*, *over*, *under*). Derfra: trend eller eksport, for ett kjøreverk eller alle |
| **Trend** | Flere kjøreverk og tagger i samme graf (høyst 24). Tall som trinn, én akse per enhet; av/på-signaler som felt i en tidslinje under. Dra for å zoome inn, rull for å zoome rundt pekeren, ◀ ▶ flytter, *Live* følger nå. Hver endring henter punktene på nytt, med finere oppløsning når du zoomer inn |
| **Eksport** | CSV for Excel: verdier, hendelser eller hull. Lang form (én rad per verdi) eller bred (én kolonne per tag), alle verdier eller per minutt/time, `;` og desimalkomma eller `,` og punktum, lokal tid eller UTC, én fil eller én per kjøreverk i en zip. Viser omtrent hvor mange rader det blir før nedlastingen. Strømmes fra databasen, så store uttrekk ikke fyller minnet |
| **Regler** | Rediger regelsettene og tillegget per kjøreverk, regel for regel eller som JSON, med sjekk mens du skriver. Pauser (lagres med en gang). Forhåndsvisning: hva reglene ville lagret for et kjøreverk de siste timene, regnet med regelmotoren fra recorderen. Historikk med hvem, når og hvorfor, og «hent inn» en eldre versjon |
| **Hendelser** | Varsler øverst (stille kjøreverk, klokker som er av). Hendelser og alarmer fra alle kjøreverkene med filtre på kjøreverk, tid, alvorlighet, tekst og kilde. Hull: de recorderne har meldt, og brudd mellom to økter der ingenting kom inn |
| **Kjøreverk** | Legge til, endre navn, notater, regelsett og grensen for stille-varselet, slå av og på, lage og trekke tilbake nøkler, og slette et kjøreverk som aldri har lagret data ([§4](#4-legge-til-et-kjøreverk)) |

**Finn data, slik den regner:** uten betingelse svarer katalogen (`vehicle_tag`) på «har taggen», og
antallet kommer fra sammendragene. *Var på*, *over* og *under* regnes på rådataene: verdien som gjaldt ved
starttidspunktet teller med, og hver verdi gjelder til den neste, så «tid på» er riktig også for et signal
som sjelden endres. Blir det mer enn 2 millioner rader, teller den i stedet minuttene i `sample_1m` der
verdien var over (eller under), og sier fra om det.

### Innlogging og roller

Alle på nettet kan **se** web-siden. For å **endre** noe må du logge inn (øverst til høyre). Hver bruker
har én rolle, og hver rolle kan alt rollene over kan:

| Rolle | Kan |
|---|---|
| `view` | se (og eksportere, når den siden kommer) |
| `rules` | i tillegg velge regelsett for kjøreverkene, og etter hvert endre regler og pauser |
| `admin` | alt: kjøreverk, nøkler og brukere |

Brukerne lages på databasemaskinen:

| Kommando | Gjør |
|---|---|
| `sudo kv-admin user add storm --role admin` | ny bruker; spør etter passordet (minst 8 tegn). Finnes brukeren, får den nytt passord og ny rolle |
| `sudo kv-admin user list` | brukerne, rollen og siste innlogging |
| `sudo kv-admin user remove ola` | sletter brukeren, og logger den ut |

- **Innloggingen varer** i `web.sessionDays` (14) dager etter siste bruk, også etter en omstart av
  serveren. Passordet lagres med scrypt, og cookien har bare et tilfeldig token, som serveren også bare
  har et fingeravtrykk av.
- **Fem feil passord** fra samme maskin på 10 minutter gir en pause, og hvert feil forsøk står i
  serverens logg.
- **Alt som endrer noe**, må komme som JSON fra serverens egen side (sjekket med `Origin`), så en annen
  nettside ikke kan gjøre det for deg. Hver endring står i `audit_log` som `web:<bruker>`
  (`sudo kv-admin audit`).
- **Krev innlogging også for å se:** sett `"web": { "loginToView": true }` i oppsettfilen, og start
  serveren på nytt.
- **Bare det lokale nettet:** siden går over HTTP, så passordet sendes ukryptert på nettet. Ikke gjør
  serveren tilgjengelig utenfra. HTTPS kan legges foran senere (for eksempel med Caddy eller nginx).

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
databasen på nytt med utvidelsen, kjør migreringene (`sudo kv-admin migrate`), og last dataene inn igjen
med `pg_restore --data-only`. Gjør det mens mengden er liten.

**Historikken (`/history`)** velger kilde per tag etter hvor mange rader det blir: rådataene når
timesammendraget anslår færre enn `history.maxRows`, ellers `sample_1m`, ellers `sample_1h`. De siste to
minuttene er alltid rådata, for sammendragene ligger litt etter. Det første punktet er verdien som
gjaldt ved `from`. Er det mer enn 2 × `points` punkter, tynnes de med minste og største per bøtte, i
den rekkefølgen de kom. `null` settes inn der recorderen har meldt et hull og der det er mer enn
`sessionGapSeconds` mellom to økter. Målet er under 1 sekund også for 7 dager; her tok 7 dager med 8
tagger 20–50 ms, men med lite data.

**Hvor mye plass:** oversikten viser størrelsen på databasen og antall punkter per kjøreverk siste
døgn. `sudo kv-admin status` viser det samme. Med TimescaleDB gir `SELECT * FROM hypertable_compression_stats('sample')`
i `psql` hvor mye komprimeringen sparer.

## 8. Klokka

Alle enhetene på nettet bruker **den samme NTP-serveren, 10.0.0.104**: denne serveren, Pi-ene i
kjøreverkene, og gjerne PLS-ene. Da har alle samme tid, og tidene fra kjøreverkene kan sammenlignes
med hverandre og med serveren. Serveren trenger ikke være tidskilde selv.

**På databasemaskinen** setter `deploy/install.sh` dette opp: med `systemd-timesyncd`, som følger med
Raspberry Pi OS, eller med chrony hvis det er installert. En annen adresse: `NTP_SERVER=<adresse> sudo bash
deploy/install.sh`. For hånd:

```bash
sudo mkdir -p /etc/systemd/timesyncd.conf.d
```

```bash
printf '[Time]\nNTP=10.0.0.104\n' | sudo tee /etc/systemd/timesyncd.conf.d/kjoreverk.conf
```

```bash
sudo systemctl restart systemd-timesyncd
```

Sjekk: `timedatectl` skal si `System clock synchronized: yes`, og `timedatectl timesync-status` viser
`Server: 10.0.0.104`. Oversikt på web-siden viser det samme under *Serverens klokke*.

**På Pi-ene i kjøreverkene** er det det samme: `NTP=10.0.0.104` under `[Time]` i
`/etc/systemd/timesyncd.conf` (eller i en fil i `/etc/systemd/timesyncd.conf.d/` som over). Recorderen
sender ingenting før klokka er synkronisert. `README_systemd-service.md` i HMI-prosjektet sier
`NTP=dbserver`, fra da planen var at databasemaskinen skulle være tidskilden. Bruk 10.0.0.104.

**PLS-ene** kan bruke 10.0.0.104 direkte, med den innebygde NTP-klienten (i TIA Portal: egenskapene til
CPU-en, *Time of day*, *Enable time synchronization via NTP server*). Tidene som lagres, kommer fra Pi-en,
så PLS-klokka betyr mest for ringen med historikk (TCP_LINK.md §3.8), der adapteren plasserer postene
etter forskjellen mellom PLS-klokka og Pi-klokka.

- **Pi 5 har en RTC:** sett i batteriet, så tiden overlever et strømbrudd fram til NTP-serveren svarer.
- **Er 10.0.0.104 borte**, går klokkene videre på egen hånd og driver lite. Når den er tilbake, stiller de
  seg. En Pi i et kjøreverk som starter uten batteri på RTC-en og uten NTP-serveren, holder dataene i RAM til
  klokka er synkronisert; svarer serveren, men klokka blir ikke synkronisert innen 10 minutter, sendes de
  likevel, merket at klokka ikke var synkronisert.
- **Serveren følger med:** `clock_obs` har Pi-ens tid mot serverens ved hver forespørsel. Oversikt og
  Hendelser viser kjøreverk med klokke som ikke er synkronisert, eller som er mer enn 2 sekunder av. Lagrede
  tider skrives aldri om, men en klokke som gikk feil, kan rettes senere ut fra dette.

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
`silent_after_s` (2 timer som standard, `sudo kv-admin vehicle set kv07 --silent-after 600`).

## 10. Utvikling og test

```bash
npm install
createdb kjoreverk_test                    # en database bare for testene: skjemaet bygges på nytt hver gang
KV_TEST_DB=postgres://bruker:passord@localhost/kjoreverk_test npm test
```

Testene (`test/*.test.js`, Nodes egen `node:test`) kjører mot en ekte PostgreSQL, med og uten
TimescaleDB: mottaket (idempotens, duplikater, 400/401/403/413/503, gzip, klokkemerket), reglene
(ETag og 304, versjoner, tillegg, feil, pauser), historikken (første punkt, tynning, hull, økter,
sammendragene, punkter i etterkant), innloggingen og rollene på web-siden, Kjøreverk-API-et, og
kommandolinjen.

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
  session.js              innloggingen på web-siden: økter, cookie, roller
  run-as.js               kv-admin med sudo: bytter til brukeren kjoreverk før den kobler til
  ingest.js               mottaket: sjekken av batchen og transaksjonen
  history.js              /history: kildevalg, første punkt, tynning, hull
  rules.js                regelsett, tillegg, versjoner, pauser
  admin.js                kjøreverk, nøkler, brukere
  jobs.js                 sammendragene, slettingen, oppryddingen, størrelsen per døgn
  catalog.js              katalogen: tagmønstre, tidsrom, taggene til velgerne
  find.js                 Finn data: har taggen, var på, over, under, endret seg, hendelse
  export.js, csv.js, zip.js   eksporten: cursor i PostgreSQL, CSV, zip som strømmes
  preview.js              forhåndsvisning av regler med regelmotoren
  storage.js, clock.js    plassen på disken og veksten; serverens klokke
  record-rules.js         kopi av hmi-core sin regelmotor (sjekken av regelsett)
  log.js, errors.js, audit.js
routes/v1.js              /api/v1: hello, rules, ingest, history
routes/web.js             /api/web: innloggingen, og én modul per side i routes/web/
routes/web/               overview, vehicles, find, series (trend), export, events, rules
web/                      web-siden: index.html, shell.js (meny, innlogging), components.js (velgerne), style.css,
                          pages/: overview, find, trend, export, rules, events, vehicles
db/migrations/            skjemaet, nummerert
deploy/                   install.sh, systemd-enhetene, backup.sh, postgresql-oppsettet
docs/                     PLAN.md, PROTOKOLL.md, examples/rules-example.json
test/                     testene, helpers.js og simulate.js
config.example.json       alle innstillingene
```

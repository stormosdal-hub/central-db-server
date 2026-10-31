# Plan: sentral server og database for kjøreverkene

> **Dette er planen dette prosjektet bygges etter.** Den kom fra `hmi-core/docs/SERVER-PLAN.md` i
> prosjektet HMI-user-interface (commit 3c8a0a0) og ligger her som referanse. Hva som er bygd, og hva
> som gjenstår, står i [README.md](../README.md) §Status. [PROTOKOLL.md](PROTOKOLL.md) er
> grensesnittet mot kjøreverkene, og skal være lik i begge prosjektene.
>
> **Pi-siden** står i `hmi-core/docs/PLAN.md` i HMI-user-interface. De viktigste filene der:
> - `lib/record-rules.js`: regelmotoren (kopiert hit som `lib/record-rules.js`)
> - `recorder.js`: det som sender til denne serveren
> - `hub.js`, avsnittet `historyRange`: hvordan HMI-en spør etter historikk
> - `README.md`: hele HMI-en

## Innhold

1. [Bakgrunn](#1-bakgrunn)
2. [Mål](#2-mål)
3. [Beslutningene](#3-beslutningene)
4. [Web-siden](#4-web-siden)
5. [Det som skal bygges, i rekkefølge](#5-det-som-skal-bygges-i-rekkefølge)
6. [Åpne spørsmål](#6-åpne-spørsmål)
7. [Samarbeidet med hmi-core](#7-samarbeidet-med-hmi-core)

---

## 1. Bakgrunn

- **42 kjøreverk.** Hvert har en PLS (Siemens S7-1200) og en Raspberry Pi med hmi-core:
  - `hub.js` holder taggene i RAM.
  - `tcplink-adapter.js` henter dem fra PLS-en.
  - HMI-en kjører i nettleseren.
- **`recorder.js` på hver Pi** sender taggene reglene velger, til denne serveren, i batcher over
  HTTP ([PROTOKOLL.md](PROTOKOLL.md)). Den bygges i hmi-core.
  - **Alt ligger i RAM:** Pi-ene i kjøreverkene skriver aldri til SD-kortet. Er serveren borte
    når strømmen går, er det som ventet, tapt, og det er godtatt.
  - **Den spør også denne serveren** når en trend i HMI-en vil se lenger tilbake enn huben
    husker.
- **Taggene:**
  - **Navn** som `pls.bit03`, `pls.words_0` og `calc.speed`.
  - **Typer:** `boolean`, `number` og `string`, med enhet og et navn fra PLS-en eller brukeren
    (`label`).
  - **Like navn:** kjøreverkene har samme PLS-program, så de fleste tagnavnene er like på tvers.
    Det gjør det mulig å sammenligne og søke på tvers av kjøreverkene.
- **Tidene** kommer fra Pi-klokka, i UTC. Pi-ene og serveren synkroniserer mot den samme tidsserveren ([3.7](#37-klokka)).

## 2. Mål

1. **Ta imot data fra 42 kjøreverk**, lagre hvert punkt én gang, og svare OK først etter COMMIT.
2. **En web-side** for å:
   - styre reglene for hva som lagres
   - vise og eksportere data fra alle kjøreverkene
   - filtrere, så alle kjøreverk som har data av en bestemt type, kommer opp i en liste
3. **Svare på historikkspørsmål** fra HMI-en i kjøreverkene.
4. **Lett å bygge videre på.** Nye funksjoner kommer etter hvert.
5. **Kjører på en Raspberry Pi 5 med 500 GB NVMe nå**, og kan flyttes til en annen maskin senere
   uten at noe endres i kjøreverkene.

## 3. Beslutningene

### 3.1 Programvaren

- **Ingen Docker.** Alt er Debian-pakker og systemd-tjenester.
- **PostgreSQL** fra Debian (15 i Bookworm, 17 i Trixie), **med TimescaleDB.**
  - **Hvorfor:**
    - vanlig SQL
    - tidsserietabeller (hypertables) som deles opp etter tid av seg selv
    - komprimering, ofte 10 ganger eller mer
    - ferdige sammendrag (continuous aggregates) som gjør trender over uker raske
    - automatisk sletting etter alder
    - Grafana kan lese den hvis det blir aktuelt
  - **Sjekk først** om Timescale har pakker for arm64 og den Debian-versjonen Pi-en kjører.
    Ellers bygges utvidelsen fra kildekoden.
  - **Velg utgaven med Timescale License, ikke «OSS»-utgaven:** komprimering og sammendrag
    finnes bare der. Lisensen tillater bruk internt.
  - **Uten TimescaleDB:** vanlig PostgreSQL med en partisjon per måned, BRIN-indeks og egne
    sammendragstabeller. Det går, men er mer arbeid.
- **Node.js (gjeldende LTS) for serveren.** Det er samme språk som hmi-core, så regelmotoren
  `lib/record-rules.js` kan brukes direkte for å sjekke regler og vise hva de ville lagret.
  - **Databasedriver:** `pg`.
  - **HTTP:** Fastify, som sjekker forespørslene mot et skjema og lar hver funksjon være en egen
    modul.
- **Web-siden lages med vanlig HTML, CSS og JavaScript, uten byggesteg**, som HMI-en. Grafene
  lages med et bibliotek fra en lokal kopi, så serveren ikke trenger internett, for eksempel
  uPlot, som er raskt med store tidsserier.
- **Én serverprosess** for API-et og web-siden til å begynne med. Mottaket kan skilles ut
  senere.

### 3.2 Flytting til en annen maskin senere

- **Alt oppsett i én fil**, for eksempel `/etc/kjoreverk-server/config.json`, og alle data i
  PostgreSQL.
- **Å flytte:** installer de samme pakkene, `pg_dump` og `pg_restore` (eller
  `pg_basebackup`), og kopier oppsettfilen. Beskriv det i README fra første dag.
- **Kjøreverkene bruker et navn eller en fast IP-adresse** som følger med til den nye maskinen.
  Da trenger ikke 42 Pi-er nytt oppsett.

### 3.3 Datamodellen

Et utkast; navnene kan endres.

| Tabell | Innhold |
|---|---|
| `vehicle` | `id` (smallint), `code` (`kv_52`, unik), navn, nøkkel (bare hash), aktiv, sist sett, recorder-versjon, om klokka er synkronisert, regelsett og tillegg til regelsettet, notater |
| `tag` | `id`, `name` (unik), felles for alle kjøreverkene |
| `vehicle_tag` | Katalogen: hvilke tagger hvert kjøreverk har, med `data_type`, `unit`, `label`, `description`, først og sist sett, og siste verdi. Grunnlaget for «hvilke kjøreverk har disse dataene» |
| `sample` (hypertable) | `ts` (timestamptz), `vehicle_id`, `tag_id`, `value` (double precision; `null` er et hull), `q`, `src`, `unsynced`. Unik på (`vehicle_id`, `tag_id`, `ts`). Av/på som 0 og 1 |
| `sample_text` (hypertable) | det samme for tekst |
| `event` (hypertable) | hendelser og alarmer: `ts`, `vehicle_id`, kilde, alvorlighetsgrad, melding, `src`. Unik på (`vehicle_id`, `ts`, kilde, melding) |
| `gap` | kjente hull: kjøreverk, fra, til, tagger, grunn |
| `session` | hver oppstart av en recorder: kjøreverk, `boot`, startet, siste batch og løpenummeret i den, versjon |
| `clock_obs` | Pi-ens tid mot serverens tid ved hver batch, så en klokke som har gått feil, kan oppdages og rettes senere |
| `rule_set`, `rule_history` | regelsettene (JSON), versjon, hvem som endret dem og når |
| `app_user`, `audit_log` | innlogging og roller, og hvem som gjorde hva |

**Indekser og komprimering:**
- **Indeks:** (`vehicle_id`, `tag_id`, `ts DESC`) på `sample`.
- **Komprimering:** del etter (`vehicle_id`, `tag_id`) og sorter etter `ts`. Komprimer det som er
  eldre enn 7 dager.

**Sammendrag:** `sample_1m` og `sample_1h` (minste, største, snitt, siste og antall) per
kjøreverk, tag og bøtte. Trender over lange tidsrom og filtrene bruker dem.

**Sletting:**
- **Rådataene** for eksempel etter 1–2 år, som en innstilling.
- **Sammendragene** beholdes lenger.
- **Bestem tallene** når mengdene er kjent.

**Hvor mye plass:**
- **Et grovt overslag:** 42 kjøreverk med i snitt 5 lagrede punkter i sekundet er omtrent 18
  millioner rader i døgnet.
  - **Ukomprimert:** omtrent 1,5 GB i døgnet.
  - **Komprimert:** omtrent 0,1–0,2 GB i døgnet, eller 40–70 GB i året.
- **Med komprimering** holder 500 GB i årevis. Uten holder det i månedsvis.
- **Web-siden viser størrelsen per kjøreverk og hvor fort den vokser**, så reglene kan strammes
  inn i tide.

### 3.4 Mottaket

- **Etter [PROTOKOLL.md](PROTOKOLL.md):** nøkkel per kjøreverk og gzip-pakket JSON.
- **Én transaksjon per batch:**
  - **Katalogen:** oppdater `vehicle_tag`.
  - **Punktene:** kopier dem inn i en midlertidig tabell (`COPY`), og så
    `INSERT … ON CONFLICT DO NOTHING`.
  - **Resten:** hendelser, hull, økt og klokkeobservasjon.
  - **Svar** etter COMMIT.
- **Samme `boot` og `seq` en gang til** gir samme svar, uten å lagre noe på nytt.
- **Mottrykk:** høyst for eksempel 4 batcher lagres samtidig. Ellers svarer serveren 503 med
  `retryAfter`, så 42 kjøreverk som kommer tilbake etter et brudd, ikke velter serveren.
- **Feil i en batch** gir 400 med en forklaring.
- **Nøklene:** lagres bare som hash. De er lange og tilfeldige, så SHA-256 er nok.

### 3.5 Historikk til HMI-en

- **`POST /history`** etter [PROTOKOLL.md](PROTOKOLL.md).
- **Kilden velges etter tidsrommet og antall punkter:** rådata, `sample_1m` eller `sample_1h`.
- **Det første punktet** er verdien som gjaldt ved `from`.
- **Tynning:** minste og største verdi per bøtte. Hver endring i et av/på-signal beholdes så langt
  det går.
- **Mål for svartiden:** under 1 sekund, også for 7 dager. Recorderen gir opp etter 10 sekunder.

### 3.6 Sikkerhet

- **Innlogging på web-siden**, med roller:
  - **Se:** se og eksportere data.
  - **Regler:** endre regler og pauser.
  - **Admin:** kjøreverk, nøkler og brukere.
- **Hver endring av regler og nøkler logges** med hvem og når.
- **Bare på det lokale nettet** til å begynne med. HTTPS kan legges på senere.

### 3.7 Klokka

- **Tidsserveren er NTP-serveren på nettet, `10.0.0.104`.** Serveren synkroniserer mot den med
  `chrony` eller `systemd-timesyncd`. Kjøreverkene synkroniserer mot den samme, hver for seg.
- **Serveren er ikke tidsserver** for kjøreverkene, og trenger ingen GPS.
- **Får et kjøreverk ikke kontakt med tidsserveren når det starter,** sender recorderen punktene
  10 minutter etter at serveren har svart, merket at klokka ikke var synkronisert. Serveren lagrer
  merket.
- **Pi 5 har en RTC.** Sett i batteriet, så tiden overlever et strømbrudd.
- **Lagrede tider skrives aldri om.** `clock_obs` gjør det mulig å regne ut en rettelse senere.

### 3.8 Drift

- **Sikkerhetskopi:** én NVMe-disk er ingen sikkerhetskopi. Ta `pg_dump` hver natt til en annen
  maskin eller en USB-disk (eller bruk pgBackRest), og prøv en gjenoppretting.
- **Strøm:**
  - **PostgreSQL tåler strømbrudd** så lenge `fsync` står på. Slå den aldri av.
  - **En UPS** på serveren er likevel lurt.
- **Varsel** på web-siden når et kjøreverk ikke har sendt noe på en stund, for eksempel 2 timer.
  Grensen settes per kjøreverk.

## 4. Web-siden

Hver side er en egen modul: en rutefil på serveren og en mappe for siden. Et felles skall har
menyen, innloggingen, tidsvelgeren og velgeren for kjøreverk. Da er en ny side lite arbeid.

1. **Oversikt:** alle kjøreverkene, med:
   - sist sett, og om recorderen sender
   - om klokka er synkronisert, og recorder-versjonen
   - mengden data siste døgn
   - nye hull og varsler
2. **Finn data**, den viktigste siden:
   - **Velg hva du leter etter:**
     - **Tagger:** navn, mønster (`pls.bit*`), navnet fra PLS-en, type eller enhet.
     - **Tidsrom.**
     - **En betingelse, om du vil:** *var på*, *over 80*, *endret seg*, *alarm med denne
       teksten*.
   - **Svaret** er en liste over kjøreverkene som har disse dataene (eller der betingelsen
     slo til), med antall treff og når.
   - **Fra listen:** åpne en trend, eller eksporter.
   - **Hvordan:** katalogen (`vehicle_tag`) svarer på *har taggen*, sammendragene på
     betingelsene, og rådataene på detaljene.
3. **Trend og tidslinje:**
   - **Sammenlign:** flere kjøreverk eller tagger i samme graf.
   - **Flytt og zoom** som i HMI-en.
   - **Av/på-signaler** vises som felt, som Timeline.
4. **Eksport:**
   - **CSV**, strømmet, så store uttrekk ikke fyller minnet.
   - **Valgbare skilletegn:** `;` og desimalkomma for norsk Excel, eller `,` og punktum.
   - **Ett ark per kjøreverk,** eller alt i ett.
5. **Regler:**
   - **Rediger regelsettene** i formatet fra [PROTOKOLL.md](PROTOKOLL.md) §7.
   - **Gi kjøreverkene sine regelsett**, og et tillegg per kjøreverk.
   - **Pauser,** for eksempel under vedlikehold.
   - **Forhåndsvisning:** *denne regelen ville gitt så mange punkter siste døgn for kv_52*,
     regnet med regelmotoren på rådataene.
   - **Historikk:** hvem som endret hva.
6. **Hendelser og hull** på tvers av kjøreverkene, med filtre.
7. **Kjøreverk:** registrer et kjøreverk, lag eller trekk tilbake nøkkelen, og se øktene.

## 5. Det som skal bygges, i rekkefølge

1. **Installasjon på Pi 5-en:**
   - PostgreSQL og TimescaleDB.
   - **Skjemaet** som nummererte SQL-filer (migreringer), så samme oppsett kan bygges på en ny
     maskin.
2. **Mottaket (`/hello`, `/ingest`)** etter protokollen.
   - **Et testskript** som later som det er 42 kjøreverk, med brudd og nye forsøk.
   - **Mål hva Pi 5-en tåler.**
3. **Kjøreverk og nøkler:** først på kommandolinjen, siden på web-siden.
4. **`/rules`** og siden for reglene.
5. **`/history`.**
6. **Web-siden:** oversikten, *Finn data*, trend og eksport.
7. **Hendelser, hull og varsler** for kjøreverk som har stilnet.
8. **Klokka:** serveren synkroniserer mot `10.0.0.104`.
9. **Sikkerhetskopi**, og hvordan serveren flyttes, beskrevet og prøvd.

## 6. Åpne spørsmål

- **Hvem skal logge inn, og fra hvor?** Bare fra det lokale nettet?
- **Hvor lenge skal rådataene beholdes?**
- **Andre eksportformater** enn CSV, for eksempel Excel eller Parquet?

## 7. Samarbeidet med hmi-core

- **[PROTOKOLL.md](PROTOKOLL.md) er kontrakten.** Den er lik i begge prosjektene, og har et
  versjonsnummer. Endres den, endres den i begge.
- **Regelformatet** eies av `lib/record-rules.js` i hmi-core. Serveren lagrer og redigerer
  reglene, og bruker den samme filen til å sjekke dem og vise hva de ville lagret: som en kopi
  med versjonen merket, eller lest fra hmi-core-mappen.
- **Testene på hver side** bruker protokollen:
  - **hmi-core:** en falsk server.
  - **Serveren:** et skript som later som det er kjøreverk.

  Når de er ferdige, kjøres recorderen mot den ekte serveren.

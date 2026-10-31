# Protokoll: recorderen i kjøreverkene ↔ den sentrale serveren

> **Versjon 1.** Denne filen finnes i to prosjekter, og skal være lik i begge:
> - `hmi-core/docs/PROTOKOLL.md`: recorderen på Pi-ene ([PLAN.md](PLAN.md)).
> - Serverprosjektet: mottaket, databasen og web-siden ([SERVER-PLAN.md](SERVER-PLAN.md)).
>
> Endres den, endres den i begge samtidig. Nye felt som den andre siden kan overse, krever ingen
> ny versjon. Alt annet gir versjon 2.

## Innhold

1. [Generelt](#1-generelt)
2. [Feil og nye forsøk](#2-feil-og-nye-forsøk)
3. [POST /hello](#3-post-hello)
4. [GET /rules](#4-get-rules)
5. [POST /ingest](#5-post-ingest)
6. [POST /history](#6-post-history)
7. [Regelformatet](#7-regelformatet)

---

## 1. Generelt

- **HTTP/1.1 og JSON** (UTF-8), under `http://<server>:<port>/api/v1`. Porten står i serverens
  oppsett. 8090 er utgangspunktet.
- **Komprimering:** en forespørsel kan sendes med `Content-Encoding: gzip`, og serveren tar imot
  begge deler. Recorderen pakker alt over 4 kB. Et svar kan pakkes hvis forespørselen sa
  `Accept-Encoding: gzip`.
- **Nøkkel:** `Authorization: Bearer <nøkkel>`. Hvert kjøreverk har sin egen nøkkel, laget på
  serverens web-side. Feltet `vehicle` i forespørselen må høre til nøkkelen.
- **Tider** er heltall, millisekunder siden 1970-01-01 UTC.
- **Kjøreverkets id** (`vehicle`) er en kort tekst, for eksempel `kv_52`. Pi-en har den i
  `/etc/kjoreverk/vehicle`, og den er også kilden i hendelsene fra kjøreverket.
- **Verdier:**
  - **Tall og av/på** er tall. Av/på er `1` og `0`, som i huben.
  - **Tekst** sendes for seg, i `text`.
  - **`null`** betyr ingen verdi: enheten var frakoblet, eller kvaliteten var dårlig. En trend
    viser et hull der.
- **Kvalitet** (`q`): 0 god (kan utelates), 1 usikker, 2 dårlig (enheten er frakoblet, eller
  verdien er foreldet), 3 pauset. Pauset er et merke der en pause begynner, med `null` som
  verdi.
- **Kilde** (`src`): 0 sanntid (kan utelates), 1 fra ringen i PLS-en, 2 fylt inn fra hubens
  minne etter en omstart.

## 2. Feil og nye forsøk

Et feilsvar har alltid `{ "error": "tekst" }`.

| Status | Betyr | Recorderen gjør |
|---|---|---|
| 200 | OK. For `/ingest`: lagret og COMMIT-et | tar batchen ut av køen |
| 304 | Uendret (`/rules` med `If-None-Match`) | beholder reglene den har |
| 400 | Forespørselen er feil og blir aldri godtatt | logger feilen, kaster batchen og melder et hull med grunnen `rejected` i neste batch |
| 401 / 403 | Nøkkelen mangler, er feil eller trukket tilbake | beholder køen, prøver igjen hvert 5. minutt, og viser det i `rec.server` |
| 413 | For stor | deler batchen i to og prøver igjen |
| 429 / 503 | Opptatt | venter `retryAfter` sekunder (fra svaret eller `Retry-After`), så samme batch igjen |
| 5xx, tidsavbrudd, ingen forbindelse | | samme batch igjen etter 2, 4, 8 … høyst 60 sekunder |

- **Én batch om gangen, i rekkefølge.** Recorderen sender aldri to batcher samtidig.
- **Tidsavbrudd:** 30 sekunder for `/ingest`, 10 sekunder for `/history`.

## 3. POST /hello

Sendes når recorderen starter, og hver gang serveren svarer etter å ha vært utilgjengelig.

```json
{
  "protocol": 1,
  "vehicle": "kv_52",
  "boot": "3f2b9c1e-…",
  "recorder": "1.0.0",
  "clock": { "synced": true, "piTime": 1793268000000 }
}
```

- `boot`: en tilfeldig id per oppstart av recorderen.
- `clock.piTime`: Pi-ens klokke da forespørselen ble sendt.

**Svar:**

```json
{
  "serverTime": 1793268000412,
  "rulesVersion": 12,
  "lastTs": 1793267940000,
  "maxBatchBytes": 5000000
}
```

- `lastTs`: nyeste tidspunkt serveren har data fra for dette kjøreverket, eller `null`.
  Recorderen fyller hullet etter det fra hubens minne (med `src` 2).
- `maxBatchBytes`: største batch, pakket ut.
- **Ukjent `protocol`:** svaret er 400, med en tekst som sier hvilke versjoner serveren kan.

## 4. GET /rules

`GET /api/v1/rules?vehicle=kv_52`, med `If-None-Match: "12"` hvis recorderen har reglene fra før.

**Svar** (med `ETag: "12"`):

```json
{
  "version": 12,
  "recording": {
    "events": true,
    "eventsMin": "info",
    "rules": [ { "tags": "pls.spare*", "mode": "ignore" } ],
    "pauses": []
  }
}
```

- `recording` er det ferdige regelsettet for dette kjøreverket: tillegget for kjøreverket først,
  så det felles. Se [7](#7-regelformatet).
- **Når hentes reglene:** når `rulesVersion` i et svar fra `/hello` eller `/ingest` er en annen
  enn den recorderen har.

## 5. POST /ingest

```json
{
  "vehicle": "kv_52",
  "boot": "3f2b9c1e-…",
  "seq": 41,
  "clock": { "synced": true, "piTime": 1793268010000 },
  "tags": [
    { "name": "pls.bit03", "dataType": "boolean", "unit": "", "label": "Nødstopp OK", "description": "" }
  ],
  "series": {
    "pls.bit03": [[1793268001200, 1], [1793268004410, 0]],
    "pls.speed": [[1793268001000, 12.5], [1793268002000, null, 2]],
    "pls.words_0": [[1793267000000, 7, 0, 1]]
  },
  "text": {
    "pls.state": [[1793268003000, "running"]]
  },
  "events": [
    { "ts": 1793268002500, "source": "kv_52", "severity": "alarm", "message": "Feil (ZSW1)", "src": 0 }
  ],
  "gaps": [
    { "from": 1793260000000, "to": 1793261000000, "tags": "*", "reason": "queue-full" }
  ]
}
```

- `seq`: løpenummer per `boot`, fra 1. En ny batch får neste nummer. Et nytt forsøk med samme
  batch har samme nummer.
- `clock.synced: false`: Pi-klokka var ikke synkronisert da punktene ble tatt. Serveren lagrer
  merket for hvert punkt i batchen.
- `tags`: tagoversikten. Den sendes i første batch etter `/hello`, og når huben melder nye eller
  endrede tagger. Ellers kan den utelates.
- **Et punkt** er `[ts, verdi, q, src]`, der `q` og `src` kan utelates når de er 0.
- `gaps` er hull recorderen vet om:
  - **Grunner:** `queue-full`, `rejected` og `paused`.
  - **`tags`:** `"*"` eller en liste med navn.
- **Felt uten innhold** kan utelates.

**Serveren:**
- **Alt i én transaksjon**, og svarer først etter COMMIT.
- **Hvert punkt lagres én gang**, med nøkkelen kjøreverk, tag og tid. Finnes det fra før, beholdes
  det som er der.
- **Hver hendelse lagres én gang**, med nøkkelen kjøreverk, tid, kilde og melding. Recorderen
  kan sende den samme to ganger etter en omstart.
- **Et nytt forsøk med samme `boot` og `seq`** gir samme svar, uten å lagre noe på nytt.

**Svar:**

```json
{ "ok": true, "seq": 41, "stored": 3120, "duplicates": 0, "rulesVersion": 12, "lastTs": 1793268004410 }
```

## 6. POST /history

Recorderen spør på vegne av HMI-en: en trend, en Timeline eller en tidsstripe. Spørsmålet er det
samme som `historyRange` i huben.

```json
{ "vehicle": "kv_52", "tags": ["pls.bit03", "pls.speed"], "from": 1793180000000, "to": 1793268000000, "points": 1500 }
```

- Høyst 8 tagger per spørsmål, som i huben.

**Svar:**

```json
{
  "series": { "pls.bit03": [[1793180000000, 1], [1793190000000, 0]], "pls.speed": [] },
  "unrecorded": ["pls.speed"],
  "ms": 84
}
```

- **Det første punktet** er verdien som gjaldt ved `from`, satt til `from`, slik huben gjør.
  Timeline og tidsstripen trenger den.
- **`null`** er et hull: et kjent hull, eller tid uten data mellom to økter.
- **Tynning:** er det mer enn `2 × points` punkter, tynnes de med minste og største verdi per
  bøtte, så topper og korte pulser ikke forsvinner. Av/på-signaler beholder hver endring så langt
  det går.
- `unrecorded`: tagger serveren aldri har lagret for dette kjøreverket. Huben viser hubens eget
  minne for dem.
- **Svartid:** helst under 1 sekund, også for 7 dager. Recorderen gir opp etter 10 sekunder.

## 7. Regelformatet

Formatet er det `lib/record-rules.js` i hmi-core leser. Den filen er fasiten. Serveren lagrer og
redigerer det, og kan bruke den samme filen for å sjekke et regelsett, og for å vise hva en regel
ville lagret.

```json
{
  "events": true,
  "eventsMin": "info",
  "rules": [
    { "tags": "pls.spare*", "mode": "ignore" },
    { "tags": "pls.reals_0, pls.reals_1", "deadband": "1%", "minInterval": 1, "maxInterval": 60 },
    { "tags": "pls.words_2", "ignoreBits": "8, 10" },
    { "tags": "pls.ints_1", "mode": "interval", "every": 60 },
    { "tags": "pls.bit0*", "flickerChanges": 6, "flickerSeconds": 2 },
    { "tags": "*" }
  ],
  "pauses": [
    { "id": "k3f9a", "tags": "*", "since": 1793260000000, "until": 1793263600000, "reason": "maintenance" }
  ]
}
```

- **Første regel som treffer, gjelder.** En tag ingen regel treffer, lagres ikke.
- **`${pls}` i et mønster** byttes ut på Pi-en med prosjektets variabler (`vars` i `hmi.json`).
  Det samme regelsettet virker da også der enhetene heter forskjellig.
- **Tider i `pauses`** er millisekunder i UTC, ikke tekst. Den gamle regelfilen hadde lokal tid
  som tekst. `until: null` betyr til pausen oppheves.
- **`eventsMin`:** laveste alvorlighetsgrad som sendes (`info`, `warning` eller `alarm`). Den er
  ny i forhold til den gamle regelfilen.

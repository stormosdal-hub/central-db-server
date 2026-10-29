-- 001_init.sql: skjemaet for den sentrale serveren (docs/PLAN.md §3.3).
--
-- Kjøres av lib/db.js (kv-admin migrate), i én transaksjon. Tidsserietabellene blir hypertables når
-- TimescaleDB er installert i databasen (CREATE EXTENSION gjøres av install.sh, som superbruker);
-- ellers blir de vanlige tabeller med en BRIN-indeks på tiden, så det samme skjemaet virker begge steder.

-- ---------------------------------------------------------------- reglene
-- Ett løpenummer for alle regelendringer. Et kjøreverks regelversjon er den største av regelsettets
-- og kjøreverkets egen, så en endring i tillegget for kv07 bare får kv07 til å hente reglene på nytt.
CREATE SEQUENCE rules_version_seq START 1;

CREATE TABLE rule_set (
  id          serial PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  recording   jsonb NOT NULL,                                   -- PROTOKOLL.md §7, sjekket med record-rules.js
  version     bigint NOT NULL DEFAULT nextval('rules_version_seq'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT ''
);
-- standardsettet: alt lagres ved hver endring, til noen lager regler
INSERT INTO rule_set (id, name, recording, updated_by)
  VALUES (1, 'default', '{"events": true, "eventsMin": "info", "rules": [{"tags": "*", "mode": "change"}], "pauses": []}', 'migration');
SELECT setval('rule_set_id_seq', 1);

-- ---------------------------------------------------------------- kjøreverkene
CREATE TABLE vehicle (
  id              smallserial PRIMARY KEY,
  code            text UNIQUE NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),   -- 'kv07'
  name            text NOT NULL DEFAULT '',
  key_hash        bytea UNIQUE,                                 -- SHA-256 av nøkkelen; null = ingen nøkkel
  key_prefix      text,                                         -- de første tegnene, for å kjenne den igjen
  key_made_at     timestamptz,
  active          boolean NOT NULL DEFAULT true,
  rule_set_id     integer NOT NULL DEFAULT 1 REFERENCES rule_set(id),
  rule_extra      jsonb,                                        -- tillegget for dette kjøreverket: regler og pauser som går foran settet
  rules_version   bigint NOT NULL DEFAULT 0,
  silent_after_s  integer NOT NULL DEFAULT 7200,                -- varsel når ingenting er kommet på så lenge
  notes           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- sist sett
  last_seen       timestamptz,                                  -- siste forespørsel av noe slag
  last_batch_at   timestamptz,                                  -- siste batch som ble lagret
  last_ts         timestamptz,                                  -- nyeste tidspunkt det finnes data fra (lastTs i /hello)
  recorder_version text,
  clock_synced    boolean,
  clock_offset_ms integer                                       -- Pi-klokka minus serverklokka ved siste forespørsel
);

CREATE TABLE rule_history (
  id          bigserial PRIMARY KEY,
  rule_set_id integer REFERENCES rule_set(id),                  -- enten et regelsett ...
  vehicle_id  smallint REFERENCES vehicle(id),                  -- ... eller tillegget til et kjøreverk
  version     bigint NOT NULL,
  recording   jsonb,                                            -- null: tillegget ble fjernet
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT ''
);
CREATE INDEX rule_history_set ON rule_history (rule_set_id, changed_at DESC);
CREATE INDEX rule_history_vehicle ON rule_history (vehicle_id, changed_at DESC);

-- ---------------------------------------------------------------- taggene
CREATE TABLE tag (
  id    serial PRIMARY KEY,
  name  text UNIQUE NOT NULL                                    -- 'kv_1.bit03', felles for alle kjøreverkene
);

-- katalogen: hvilke tagger hvert kjøreverk har. Grunnlaget for «hvilke kjøreverk har disse dataene»
CREATE TABLE vehicle_tag (
  vehicle_id  smallint NOT NULL REFERENCES vehicle(id),
  tag_id      integer NOT NULL REFERENCES tag(id),
  data_type   text NOT NULL DEFAULT 'number',                   -- boolean, number, string
  unit        text NOT NULL DEFAULT '',
  label       text NOT NULL DEFAULT '',                         -- navnet fra PLS-en eller brukeren
  description text NOT NULL DEFAULT '',
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz,
  last_ts     timestamptz,                                      -- siste verdi
  last_value  double precision,
  last_text   text,
  PRIMARY KEY (vehicle_id, tag_id)
);
CREATE INDEX vehicle_tag_tag ON vehicle_tag (tag_id);

-- ---------------------------------------------------------------- øktene og batchene
-- hver oppstart av en recorder; tiden mellom to økter uten data er et hull
CREATE TABLE session (
  id               bigserial PRIMARY KEY,
  vehicle_id       smallint NOT NULL REFERENCES vehicle(id),
  boot             text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_batch_at    timestamptz,
  last_seq         integer NOT NULL DEFAULT 0,
  batches          integer NOT NULL DEFAULT 0,
  points           bigint NOT NULL DEFAULT 0,
  first_ts         timestamptz,                                 -- sanntidspunktene (src 0) i økten
  last_ts          timestamptz,
  recorder_version text,
  clock_synced     boolean,
  UNIQUE (vehicle_id, boot)
);
CREATE INDEX session_vehicle ON session (vehicle_id, started_at DESC);

-- svaret på hver batch, så et nytt forsøk med samme boot og seq får samme svar uten å lagre noe på nytt
CREATE TABLE batch (
  session_id  bigint NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  response    jsonb NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX batch_received ON batch (received_at);

-- ---------------------------------------------------------------- dataene
CREATE TABLE sample (
  ts          timestamptz NOT NULL,
  value       double precision,                                 -- null er et hull; av/på som 0 og 1
  tag_id      integer NOT NULL,
  vehicle_id  smallint NOT NULL,
  q           smallint NOT NULL DEFAULT 0,                      -- 0 god, 1 usikker, 2 dårlig, 3 pauset
  src         smallint NOT NULL DEFAULT 0,                      -- 0 sanntid, 1 ringen i PLS-en, 2 hubens minne
  unsynced    boolean NOT NULL DEFAULT false,                   -- Pi-klokka var ikke synkronisert
  PRIMARY KEY (vehicle_id, tag_id, ts)
);

CREATE TABLE sample_text (
  ts          timestamptz NOT NULL,
  value       text,
  tag_id      integer NOT NULL,
  vehicle_id  smallint NOT NULL,
  q           smallint NOT NULL DEFAULT 0,
  src         smallint NOT NULL DEFAULT 0,
  unsynced    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (vehicle_id, tag_id, ts)
);

CREATE TABLE event (
  ts          timestamptz NOT NULL,
  vehicle_id  smallint NOT NULL,
  source      text NOT NULL DEFAULT '',
  severity    text NOT NULL DEFAULT 'info',                     -- info, warning, alarm
  message     text NOT NULL,
  src         smallint NOT NULL DEFAULT 0,
  unsynced    boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX event_uniq ON event (vehicle_id, ts, source, md5(message));
CREATE INDEX event_severity ON event (severity, ts DESC);

-- kjente hull: det recorderen melder (queue-full, rejected, paused)
CREATE TABLE gap (
  id          bigserial PRIMARY KEY,
  vehicle_id  smallint NOT NULL REFERENCES vehicle(id),
  session_id  bigint REFERENCES session(id) ON DELETE SET NULL,
  from_ts     timestamptz NOT NULL,
  to_ts       timestamptz NOT NULL,
  tags        text[],                                           -- null: alle tagger
  reason      text NOT NULL DEFAULT '',
  reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gap_vehicle ON gap (vehicle_id, from_ts);
CREATE INDEX gap_reported ON gap (reported_at);

-- Pi-ens tid mot serverens ved hver forespørsel, så en klokke som har gått feil, kan oppdages og rettes senere
CREATE TABLE clock_obs (
  ts          timestamptz NOT NULL DEFAULT now(),
  vehicle_id  smallint NOT NULL,
  session_id  bigint,
  pi_time     timestamptz NOT NULL,
  offset_ms   integer NOT NULL,                                 -- Pi minus server
  synced      boolean NOT NULL
);
CREATE INDEX clock_obs_vehicle ON clock_obs (vehicle_id, ts);

-- ---------------------------------------------------------------- sammendragene
-- Fylles av serveren (lib/jobs.js) fra rollup_dirty, likt med og uten TimescaleDB. Trender over lange
-- tidsrom og filtrene på web-siden leser dem. vfirst og vlast tar med null, så et hull i slutten av
-- en bøtte synes.
CREATE TABLE sample_1m (
  bucket      timestamptz NOT NULL,
  vehicle_id  smallint NOT NULL,
  tag_id      integer NOT NULL,
  n           integer NOT NULL,                                 -- verdier (uten null)
  nnull       integer NOT NULL,
  vmin        double precision,
  vmax        double precision,
  vsum        double precision,
  vfirst      double precision,
  vlast       double precision,
  PRIMARY KEY (vehicle_id, tag_id, bucket)
);
CREATE TABLE sample_1h (LIKE sample_1m INCLUDING ALL);

-- tidsrom med nye punkter som sammendragene ikke har tatt med ennå
CREATE TABLE rollup_dirty (
  id          bigserial PRIMARY KEY,
  vehicle_id  smallint NOT NULL,
  from_ts     timestamptz NOT NULL,
  to_ts       timestamptz NOT NULL
);

-- ---------------------------------------------------------------- web-siden
CREATE TABLE app_user (
  id          serial PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  pw_hash     text NOT NULL,                                    -- scrypt, se lib/admin.js
  role        text NOT NULL CHECK (role IN ('view', 'rules', 'admin')),
  disabled    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  who     text NOT NULL,                                        -- 'web:ola', 'cli:root'
  action  text NOT NULL,                                        -- 'vehicle.key', 'rules.set', ...
  target  text NOT NULL DEFAULT '',
  details jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

CREATE TABLE setting (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- ---------------------------------------------------------------- TimescaleDB, når den finnes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('sample',      'ts',     chunk_time_interval => INTERVAL '1 day');
    PERFORM create_hypertable('sample_text', 'ts',     chunk_time_interval => INTERVAL '7 days');
    PERFORM create_hypertable('event',       'ts',     chunk_time_interval => INTERVAL '7 days');
    PERFORM create_hypertable('sample_1m',   'bucket', chunk_time_interval => INTERVAL '7 days');
    PERFORM create_hypertable('sample_1h',   'bucket', chunk_time_interval => INTERVAL '30 days');

    -- komprimering: del etter kjøreverk og tag, sorter etter tid; det som er eldre enn 7 dager
    ALTER TABLE sample SET (timescaledb.compress, timescaledb.compress_segmentby = 'vehicle_id, tag_id', timescaledb.compress_orderby = 'ts');
    PERFORM add_compression_policy('sample', INTERVAL '7 days');
    ALTER TABLE sample_text SET (timescaledb.compress, timescaledb.compress_segmentby = 'vehicle_id, tag_id', timescaledb.compress_orderby = 'ts');
    PERFORM add_compression_policy('sample_text', INTERVAL '7 days');
    ALTER TABLE event SET (timescaledb.compress, timescaledb.compress_segmentby = 'vehicle_id', timescaledb.compress_orderby = 'ts');
    PERFORM add_compression_policy('event', INTERVAL '30 days');
    ALTER TABLE sample_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'vehicle_id, tag_id', timescaledb.compress_orderby = 'bucket');
    PERFORM add_compression_policy('sample_1m', INTERVAL '30 days');
    ALTER TABLE sample_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'vehicle_id, tag_id', timescaledb.compress_orderby = 'bucket');
    PERFORM add_compression_policy('sample_1h', INTERVAL '90 days');
  ELSE
    -- uten TimescaleDB: BRIN på tiden, så sletting etter alder og spørsmål på tvers av kjøreverkene har en indeks
    CREATE INDEX sample_ts_brin ON sample USING brin (ts);
    CREATE INDEX sample_text_ts_brin ON sample_text USING brin (ts);
    CREATE INDEX event_ts_brin ON event USING brin (ts);
    CREATE INDEX sample_1m_bucket_brin ON sample_1m USING brin (bucket);
    CREATE INDEX sample_1h_bucket_brin ON sample_1h USING brin (bucket);
  END IF;
END $$;

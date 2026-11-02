-- 006_dashboard.sql: visningene på Kjøreverk-database (web-siden): widgeter på et lerret, som i HMI-en.
-- config er hele oppsettet (lerretet, tidsrommet og widgetene med dataene sine), slik web-siden lager det.
-- version øker for hver lagring, så to som redigerer samme visning, ikke skriver over hverandre uten å vite det.
CREATE TABLE dashboard (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}',
  version     integer NOT NULL DEFAULT 1,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dashboard_name ON dashboard (lower(name));

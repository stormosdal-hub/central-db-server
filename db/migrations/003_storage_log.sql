-- 003_storage_log.sql: databasens størrelse per døgn, så Oversikt kan vise hvor fort den vokser og hvor lenge
-- disken rekker (docs/PLAN.md §3.3: «så reglene kan strammes inn i tide»). Fylles av lib/jobs.js.
CREATE TABLE storage_log (
  day    date PRIMARY KEY,
  bytes  bigint NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);

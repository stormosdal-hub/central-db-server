-- 004_vehicle_refused.sql: siste gang serveren avviste et kjøreverk, og hvorfor, så web-siden kan vise det
-- (for eksempel «the key belongs to kv52, not kv_52» når navnet på Pi-en ikke er likt koden her).
ALTER TABLE vehicle ADD COLUMN last_refused_at timestamptz;
ALTER TABLE vehicle ADD COLUMN last_refused_reason text;
ALTER TABLE vehicle ADD COLUMN last_refused_ip text;

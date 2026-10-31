-- 005_vehicle_code.sql: koden er kjøreverkets navn på Pi-en, så den følger samme regel som hmi-core (VEHICLE_RX i
-- lib/vehicle.js, og install.sh): en bokstav eller _ først. Før kunne den begynne med et siffer, og det godtar Pi-en
-- aldri. Finnes det kjøreverk med en slik kode fra før, blir den gamle sjekken stående, så serveren og kv-admin
-- starter som før, og en advarsel står i PostgreSQL-loggen: gi dem en ny kode med kv-admin vehicle rename.
-- lib/admin.js godtar uansett bare den nye regelen for nye og endrede koder.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM vehicle WHERE code !~ '^[A-Za-z_][A-Za-z0-9_.-]{0,31}$') THEN
    RAISE WARNING 'vehicle codes the Pi can''t use: %; give them a new code with kv-admin vehicle rename',
      (SELECT string_agg(code, ', ') FROM vehicle WHERE code !~ '^[A-Za-z_][A-Za-z0-9_.-]{0,31}$');
  ELSE
    ALTER TABLE vehicle DROP CONSTRAINT IF EXISTS vehicle_code_check;
    ALTER TABLE vehicle ADD CONSTRAINT vehicle_code_check CHECK (code ~ '^[A-Za-z_][A-Za-z0-9_.-]{0,31}$');
  END IF;
END $$;

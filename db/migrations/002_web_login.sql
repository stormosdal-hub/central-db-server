-- 002_web_login.sql: innloggingen på web-siden (docs/PLAN.md §3.6), og hvor et kjøreverk sist sendte fra.

-- en innlogget nettleser: cookien har tokenet, tabellen bare SHA-256 av det
CREATE TABLE web_session (
  token_hash  bytea PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  ip          text
);
CREATE INDEX web_session_expires ON web_session (expires_at);

-- IP-adressen til Pi-en i kjøreverket ved siste forespørsel, så Kjøreverk-siden viser hvor den står
ALTER TABLE vehicle ADD COLUMN last_ip text;

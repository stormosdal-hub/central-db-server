#!/bin/bash
# deploy/install.sh - setter opp den sentrale serveren på en Raspberry Pi 5 (Debian/Raspberry Pi OS, arm64).
#
#   sudo bash deploy/install.sh
#
# Gjør dette, og kan kjøres flere ganger:
#   1. PostgreSQL fra Debian, og TimescaleDB fra Timescales pakkebrønn når den finnes for denne Debian-utgaven
#      og PostgreSQL-versjonen. Finnes den ikke, går alt videre uten (vanlige tabeller, se README).
#   2. Databasebrukeren kjoreverk og databasen kjoreverk, med utvidelsen timescaledb (som superbruker).
#   3. Kopierer programmet til /opt/kjoreverk-server, installerer avhengighetene, og lager
#      /etc/kjoreverk-server/config.json hvis den mangler.
#   4. systemd-tjenesten kjoreverk-server, og sikkerhetskopien (deploy/backup.sh) hver natt.
#   5. Kjører migreringene.
#   6. Klokka: synkroniserer mot NTP-serveren på nettet, den samme som kjøreverkene bruker
#      (NTP_SERVER=10.0.0.104 som standard; NTP_SERVER=none lar klokka være som den er).
# Node.js (LTS) må være installert fra før: https://github.com/nodesource/distributions, eller README.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/kjoreverk-server
CONF_DIR=/etc/kjoreverk-server
DB=kjoreverk
DB_USER=kjoreverk
SVC_USER=kjoreverk
NO_TIMESCALE=${NO_TIMESCALE:-0}
NTP_SERVER=${NTP_SERVER:-10.0.0.104}

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
command -v node >/dev/null || die "Node.js is missing: install the current LTS first (see README)"
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) is too old: the server needs 20 or newer"

# ---------------------------------------------------------------- 1. PostgreSQL og TimescaleDB
say "PostgreSQL"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql postgresql-client gnupg curl lsb-release >/dev/null
PG_MAJOR=$(pg_lsclusters -h | awk '{print $1; exit}')
[ -n "$PG_MAJOR" ] || die "no PostgreSQL cluster found after installing postgresql"
CODENAME=$(lsb_release -cs)
echo "PostgreSQL $PG_MAJOR on Debian $CODENAME ($(dpkg --print-architecture))"

if [ "$NO_TIMESCALE" != 1 ]; then
  say "TimescaleDB"
  if [ ! -f /etc/apt/sources.list.d/timescaledb.list ]; then
    echo "deb https://packagecloud.io/timescale/timescaledb/debian/ $CODENAME main" > /etc/apt/sources.list.d/timescaledb.list
    curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg
    apt-get update -qq || true
  fi
  if apt-cache show "timescaledb-2-postgresql-$PG_MAJOR" >/dev/null 2>&1; then
    apt-get install -y -qq "timescaledb-2-postgresql-$PG_MAJOR" >/dev/null
    # timescaledb-tune setter shared_preload_libraries og minneinnstillingene etter maskinen
    if command -v timescaledb-tune >/dev/null; then timescaledb-tune --quiet --yes --pg-config "/usr/lib/postgresql/$PG_MAJOR/bin/pg_config" >/dev/null || true; fi
    systemctl restart postgresql
    echo "TimescaleDB installed for PostgreSQL $PG_MAJOR"
  else
    echo "WARNING: no TimescaleDB package for PostgreSQL $PG_MAJOR on Debian $CODENAME ($(dpkg --print-architecture))."
    echo "         Going on without it: plain tables, no compression. See README §Databasen for the options."
  fi
fi

# innstillinger for NVMe og en Pi 5 med 8 GB; timescaledb-tune kan ha satt noen av dem, denne filen leses sist
CONF_D=/etc/postgresql/$PG_MAJOR/main/conf.d
mkdir -p "$CONF_D"
if [ ! -f "$CONF_D/kjoreverk.conf" ]; then
  cp "$HERE/deploy/postgresql-kjoreverk.conf" "$CONF_D/kjoreverk.conf"
  systemctl restart postgresql
fi

# ---------------------------------------------------------------- 2. brukeren og databasen
say "the database $DB"
if ! id "$SVC_USER" >/dev/null 2>&1; then useradd --system --home-dir "$APP" --shell /usr/sbin/nologin "$SVC_USER"; fi
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'\"" | grep -q 1 || su postgres -c "createuser $DB_USER"
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = '$DB'\"" | grep -q 1 || su postgres -c "createdb -O $DB_USER $DB"
if su postgres -c "psql -tAc \"SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'\"" | grep -q 1; then
  su postgres -c "psql -d $DB -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'" >/dev/null
  echo "extension timescaledb is in $DB"
fi
# tjenesten kobler til over unix-socket som brukeren kjoreverk (peer), uten passord

# ---------------------------------------------------------------- 3. programmet
say "the program in $APP"
mkdir -p "$APP"
rsync -a --delete --exclude node_modules --exclude .git --exclude config.json "$HERE/" "$APP/" 2>/dev/null || cp -r "$HERE/." "$APP/"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null
chown -R "$SVC_USER:$SVC_USER" "$APP"
mkdir -p "$CONF_DIR"
if [ ! -f "$CONF_DIR/config.json" ]; then
  cp "$HERE/config.example.json" "$CONF_DIR/config.json"
  echo "wrote $CONF_DIR/config.json from config.example.json; look through it"
fi
chown root:"$SVC_USER" "$CONF_DIR/config.json"; chmod 640 "$CONF_DIR/config.json"
ln -sf "$APP/bin/kv-admin.js" /usr/local/bin/kv-admin

# ---------------------------------------------------------------- 4. tjenestene
say "systemd"
install -m 644 "$HERE/deploy/kjoreverk-server.service" /etc/systemd/system/kjoreverk-server.service
install -m 644 "$HERE/deploy/kjoreverk-backup.service" /etc/systemd/system/kjoreverk-backup.service
install -m 644 "$HERE/deploy/kjoreverk-backup.timer" /etc/systemd/system/kjoreverk-backup.timer
install -m 755 "$HERE/deploy/backup.sh" /usr/local/sbin/kjoreverk-backup
mkdir -p /var/backups/kjoreverk && chown postgres:postgres /var/backups/kjoreverk
systemctl daemon-reload

# ---------------------------------------------------------------- klokka
# Alle enhetene på nettet bruker samme NTP-server, så tidene på serveren og i kjøreverkene kan sammenlignes.
if [ "$NTP_SERVER" != none ]; then
  say "the clock: NTP from $NTP_SERVER"
  if systemctl is-active --quiet chrony 2>/dev/null; then
    mkdir -p /etc/chrony/conf.d
    echo "server $NTP_SERVER iburst prefer" > /etc/chrony/conf.d/kjoreverk.conf
    systemctl restart chrony
  else
    mkdir -p /etc/systemd/timesyncd.conf.d
    printf '[Time]\nNTP=%s\n' "$NTP_SERVER" > /etc/systemd/timesyncd.conf.d/kjoreverk.conf
    timedatectl set-ntp true 2>/dev/null || true
    systemctl restart systemd-timesyncd 2>/dev/null || true
  fi
  sleep 3
  timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes && echo "the clock is synchronized" || echo "the clock isn't synchronized yet; check with: timedatectl timesync-status"
fi

# ---------------------------------------------------------------- 5. migreringene og start
say "migrations"
su "$SVC_USER" -s /bin/bash -c "cd $APP && node bin/kv-admin.js migrate --config $CONF_DIR/config.json"
systemctl enable kjoreverk-server.service
systemctl restart kjoreverk-server.service     # også ved en oppdatering: den nye koden tas i bruk
systemctl enable --now kjoreverk-backup.timer
sleep 2
systemctl --no-pager --lines=5 status kjoreverk-server.service || true

cat <<EOF

Done. Next:
  sudo kv-admin vehicle add kv01 --name "Kjøreverk 1"     # one per vehicle
  sudo kv-admin vehicle key kv01                          # the key for /etc/hmi-recorder.json on that Pi
  sudo kv-admin status
  http://$(hostname -I | awk '{print $1}'):$(grep -o '"port": *[0-9]*' $CONF_DIR/config.json | grep -o '[0-9]*' || echo 8090)/
Logs: journalctl -u kjoreverk-server -f
The clock: NTP from $NTP_SERVER, the same as the vehicles (README §8).
EOF

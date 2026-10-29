#!/bin/bash
# deploy/backup.sh - sikkerhetskopi av databasen med pg_dump (docs/PLAN.md §3.8). Installeres som
# /usr/local/sbin/kjoreverk-backup og kjøres hver natt av kjoreverk-backup.timer.
#
#   kjoreverk-backup [mappe]      standard: /var/backups/kjoreverk
#
# Én NVMe-disk er ingen sikkerhetskopi: pek mappen på en USB-disk, eller kopier filene til en annen maskin
# etterpå (rsync i en cron-jobb, eller en NFS-/SMB-montering). KEEP er hvor mange døgn som beholdes.
# Gjenoppretting: se README §Sikkerhetskopi.
set -euo pipefail
DIR=${1:-/var/backups/kjoreverk}
DB=${DB:-kjoreverk}
KEEP=${KEEP:-14}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DIR"
FILE="$DIR/$DB-$STAMP.dump"
# -Fc: komprimert, kan gjenopprettes tabell for tabell med pg_restore. Kjøres som postgres (peer-innlogging).
if [ "$(id -un)" = postgres ]; then pg_dump -Fc -d "$DB" -f "$FILE.part"; else su postgres -c "pg_dump -Fc -d $DB -f '$FILE.part'"; fi
mv "$FILE.part" "$FILE"
# oppsettfilen hører med
[ -f /etc/kjoreverk-server/config.json ] && cp /etc/kjoreverk-server/config.json "$DIR/config-$STAMP.json" 2>/dev/null || true
find "$DIR" -name "$DB-*.dump" -mtime +"$KEEP" -delete
find "$DIR" -name "config-*.json" -mtime +"$KEEP" -delete
echo "backup: $FILE ($(du -h "$FILE" | cut -f1)); $(ls "$DIR"/$DB-*.dump | wc -l) kept in $DIR"

#!/usr/bin/env bash
# 044 SC-001 — restore drill: backup → wipe schema → migrate → restore →
# verify row counts match. Runs against the live prod compose stack
# (`docker compose -f docker-compose.prod.yml up -d` first). Exit 1 on any
# diff — an untested backup is not a backup.
set -euo pipefail

COMPOSE=${COMPOSE:-"docker compose -f docker-compose.prod.yml"}
COUNTS=(User Project Issue Attachment Comment)

count_rows() {
  local out=""
  for t in "${COUNTS[@]}"; do
    n=$($COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-trackforge}" -d "${POSTGRES_DB:-trackforge}" \
        -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "?")
    out="$out $t:$n"
  done
  echo "$out"
}

echo "== baseline counts =="
before=$(count_rows); echo "$before"

echo "== running backup =="
LOG=$(mktemp)
$COMPOSE exec -T app node dist/bin/backup.js | tee "$LOG"
id=$(grep -oE 'backup [0-9]{8}-[0-9]{6}' "$LOG" | tail -1 | awk '{print $2}')
[ -z "$id" ] && { echo "FAIL: no backup id in output"; exit 1; }
echo "backup id: $id"

echo "== verify checksums =="
$COMPOSE exec -T app node -e \
  "import('./dist/services/backupService.js').then(m=>m.verifyBackup('$id')).then(r=>{if(!r.ok){console.error('checksum FAIL',r.mismatched);process.exit(1)}console.log('checksums ok')})"

echo "== wiping schema (drill = prove restore repopulates) =="
$COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-trackforge}" -d "${POSTGRES_DB:-trackforge}" \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
echo "after wipe: $(count_rows)"

echo "== migrate back to current schema =="
$COMPOSE run --rm migrate || { echo "FAIL: migrate did not exit 0"; exit 1; }

echo "== restore $id =="
$COMPOSE exec -T app node dist/bin/restore.js "$id"

echo "== diff =="
after=$(count_rows); echo "$after"
[ "$before" = "$after" ] && { echo "DRILL PASS — $id restored byte-identical counts"; exit 0; }
echo "DRILL FAIL"
echo "before:$before"
echo "after: $after"
exit 1

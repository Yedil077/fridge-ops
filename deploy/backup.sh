#!/bin/sh
# Daily PostgreSQL backup (cron: 0 3 * * * /opt/fridge-ops/deploy/backup.sh). Keeps 14 days.
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T db pg_dump -U fridgeops -d fridgeops | gzip > "backups/fridgeops-$(date +%F).sql.gz"
find backups -name 'fridgeops-*.sql.gz' -mtime +14 -delete

#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ "${BACKUP_QUIESCED:-false}" != "true" ]]; then
  echo "Backup refused: stop application writers and set BACKUP_QUIESCED=true." >&2
  exit 1
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Backup refused: DATABASE_URL is not configured." >&2
  exit 1
fi
if [[ -z "${BACKUP_DIR:-}" || "${BACKUP_DIR}" != /* || "${BACKUP_DIR}" == "/" ]]; then
  echo "Backup refused: BACKUP_DIR must be a specific absolute path." >&2
  exit 1
fi

attachment_volume="${EVIDENCE_ATTACHMENT_VOLUME_NAME:-alert_reduction_attachments}"
model_volume="${ML_ARTIFACT_VOLUME_NAME:-alert_reduction_ml_artifacts}"
postgres_image="${POSTGRES_TOOL_IMAGE:-postgres:16-alpine}"
archive_image="${ARCHIVE_TOOL_IMAGE:-alpine:3.20}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle_dir="${BACKUP_DIR%/}/alert-reduction-${timestamp}"

mkdir -p "$bundle_dir"
docker volume inspect "$attachment_volume" >/dev/null
docker volume inspect "$model_volume" >/dev/null

docker run --rm \
  --env DATABASE_URL \
  --volume "$bundle_dir:/backup" \
  "$postgres_image" \
  sh -eu -c 'pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file=/backup/postgresql.dump'

docker run --rm \
  --volume "$attachment_volume:/source:ro" \
  --volume "$bundle_dir:/backup" \
  "$archive_image" \
  tar -czf /backup/evidence-attachments.tar.gz -C /source .

docker run --rm \
  --volume "$model_volume:/source:ro" \
  --volume "$bundle_dir:/backup" \
  "$archive_image" \
  tar -czf /backup/ml-artifacts.tar.gz -C /source .

docker run --rm \
  --volume "$bundle_dir:/backup" \
  "$archive_image" \
  sh -eu -c 'cd /backup && sha256sum postgresql.dump evidence-attachments.tar.gz ml-artifacts.tar.gz > checksums.sha256'

printf '%s\n' \
  "created_at_utc=${timestamp}" \
  "database_format=postgresql_custom" \
  "attachment_archive=evidence-attachments.tar.gz" \
  "model_archive=ml-artifacts.tar.gz" \
  > "$bundle_dir/manifest.txt"

echo "Backup bundle created: $bundle_dir"
echo "Restore validation is still required before this backup is considered usable."

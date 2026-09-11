#!/usr/bin/env bash
set -euo pipefail

if [[ "${RESTORE_CONFIRM:-}" != "isolated" ]]; then
  echo "Restore refused: set RESTORE_CONFIRM=isolated for a disposable validation target." >&2
  exit 1
fi
if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo "Restore refused: RESTORE_DATABASE_URL is not configured." >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" && "${RESTORE_DATABASE_URL}" == "${DATABASE_URL}" ]]; then
  echo "Restore refused: validation target matches DATABASE_URL." >&2
  exit 1
fi
if [[ -z "${BACKUP_BUNDLE_DIR:-}" || "${BACKUP_BUNDLE_DIR}" != /* || ! -d "${BACKUP_BUNDLE_DIR}" ]]; then
  echo "Restore refused: BACKUP_BUNDLE_DIR must be an existing absolute path." >&2
  exit 1
fi

postgres_image="${POSTGRES_TOOL_IMAGE:-postgres:16-alpine}"
archive_image="${ARCHIVE_TOOL_IMAGE:-alpine:3.20}"
attachment_restore_volume="${RESTORE_ATTACHMENT_VOLUME_NAME:-alert_reduction_attachments_restore_validation}"
model_restore_volume="${RESTORE_ML_VOLUME_NAME:-alert_reduction_ml_artifacts_restore_validation}"

for required in postgresql.dump evidence-attachments.tar.gz ml-artifacts.tar.gz checksums.sha256; do
  if [[ ! -f "${BACKUP_BUNDLE_DIR%/}/$required" ]]; then
    echo "Restore refused: backup bundle is missing $required." >&2
    exit 1
  fi
done

docker run --rm \
  --volume "$BACKUP_BUNDLE_DIR:/backup:ro" \
  "$archive_image" \
  sh -eu -c 'cd /backup && sha256sum -c checksums.sha256'

if docker volume inspect "$attachment_restore_volume" >/dev/null 2>&1; then
  echo "Restore refused: validation attachment volume already exists." >&2
  exit 1
fi
if docker volume inspect "$model_restore_volume" >/dev/null 2>&1; then
  echo "Restore refused: validation model volume already exists." >&2
  exit 1
fi

docker volume create "$attachment_restore_volume" >/dev/null
docker volume create "$model_restore_volume" >/dev/null

docker run --rm \
  --env RESTORE_DATABASE_URL \
  --volume "$BACKUP_BUNDLE_DIR:/backup:ro" \
  "$postgres_image" \
  sh -eu -c 'pg_restore --dbname="$RESTORE_DATABASE_URL" --clean --if-exists --exit-on-error --no-owner --no-acl /backup/postgresql.dump'

docker run --rm \
  --volume "$attachment_restore_volume:/restore" \
  --volume "$BACKUP_BUNDLE_DIR:/backup:ro" \
  "$archive_image" \
  tar -xzf /backup/evidence-attachments.tar.gz -C /restore

docker run --rm \
  --volume "$model_restore_volume:/restore" \
  --volume "$BACKUP_BUNDLE_DIR:/backup:ro" \
  "$archive_image" \
  tar -xzf /backup/ml-artifacts.tar.gz -C /restore

docker run --rm \
  --env RESTORE_DATABASE_URL \
  "$postgres_image" \
  sh -eu -c 'psql "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --command="SELECT json_build_object('"'"'alerts'"'"', (SELECT COUNT(*) FROM alerts), '"'"'slack_occurrences'"'"', (SELECT COUNT(*) FROM slack_alert_events), '"'"'evidence_reports'"'"', (SELECT COUNT(*) FROM incident_verification_reports), '"'"'callback_inbox'"'"', (SELECT COUNT(*) FROM slack_callback_inbox), '"'"'ml_models'"'"', (SELECT COUNT(*) FROM ml_model_registry));"'

echo "Restore validation data was created in an isolated database and two validation volumes."
echo "Run the application smoke tests against those restored targets before recording PASS."

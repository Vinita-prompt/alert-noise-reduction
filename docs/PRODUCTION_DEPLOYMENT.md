# Production deployment gate

This repository is deployable to an approved always-on Linux host, but a local
checkout cannot prove a production deployment. Production readiness requires all
items below to be completed against the real host and Slack application.

## Required external inputs

- GitHub repository/organization and protected `production` environment
- approved server or container host, permanent DNS name, and TLS ingress
- managed PostgreSQL connection URL and provider CA/trust configuration
- production secret-manager entries copied from `backend/.env.production.example`
- durable, backed-up volumes or equivalent object storage for evidence attachments
  and shadow-model artifacts
- a privately entered administrator test account

Never commit the populated production environment file. GitHub Actions CI runs
backend tests (including additive migration contract tests), the frontend build, and deployment-config validation on
every push and pull request. The manual `Deploy Production` workflow publishes
immutable backend/frontend images and deploys only when the protected production
environment has been approved and `PRODUCTION_DEPLOYMENT_ENABLED=true`.

The release workflow requires these repository settings:

- variables: `PRODUCTION_DEPLOYMENT_ENABLED`, `PRODUCTION_DEPLOY_PATH`,
  `PRODUCTION_DOMAIN`
- protected-environment secrets: `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`,
  `PRODUCTION_SSH_KEY`, `PRODUCTION_GHCR_TOKEN`

The target host must already contain the private, populated
`backend/.env.production`. The workflow never generates or checks in that file.

## Deployment sequence

1. Create the managed PostgreSQL database, enable TLS, point-in-time recovery,
   retention, and automated backups.
2. Restore a current backup into an isolated database and record the restore result.
3. Create `backend/.env.production` only on the host or inject equivalent secrets.
4. Set the permanent callback URLs to the same public HTTPS origin:
   `https://<host>/api/slack/events` and
   `https://<host>/api/slack/interactions`.
5. Validate the populated environment with `npm run deploy:validate-config`, then
   build, migrate, and start with `compose.production.yml`. The backend runs
   additive migrations before serving and the runtime restarts exited containers.
   Configure health-based task replacement in the external container platform;
   Docker restart policies alone do not restart a process that remains alive but
   unhealthy.
6. Verify `GET /live`, `GET /ready`, `GET /api/health/live`, and
   `GET /api/health/ready` through the public origin. Production readiness fails
   closed when either permanent Slack URL is invalid or when enabled ML workers do
   not have durable artifact storage.
7. Register the exact permanent URLs in Slack. Verify `message.channels`, a real
   Events API delivery, immediate signed interaction acknowledgement, callback
   deduplication, and persisted asynchronous completion. Polling remains at 30
   seconds as a recovery path.
8. Run one staged alert/evidence round trip with an authorized reviewer. Confirm
   the exact occurrence ID, append-only revision, provenance, attachment metadata,
   learning eligibility, durable ML job, model artifact/registry row when both
   confirmed classes are sufficient, and website prediction refresh.

## Data and ML invariants

- Evidence is committed before Slack/web synchronization or ML work is queued.
- Evidence updates create new report/version/audit rows; prior rows are retained.
- Only the latest valid, conflict-free human Incident/Noise outcome is trainable.
- Evidence Pending and missing/conflicting evidence remain unlabeled.
- Predictions never create labels or operational actions.
- Dataset splits are chronological and keep an exact source identity in one split.
- If either confirmed class is below `ML_MINIMUM_CLASS_EXAMPLES`, the retraining
  job is recorded as skipped with `INSUFFICIENT_VALIDATED_TRAINING_DATA`.

## Release evidence

Do not mark production ready until the release record contains: public health
responses, Slack request IDs/timestamps, callback inbox rows, database backup and
restore evidence, container restart/retry results, administrator-page screenshots,
test/build output, dataset class distribution, model registry/artifact checksum,
and the staged alert-to-prediction trace. Do not include credentials or callback
payloads in the release record.

The executable backup bundle and isolated restore validation procedure is in
`docs/GITHUB_EXTERNAL_CONTAINER_DEPLOYMENT.md`. A backup is not accepted until
the database, attachments, and model artifacts have all been restored and opened
from a separate validation target.

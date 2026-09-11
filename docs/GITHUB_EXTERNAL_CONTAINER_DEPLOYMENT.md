# GitHub and external container deployment

## Current repository state

The application is prepared for an external Linux container host. It is not a
Codex Site backend and it is not a Cloudflare Worker. The runtime remains React
and Vite behind Nginx, Node and Express, PostgreSQL, Python/XGBoost, and Caddy.

This checkout has no first Git commit and no GitHub remote. Creating the private
repository is therefore an operator action, not an already completed deployment.
Do not push until the pre-push checks below pass.

## Private GitHub repository

Create an empty **private** repository in the approved GitHub organization, then
connect this checkout. One CLI form is shown below; replace the placeholder with
the approved owner and repository name.

```text
gh repo create <owner>/alert-noise-reduction --private --source=. --remote=origin
git add .
git status --short
git commit -m "Prepare external production deployment"
git push -u origin main
```

Before the first commit, verify that `backend/.env`,
`backend/.env.production`, attachment bytes, model artifacts, database dumps,
private keys, and access tokens are absent from `git status`. The environment
files are ignored; only `.env.example` files belong in Git.

Protect `main` with required pull requests and the `CI` workflow. Create a
protected GitHub environment named `production`, require an approver, and set:

- repository variables: `PRODUCTION_DEPLOYMENT_ENABLED`,
  `PRODUCTION_DEPLOY_PATH`, `PRODUCTION_DOMAIN`;
- protected secrets: `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`,
  `PRODUCTION_SSH_KEY`, `PRODUCTION_GHCR_TOKEN`.

The deploy workflow publishes commit-SHA container tags. It does not populate
runtime credentials and remains inert until `PRODUCTION_DEPLOYMENT_ENABLED=true`.

## Runtime topology

Use an approved always-on Linux VM or container platform with a persistent disk.
The supplied Compose topology runs:

- one backend instance containing Express, Slack callback and polling workers,
  monitoring pollers, and the durable ML job worker;
- one immutable Nginx frontend built with same-origin `VITE_API_BASE_URL=/api`;
- Caddy on ports 80/443 for permanent DNS and TLS;
- a separately managed PostgreSQL service with TLS certificate validation;
- stable attachment and ML-artifact volumes mounted at `/app/data/...`.

Keep the backend at one replica for the initial release. Slack callback and ML
jobs have PostgreSQL leases and idempotency, but all monitoring pollers have not
been certified for active-active replicas. A platform may replace an exited or
unhealthy task, but it must never mount two independent attachment/model volumes.

Docker's restart policy restarts an exited process. It does not by itself repair
an indefinitely unhealthy process; the approved production platform must enable
health-based task replacement using `/api/health/live` and
`/api/health/ready`.

## Production configuration

Create `backend/.env.production` from the example only on the target host, or
inject the same keys through its secret manager. Run the non-secret validator
before startup:

```text
docker compose --env-file backend/.env.production -f compose.production.yml run --rm --no-deps backend npm run deploy:validate-config -- --environment
```

PostgreSQL must use `DB_SSL=true` and
`DB_SSL_REJECT_UNAUTHORIZED=true`. If the provider CA is not in the container's
system trust store, securely mount its CA bundle and set `DB_SSL_CA_FILE` to that
container path. Never use `sslmode=no-verify` or disable certificate validation.

`CORS_ORIGIN` must be the exact public website origin. The production frontend
uses `/api`, so browser API traffic and secure session cookies stay on the same
HTTPS origin.

Use a secret manager for every token and for `DATABASE_URL`; never pass a local
development `.env` into the production image. Keep every Atlassian write flag
false and keep `MODEL_MODE=SHADOW`.

## Durable data

PostgreSQL is the source of truth for occurrences, callback jobs, evidence
metadata, revisions, audit history, and model registry rows. The two named
volumes contain evidence attachment bytes and ML artifact bytes. Place the
Docker data directory on persistent block/NFS storage, or map the volume names
to equivalent provider-managed persistent volumes. Local ephemeral container
filesystems are not acceptable.

For each release:

1. verify provider point-in-time recovery and retention;
2. stop/quiesce application writers;
3. run `deploy/backup-production.sh` with `BACKUP_QUIESCED=true`, `DATABASE_URL`,
   and a protected absolute `BACKUP_DIR`;
4. copy the complete bundle off-host to encrypted durable storage;
5. run `deploy/verify-production-restore.sh` against a disposable managed
   PostgreSQL database and newly created validation volumes;
6. start the restored application with the restored storage, run migrations,
   compare record counts/checksums, open an attachment, load a model artifact,
   then record and retain the result.

Never point the restore script at production. It refuses an identical URL and
requires `RESTORE_CONFIRM=isolated`, but the operator must still verify the
target independently. Match `POSTGRES_TOOL_IMAGE` to the managed PostgreSQL
major version.

## Slack and continuous workers

Set and register exactly:

```text
https://<domain>/api/slack/events
https://<domain>/api/slack/interactions
```

The URLs must share `BACKEND_DOMAIN`, use a valid public certificate, and must
not be a laptop tunnel. Subscribe only to `message.channels` for a public source
channel or `message.groups` for a private source channel. The app must be a
member of every private channel it reads. Keep the 30-second cursor poller as a
fallback.

The HTTP handlers verify Slack signatures, durably insert the callback, return
HTTP 200, and process it asynchronously. Callback and occurrence idempotency
prevent Slack retries from producing duplicates. Failed rows stay in PostgreSQL
for audit and bounded retry.

## Release validation gate

The following must all be captured from the real external deployment before it
is called production-ready:

- CI backend suite, frontend build, Compose validation, and both Docker builds;
- additive migration result against a restored copy before production;
- public liveness/readiness and browser route checks;
- a real direct Slack event with event, receive, store, and UI timestamps;
- a signed interaction acknowledged within three seconds and completed from the
  durable callback inbox;
- polling fallback recovery without a duplicate occurrence;
- append-only evidence create/update plus durable attachment retrieval;
- persisted ML job, restart recovery, shadow prediction, artifact checksum, and
  artifact reload after container replacement;
- container termination/replacement with no callback, evidence, or ML-job loss;
- managed PostgreSQL point-in-time restore plus attachment/model volume restore;
- a check from another device after the development laptop is powered off.

Until every item passes, the correct status is **prepared for external
deployment, not production-ready**.

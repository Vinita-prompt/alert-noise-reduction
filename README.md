# Alert Noise Reduction Platform

Alert Noise Reduction Platform is an evidence-driven operations solution that collects alerts from monitoring sources, preserves their history, and helps the Command Center distinguish actionable incidents from operational noise.

The platform combines live alert ingestion, structured evidence collection, pattern analysis, and human feedback. Each verified decision becomes learning data, allowing the system to improve its classification over time while keeping every decision traceable and reviewable.

It provides a real-time 24-hour alert view, historical evidence tracking, Slack-based verification, and a persistent backend archive so monitoring continues even when a user’s laptop is offline.

## Product boundaries

- **Live Alerts** is a server-filtered rolling 24-hour view with automatic refresh.
- **Alert History** is the permanent occurrence archive; separate deliveries are not collapsed by alert number.
- **Evidence History** shows evidence submitted or updated within the configurable retention window (60 days by default) and links to complete append-only revision history.
- Monitoring sources are AppDynamics, Grafana, Nagios, and other explicitly configured adapters. Slack and Jira provide workflow and evidence context; they are not monitoring sources.
- ThousandEyes is retired from active polling and product navigation. Existing historical rows remain preserved.
- Recommendations stay transparent and reversible. Only completed, human-confirmed Incident or Noise evidence is eligible for learning.

## Architecture

- React/Vite frontend in `frontend/`
- Express backend and asynchronous Slack callback worker in `backend/`
- Managed PostgreSQL for permanent alert occurrences, callback inbox entries, evidence, audit revisions, and learning records
- Durable evidence attachments mounted outside the container
- Slack Events API plus persisted-cursor polling fallback
- Docker Compose, a production-built Nginx frontend, and Caddy for process restart policies, health checks, same-origin API routing, and permanent HTTPS; production connects to a separately managed PostgreSQL service
- A durable shadow-learning queue and backed-up model-artifact volume; Evidence Pending records never become labels

Slack callback bodies are acknowledged promptly after signature/replay validation and durable inbox insertion. Workers claim inbox rows using database leases, retry with bounded backoff, and reclaim abandoned work after restart. Exact Slack retries are idempotent by event ID or channel/message timestamp; legitimate repeated occurrences remain separate.

## Local development

Requirements: Node.js 18+, PostgreSQL, and the corporate CA file already provided to the backend.

```bash
cp backend/.env.example backend/.env
cd backend
npm ci
npm run db:migrate
npm run dev
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The API defaults to `http://127.0.0.1:4000/api`.

## Environment and secrets

Use `backend/.env.example` for development and `backend/.env.production.example` as the safe deployment template. Never commit `.env`, `.env.production`, tokens, credentials, logs, attachments, or local database files.

Key settings:

- `DATABASE_URL`: production managed-PostgreSQL connection (TLS verification is on by default when `DB_SSL=true`)
- `EVIDENCE_COLLECTION_MODE`: `disabled` by default; permanent production archiving is an explicit deployment decision
- `EVIDENCE_HISTORY_RETENTION_DAYS`: evidence-list window, default `60`; set `30` without a migration when policy changes
- `SLACK_EVENTS_PUBLIC_URL`: permanent HTTPS URL ending `/api/slack/events`
- `SLACK_INTERACTIONS_PUBLIC_URL`: permanent HTTPS URL ending `/api/slack/interactions`
- `SLACK_SIGNING_SECRET`, `SLACK_BOT_USER_OAUTH_TOKEN`, `SLACK_CHANNEL_ID`: backend-only Slack configuration
- `GRAFANA_*`, `APPDYNAMICS_*`, `NAGIOS_D01_*`, `NAGIOS_D02_*`: backend-only, least-privilege monitoring access
- `ML_ARTIFACT_STORAGE_DIR`: backed-up durable model storage shared with the inference process
- `ML_AUTOMATED_RETRAINING_ENABLED`: durable asynchronous retraining/prediction worker; production template enables it, local development does not
- all Atlassian write flags remain `false` for read-only/shadow operation

## Database migrations

Migrations are additive and run through the application schema bootstrap:

```bash
cd backend
npm run db:migrate
```

The production live/history migration adds indexes for time-window reads, alert number, source, priority, application, classification, reviewer, and evidence time. Existing alert and evidence records are not rewritten or deleted.

## Slack configuration

Register these permanent Request URLs after DNS and HTTPS are active:

- Events: `https://<backend-domain>/api/slack/events`
- Interactivity: `https://<backend-domain>/api/slack/interactions`

Grant only the scopes required for the configured channel and workflows. Keep the 30-second polling fallback enabled. Verify the app is a member of private channels. Do not use laptop tunnels in production.

## Production deployment

`compose.production.yml` requires a managed PostgreSQL `DATABASE_URL` and provides durable attachment/model storage, backend and frontend restart policies, readiness health checks, a production-built React site, same-origin `/api` routing, and Caddy HTTPS termination.

```bash
cp backend/.env.production.example backend/.env.production
# Fill secrets in the deployment secret store or protected environment file,
# including the managed DATABASE_URL and permanent BACKEND_DOMAIN.
docker compose --env-file backend/.env.production -f compose.production.yml build
docker compose --env-file backend/.env.production -f compose.production.yml run --rm --no-deps backend npm run deploy:validate-config -- --environment
docker compose --env-file backend/.env.production -f compose.production.yml run --rm --no-deps backend npm run db:migrate
docker compose --env-file backend/.env.production -f compose.production.yml up -d --wait
curl -fsS https://<backend-domain>/api/health/live
curl -fsS https://<backend-domain>/api/health/ready
```

Production is not complete until a real always-on host, managed PostgreSQL backups and a tested restore, durable attachment/model backups, DNS, TLS, permanent Slack callbacks, secret management, and restart/retry validation are configured in the target environment. See `docs/PRODUCTION_DEPLOYMENT.md`.

The private GitHub handoff, external container topology, safe configuration
preflight, backup/restore commands, and off-laptop release gate are documented in
`docs/GITHUB_EXTERNAL_CONTAINER_DEPLOYMENT.md`.

`.github/workflows/ci.yml` validates every push and pull request. The separately
approved `.github/workflows/deploy-production.yml` publishes immutable container
images and can deploy them to an approved always-on host after its protected
environment, repository variables, and secrets have been configured. It is not
enabled by repository defaults.

## Learning safety

The supervised dataset uses only the latest conflict-free, human-confirmed Incident or Noise outcome for an exact alert occurrence. Evidence Pending, legacy No Observed Incident records, system classifications, predictions, and superseded evidence revisions are excluded. Splits are chronological and keep an exact source-identity group in only one of train, validation, or holdout. Confirmed submissions enqueue durable shadow retraining and prediction jobs; insufficient class coverage records a skipped run and does not create a model.

## Validation

```bash
cd backend && npm test
cd ../frontend && npm run build
```

Health and product endpoints:

- `GET /api/health/live` — process liveness
- `GET /api/health/ready` — PostgreSQL and callback-worker readiness
- `GET /api/alerts/live` — rolling 24-hour occurrences only
- `GET /api/evidence/history` — authenticated, paginated retained evidence history

No evidence submission changes Jira, Slack alert state, or monitoring state. Recommendations remain shadow-only.

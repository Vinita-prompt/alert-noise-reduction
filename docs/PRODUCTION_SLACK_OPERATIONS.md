# Production Slack evidence operations

The backend is packaged as an always-on container behind Caddy HTTPS. Production uses a managed PostgreSQL service, Slack Events API and Interactivity callbacks enter a durable database inbox, and the container runtime restarts unhealthy processes.

## Required deployment inputs

Before deployment, an operator must provide:

- an approved Linux server or container host with Docker Compose;
- a permanent DNS name in `BACKEND_DOMAIN` pointing to that host;
- a secured `backend/.env.production` created from `backend/.env.production.example`;
- a managed PostgreSQL `DATABASE_URL`, TLS validation, automated point-in-time backups, and an isolated restore test;
- firewall access for inbound TCP 80/443 and outbound HTTPS to Slack;
- the permanent website URL for `ALERT_REDUCTION_WEB_URL` and `CORS_ORIGIN`.

Never copy the development `.env` into source control or a container image. Never use the development-only local authentication in production.

## Start and verify

From the repository root on the approved host:

```text
docker compose --env-file backend/.env.production -f compose.production.yml up -d --build
docker compose --env-file backend/.env.production -f compose.production.yml ps
```

Validate both endpoints through the permanent hostname:

```text
https://<BACKEND_DOMAIN>/api/health/live
https://<BACKEND_DOMAIN>/api/health/ready
```

The readiness response is safe metadata only. It confirms PostgreSQL access and reports callback queue counts without returning callback payloads or credentials.

## Slack configuration

Configure these two Slack app URLs with the same permanent HTTPS origin:

```text
Event Subscriptions: https://<BACKEND_DOMAIN>/api/slack/events
Interactivity:       https://<BACKEND_DOMAIN>/api/slack/interactions
```

Keep `message.channels` for a public Alerts and Notifications channel or `message.groups` for a private one; do not grant unrelated scopes. Keep the 30-second polling fallback enabled.

Slack callbacks are signed before acceptance. Each accepted callback is persisted with a deterministic idempotency key, acknowledged with HTTP 200, processed asynchronously, and retried with an expiring PostgreSQL lease. Slack retry deliveries are acknowledged and deduplicated rather than producing duplicate alerts or evidence.

## Data and recovery

- `slack_raw_messages` and `slack_alert_events` preserve each occurrence by event ID or channel/message timestamp.
- `slack_callback_inbox` preserves callback work across restarts and logs bounded retry failures.
- Evidence reports and update events remain append-only.
- Failed verification posts retry during the continuous Slack reconciliation cycle.
- `EVIDENCE_COLLECTION_MODE=enabled` is an explicit production activation; it is never inferred from startup.

Create a provider snapshot before schema upgrades and test restore into an isolated managed database. A real Slack event, evidence submission, container restart, and retry must pass on the permanent hostname before production readiness is declared.

The `alert_reduction_attachments` and `alert_reduction_ml_artifacts` volumes are
also part of the evidence/learning record. Back them up with PostgreSQL and
restore all stores to a consistent recovery point; PostgreSQL contains metadata,
provenance, model registry rows and opaque storage keys while the volumes contain
the attachment and model bytes.

## Capacity validation

Before a production release, run the isolated capacity gate from `backend`:

```text
npm run capacity:test
```

The test loads 50,000 alert occurrences, 100,000 initial evidence versions,
50,000 feedback-learning rows, 100 concurrent Slack callbacks, and 50 concurrent
evidence updates in a temporary PostgreSQL schema. See
`docs/CAPACITY_VALIDATION_50000.md` for the recorded baseline and limitations.

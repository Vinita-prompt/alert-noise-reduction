# Alert Noise Reduction Backend

Node.js, Express, and PostgreSQL API for the Alert Noise Reduction System.

## Interim architecture

The backend is in the **ingestion, feature extraction, and data foundation** phase. The legacy rule-based Noise / Incident / Needs Review layer is retired, automatic decisions are disabled, and no replacement classifier or ML model is enabled.

- New alerts are stored as `unclassified` with decision state `not_evaluated`.
- Historical labels and decision audit rows are retained with an explicit legacy marker and are not ground truth.
- Source ingestion, raw payloads, normalized fields, correlations, source identities, evidence, Jira, Slack, and monitoring integrations remain active.
- `GET /api/noise-analysis` and `GET /api/noise-analysis/status` report the retirement/foundation state.
- `GET /api/noise-analysis/foundation` exposes decision-free foundation groups.
- Legacy decision routes, manual classification, reduction simulation, evidence-completion decision workflows, and rule mutation return HTTP `410`.

Apply `src/db/migrations/034_retire_legacy_decision_layer.sql` to an existing database. It is additive and does not delete or relabel historical alerts. Full details are in [`../docs/phase-0-decision-layer-retirement.md`](../docs/phase-0-decision-layer-retirement.md).

## What Is Included

- `GET /api/health`
- `GET /api/alerts`
- `GET /api/alerts/:id`
- `GET /api/alerts/:id/raw`
- `GET /api/alerts/:id/linked-incidents`
- `POST /api/alerts/:id/acknowledge`
- `POST /api/alerts/:id/escalate`
- `POST /api/alerts/:id/actions` (legacy decision action; retired with HTTP 410)
- `GET /api/incidents`
- `GET /api/incidents/:key`
- `GET /api/integrations`
- `POST /api/integrations/:tool`
- `PUT /api/integrations/:tool`
- `DELETE /api/integrations/:tool`
- `POST /api/integrations/:tool/test`
- `GET /api/integrations/jira/status`
- `POST /api/integrations/jira/alerts/import`
- `POST /api/integrations/operations/alerts/import`
- `POST /api/ingestion/:source/alerts`
- `POST /api/ingestion/:tool/run`
- `GET /api/rules`
- `PATCH /api/rules/:id/status` (retired with HTTP 410)
- `POST /api/slack/events`
- `POST /api/slack/interactions`
- `GET /api/abc-hub/daemon-monitor`
- `GET /api/abc-hub/daemon-monitor/history`
- PostgreSQL schema for `raw_alerts`, `alerts`, `alert_acknowledgements`, `alert_escalations`, `audit_events`, `slack_notifications`, `alert_classification_history`, `alert_correlation_history`, `incidents`, `alert_incident_mappings`, and `noise_rules`
- Retired noise-rule definitions are preserved for audit/rollback only; alert rows come from real ingestion sources
- Jira connection testing and issue creation from alert actions only

Slack alert collection and source-first alert ingestion are included. Automatic alert classification is retired. Existing separately-authorized Jira write workflows are not part of the classification path and remain governed by their write-safety flags.

## Setup

1. Install backend dependencies.

```bash
cd backend
npm install
```

2. Create a local environment file.

```bash
cp .env.example .env
```

3. Create the PostgreSQL database.

```bash
createdb alert_noise_reduction
```

4. Apply schema and default rule data.

```bash
psql -d alert_noise_reduction -f src/db/schema.sql
psql -d alert_noise_reduction -f src/db/seed.sql
```

If you already created the database before Slack collection was added, apply the migration instead of dropping data.

```bash
psql -d alert_noise_reduction -f src/db/migrations/001_slack_alert_ingestion.sql
psql -d alert_noise_reduction -f src/db/migrations/002_integrations.sql
psql -d alert_noise_reduction -f src/db/migrations/006_jira_open_ticket_ingestion.sql
psql -d alert_noise_reduction -f src/db/migrations/007_alert_extracted_details.sql
psql -d alert_noise_reduction -f src/db/migrations/008_remove_demo_alert_data.sql
psql -d alert_noise_reduction -f src/db/migrations/009_source_first_alert_storage.sql
psql -d alert_noise_reduction -f src/db/migrations/012_slack_acknowledgement_workflow.sql
psql -d alert_noise_reduction -f src/db/migrations/017_abc_hub_daemon_monitor_fields.sql
psql -d alert_noise_reduction -f src/db/migrations/034_retire_legacy_decision_layer.sql
```

5. Start the API.

```bash
npm run dev
```

The backend npm scripts start Node.js with the internal ABC Fitness root certificate:

```bash
NODE_EXTRA_CA_CERTS=./ABCFSROOTCA.pem
```

Run the command from the `backend` folder so `./ABCFSROOTCA.pem` resolves correctly. This lets Slack API HTTPS requests validate through the corporate certificate chain. On startup, the backend logs the certificate path it is using. If you start the backend with `node src/server.js` directly, set `NODE_EXTRA_CA_CERTS=./ABCFSROOTCA.pem` yourself before Node starts.

The server runs on `http://localhost:4000`.

For local development, the backend also checks Slack for new channel notifications every 60 seconds using `SLACK_SYNC_INTERVAL_MS=60000`. Set that value to `0` if you want to disable polling. Slack Event Subscriptions can still deliver live events to `/api/slack/events` when the backend is hosted or exposed through a tunnel.

ABC Hub Daemon Monitor uses `GET /abcHub/api/v1/daemon-monitors/broken-jobs` from `ABC_HUB_BASE_URL`. Set `ABC_HUB_API_KEY` or `ABC_HUB_TOKEN` to call the live API. If credentials are missing or `ABC_HUB_USE_MOCK=true`, the backend keeps the Monitoring page usable with local mock records.

## Atlassian Scoped Integration

The Atlassian integration uses separate backend-only tokens for each API lane. Do not paste tokens into source code or the frontend.

```bash
ATLASSIAN_EMAIL=
ATLASSIAN_CLOUD_ID=
ATLASSIAN_SITE_URL=

ATLASSIAN_JIRA_READ_TOKEN=
ATLASSIAN_OPS_READ_TOKEN=
ATLASSIAN_OPS_WRITE_TOKEN=
ATLASSIAN_JIRA_WRITE_TOKEN=
ATLASSIAN_JSM_READ_TOKEN=
ATLASSIAN_JSM_WRITE_TOKEN=

ATLASSIAN_OPS_POLLING_ENABLED=true
ATLASSIAN_OPS_POLL_INTERVAL_SECONDS=30
ATLASSIAN_OPS_INITIAL_SYNC_DAYS=30

ATLASSIAN_OPS_WRITE_ENABLED=false
ATLASSIAN_JIRA_WRITE_ENABLED=false
ATLASSIAN_JSM_WRITE_ENABLED=false
```

Apply the Atlassian migration after updating the backend:

```bash
psql -d alert_noise_reduction -f src/db/migrations/024_atlassian_full_integration.sql
```

Safe local checks:

```bash
curl http://localhost:4000/api/integrations/atlassian/status
curl -X POST http://localhost:4000/api/integrations/atlassian/test
curl -X POST http://localhost:4000/api/integrations/atlassian/ops/sync
curl http://localhost:4000/api/integrations/atlassian/jsm/service-desks
curl http://localhost:4000/api/integrations/atlassian/jsm/requests
```

Write actions remain disabled unless the matching `*_WRITE_ENABLED` flag is explicitly set to `true`. The backend never tests write tokens by modifying real Atlassian data.

## Quick Checks

```bash
curl http://localhost:4000/api/health
curl http://localhost:4000/api/alerts
curl http://localhost:4000/api/incidents
curl http://localhost:4000/api/integrations
curl http://localhost:4000/api/rules
```

## Legacy write examples (not available in the current phase)

The classification/action and rule-mutation examples below describe the retired interface. Calls now fail closed with HTTP `410`; they are retained here only to make the compatibility boundary explicit.

Acknowledge an alert before investigation.

```bash
curl -X POST http://localhost:4000/api/alerts/ALERT-ID/acknowledge \
  -H "Content-Type: application/json" \
  -d '{"acknowledgedBy":"on-call engineer","source":"website"}'
```

Escalate an alert manually.

```bash
curl -X POST http://localhost:4000/api/alerts/ALERT-ID/escalate \
  -H "Content-Type: application/json" \
  -d '{"reason":"No acknowledgement received within 2 minutes","responderTeam":"Command Center"}'
```

Apply an alert action.

```bash
curl -X POST http://localhost:4000/api/alerts/JIRA-123/actions \
  -H "Content-Type: application/json" \
  -d '{"action":"resolved"}'
```

Supported alert actions:

- `incident`
- `noise`
- `resolved`
- `duplicate`
- `jira`
- `reopen`

Slack-notified alerts must be acknowledged before these investigation actions can be applied.

Update a rule status.

```bash
curl -X PATCH http://localhost:4000/api/rules/1/status \
  -H "Content-Type: application/json" \
  -d '{"status":"paused"}'
```

Create or update a monitoring integration.

```bash
curl -X PUT http://localhost:4000/api/integrations/grafana \
  -H "Content-Type: application/json" \
  -d '{
    "baseUrl": "https://grafana.example.com",
    "accountIdentifier": "optional-alert-rule-uid",
    "token": "replace-with-token",
    "isEnabled": true
  }'
```

Test a saved integration configuration.

```bash
curl -X POST http://localhost:4000/api/integrations/grafana/test
```

Supported integration tools:

- `nagios`
- `thousandeyes`
- `grafana`
- `jira`
- `splunk-appdynamics`

## Nagios XI Monitoring Integration

Nagios DC01 and DC02 are treated as separate monitoring sources with the same
normalized schema. The existing client targets the Nagios XI REST API v1. It
requires a Nagios XI base URL and API key for each environment; it does not use
username/password authentication.

```bash
# DC01
NAGIOS_D01_BASE_URL=
NAGIOS_D01_API_KEY=

# DC02
NAGIOS_D02_BASE_URL=
NAGIOS_D02_API_KEY=

# Leave polling disabled until read-only connectivity is approved.
NAGIOS_POLL_INTERVAL_MS=0
NAGIOS_TIMEOUT_MS=10000
```

These values are backend-only. API keys must not be returned by status/config
responses, sent to the React application, stored in browser storage, or written
to application logs. Populate and validate each environment separately.

Useful local endpoints:

```bash
curl http://localhost:4000/api/nagios/d01
curl http://localhost:4000/api/nagios/d02
curl -X POST http://localhost:4000/api/nagios/d01/poll
curl -X POST http://localhost:4000/api/nagios/d02/poll
curl http://localhost:4000/api/nagios/d01/ai-features
curl http://localhost:4000/api/nagios/d01/sync-logs
```

Each poll stores current hosts, services, summaries, active problems, append-only event history, downtime/acknowledgement records when available, raw payloads, sync logs, and AI-ready feature rows. The AI fields are only prepared for later noise-vs-incident classification; no AI model runs during ingestion.

## Slack Acknowledgement Flow

Slack is used for notification and acknowledgement only. The website remains the investigation and decision layer.

Configure the Slack app with:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_ALERT_CHANNEL_ID=C0123456789
```

Slack Event Subscriptions should send alert-channel events to:

```text
https://your-public-backend-or-tunnel.example/api/slack/events
```

Slack cannot reach localhost. The public HTTPS URL must forward to the local
`http://127.0.0.1:4000/api/slack/events` endpoint during development.

Slack Interactivity should send button clicks to:

```text
http://localhost:4000/api/slack/interactions
```

When an alert message appears in the configured Slack channel, the backend stores it and prepares a Slack Block Kit acknowledgement message with an `Acknowledge` button. Clicking the button calls the backend, stores who acknowledged it, stores the acknowledgement time, updates the alert status, and unlocks website investigation.

If acknowledgement is not received within 2 minutes, the backend marks the alert escalated, stores the escalation event, and keeps the full audit history.

## Source-First Alert Ingestion

Every monitoring alert must be stored in the backend before classification or Jira work. Use this endpoint for Nagios, Grafana webhooks, AppDynamics events, ThousandEyes events, or any future source:

```bash
curl -X POST http://localhost:4000/api/ingestion/nagios/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "alertId": "nagios-host-123",
    "title": "Host CPU critical",
    "service": "payments-api",
    "environment": "production",
    "severity": "critical",
    "status": "firing",
    "message": "CPU above 95 percent",
    "timestamp": "2026-07-09T10:00:00Z"
  }'
```

The backend stores:

- the original payload in `raw_alerts`
- the normalized searchable alert in `alerts`
- the classification decision in `alert_classification_history`
- duplicate and correlation evidence in `alert_correlation_history`
- Operations incident records in `operations_incidents`
- incident mappings in `incidents` and `alert_incident_mappings`

For the ABC Fitness Command Center flow, JSM Operations Alerts is the primary alert source. Slack is notification-only. The backend stores every Operations alert first, then enriches it with JSM Operations Incidents when a link exists.

For historical backfill from JSM Operations, use Jira Cloud email/API token authentication and JQL. Operations alerts are copied into `raw_alerts` first, normalized into `alerts`, enriched from `operations_incidents`, and then classified.

Create or update the Jira incident-ticket integration. Use the ACC project here if ACC is where incident tickets are produced.

```bash
curl -X PUT http://localhost:4000/api/integrations/jira \
  -H "Content-Type: application/json" \
  -d '{
    "baseUrl": "https://your-company.atlassian.net",
    "accountIdentifier": "ACC",
    "email": "your.email@company.com",
    "apiToken": "replace-with-jira-api-token",
    "issueType": "Task",
    "isEnabled": true
  }'
```

Or configure Jira ticket creation with backend environment variables in `backend/.env`.

```bash
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token
JIRA_PROJECT_KEY=ACC
```

Configure Jira Service Management once. The same Jira URL, email, and API token are used for both ACC incident tickets and JSM Operations alert backfill.

```bash
# Operations alerts have tiny IDs like #167413.
# ACC remains the Jira incident-ticket project, not the alert source.
JIRA_INCIDENTS_JQL=project = ACC ORDER BY created ASC
```

Do not create an Opsgenie key or a second Atlassian token for this app. `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` are the only Jira Service Management authentication values used. `JIRA_INCIDENTS_JQL` should match Operations -> Incidents or your ACC incident-ticket lifecycle query.

Test Jira incident-ticket access.

```bash
curl -X POST http://localhost:4000/api/integrations/jira/test
curl http://localhost:4000/api/integrations/jira/status
```

Import all available historical ACC incidents from Jira first. This import does not hardcode a latest key; it pages oldest-to-newest until Jira reports that there are no more records.

```bash
curl -X POST http://localhost:4000/api/integrations/jira/incidents/import \
  -H "Content-Type: application/json" \
  -d '{"range":"all"}'
```

After the historical backfill, use incremental sync to fetch newly created and updated incidents from the stored cursor.

```bash
curl -X POST http://localhost:4000/api/integrations/jira/incidents/import \
  -H "Content-Type: application/json" \
  -d '{"incremental":true}'
```

Import all available historical source alerts and incidents from JSM Operations. This import does not use an open-ticket filter; `range=all` sends no date limit and paginates until Jira reports that there are no more records. The backend stores the raw payload first, then stores/classifies the normalized alert.

```bash
curl -X POST http://localhost:4000/api/integrations/operations/alerts/import \
  -H "Content-Type: application/json" \
  -d '{"range":"all"}'
```

Supported ranges are `all`, `1d`, `1w`, `1m`, and `custom`. Use `incremental=true` after a successful full backfill to refresh from the stored last-seen Jira update cursor.

```bash
curl -X POST http://localhost:4000/api/integrations/operations/alerts/import \
  -H "Content-Type: application/json" \
  -d '{"incremental":true}'
```

```bash
curl -X POST http://localhost:4000/api/integrations/operations/alerts/import \
  -H "Content-Type: application/json" \
  -d '{"range":"custom","from":"2026-07-01","to":"2026-07-09"}'
```

View the latest sync state and recent run log:

```bash
curl http://localhost:4000/api/integrations/operations/backfill/status
```

The importer uses the existing Jira Service Management auth setup for Operations alerts. Jira/ACC issue search is used for incident-ticket records and should not be treated as the full `#number` alert source.

The Operations/Jira importer stores all available metadata it receives:

- alert key, summary, description, status, priority, severity, assignee, reporter, labels, components, comments, custom fields, deep event link, source URL, raw payload
- incident key, summary, description, reporter, priority, status, resolution, created/updated/closed dates, assignee, linked alerts, root-cause notes, comments, custom fields, raw payload
- source tool, service/application, environment, deep event links, alert identifiers, correlation IDs, duplicate/incident references
- Jira incident key when linked, reason codes, confidence, justification, recommended action, and review status
- sync run metadata in `sync_runs` and the incremental cursor in `sync_state`

Alert list filters can be passed as query parameters:

```bash
curl "http://localhost:4000/api/alerts?priority=High&classification=incident&state=open&sourceTool=Nagios"
```

Fetch raw Jira payload and linked incident mappings:

```bash
curl http://localhost:4000/api/alerts/ACC-123/raw
curl http://localhost:4000/api/alerts/ACC-123/linked-incidents
```

Create a Jira issue for an alert.

```bash
curl -X POST http://localhost:4000/api/alerts/JIRA-123/actions \
  -H "Content-Type: application/json" \
  -d '{"action":"jira"}'
```

## Slack Events

Set these values in `backend/.env`.

```bash
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_ALERT_CHANNEL_ID=
```

Slack should send events to:

```text
https://your-public-backend-or-tunnel.example/api/slack/events
```

For local Slack testing a public HTTPS tunnel is required because Slack cannot call your laptop's localhost directly. Set the same complete URL in `SLACK_EVENTS_PUBLIC_URL` so the status endpoint can distinguish configured from setup-required state.

Signed local curl test:

```bash
export SLACK_SIGNING_SECRET="your-signing-secret"
export SLACK_ALERT_CHANNEL_ID="C1234567890"

BODY='{"type":"event_callback","event":{"type":"message","channel":"C1234567890","ts":"1720000000.000100","text":"Critical Payment latency firing service=payments-api production"}}'
TS=$(date +%s)
SIG="v0=$(printf "v0:$TS:$BODY" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" | sed 's/^.* //')"

curl -X POST http://localhost:4000/api/slack/events \
  -H "Content-Type: application/json" \
  -H "X-Slack-Request-Timestamp: $TS" \
  -H "X-Slack-Signature: $SIG" \
  --data "$BODY"
```

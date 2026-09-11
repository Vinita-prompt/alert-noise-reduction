# Slack Live Event Setup

The application uses two deliberately separate Slack paths:

1. Historical backfill reads paginated channel history for initial import and recovery.
2. Live ingestion receives one signed Slack Events API callback per new message and pushes new operational alerts to browsers with Server-Sent Events (SSE).

The 30-second cursor poll is fallback reconciliation only. It never rescans the complete history.

## Backend environment

Keep these values only in `backend/.env`:

- `SLACK_BOT_USER_OAUTH_TOKEN`: bot token used for history and channel metadata
- `SLACK_CHANNEL_ID`: the only channel accepted by the live handler
- `SLACK_SIGNING_SECRET`: used to verify every Events API callback
- `SLACK_EVENTS_PUBLIC_URL`: the complete public HTTPS callback URL, for example `https://your-tunnel.example/api/slack/events`
- `EVIDENCE_COLLECTION_MODE`: keep `disabled` for the rolling operational view; only `enabled` activates permanent archive semantics

The legacy aliases `SLACK_BOT_TOKEN` and `SLACK_ALERT_CHANNEL_ID` remain supported.

## Slack app Event Subscriptions

In the Slack app administration page:

1. Open **Event Subscriptions** and switch **Enable Events** on.
2. Set **Request URL** to the public HTTPS value used for `SLACK_EVENTS_PUBLIC_URL`.
3. Wait for Slack to show the URL as **Verified**. The backend handles Slack's URL verification challenge and validates the request signature.
4. Under **Subscribe to bot events**, add exactly one event for the configured channel type:
   - `message.channels` for a public channel
   - `message.groups` for a private channel
5. Save changes and reinstall the app to the workspace if Slack requests it.
6. Invite the bot/app to the configured alert channel.

Required read scope matches the channel type:

- `channels:history` for `message.channels`
- `groups:history` for `message.groups`

`users:read` is optional and only needed for profile-name enrichment. No write scope is required for live alert ingestion.

Bot-authored `bot_message` events are accepted because Jira Service Management ChatOps and monitoring apps commonly author the operational alert messages. Messages from every channel except `SLACK_CHANNEL_ID` are ignored.

Every accepted channel message is written to the raw-message store before alert parsing. Parsing failures retain the original payload and create a safe ingestion-error record. Delivery retries are deduplicated only by Slack event ID or the channel/message timestamp pair.

Read the safe reconciliation report at:

```text
GET /api/slack/alerts/reconciliation
```

It reports captured messages, stored alerts, duplicates, parse/permission failures, missing records, and the last successful Slack timestamp cursor. It never returns raw message bodies or credentials.

## Local development callback

Slack cannot send an Events API callback to `127.0.0.1` or `localhost`. Expose local port `4000` through a stable public HTTPS tunnel or deploy the backend to an HTTPS host. The callback must forward to:

```text
http://127.0.0.1:4000/api/slack/events
```

For example, if a tunnel provides `https://alerts-example.tunnel.dev`, configure Slack with:

```text
https://alerts-example.tunnel.dev/api/slack/events
```

Do not mark live delivery healthy merely because the local SSE connection works. The application reports Slack Events as healthy only after a valid signed Slack event has actually reached the endpoint.

## Browser delivery and timing

The backend pushes newly stored, non-duplicate alerts through:

```text
GET /api/alerts/stream
```

The Live Alerts browser records receipt through:

```text
POST /api/alerts/live/:id/delivered
```

Stored timing fields are `slackMessageTime`, `eventReceivedTime`, `normalizedAt`, and `frontendDeliveredAt`. Duplicate delivery is prevented by the stable Slack channel ID plus message timestamp key.

# Phase 2 — Confirmed operational outcomes

Phase 2 adds explicit occurrence-level operator feedback without changing the
historical outcome produced by the Phase 1 evidence dataset.

## Outcome vocabulary

- `CONFIRMED_INCIDENT`: an authenticated operator linked a preserved Jira Incident.
- `CONFIRMED_NOISE`: an authenticated operator selected a controlled Noise reason.
- `UNKNOWN`: an authenticated operator could not establish the operational outcome.
- No row means `UNCONFIRMED`; this never means Noise.

Noise reasons are `AUTO_RESOLVED`, `DUPLICATE`, `FLAPPING`, `NON_ACTIONABLE`,
`TRANSIENT`, `EXPECTED_BEHAVIOR`, `FALSE_POSITIVE`, and `OTHER`. `OTHER`
requires an explanation.

## Audit and correction

`alert_occurrence_outcomes` stores immutable versions. Only one version is
current per alert occurrence. Corrections append a new row, set the previous
row non-current, and reference it through `supersedes_id`.

`alert_occurrence_outcome_audit` records the actor, action, idempotency key,
and safe request context. There is no delete path.

## Authentication boundary

Phase 2.5 adds a signed, HttpOnly, CSRF-protected session boundary for explicitly
configured development operators. It has no default user, is disabled by
default, is localhost-only, and refuses to run when `NODE_ENV=production`.
Outcome middleware accepts only the verified `request.auth.user` principal
created by this boundary. Request bodies and identity-shaped headers are ignored.

The verified principal must be a human user with an `operator`,
`incident_manager`, or `admin` role, or the `outcomes:write` permission.
Production remains fail-closed until the deployment integrates its real SSO or
token provider; the development adapter cannot become a production fallback.

## API

- `GET /api/noise-analysis/foundation/:alertId/outcome`
- `POST /api/noise-analysis/foundation/:alertId/outcome`
- `PATCH /api/noise-analysis/foundation/:alertId/outcome`
- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/logout`

Writes require an `Idempotency-Key`, the verified session cookie, and the
session CSRF proof. They only update this application's PostgreSQL data. They
never write to Jira, Slack, or monitoring systems.

## Development operator setup

The backend configuration is intentionally empty until a real local operator
is provisioned:

```dotenv
AUTH_DEVELOPMENT_ENABLED=false
AUTH_DEVELOPMENT_SESSION_SECRET=
AUTH_DEVELOPMENT_USERS_JSON=[]
AUTH_DEVELOPMENT_SESSION_TTL_SECONDS=28800
AUTH_DEVELOPMENT_COOKIE_NAME=anr_dev_session
```

`AUTH_DEVELOPMENT_USERS_JSON` is an array of objects containing stable `id`,
`name`, `email`, `roles`, `permissions`, and `passwordHash` fields. Generate a
scrypt hash through `npm run auth:hash-password`; the command reads the password
interactively without placing it in command history. No plaintext password,
session secret, cookie, or CSRF proof belongs in source control.

## Authenticated audit

Every outcome audit event now captures the verified actor ID, display name,
email (when configured), roles, permissions, authorization basis, old/new
outcome, reason, notes, linked Incident, and supersession link. It contains no
password, session secret, cookie, or external-integration credential.

## Training readiness

- Confirmed Incident or Confirmed Noise: `CONFIRMED_LABELED`
- Operator Unknown: `UNKNOWN`
- Historical Incident evidence without confirmation: `WEAK_EVIDENCE`
- Everything else without confirmation: `UNLABELED`

Future target candidates remain metadata only. No training rows, model,
prediction, or ML confidence are created in Phase 2.

# Phase 6: Live multi-source shadow evaluation

Phase 6 adds a read-only, Jira-anchored evaluation path for AppDynamics, Grafana, Nagios, and ThousandEyes. Slack remains supporting context. Phase 0 remains intact: the legacy rules and classifier stay retired.

## Safety boundary

- Mode: `SHADOW`
- Release status: `NOT_READY`
- Approved model: none (`NO_APPROVED_MODEL`)
- Automatic alert suppression, acknowledgement, closure, Jira creation, and source mutation: disabled
- A shadow prediction never becomes a training label.
- If technical evidence is missing or unavailable, the final decision is `NEEDS_REVIEW` with null confidence.

All source requests run in the backend through the existing clients and credential mechanisms. API responses pass through recursive secret redaction. TLS verification is not disabled.

## Evaluation flow

1. Read a stored Jira/JSM Operations alert occurrence.
2. Resolve the monitoring source from structured integration metadata.
3. Resolve an existing validated mapping or an exact stored source identifier.
4. Query only the relevant source adapter within a bounded window.
5. Query Jira and Slack as anchor/supporting evidence.
6. Normalize evidence while retaining source-specific records and provenance.
7. create a prediction-time snapshot with explicit leakage exclusions.
8. Record an auditable shadow decision.
9. Keep authenticated operational feedback separate from the prediction.

## API

- `GET /api/evaluation` — server-paginated Jira-anchored alert inventory.
- `GET /api/evaluation/connectivity` — latest stored source checks.
- `GET /api/evaluation/connectivity?refresh=true` — bounded read-only validation.
- `POST /api/evaluation/:alertId/run` — run a single shadow evaluation.
- `GET /api/evaluation/:alertId` — latest full evaluation.
- `GET /api/evaluation/:alertId/evidence` — evidence and adapter diagnostics.
- `GET /api/evaluation/:alertId/decision` — separated decision dimensions.
- `GET /api/evaluation/:alertId/feedback` — separately confirmed operational outcome.
- `POST /api/evaluation/:alertId/feedback` — authenticated, CSRF-protected outcome feedback.
- `GET /api/evaluation/gold-dataset` — confirmed labels only.
- `GET /api/model/status` and `GET /api/model/performance` — release gates and non-fabricated metrics.

## Source connectivity statuses

Checks report one of `CONNECTED`, `NOT_CONFIGURED`, `AUTHENTICATION_FAILED`, `FORBIDDEN`, `NOT_FOUND`, `TIMEOUT`, `CERTIFICATE_ERROR`, or `UNAVAILABLE`. A failed source is visible and never silently converted into evidence.

## Feature boundary

The snapshot stores identity, technical taxonomy, current behavior, source metrics, and strictly earlier historical counts. It explicitly excludes final Jira resolution, operator outcome, and prediction-derived labels.

Observed Duplicate, Flapping, Auto-resolved, Non-actionable, Correlated, Stale, and Expected Activity states remain features. They do not directly set the final decision.

## Ground truth and feedback

Only `CONFIRMED_NOISE` and `CONFIRMED_INCIDENT` outcomes recorded through the existing authenticated outcome workflow enter the gold view. `UNKNOWN` remains an auditable outcome but not a gold training label. Feedback error types are computed by comparing the separately recorded outcome with the stored prediction.

Performance metrics remain null and display `INSUFFICIENT_LABELED_DATA` until enough confirmed outcomes exist. No confidence, PR-AUC, precision, recall, or error rate is fabricated.

# Phase 7: Unified evidence-based alert decisions

Phase 7 extends the existing Phase 6 shadow evaluation. It does not replace the
retired legacy classifier and it does not load the rejected Phase 4 model.

## Runtime contract

Each Jira/JSM-anchored monitoring alert is evaluated as one occurrence. The
backend retrieves bounded, read-only evidence from the resolved monitoring
source and supporting Jira and Slack context. The stored result contains:

- observed Noise behavior, kept separate from the final recommendation;
- technical domain and subtype;
- business impact, actionability, underlying event, and notification role;
- independent Incident, Noise, redundancy, persistence, correlation,
  historical, business-impact, source, and completeness evidence dimensions;
- `NOISE`, `INCIDENT`, or `NEEDS_REVIEW` as an experimental shadow
  recommendation;
- an evidence score and structured reasons;
- source-specific evidence details and provenance;
- model, evaluation, and feedback status.

`evidenceScore` is evidence strength. It is not a probability, is not ML
confidence, and is always paired with `decisionConfidence: NOT_CALIBRATED`.

## Semantic recommendation gates

The final recommendation is not produced from one numeric threshold:

- a represented underlying Incident plus an independently observed duplicate
  notification can recommend `NOISE` when the notification is redundant;
- a source-supported actionable event with a primary notification can recommend
  `INCIDENT`;
- missing, conflicting, incomplete, or source-unavailable evidence recommends
  `NEEDS_REVIEW`.

This distinction is intentional and supported:

```text
Underlying event: CONFIRMED_INCIDENT
Notification role: REDUNDANT
Final decision: NOISE
```

The real event still exists; only the redundant notification is recommended as
Noise.

## Safety and performance

- Evaluation mode is fixed to `SHADOW`.
- The model release remains `NOT_READY` and the model version remains
  `NO_APPROVED_MODEL`.
- No alert is suppressed, acknowledged, closed, assigned, or modified.
- No Jira issue is created or changed.
- No Slack or monitoring-source mutation is performed.
- Monitoring queries use a two-hour maximum window, 12-second source timeout,
  bounded retained evidence, short-lived safe query reuse, and a three-failure
  circuit breaker with a five-minute open interval.
- The live evaluation poller processes at most two pending alerts per 30-second
  cycle by default, with no overlapping cycle.

## Human review and metrics

Authenticated, authorized operators can confirm Noise, confirm an existing Jira
Incident, or mark an outcome Unknown. Outcomes are stored separately from
predictions with actor, time, reason, referenced evidence, and correction audit.
Predictions never become their own labels.

The immediate gold-review target is 30–50 real examples; the longer-term target
is 100–300. Incident and Noise metrics remain `INSUFFICIENT_SAMPLE` until at
least 30 independently confirmed records contain both classes. Probability and
calibration metrics remain unavailable while only the uncalibrated evidence
score exists.

## Primary APIs

- `GET /api/evaluation`
- `POST /api/evaluation/:alertId/run`
- `GET /api/evaluation/:alertId`
- `GET /api/evaluation/:alertId/evidence`
- `GET /api/evaluation/:alertId/decision`
- `GET /api/evaluation/:alertId/feedback`
- `POST /api/evaluation/:alertId/feedback` (authenticated operator + CSRF)
- `GET /api/evaluation/gold-dataset`
- `GET /api/model/performance`
- `GET /api/model/status`

The Phase 7 UI is available in Noise Analysis under the live evaluation view.

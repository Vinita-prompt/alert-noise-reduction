# Phase 3 — Feature engineering and training readiness

Phase 3 extends the preserved occurrence-level learning foundation. It does not train a model or create an automatic Noise/Incident decision.

## Semantic boundaries

- Alert classification describes the technical domain and subtype.
- Observed behavior describes source-supported duplicate, flapping, recovery, correlation, stale, expected-activity, or non-actionable-history evidence.
- Historical evidence describes preserved Jira/Slack/correlation relationships.
- Operational outcome is authenticated human feedback from Phase 2/2.5.
- Training readiness admits only explicit `CONFIRMED_INCIDENT` and `CONFIRMED_NOISE` outcomes as future label candidates.

`NO_OBSERVED_INCIDENT` remains unlabeled and never means Noise. Legacy classification remains excluded.

## Feature-time policy

The read-only training preview is a reproducible `T+0` snapshot. Its `feature_as_of` is the stored occurrence creation timestamp. It exposes source, identity, taxonomy, severity/priority, environment, signature, and strictly earlier historical counts.

Current-occurrence Jira Incident creation, final duration, resolution, resolver, current Problem linkage, later Slack activity, operator outcome, and all legacy classification fields are excluded from prediction-time input.

The feature shape supports future `T+5m`, `T+15m`, and `T+30m` snapshots without materializing them in this phase.

## Source temporal semantics

| Source | Stored record meaning | Temporal caution |
|---|---|---|
| AppDynamics | Operations alert or preserved AppDynamics-derived alert | Occurrence counts and last-seen can aggregate repeated notifications. |
| Grafana | Grafana rule occurrence represented through normalized storage | Last-seen can track later lifecycle refreshes. |
| Nagios | Host/service notification or Operations-wrapped notification | Long spans can be grouped notification histories. |
| JSM Operations | Canonical Operations alert occurrence | Operations count and lifecycle state are preserved when supplied. |
| Slack | Communication-derived alert/context record | Message activity is not a guaranteed monitoring episode. |
| ThousandEyes | Alert occurrence represented through stored ingestion | Test/agent aggregation may apply. |

Occurrence quality is therefore explicit: `RELIABLE`, `SOURCE_AGGREGATED`, `SUSPECT`, or `UNAVAILABLE`. Records are preserved even when temporal features are unsuitable for later training.

## Write safety

Technical taxonomy corrections reuse the Phase 2.5 signed session and CSRF boundary. Corrections are append-only, retain the original suggestion, and never change operational outcome. Unauthenticated or unauthorized writes fail closed.

## Read APIs

- `GET /api/noise-analysis/foundation`
- `GET /api/noise-analysis/foundation/summary`
- `GET /api/noise-analysis/foundation/training-preview`
- `GET /api/noise-analysis/foundation/features/audit`
- `GET /api/noise-analysis/foundation/:alertId`
- `GET /api/noise-analysis/foundation/:alertId/taxonomy`

The list API supports server-side domain, subtype, observed-behavior, and training-readiness filters in addition to the Phase 1/2 filters.

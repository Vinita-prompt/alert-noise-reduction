# Phase 1: Historical Learning Dataset

Phase 1 builds on the preserved Phase 0 data foundation. It does not restore the retired rule engine and does not train or emulate an ML model.

## Learning unit

`ONE_STORED_ALERT_OCCURRENCE` means one row from `alerts` becomes one learning record. Signatures and entities provide historical context only; they never collapse records and never assign an outcome.

Deterministic feature version: `alert-foundation-v1`  
Dataset version: `historical-learning-dataset-v1.1`

The migration `035_historical_learning_foundation.sql` adds deterministic message, signature, and entity-key columns, the trigger that maintains them, bounded-query indexes, and `historical_alert_learning_occurrences_v1`. No classifier output or label is stored by the migration.

## Historical outcomes

- `INCIDENT`: an explicit mapping or strong provenance-aware reconciliation connects the alert occurrence to a Jira Incident.
- `INCIDENT_UNLINKED`: a current Jira Incident has a probable occurrence candidate, but the relationship is not confirmed and is not a training label.
- `NO_OBSERVED_INCIDENT`: no Incident relationship was observed after preserved mappings and the latest reconciliation. This is never interpreted as Noise.
- `UNKNOWN`: relationship evidence is ambiguous, legacy/non-authoritative, or unresolved.

Each record carries the reason, matching method, matching source, timestamp, ambiguity flag, and evidence identifiers where available. Legacy classifications remain visible only as non-authoritative audit data.

## Feature windows

Correlation features use a bounded 1,800-second (30-minute) window. Previous-signature and previous-entity features use indexed occurrence timestamps. Missing evidence remains `null` or unavailable; it is not inferred.

## APIs

- `GET /api/noise-analysis/foundation` — paginated occurrence records, newest first.
- `GET /api/noise-analysis/foundation/summary` — outcome totals, match rate, data-quality audit, and breakdowns.
- `GET /api/noise-analysis/foundation/audit?range=all` — complete stored-history audit.
- `GET /api/noise-analysis/foundation/sample?limit=10` — at most ten representative real records.
- `GET /api/noise-analysis/foundation/:alertId` — occurrence detail and provenance.

Supported filters: time range, source, outcome, severity, priority, environment, service, application, Incident linked, Problem linked, and text search.

## Rolling 24-hour refresh

The UI is backed by stored PostgreSQL records. A bounded, read-only refresh can persist the latest Operations list payload without per-alert detail, child-resource, or Jira calls:

```bash
cd backend
npm run refresh:learning-dataset
```

This command performs no Atlassian mutation and starts no background polling. Existing full Operations ingestion behavior is unchanged unless `foundationOnly` is explicitly requested by this refresh.

## Jira Incident reconciliation

Migration `036_incident_alert_reconciliation.sql` adds auditable relationship evidence to the existing alert/Jira foundation. Confirmed, probable, ambiguous, and no-match results remain separate. Superseded runs are retained with `current = false`; stored alerts, Jira snapshots, and earlier mappings are not deleted.

Run the bounded reconciliation explicitly:

```bash
cd backend
npm run reconcile:learning-incidents
```

The command uses the existing Cloud-ID Jira read client, the project runtime timezone, and the same rolling 24-hour alert population as the dataset. It stores read-only Jira snapshots and local provenance only. It performs no Jira mutation and starts no polling.

## ML boundary

Every record reports `ML decision = PENDING` and `ML confidence = NOT_TRAINED`. There is no numerical ML confidence, Noise label, Incident prediction, deterministic fallback, or replacement classifier in Phase 1.

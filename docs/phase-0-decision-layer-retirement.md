# Phase 0: decision-layer retirement and data foundation

Date: 2026-08-24

## Current architecture

The current phase is **ingestion, feature extraction, and data foundation**.

- The rule-based Noise / Incident / Needs Review classifier is retired.
- Automatic classifier decisions are disabled for every new ingestion path.
- No replacement classifier, statistical decision engine, or ML model is active.
- Existing alert records, raw payloads, normalized fields, timestamps, occurrences, correlations, source identities, monitoring evidence, Jira data, Slack context, and deep links are preserved.
- Historical classifier outputs are retained as legacy audit data. They are not labels, truth data, or training targets.
- The recommended next phase is a Historical Learning Dataset spanning alerts, ACC Jira Incidents and Problems, Slack context, source evidence, correlations, identity mappings, and human-confirmed outcomes.

## A. Old classification components inventoried

### Active decision entry points before retirement

| Area | Components | Previous behavior |
|---|---|---|
| Core rules | `backend/src/services/classification.service.js` | Hard-coded Noise / Incident / Needs Review labels, confidence, type, and reason |
| Operations ingestion | `backend/src/services/atlassian/opsIngestion.service.js` | Classified normalized Operations alerts during persistence |
| Monitoring ingestion | `backend/src/services/monitoringIngestion.service.js` | Classified Grafana, AppDynamics, Nagios, and ThousandEyes alerts and synchronized derived incidents |
| Slack/Jira alert persistence | `backend/src/services/alert.service.js`, `backend/src/services/jira.service.js` | Created classifier-shaped records; exposed manual classification/process actions; Jira import classified stored alerts |
| Primary decision stack | `noiseAnalysis.service.js`, `noiseScoring.service.js`, `noiseActionability.service.js`, `canonicalAlertAssessment.service.js`, `operationalDecision.service.js` | Rule/scoring/actionability/canonical decisions returned at request time |
| Decision support | `decisionReadiness.service.js`, `evidenceCompletion.service.js`, `sourceIdentityCompletion.service.js`, `noiseReduction.service.js` | Evidence completion and reduction projections fed or triggered decisions |
| Source experiments | `noiseAppDynamicsDecisionPolicy.service.js`, `noiseAppDynamicsPositiveNoiseProof.service.js`, related AppDynamics noise services | Source-specific decision/proof experiments |
| Policy/config | `backend/src/config/noise*.js`, `canonicalAlertAssessmentPolicy.js`, `operationalDecisionPolicy.js`, `appDynamicsWorkflowPolicy.js` | Thresholds, weights, reasons, and decision policies |
| HTTP routes | `backend/src/routes/noiseAnalysis.routes.js`, alert classify/process routes, rule mutation routes, source-identity completion route | Exposed automatic/manual decision and diagnostic APIs |
| Frontend | former `frontend/src/pages/NoiseAnalysisDemo.jsx`; legacy `Alerts.jsx`, `NoiseRules.jsx`, dashboard classification widgets and old API clients | Presented classifier labels, likelihoods, reduction, rules, and decision explanations |
| Database | `alerts.classification/noise_type/confidence_score/noise_reason/classification_reason`, `alert_classification_history`, `operational_decision_audit`, `noise_rules` | Stored derived labels, rationale, decisions, and rule state |

No scheduled classifier worker was found. Existing background jobs are integration polling, ingestion, and escalation jobs. The previous classification triggers were ingestion code paths, explicit alert classify/process requests, Jira import, and request-time Noise Analysis services.

### Preserved reusable infrastructure

- Operations, Slack, Jira, AppDynamics, Grafana, Nagios, and ThousandEyes clients and routes.
- `raw_alerts` and normalized `alerts` records, including source IDs, raw payload links, timestamps, occurrences, severity/priority, service, team, environment, owner, tags, and lifecycle data.
- `alert_correlation_history`, correlation signatures/keys, and incident mappings.
- Source identity entities, aliases, candidates, review state, and monitoring inventory lookups.
- Evidence packages, acquisition provenance, event reconstruction, telemetry semantics, and source-side diagnostics as historical/reusable data.
- Jira Incidents and Problems, comments/changelog/worklog/link read models, Slack messages/threads/replies/context, and monitoring-source deep links.

## B. What is disabled

- `classification.service.classifyAlert` fails closed with `LEGACY_DECISION_LAYER_RETIRED`.
- Alert `classify`, `process`, and decision action service paths fail before querying or mutating data.
- Operations, Slack, Jira, and monitoring ingestion do not invoke a classifier.
- New alerts are stored as `unclassified`, with no confidence/reason and nested state `not_evaluated`.
- Existing alert upserts preserve historical classifier fields instead of recalculating them.
- The old `/api/noise-analysis/*` decision, scoring, actionability, reduction, evidence-completion, enrichment, feedback, and source-validation endpoints return HTTP 410.
- Source-identity completion, rule updates, and rule status mutations return HTTP 410.
- All persisted noise rules are paused and retired.
- Old detail URLs redirect to the foundation page. No live UI imports the retired client functions.

The source files remain isolated as rollback/audit reference; they are not reachable from active ingestion or route dependencies.

## C. Preserved data and integrations

The migration and code changes do not delete alerts, raw alerts, classification history, correlation history, incidents, mappings, evidence, identities, rules, or decision audit records. External integrations and their workspaces remain unchanged. Live Alerts remains an Operations-authoritative, Slack-context read model and does not consume the retired classifier.

## D. Database migration and baseline

Migration: `backend/src/db/migrations/034_retire_legacy_decision_layer.sql`

Additive changes:

- Adds `alerts.classification_is_legacy`; all previously derived alert labels are marked legacy.
- Adds `alert_classification_history.is_legacy` and `operational_decision_audit.is_legacy`.
- Adds `noise_rules.retired_at` and `retirement_reason`; all rules are paused/retired.
- Adds `normalization_failed` to the raw-alert processing status constraint while preserving the old `classification_failed` value for history.
- Changes schema defaults for new alerts to `unclassified`; no historical label value is rewritten.

Live baseline immediately before migration:

| Dataset | Rows |
|---|---:|
| alerts | 133,137 |
| raw_alerts | 303,750 |
| alert_classification_history | 11,174 |
| alert_correlation_history | 11,175 |
| incidents | 49 |
| alert_incident_mappings | 5,134 |
| noise_rules | 6 |
| source_identity_entities | 37 |
| source_identity_decisions | 0 |
| noise_evidence_packages | 388 |
| noise_evidence_acquisition_runs | 20 |
| operational_decision_audit | 482 |

Historical alert labels at the baseline: 49 `incident`, 129,000 `needs_review`, and 4,088 `noise`. After migration all 133,137 are preserved and explicitly marked legacy. All six former rules are preserved, paused, and marked retired.

## E. Current API boundary

Available foundation endpoints:

- `GET /api/noise-analysis`
- `GET /api/noise-analysis/status`
- `GET /api/noise-analysis/foundation`
- `GET /api/noise-analysis/foundation/:groupId`

The first two expose explicit phase/retirement state. Foundation endpoints group Operations alert occurrences using deterministic source identity and return source/timing/occurrence data without business decisions.

Legacy decision endpoints return HTTP 410 with `LEGACY_DECISION_LAYER_RETIRED`. Alert responses may still include historical labels only with `classificationLegacy: true`, `classificationState: legacy_non_authoritative`, and `legacyClassification`; they are not actionable decisions.

## F. Frontend boundary

The former Noise Analysis operator classifier has been replaced by a simple **Data Foundation** page. It shows:

- old decision layer retired;
- automatic decisions off;
- no replacement ML/classifier;
- ingestion and foundation counts;
- preserved reusable datasets;
- legacy outputs explicitly non-authoritative;
- Historical Learning Dataset as the recommended next phase.

There are no classifier scores, predictions, synthetic labels, or replacement decision rules on this page.

## Rollback baseline

This workspace had no Git repository, commit, or branch at retirement time, so no commit identifier can be truthfully recorded. A secret-free source archive was created instead:

- Archive: `artifacts/phase0-pre-retirement-source-20260824.tar.gz`
- SHA-256: `ef80ffcda7c02ef91cf8d3fad10c43461f544c86e7405eed4ff21767b8d7484c`
- Excludes `.env`, private keys/certificates, `node_modules`, and build output.

Rollback procedure:

1. Stop the application.
2. Copy the current source and database backup to a separate recovery location.
3. Restore only the required source files from the archive; do not extract over an unreviewed workspace.
4. If the former runtime is deliberately restored, restore the six rule statuses from the recorded pre-migration state: duplicate active, flapping active, auto-resolved active, non-actionable draft, correlated active, stale paused.
5. The additive legacy-marker and retirement columns may safely remain. Do not delete historical rows or blindly clear legacy markers.
6. Run the complete tests and validate ingestion/read-only integration routes before restarting polling.

This is a rollback mechanism, not permission to reactivate the retired classifier as an authoritative production decision layer.

## Recommended next phase

Build a **Historical Learning Dataset** before designing any new classifier. Define source-of-truth outcomes and provenance; join alerts to Jira Incidents/Problems, Slack investigation context, monitoring evidence, source identity, correlations, and human-confirmed resolution data; measure missingness and bias; keep legacy classifier outputs excluded from labels. Only after dataset review should model/decision design begin.

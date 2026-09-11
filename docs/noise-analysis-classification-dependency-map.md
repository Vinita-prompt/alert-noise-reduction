# Noise Analysis classification dependency map

> **Retired on 2026-08-24.** This document is a pre-retirement dependency inventory, not the current runtime design. The common decision engine and every legacy classifier described below are isolated from active routes and ingestion. See [`phase-0-decision-layer-retirement.md`](phase-0-decision-layer-retirement.md) for the authoritative interim architecture.

This map records the dependency boundary inspected before the controlled classification refactor. It is intentionally implementation-facing and belongs in Technical Diagnostics documentation, not the operator decision model.

## Preserved infrastructure

| Capability | Primary files | Consumers / dependency direction | Refactor status |
|---|---|---|---|
| JSM Operations | `backend/src/services/atlassian/operationsLiveAlerts.service.js`, `opsIngestion.service.js`, `jsmOps.service.js`, `backend/src/routes/operations.routes.js` | Operations alerts feed Live Alerts and the 24-hour Noise Analysis denominator | Keep unchanged |
| Slack | `slack.service.js`, `slackIngestion.service.js`, `slackAlertStore.service.js`, `slackAlertNormalizer.service.js`, `slackAlertPolling.service.js` | Shared evidence adapter reads normalized messages/threads; Live Alerts uses Slack as context | Keep unchanged |
| ACC Jira | `atlassian/accJiraRead.service.js`, `jira.service.js`, Jira routes/controllers | Shared evidence adapter performs read-only Incident/Problem correlation | Keep unchanged |
| AppDynamics | `appDynamics.service.js`, `appDynamics.routes.js` | Shared adapter, evidence enrichment, event reconstruction, and source workspace | Keep unchanged |
| Grafana | `grafanaDashboard.service.js`, Grafana routes/controller | Shared adapter and Grafana workspace | Keep unchanged |
| Nagios | `nagios.service.js`, Nagios routes/controller | Shared adapter and DC01/DC02 workspace | Keep unchanged |
| ThousandEyes | `thousandEyes.service.js`, `thousandEyesWorkspace.service.js`, ThousandEyes routes/controller | Shared adapter and v7 workspace; secondary diagnostic stays isolated | Keep unchanged |
| Source adapters | `sourceEvidenceAdapters.service.js` | Called by evidence/source-validation services; bridges all monitoring sources plus Jira and Slack | Keep unchanged; no duplicate adapters |
| Source identity | `sourceIdentity.service.js`, `config/sourceIdentity.js`, migration `029_source_identity_registry.sql` | Used by source validation, enrichment, acquisition, and AppDynamics evidence | Keep unchanged; identity never decides Incident/Noise |
| Evidence collection | `noiseEvidence.service.js`, `noiseEvidenceAcquisition.service.js`, `noiseEvidenceQueue.service.js`, `noiseSourceValidation.service.js` | Uses source identity and shared adapters, bounded concurrency 3, bounded windows, caching, timeout diagnostics | Keep unchanged |
| Evidence enrichment/persistence | `noiseEvidenceEnrichment.service.js`, migrations `030_noise_evidence_acquisition.sql`, `031_appdynamics_identity_registry.sql` | Restores persisted evidence packages and produces safe normalized evidence | Keep unchanged |
| Telemetry semantics | `noiseAppDynamicsTelemetrySemantics.service.js` and source-specific adapter normalizers | Validates source/entity/metric/time semantics before classification | Keep unchanged |
| Event reconstruction | `noiseAppDynamicsEventReconstruction.service.js`, migration `032_appdynamics_event_reconstruction.sql` | Reuses persisted evidence to describe AppDynamics events and notification association | Keep as evidence infrastructure; output is not the final business decision |
| Audit/persistence | Evidence tables above plus local snapshot stores and append-only decision audit tables | Restart restoration, provenance, model timestamps, and decision history | Keep; never delete evidence or audit history |

## Legacy / diagnostic classifiers

| Legacy capability | Files | Current dependencies | Refactor disposition |
|---|---|---|---|
| Noise score / duplicate / recurring / flapping / auto-resolution | `noiseAnalysis.service.js`, `noiseScoring.service.js`, matching configs | Feeds actionability, history, evidence diagnostics, and reduction simulation | Freeze; diagnostic only |
| Actionability heuristics | `noiseActionability.service.js`, `config/noiseActionability.js` | Feeds enrichment and current operational-signal snapshot | Freeze; may prepare evidence but cannot be the authoritative operator decision |
| Operational signal classification | `noiseOperationalSignal.service.js`, `config/noiseOperationalSignal.js` | Groups notifications/events and currently assigns useful/redundant/non-actionable/review labels | Preserve event/evidence projection; old labels become comparison diagnostics |
| Historical analysis | `noiseHistory.service.js`, `config/noiseHistory.js` | Pattern investigation and trend context | Keep for context; history alone cannot classify today's alerts |
| Reduction simulation | `noiseReduction.service.js`, `config/noiseReduction.js` | Threshold and conservative/opportunity projections | Freeze under Legacy Diagnostics; remove from primary view |
| Evidence-gap diagnostics | `noiseEvidenceGap.service.js`, `config/noiseEvidenceGap.js` | Maps missing source/mapping/telemetry states | Keep as diagnostics; normalized gaps can support `NEEDS_REVIEW` explanations |
| AppDynamics decision experiments | `noiseAppDynamicsDecisionPolicy.service.js`, `noiseAppDynamicsPositiveNoiseProof.service.js`, related config | AppDynamics-only explainability workspace | Preserve for comparison; the new common engine is authoritative |

## API and UI boundary

- Existing `/api/noise-analysis/*` evidence, enrichment, acquisition, source-validation, operational-signal, AppDynamics, history, and reduction endpoints stay available.
- A new read-only `/api/noise-analysis/decisions` endpoint is the primary operator decision API.
- Existing old classifiers and score/reduction APIs are loaded only from collapsed Technical Diagnostics.
- `frontend/src/pages/NoiseAnalysisDemo.jsx` remains the route component, but its primary screen consumes the common decision API and shows only `INCIDENT`, `NOISE`, and `NEEDS_REVIEW`.
- Live Alerts and every source workspace retain their existing routes and data paths.

## New dependency direction

```text
External read-only integrations
  -> shared source adapters
  -> deterministic source identity
  -> bounded evidence acquisition + persisted evidence packages
  -> telemetry/event normalization and reusable event reconstruction
  -> common evidence model + common OperationalEvent model
  -> source-neutral operationalDecision.service
  -> /noise-analysis/decisions
  -> primary Noise Analysis operator UI

Legacy scoring/actionability/reduction
  -> Technical / Legacy Diagnostics only
```

The new decision engine must never import or evaluate Noise Likelihood, Review Risk, Correlation Confidence, scoring weights, threshold reduction, acknowledgement penalties, generic duplicate/recurring labels, or absence of Jira/Slack as decision rules.

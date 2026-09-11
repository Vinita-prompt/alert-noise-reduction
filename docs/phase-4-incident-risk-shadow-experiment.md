# Phase 4 — Incident-risk shadow experiment

Phase 4 is an offline Positive-Unlabeled learning experiment. It does not make an operational decision and is not imported by ingestion, alert-processing, Jira, Slack, Operations, or monitoring paths.

## Population contract

- Positive Tier A: authenticated `CONFIRMED_INCIDENT`, explicit alert-to-Incident mapping, or confirmed deterministic reconciliation.
- Positive Tier B: probable deterministic reconciliation. Tier B remains separate and is not trained as Tier A.
- Unlabeled: `NO_INCIDENT_OBSERVED` with no confirmed operational outcome. Unlabeled never means Noise.
- Confirmed negative: authenticated `CONFIRMED_NOISE`, if one exists in the future.
- Excluded: suspect occurrences, temporally unsafe source-aggregated occurrences, ambiguous/unknown evidence, Tier B from primary fitting, and snapshots that cannot be reconstructed safely.

The T+0 feature export includes only source/context, technical taxonomy, severity/priority, and strictly-earlier historical features. Current Incident linkage, current Incident reconciliation, resolution, resolver, final duration, current Problem linkage, later Slack data, operational outcome, and legacy decision fields are excluded.

## Experiment implementation

LightGBM was attempted first. Its macOS wheel requires a machine-wide `libomp` runtime that is not installed. To avoid changing the host runtime, the experiment uses the pinned `scikit-learn==1.6.1` `HistGradientBoostingClassifier` fallback.

The implemented comparisons are:

- naive positive-vs-unlabeled benchmark;
- class-weighted positive-vs-unlabeled benchmark;
- repeated-subsample bagging PU;
- source-only baseline;
- signature historical-rate baseline;
- source/service historical-rate baseline;
- without-source ablation;
- without-identity ablation.

The PU ensemble uses 12 deterministic bags, all training Tier A positives, 40 sampled unlabeled records per positive per bag, and seed `20260824`.

## Evaluation result

The full feature experiment showed material identity leakage from the `ABC Command Center` application. The leakage-controlled primary experiment excludes entity, application, and service identifiers.

Although the leakage-controlled held-out proxy metrics show enrichment, the experiment fails deployment sanity because:

- full-versus-without-identity PR-AUC differs materially;
- the current known Incident-evidence records have zero recall in the top 20%;
- validation score regions are degenerate and do not support useful high/intermediate/low boundaries;
- only 41 Tier A positives exist and there are no confirmed Noise negatives.

Therefore current 24-hour shadow scores are not published to the UI and no candidate threshold is activated.

## Artifact isolation

Each run writes a new directory under `backend/artifacts/ml-shadow/<experiment-id>` and inserts append-only metadata and held-out predictions into:

- `ml_shadow_experiments`
- `ml_shadow_predictions`

Predictions never update `alerts`, historical outcomes, operational outcomes, taxonomy corrections, or legacy classifications. The running application exposes metadata through a read-only endpoint but never imports `model.joblib`.

## Commands

Install the isolated dependencies:

```bash
python3 -m venv .venv-phase4
.venv-phase4/bin/python -m pip install -r ml/requirements-phase4.txt
```

Run a new append-only experiment:

```bash
npm run experiment:incident-risk -- phase4-<unique-id>
```

The final Phase 4 artifact is `phase4-final-shadow-20260824`. It is explicitly `SHADOW_EXPERIMENT_ONLY` and failed the promotion sanity gate.

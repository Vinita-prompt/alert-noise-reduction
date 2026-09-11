#!/usr/bin/env python3
"""Offline-only Phase 4 Positive-Unlabeled Incident-risk experiment."""

import argparse
import hashlib
import json
import math
import os
import platform
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OrdinalEncoder


SEED = 20260824
PURGE_GAP = timedelta(minutes=30)
PU_BAGS = 12
PU_UNLABELED_PER_POSITIVE = 40
FEATURE_SCHEMA_VERSION = "incident-risk-t0-v1"
TAXONOMY_VERSION = "structured-text-taxonomy-v1"
MODEL_FAMILY = "sklearn.HistGradientBoostingClassifier"

CATEGORICAL_FEATURES = [
    "normalized_source",
    "entity",
    "application",
    "service",
    "environment",
    "severity",
    "priority",
    "taxonomy_domain",
    "taxonomy_subtype",
]

NUMERIC_FEATURES = [
    "taxonomy_confidence",
    "occurrence_count_so_far",
    "duration_so_far_seconds",
    "related_alerts_observed_so_far",
    "cross_source_activity_observed_so_far",
    "previous_same_signature_count",
    "previous_same_entity_count",
    "previous_same_service_count",
    "previous_incident_evidence_count",
    "previous_confirmed_incident_count",
    "previous_confirmed_noise_count",
    "historical_incident_association_rate",
    "recurrence_interval_seconds",
]

COUNT_FEATURES = [
    "previous_same_signature_count",
    "previous_same_entity_count",
    "previous_same_service_count",
    "previous_incident_evidence_count",
    "previous_confirmed_incident_count",
    "previous_confirmed_noise_count",
    "recurrence_interval_seconds",
]

POST_OUTCOME_EXCLUDED = [
    "current_occurrence_jira_incident",
    "current_incident_key",
    "current_incident_creation_timestamp",
    "final_resolution",
    "final_resolver",
    "final_duration",
    "current_problem_linkage",
    "future_slack_incident_links",
    "operator_confirmed_outcome",
    "legacy_classification",
    "legacy_confidence",
    "historical_outcome_string",
    "current_incident_match_confidence",
    "current_incident_reconciliation_result",
]


def json_safe(value):
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if pd.isna(value):
        return None
    return value


def write_json(path, payload):
    path.write_text(json.dumps(payload, default=json_safe, indent=2) + "\n", encoding="utf-8")


def read_population(path):
    frame = pd.read_json(path, lines=True)
    frame["feature_as_of"] = pd.to_datetime(frame["feature_as_of"], utc=True, errors="coerce")
    for column in CATEGORICAL_FEATURES:
        frame[column] = frame[column].fillna("__MISSING__").astype(str)
    for column in NUMERIC_FEATURES:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame["cross_source_activity_observed_so_far"] = (
        frame["cross_source_activity_observed_so_far"].fillna(False).astype(int)
    )
    for column in COUNT_FEATURES:
        frame[column] = np.log1p(frame[column].clip(lower=0))
    return frame


def select_boundaries(candidates):
    positives = candidates.loc[candidates.learning_tier == "TIER_A", "feature_as_of"].sort_values()
    if len(positives) < 15:
        raise RuntimeError("No defensible temporal experiment: fewer than 15 Tier A positives remain.")
    first_index = max(1, math.ceil(len(positives) * 0.50)) - 1
    second_index = max(first_index + 1, math.ceil(len(positives) * 0.75)) - 1
    train_boundary = positives.iloc[first_index]
    validation_boundary = positives.iloc[min(second_index, len(positives) - 2)]
    return train_boundary, validation_boundary


def temporal_split(candidates):
    train_boundary, validation_boundary = select_boundaries(candidates)
    split = pd.Series("PURGED", index=candidates.index, dtype="object")
    split.loc[candidates.feature_as_of < train_boundary - PURGE_GAP] = "TRAIN"
    split.loc[
        (candidates.feature_as_of > train_boundary + PURGE_GAP)
        & (candidates.feature_as_of < validation_boundary - PURGE_GAP)
    ] = "VALIDATION"
    split.loc[candidates.feature_as_of > validation_boundary + PURGE_GAP] = "TEST"
    candidates = candidates.copy()
    candidates["split"] = split
    usable = candidates[candidates.split != "PURGED"]
    for name in ["TRAIN", "VALIDATION", "TEST"]:
        positives = int(((usable.split == name) & (usable.learning_tier == "TIER_A")).sum())
        if positives < 3:
            raise RuntimeError(f"No defensible temporal experiment: {name} contains only {positives} Tier A positives.")
    return candidates, train_boundary, validation_boundary


def model_pipeline(feature_names, class_weight=None, seed=SEED):
    categorical = [name for name in CATEGORICAL_FEATURES if name in feature_names]
    numeric = [name for name in NUMERIC_FEATURES if name in feature_names]
    transformer = ColumnTransformer(
        [
            (
                "categorical",
                OrdinalEncoder(
                    handle_unknown="use_encoded_value",
                    unknown_value=-1,
                    encoded_missing_value=-1,
                    min_frequency=10,
                    max_categories=128,
                ),
                categorical,
            ),
            ("numeric", SimpleImputer(strategy="median", add_indicator=True), numeric),
        ],
        sparse_threshold=0,
        verbose_feature_names_out=False,
    )
    categorical_mask = [True] * len(categorical) + [False] * len(numeric)
    # Imputer indicators, when produced, are numeric. Missing numeric values are rare;
    # fit below adjusts the mask after preprocessing if indicators are added.
    estimator = HistGradientBoostingClassifier(
        learning_rate=0.06,
        max_iter=160,
        max_leaf_nodes=15,
        max_depth=5,
        min_samples_leaf=20,
        l2_regularization=1.0,
        class_weight=class_weight,
        random_state=seed,
        early_stopping=False,
    )
    return Pipeline([("features", transformer), ("model", estimator)]), categorical_mask


def fit_pipeline(frame, labels, feature_names, class_weight=None, seed=SEED):
    pipeline, categorical_mask = model_pipeline(feature_names, class_weight, seed)
    transformed = pipeline.named_steps["features"].fit_transform(frame[feature_names], labels)
    if transformed.shape[1] > len(categorical_mask):
        categorical_mask += [False] * (transformed.shape[1] - len(categorical_mask))
    pipeline.named_steps["model"].set_params(categorical_features=categorical_mask)
    pipeline.named_steps["model"].fit(transformed, labels)
    return pipeline


def fit_pu_bagging(train, feature_names, seed=SEED):
    positive = train[train.learning_tier == "TIER_A"]
    unlabeled = train[train.learning_tier.isin(["UNLABELED", "CONFIRMED_NEGATIVE"])]
    if positive.empty:
        raise RuntimeError("Tier A positive population is empty.")
    bag_size = min(len(unlabeled), len(positive) * PU_UNLABELED_PER_POSITIVE)
    models = []
    samples = []
    for bag in range(PU_BAGS):
        sampled_unlabeled = unlabeled.sample(n=bag_size, random_state=seed + bag, replace=False)
        sample = pd.concat([positive, sampled_unlabeled]).sort_values("feature_as_of")
        labels = (sample.learning_tier == "TIER_A").astype(int)
        models.append(fit_pipeline(sample, labels, feature_names, seed=seed + bag))
        samples.append({"bag": bag + 1, "positives": len(positive), "unlabeled": len(sampled_unlabeled)})
    return models, samples


def predict_ensemble(models, frame, feature_names):
    if frame.empty:
        return np.array([], dtype=float)
    scores = [model.predict_proba(frame[feature_names])[:, 1] for model in models]
    return np.mean(np.vstack(scores), axis=0)


def ranking_metrics(labels, scores):
    labels = np.asarray(labels, dtype=int)
    scores = np.asarray(scores, dtype=float)
    positives = max(1, int(labels.sum()))
    prevalence = float(labels.mean()) if len(labels) else 0.0
    result = {}
    for fraction in [0.05, 0.10, 0.20]:
        count = max(1, int(math.ceil(len(scores) * fraction)))
        top = np.argsort(scores)[::-1][:count]
        found = int(labels[top].sum())
        precision = found / count
        recall = found / positives
        key = str(int(fraction * 100))
        result[f"precisionAt{key}Pct"] = precision
        result[f"recallAt{key}Pct"] = recall
        result[f"liftAt{key}Pct"] = precision / prevalence if prevalence else None
    return result


def calibration_error(labels, scores, bins=10):
    labels = np.asarray(labels, dtype=int)
    scores = np.asarray(scores, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    error = 0.0
    curve = []
    for lower, upper in zip(edges[:-1], edges[1:]):
        selected = (scores >= lower) & (scores <= upper if upper == 1 else scores < upper)
        if not selected.any():
            continue
        observed = float(labels[selected].mean())
        predicted = float(scores[selected].mean())
        weight = float(selected.mean())
        error += weight * abs(observed - predicted)
        curve.append({"lower": lower, "upper": upper, "scoreMean": predicted, "observedPositiveRate": observed, "count": int(selected.sum())})
    return error, curve


def choose_thresholds(labels, scores):
    precision, recall, thresholds = precision_recall_curve(labels, scores)
    if len(thresholds):
        f1 = 2 * precision[:-1] * recall[:-1] / np.maximum(precision[:-1] + recall[:-1], 1e-12)
        high = float(thresholds[int(np.nanargmax(f1))])
    else:
        high = float(np.max(scores))
    positive_scores = np.sort(np.asarray(scores)[np.asarray(labels) == 1])
    low = float(positive_scores[0]) if len(positive_scores) else float(np.quantile(scores, 0.25))
    if high <= low:
        high = float(np.median(positive_scores)) if len(positive_scores) else float(np.quantile(scores, 0.75))
    if high <= low:
        low = float(np.nextafter(high, 0.0))
    separation = high - low
    return {"highBoundary": high, "lowBoundary": low, "intermediateRegion": [low, high], "scoreSeparation": separation, "usable": bool(separation >= 1e-6), "derivation": "High maximizes validation proxy F1; low is the minimum validation Tier A score, preserving all observed positives above the low region. Degenerate regions are rejected."}


def score_band(score, thresholds):
    if score >= thresholds["highBoundary"]:
        return "HIGH_INCIDENT_LIKENESS"
    if score < thresholds["lowBoundary"]:
        return "LOW_INCIDENT_LIKENESS"
    return "INTERMEDIATE"


def evaluate(labels, scores, threshold):
    labels = np.asarray(labels, dtype=int)
    predicted = (np.asarray(scores) >= threshold).astype(int)
    matrix = confusion_matrix(labels, predicted, labels=[0, 1])
    ece, curve = calibration_error(labels, scores)
    result = {
        "population": len(labels),
        "knownPositives": int(labels.sum()),
        "proxyPrevalence": float(labels.mean()) if len(labels) else 0.0,
        "precision": precision_score(labels, predicted, zero_division=0),
        "recall": recall_score(labels, predicted, zero_division=0),
        "f1": f1_score(labels, predicted, zero_division=0),
        "prAuc": average_precision_score(labels, scores) if labels.sum() else None,
        "rocAuc": roc_auc_score(labels, scores) if 0 < labels.sum() < len(labels) else None,
        "confusionMatrix": {"tn": int(matrix[0, 0]), "fp": int(matrix[0, 1]), "fn": int(matrix[1, 0]), "tp": int(matrix[1, 1])},
        "experimentalThreshold": float(threshold),
        "proxyCalibrationError": ece,
        "calibrationCurve": curve,
        "calibrationStatus": "NOT_PROBABILITY_CALIBRATED_PU_LABELS_UNCERTAIN",
    }
    result.update(ranking_metrics(labels, scores))
    return result


def historical_baseline_scores(train, target, kind):
    if kind == "signature":
        return target.historical_incident_association_rate.fillna(0).to_numpy(float)
    columns = ["normalized_source", "service"] if kind == "source_service" else ["normalized_source"]
    stats = train.assign(_positive=(train.learning_tier == "TIER_A").astype(int)).groupby(columns, dropna=False)._positive.agg(["sum", "count"])
    global_rate = max(float((train.learning_tier == "TIER_A").mean()), 1e-9)
    rates = (stats["sum"] + 1.0) / (stats["count"] + 20.0)
    keys = pd.MultiIndex.from_frame(target[columns]) if len(columns) > 1 else target[columns[0]]
    return np.asarray([float(rates.get(key, global_rate)) for key in keys], dtype=float)


def permutation_importance(models, validation, feature_names, seed=SEED):
    positives = validation[validation.learning_tier == "TIER_A"]
    unlabeled = validation[validation.learning_tier != "TIER_A"]
    sampled = pd.concat([positives, unlabeled.sample(n=min(5000, len(unlabeled)), random_state=seed)]).sort_values("feature_as_of")
    labels = (sampled.learning_tier == "TIER_A").astype(int).to_numpy()
    baseline = average_precision_score(labels, predict_ensemble(models, sampled, feature_names))
    rng = np.random.default_rng(seed)
    importance = []
    for feature in feature_names:
        permuted = sampled.copy()
        permuted[feature] = rng.permutation(permuted[feature].to_numpy())
        score = average_precision_score(labels, predict_ensemble(models, permuted, feature_names))
        importance.append({"feature": feature, "permutationPrAucDecrease": float(baseline - score)})
    return sorted(importance, key=lambda item: item["permutationPrAucDecrease"], reverse=True)


def safe_record(row, score, factors=None):
    return {
        "alertId": row.alert_id,
        "source": row.source,
        "service": None if row.service == "__MISSING__" else row.service,
        "application": None if row.application == "__MISSING__" else row.application,
        "domain": row.taxonomy_domain,
        "subtype": row.taxonomy_subtype,
        "featureAsOf": row.feature_as_of,
        "score": float(score),
        "topFactors": factors or [],
    }


def reference_values(train, feature_names):
    result = {}
    for feature in feature_names:
        series = train[feature]
        if feature in CATEGORICAL_FEATURES:
            mode = series.mode(dropna=True)
            result[feature] = mode.iloc[0] if len(mode) else "__MISSING__"
        else:
            result[feature] = float(series.median()) if series.notna().any() else 0.0
    return result


def local_explanation(models, row, feature_names, references, limit=5):
    one = pd.DataFrame([row])[feature_names]
    original = float(predict_ensemble(models, one, feature_names)[0])
    factors = []
    for feature in feature_names:
        changed = one.copy()
        changed.at[changed.index[0], feature] = references[feature]
        without = float(predict_ensemble(models, changed, feature_names)[0])
        factors.append({
            "feature": feature,
            "value": json_safe(row[feature]),
            "reference": json_safe(references[feature]),
            "scoreContribution": original - without,
        })
    return sorted(factors, key=lambda item: abs(item["scoreContribution"]), reverse=True)[:limit]


def representative_errors(test, scores, threshold, models, feature_names, references):
    work = test.copy()
    work["_score"] = scores
    positives = work[work.learning_tier == "TIER_A"]
    unlabeled = work[work.learning_tier != "TIER_A"]

    def records(frame, ascending, limit=5):
        selected = frame.sort_values("_score", ascending=ascending).head(limit)
        output = []
        for _, row in selected.iterrows():
            factors = local_explanation(models, row, feature_names, references)
            output.append(safe_record(row, row._score, factors))
        return output

    source_failures = []
    for source, group in work.groupby("normalized_source"):
        source_failures.append({
            "source": source,
            "population": int(len(group)),
            "knownPositives": int((group.learning_tier == "TIER_A").sum()),
            "falseNegativeLike": int(((group.learning_tier == "TIER_A") & (group._score < threshold)).sum()),
            "highScoringUnlabeled": int(((group.learning_tier != "TIER_A") & (group._score >= threshold)).sum()),
        })
    return {
        "highestScoringUnlabeled": records(unlabeled, False),
        "lowestScoringKnownPositives": records(positives, True),
        "falseNegativeLike": records(positives[positives._score < threshold], True),
        "falsePositiveLike": records(unlabeled[unlabeled._score >= threshold], False),
        "taxonomyUnknownFailures": records(work[(work.taxonomy_domain == "UNKNOWN_DOMAIN") & (((work.learning_tier == "TIER_A") & (work._score < threshold)) | ((work.learning_tier != "TIER_A") & (work._score >= threshold)))], False),
        "identityMissingFailures": records(work[(work.entity == "__MISSING__") & (((work.learning_tier == "TIER_A") & (work._score < threshold)) | ((work.learning_tier != "TIER_A") & (work._score >= threshold)))], False),
        "sourceSpecificFailures": sorted(source_failures, key=lambda item: item["falseNegativeLike"] + item["highScoringUnlabeled"], reverse=True),
    }


def source_audit(frame):
    grouped = frame.groupby("normalized_source", dropna=False).learning_tier.agg(
        total="count",
        tierA=lambda values: int((values == "TIER_A").sum()),
        tierB=lambda values: int((values == "TIER_B").sum()),
        unlabeled=lambda values: int((values == "UNLABELED").sum()),
    ).reset_index()
    grouped["observedTierARate"] = grouped.tierA / grouped.total
    return grouped.sort_values("total", ascending=False).to_dict(orient="records")


def prediction_payload(frame, scores, thresholds, importance, split_name):
    factor_names = [item["feature"] for item in importance[:5]]
    output = []
    for (_, row), score in zip(frame.iterrows(), scores):
        factors = [{"feature": feature, "value": json_safe(row[feature]), "globalPermutationImportance": next(item["permutationPrAucDecrease"] for item in importance if item["feature"] == feature)} for feature in factor_names]
        output.append({
            "alertId": row.alert_id,
            "featureAsOf": row.feature_as_of,
            "incidentRiskScore": float(score),
            "scoreBand": score_band(float(score), thresholds),
            "datasetSplit": split_name,
            "explanation": {
                "method": "MODEL_FEATURE_PERMUTATION_IMPORTANCE",
                "topFactors": factors,
                "experimental": True,
                "automatedAction": False,
            },
        })
    return output


def run(args):
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False)
    population = read_population(args.population)
    audit = {
        "totalStoredRecords": int(len(population)),
        "exclusions": population.exclusion_reason.fillna("INCLUDED").value_counts().to_dict(),
        "tierCountsBeforeExclusion": population.learning_tier.value_counts().to_dict(),
    }
    candidates = population[population.exclusion_reason.isna()].copy()
    if int((candidates.learning_tier == "TIER_A").sum()) == 0:
        raise RuntimeError("No defensible Tier A positive population can be constructed.")
    candidates, train_boundary, validation_boundary = temporal_split(candidates)
    train = candidates[candidates.split == "TRAIN"].copy()
    validation = candidates[candidates.split == "VALIDATION"].copy()
    test = candidates[candidates.split == "TEST"].copy()

    full_features = CATEGORICAL_FEATURES + NUMERIC_FEATURES
    no_source_features = [name for name in full_features if name != "normalized_source"]
    no_identity_features = [name for name in full_features if name not in ["entity", "application", "service"]]

    train_labels = (train.learning_tier == "TIER_A").astype(int)
    naive = fit_pipeline(train, train_labels, full_features, class_weight=None, seed=SEED)
    weighted = fit_pipeline(train, train_labels, full_features, class_weight="balanced", seed=SEED)
    source_only = fit_pipeline(train, train_labels, ["normalized_source"], class_weight="balanced", seed=SEED)
    pu_full_models, bag_samples = fit_pu_bagging(train, full_features, seed=SEED)
    pu_without_source, _ = fit_pu_bagging(train, no_source_features, seed=SEED + 100)
    pu_without_identity, _ = fit_pu_bagging(train, no_identity_features, seed=SEED + 200)
    primary_models = pu_without_identity
    primary_features = no_identity_features

    validation_labels = (validation.learning_tier == "TIER_A").astype(int).to_numpy()
    test_labels = (test.learning_tier == "TIER_A").astype(int).to_numpy()
    validation_scores = predict_ensemble(primary_models, validation, primary_features)
    thresholds = choose_thresholds(validation_labels, validation_scores)
    threshold = thresholds["highBoundary"]

    model_scores = {
        "naivePositiveVsUnlabeled": naive.predict_proba(test[full_features])[:, 1],
        "classWeightedPositiveVsUnlabeled": weighted.predict_proba(test[full_features])[:, 1],
        "baggingPUFull": predict_ensemble(pu_full_models, test, full_features),
        "baggingPULeakageControlled": predict_ensemble(primary_models, test, primary_features),
        "sourceOnly": source_only.predict_proba(test[["normalized_source"]])[:, 1],
        "withoutSource": predict_ensemble(pu_without_source, test, no_source_features),
        "withoutIdentity": predict_ensemble(pu_without_identity, test, no_identity_features),
        "signatureHistoricalRate": historical_baseline_scores(train, test, "signature"),
        "sourceServiceHistoricalRate": historical_baseline_scores(train, test, "source_service"),
    }
    performance = {name: evaluate(test_labels, scores, threshold) for name, scores in model_scores.items()}
    performance["baggingPUValidation"] = evaluate(validation_labels, validation_scores, threshold)
    importance = permutation_importance(primary_models, validation, primary_features)
    references = reference_values(train, primary_features)
    errors = representative_errors(test, model_scores["baggingPULeakageControlled"], threshold, primary_models, primary_features, references)

    test_prevalence = max(float(test_labels.mean()), 1e-12)
    current_cutoff = pd.Timestamp(datetime.now(timezone.utc) - timedelta(hours=24))
    current = candidates[(candidates.feature_as_of >= current_cutoff) & (candidates.exclusion_reason.isna())].copy()
    current_evaluation = population[
        (population.feature_as_of >= current_cutoff)
        & (population.occurrence_quality == "RELIABLE")
        & (population.learning_tier.isin(["TIER_A", "TIER_B", "UNLABELED", "CONFIRMED_NEGATIVE"]))
    ].copy()
    current_evaluation_scores = predict_ensemble(primary_models, current_evaluation, primary_features)
    current_known = current_evaluation.learning_tier.isin(["TIER_A", "TIER_B"]).astype(int).to_numpy()
    current_ranking = ranking_metrics(current_known, current_evaluation_scores) if current_known.sum() else {}
    identity_leakage_gap = performance["baggingPUFull"]["prAuc"] - performance["baggingPULeakageControlled"]["prAuc"]
    sanity_checks = {
        "testHasAtLeastFiveTierAPositives": int(test_labels.sum()) >= 5,
        "testPrAucExceedsProxyPrevalence": performance["baggingPULeakageControlled"]["prAuc"] > test_prevalence,
        "testRecallAt20AtLeastHalf": performance["baggingPULeakageControlled"]["recallAt20Pct"] >= 0.5,
        "identityLeakageGapAcceptable": identity_leakage_gap <= 0.15,
        "currentKnownEvidenceRecallAt20AtLeastHalf": bool(current_known.sum()) and current_ranking.get("recallAt20Pct", 0) >= 0.5,
        "thresholdRegionsAreNonDegenerate": thresholds["usable"],
    }
    sanity = all(sanity_checks.values())
    current_scores = predict_ensemble(primary_models, current, primary_features) if sanity else np.array([])
    tier_b = population[(population.learning_tier == "TIER_B") & (population.occurrence_quality == "RELIABLE")].copy()
    tier_b_scores = predict_ensemble(primary_models, tier_b, primary_features)
    tier_b_sensitivity = [
        safe_record(row, score)
        for (_, row), score in zip(tier_b.iterrows(), tier_b_scores)
    ]

    model_version = f"incident-risk-pu-v1-{args.experiment_id}"
    predictions = prediction_payload(test, model_scores["baggingPULeakageControlled"], thresholds, importance, "HELD_OUT_TEST")
    if sanity:
        predictions += prediction_payload(current, current_scores, thresholds, importance, "CURRENT_24H_SHADOW")

    splits = {}
    for name, frame in [("training", train), ("validation", validation), ("test", test)]:
        splits[name] = {
            "from": frame.feature_as_of.min(),
            "to": frame.feature_as_of.max(),
            "count": int(len(frame)),
            "tierA": int((frame.learning_tier == "TIER_A").sum()),
            "unlabeled": int((frame.learning_tier == "UNLABELED").sum()),
        }

    metadata = {
        "experimentId": args.experiment_id,
        "experimentState": "SHADOW_EXPERIMENT_ONLY",
        "modelVersion": model_version,
        "modelFamily": MODEL_FAMILY,
        "trainingTimestamp": datetime.now(timezone.utc),
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "taxonomyVersion": TAXONOMY_VERSION,
        "positiveDefinition": "Tier A explicit/confirmed historical Incident evidence; authenticated CONFIRMED_INCIDENT takes precedence.",
        "puStrategy": f"Bagging PU with {PU_BAGS} repeated unlabeled subsamples at {PU_UNLABELED_PER_POSITIVE}:1 unlabeled-to-positive per bag.",
        "randomSeed": SEED,
        "libraryVersions": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikitLearn": sklearn.__version__,
            "joblib": joblib.__version__,
        },
        "lightGbmFallbackReason": "The available macOS LightGBM wheel required a machine-wide libomp runtime that was not installed; scikit-learn's histogram gradient-boosted tree was used to keep the experiment isolated.",
        "hyperparameters": {
            "learningRate": 0.06,
            "maxIterations": 160,
            "maxLeafNodes": 15,
            "maxDepth": 5,
            "minSamplesLeaf": 20,
            "l2Regularization": 1.0,
            "puBags": PU_BAGS,
            "unlabeledPerPositive": PU_UNLABELED_PER_POSITIVE,
        },
        "featureCount": len(primary_features),
        "features": primary_features,
        "fullAuditFeatureCount": len(full_features),
        "fullAuditFeatures": full_features,
        "postOutcomeFeaturesExcluded": POST_OUTCOME_EXCLUDED,
        "populationAudit": audit,
        "sourceDistribution": source_audit(candidates),
        "splits": splits,
        "purgeGapMinutes": int(PURGE_GAP.total_seconds() / 60),
        "boundaries": {"trainValidation": train_boundary, "validationTest": validation_boundary},
        "models": {
            "naivePositiveVsUnlabeled": {"model": MODEL_FAMILY, "puStrategy": "Benchmark only: unlabeled temporarily treated as negative", "featureCount": len(full_features)},
            "classWeightedPositiveVsUnlabeled": {"model": MODEL_FAMILY, "puStrategy": "Class-weighted benchmark", "featureCount": len(full_features)},
            "baggingPUFull": {"model": MODEL_FAMILY, "puStrategy": "Repeated unlabeled subsampling; audit-only because identity leakage was detected", "featureCount": len(full_features), "bags": bag_samples},
            "baggingPULeakageControlled": {"model": MODEL_FAMILY, "puStrategy": "Repeated unlabeled subsampling; entity/application/service excluded", "featureCount": len(primary_features), "bags": bag_samples},
            "sourceOnly": {"model": MODEL_FAMILY, "puStrategy": "Class-weighted benchmark", "featureCount": 1},
            "withoutSource": {"model": MODEL_FAMILY, "puStrategy": "Repeated unlabeled subsampling", "featureCount": len(no_source_features)},
            "withoutIdentity": {"model": MODEL_FAMILY, "puStrategy": "Repeated unlabeled subsampling", "featureCount": len(no_identity_features)},
            "signatureHistoricalRate": {"model": "Historical rate benchmark", "featureCount": 1},
            "sourceServiceHistoricalRate": {"model": "Smoothed historical rate benchmark", "featureCount": 2},
        },
        "performance": performance,
        "thresholdDiscovery": thresholds,
        "featureImportance": importance,
        "errorAnalysis": errors,
        "tierBSensitivity": tier_b_sensitivity,
        "sourceLeakageAudit": {
            "communicationDerivedExcludedFromPrimary": True,
            "sourceOnly": performance["sourceOnly"],
            "withoutSource": performance["withoutSource"],
            "withoutIdentity": performance["withoutIdentity"],
            "monitoringSourceOnly": performance["baggingPULeakageControlled"],
            "fullModel": performance["baggingPUFull"],
            "identityLeakagePrAucGap": identity_leakage_gap,
        },
        "calibration": {
            "status": "NOT_CALIBRATED_AS_PROBABILITY",
            "reason": "Positive-Unlabeled targets and small positive validation population do not support a trustworthy Incident probability calibration.",
        },
        "offlineSanityPassed": sanity,
        "sanityChecks": sanity_checks,
        "current24h": {
            "scored": int(len(current)) if sanity else 0,
            "evaluatedOffline": int(len(current_evaluation)),
            "knownTierA": int((current_evaluation.learning_tier == "TIER_A").sum()),
            "knownTierB": int((current_evaluation.learning_tier == "TIER_B").sum()),
            "knownEvidenceRanking": current_ranking,
            "high": int(sum(score_band(score, thresholds) == "HIGH_INCIDENT_LIKENESS" for score in current_scores)),
            "intermediate": int(sum(score_band(score, thresholds) == "INTERMEDIATE" for score in current_scores)),
            "low": int(sum(score_band(score, thresholds) == "LOW_INCIDENT_LIKENESS" for score in current_scores)),
        },
        "safety": {
            "operationalDecisions": False,
            "automaticActions": False,
            "artifactAutoLoaded": False,
            "outcomesMutated": False,
            "externalSystemsMutated": False,
        },
    }

    artifact = {
        "models": primary_models,
        "features": primary_features,
        "references": references,
        "thresholds": thresholds,
        "metadata": {"experimentId": args.experiment_id, "modelVersion": model_version, "state": "SHADOW_EXPERIMENT_ONLY"},
    }
    joblib.dump(artifact, output / "model.joblib", compress=3)
    write_json(output / "report.json", metadata)
    with (output / "predictions.jsonl").open("w", encoding="utf-8") as handle:
        for prediction in predictions:
            handle.write(json.dumps(prediction, default=json_safe) + "\n")
    checksum = hashlib.sha256((output / "model.joblib").read_bytes()).hexdigest()
    manifest = {
        "experimentId": args.experiment_id,
        "modelVersion": model_version,
        "state": "SHADOW_EXPERIMENT_ONLY",
        "modelSha256": checksum,
        "report": "report.json",
        "predictions": "predictions.jsonl",
        "model": "model.joblib",
    }
    write_json(output / "manifest.json", manifest)
    return metadata, predictions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--population", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--experiment-id", required=True)
    args = parser.parse_args()
    metadata, predictions = run(args)
    print(json.dumps({
        "experimentId": metadata["experimentId"],
        "modelVersion": metadata["modelVersion"],
        "sanityPassed": metadata["offlineSanityPassed"],
        "predictions": len(predictions),
        "splits": metadata["splits"],
        "current24h": metadata["current24h"],
    }, default=json_safe))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Offline XGBoost trainer/predictor for recommendation-only shadow models."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)
from xgboost import DMatrix, XGBClassifier


CLASSES = ["INCIDENT", "NOISE"]
CLASS_TO_INDEX = {label: index for index, label in enumerate(CLASSES)}


def read_jsonl(file_name: str) -> list[dict[str, Any]]:
    with Path(file_name).open("r", encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]


def safe_feature_values(features: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in features.items():
        if value is None:
            clean[key] = "__MISSING__"
        elif isinstance(value, (str, bool, int, float)):
            clean[key] = value
        else:
            clean[key] = json.dumps(value, sort_keys=True)
    return clean


def metric_payload(y_true: np.ndarray, y_pred: np.ndarray, classes: list[str]) -> dict[str, Any]:
    report = classification_report(
        y_true,
        y_pred,
        labels=list(range(len(classes))),
        target_names=classes,
        output_dict=True,
        zero_division=0,
    )
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "macroF1": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "weightedF1": float(f1_score(y_true, y_pred, average="weighted", zero_division=0)),
        "perClass": {
            label: {
                "precision": float(report[label]["precision"]),
                "recall": float(report[label]["recall"]),
                "f1": float(report[label]["f1-score"]),
                "support": int(report[label]["support"]),
            }
            for label in classes
        },
        "confusionMatrix": confusion_matrix(
            y_true, y_pred, labels=list(range(len(classes)))
        ).tolist(),
        "classOrder": classes,
    }


def top_contributors(bundle: dict[str, Any], matrix: Any, predicted_index: int) -> list[dict[str, Any]]:
    classes = bundle.get("classes", CLASSES)
    booster = bundle["model"].get_booster()
    contributions = booster.predict(DMatrix(matrix), pred_contribs=True)
    if contributions.ndim == 3:
        row = contributions[0, predicted_index, :-1]
    elif contributions.ndim == 2 and contributions.shape[1] > len(bundle["featureNames"]) + 1:
        width = len(bundle["featureNames"]) + 1
        row = contributions[0].reshape(len(classes), width)[predicted_index, :-1]
    else:
        row = contributions[0, :-1]
    ordered = np.argsort(np.abs(row))[::-1][:8]
    return [
        {
            "feature": bundle["featureNames"][int(index)],
            "contribution": float(row[int(index)]),
        }
        for index in ordered
        if float(abs(row[int(index)])) > 0
    ]


def train(args: argparse.Namespace) -> None:
    records = read_jsonl(args.dataset)
    partitions = {
        name: [row for row in records if row["temporalSplit"] == name]
        for name in ("TRAIN", "VALIDATION", "TEST")
    }
    if not all(partitions.values()):
        raise SystemExit("Every chronological split must contain at least one example.")

    vectorizer = DictVectorizer(sparse=True)
    train_x = vectorizer.fit_transform(
        [safe_feature_values(row["features"]) for row in partitions["TRAIN"]]
    )
    validation_x = vectorizer.transform(
        [safe_feature_values(row["features"]) for row in partitions["VALIDATION"]]
    )
    test_x = vectorizer.transform(
        [safe_feature_values(row["features"]) for row in partitions["TEST"]]
    )
    train_y = np.asarray([CLASS_TO_INDEX[row["goldDecision"]] for row in partitions["TRAIN"]])
    validation_y = np.asarray([CLASS_TO_INDEX[row["goldDecision"]] for row in partitions["VALIDATION"]])
    test_y = np.asarray([CLASS_TO_INDEX[row["goldDecision"]] for row in partitions["TEST"]])

    hyperparameters = {
        "n_estimators": args.n_estimators,
        "max_depth": args.max_depth,
        "learning_rate": args.learning_rate,
        "subsample": 0.85,
        "colsample_bytree": 0.85,
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "random_state": 20260826,
        "n_jobs": 1,
    }
    model = XGBClassifier(**hyperparameters)
    model.fit(train_x, train_y, eval_set=[(validation_x, validation_y)], verbose=False)
    validation_metrics = metric_payload(validation_y, model.predict(validation_x), CLASSES)
    test_metrics = metric_payload(test_y, model.predict(test_x), CLASSES)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False)
    artifact = output / "model.joblib"
    bundle = {
        "model": model,
        "vectorizer": vectorizer,
        "featureNames": vectorizer.get_feature_names_out().tolist(),
        "classes": CLASSES,
        "featureSchemaVersion": args.feature_schema_version,
        "modelVersion": args.model_version,
        "calibrationStatus": "NOT_CALIBRATED",
    }
    joblib.dump(bundle, artifact)
    report = {
        "algorithm": "XGBoost",
        "objective": "binary:logistic",
        "modelVersion": args.model_version,
        "featureSchemaVersion": args.feature_schema_version,
        "trainingDatasetVersion": args.dataset_version,
        "classOrder": CLASSES,
        "splits": {key: len(value) for key, value in partitions.items()},
        "classDistribution": {
            label: sum(row["goldDecision"] == label for row in records) for label in CLASSES
        },
        "hyperparameters": hyperparameters,
        "validationMetrics": validation_metrics,
        "testMetrics": test_metrics,
        "confusionMatrix": test_metrics["confusionMatrix"],
        "calibrationStatus": "NOT_CALIBRATED",
        "probabilityLabel": "MODEL_SCORE",
        "status": "SHADOW",
        "artifactPath": str(artifact.resolve()),
    }
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def predict(args: argparse.Namespace) -> None:
    bundle = joblib.load(args.artifact)
    classes = bundle.get("classes", CLASSES)
    request = json.loads(os.environ.get("ML_FEATURES_JSON", "{}"))
    matrix = bundle["vectorizer"].transform([safe_feature_values(request["features"])])
    probabilities = bundle["model"].predict_proba(matrix)[0]
    predicted_index = int(np.argmax(probabilities))
    print(json.dumps({
        "predictedClass": classes[predicted_index],
        "modelScore": float(probabilities[predicted_index]),
        "probabilities": {
            label: float(probabilities[index]) for index, label in enumerate(classes)
        },
        "topContributors": top_contributors(bundle, matrix, predicted_index),
    }))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    training = commands.add_parser("train")
    training.add_argument("--dataset", required=True)
    training.add_argument("--output-dir", required=True)
    training.add_argument("--model-version", required=True)
    training.add_argument("--dataset-version", required=True)
    training.add_argument("--feature-schema-version", required=True)
    training.add_argument("--n-estimators", type=int, default=220)
    training.add_argument("--max-depth", type=int, default=5)
    training.add_argument("--learning-rate", type=float, default=0.04)
    inference = commands.add_parser("predict")
    inference.add_argument("--artifact", required=True)
    return root


if __name__ == "__main__":
    arguments = parser().parse_args()
    train(arguments) if arguments.command == "train" else predict(arguments)

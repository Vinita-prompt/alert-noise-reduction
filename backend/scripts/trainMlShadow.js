#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const database = require('../src/config/db');
const {
  FEATURE_SCHEMA_VERSION,
  MODEL_ALGORITHM,
  NOT_TRAINED_STATUS,
  service,
} = require('../src/services/mlShadow.service');

async function main() {
  const dataset = await service.buildDataset({ persist: true });
  if (!dataset.trainable) {
    process.stdout.write(`${JSON.stringify({
      status: NOT_TRAINED_STATUS,
      modelTrained: false,
      validatedTrainingExamples: dataset.validatedTrainingExamples,
      classDistribution: dataset.classDistribution,
      minimumPerClass: dataset.minimumPerClass,
      missingClasses: dataset.missingClasses,
      labelsFabricated: false,
    }, null, 2)}\n`);
    return;
  }
  const root = path.resolve(__dirname, '..');
  const python = process.env.ML_PYTHON_PATH || path.join(root, '.venv-phase4/bin/python');
  const trainer = path.join(root, 'ml/multiclass_shadow.py');
  if (!fs.existsSync(python)) throw new Error('ML Python environment is missing. Install ml/requirements-shadow.txt.');
  const modelVersion = `xgb-shadow-${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'z')}`;
  const modelId = `mlm-${crypto.randomUUID()}`;
  const artifactRoot = path.resolve(process.env.ML_ARTIFACT_STORAGE_DIR
    || path.join(root, 'artifacts/ml-shadow/models'));
  await fs.promises.mkdir(artifactRoot, { recursive: true });
  const output = path.join(artifactRoot, modelVersion);
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alert-ml-shadow-'));
  const datasetFile = path.join(temporaryDirectory, 'dataset.jsonl');
  try {
    await fs.promises.writeFile(datasetFile, `${dataset.examples.map((item) => JSON.stringify({
      goldDecision: item.goldDecision,
      temporalSplit: item.temporalSplit,
      features: item.features,
    })).join('\n')}\n`);
    const trained = spawnSync(python, [trainer, 'train',
      '--dataset', datasetFile,
      '--output-dir', output,
      '--model-version', modelVersion,
      '--dataset-version', dataset.datasetVersion,
      '--feature-schema-version', FEATURE_SCHEMA_VERSION,
    ], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (trained.status !== 0) throw new Error(`Offline XGBoost training failed: ${(trained.stderr || trained.stdout || 'unknown error').trim()}`);
    const report = JSON.parse(await fs.promises.readFile(path.join(output, 'report.json'), 'utf8'));
    const artifactBytes = await fs.promises.readFile(report.artifactPath);
    const artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
    const reviewedTimes = dataset.examples.map((item) => new Date(item.reviewedAt).getTime())
      .filter(Number.isFinite);
    const trainingDataStart = reviewedTimes.length ? new Date(Math.min(...reviewedTimes)).toISOString() : null;
    const trainingDataEnd = reviewedTimes.length ? new Date(Math.max(...reviewedTimes)).toISOString() : null;
    await database.query(`INSERT INTO ml_model_registry (
      model_id, model_version, algorithm, feature_schema_version,
      training_dataset_version, training_timestamp, hyperparameters,
      class_distribution, validation_metrics, confusion_matrix,
      calibration_status, artifact_path, status, training_data_start,
      training_data_end, artifact_storage_backend, artifact_sha256
    ) VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,'SHADOW',$12,$13,$14,$15)`, [
      modelId, modelVersion, MODEL_ALGORITHM, FEATURE_SCHEMA_VERSION,
      dataset.datasetVersion, report.hyperparameters, report.classDistribution,
      { validation: report.validationMetrics, test: report.testMetrics },
      report.confusionMatrix, report.calibrationStatus,
      report.artifactPath,
      trainingDataStart, trainingDataEnd, 'FILESYSTEM', artifactSha256,
    ]);
    process.stdout.write(`${JSON.stringify({
      status: 'SHADOW', modelId, modelVersion, algorithm: MODEL_ALGORITHM,
      datasetVersion: dataset.datasetVersion, metrics: report.testMetrics,
      confusionMatrix: report.confusionMatrix, finalDecisionsChanged: 0,
    }, null, 2)}\n`);
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
}).finally(() => database.pool.end());

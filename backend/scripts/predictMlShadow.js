#!/usr/bin/env node
const database = require('../src/config/db');
const { service } = require('../src/services/mlShadow.service');

async function main() {
  const state = await service.status();
  if (state.status !== 'SHADOW') {
    process.stdout.write(`${JSON.stringify({
      status: state.status,
      modelVersion: state.modelVersion,
      predictionsAttempted: 0,
      predictionsStored: 0,
      finalDecisionsChanged: 0,
    }, null, 2)}\n`);
    return;
  }
  const limit = Math.min(500, Math.max(1, Number(process.env.ML_PREDICTION_BATCH_SIZE || 100)));
  const result = await database.query(`SELECT evaluation.*
    FROM live_shadow_evaluations_latest_v1 evaluation
    LEFT JOIN ml_multiclass_shadow_predictions prediction
      ON prediction.alert_id = evaluation.alert_id
      AND prediction.model_version = $1
      AND prediction.feature_snapshot_id IN (
        SELECT feature_snapshot_id FROM ml_feature_snapshots snapshot
        WHERE snapshot.alert_id = evaluation.alert_id
          AND snapshot.feature_as_of = evaluation.feature_as_of
      )
    WHERE prediction.prediction_id IS NULL
    ORDER BY evaluation.feature_as_of DESC LIMIT $2`, [state.modelVersion, limit]);
  const items = [];
  for (const evaluation of result.rows) {
    try { items.push(await service.predictEvaluation(evaluation)); }
    catch (error) { items.push({ status: 'FAILED', safeError: error.code || error.message }); }
  }
  process.stdout.write(`${JSON.stringify({
    status: 'SHADOW', modelVersion: state.modelVersion,
    predictionsAttempted: items.length,
    predictionsStored: items.filter((item) => item.predictionStored).length,
    failures: items.filter((item) => item.status === 'FAILED').length,
    finalDecisionsChanged: 0,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
}).finally(() => database.pool.end());

#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const database = require('../src/config/db');
const { service } = require('../src/services/mlShadow.service');

async function main() {
  const dataset = await service.buildDataset({ persist: true });
  const directory = path.resolve(__dirname, '../artifacts/ml-shadow/datasets');
  await fs.promises.mkdir(directory, { recursive: true });
  const fileName = path.join(directory, `${dataset.datasetVersion}.jsonl`);
  const content = dataset.examples.map((item) => JSON.stringify({
    trainingExampleId: item.trainingExampleId,
    alertId: item.alertId,
    episodeId: item.episodeId,
    featureSnapshotId: item.featureSnapshotId,
    featureAsOf: item.featureAsOf,
    goldDecision: item.goldDecision,
    temporalSplit: item.temporalSplit,
    features: item.features,
  })).join('\n');
  await fs.promises.writeFile(fileName, content ? `${content}\n` : '', { encoding: 'utf8', flag: 'wx' })
    .catch((error) => { if (error.code !== 'EEXIST') throw error; });
  process.stdout.write(`${JSON.stringify({
    datasetVersion: dataset.datasetVersion,
    featureSchemaVersion: dataset.featureSchemaVersion,
    validatedTrainingExamples: dataset.validatedTrainingExamples,
    classDistribution: dataset.classDistribution,
    trainingStatus: dataset.status,
    minimumPerClass: dataset.minimumPerClass,
    missingClasses: dataset.missingClasses,
    leakageChecks: dataset.leakageChecks,
    output: fileName,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
}).finally(() => database.pool.end());

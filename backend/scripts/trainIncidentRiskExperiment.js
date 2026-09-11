#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const database = require('../src/config/db');
const experimentService = require('../src/services/incidentRiskExperiment.service');

function timestampId(date = new Date()) {
  return `phase4-${date.toISOString().replace(/[-:.]/g, '').replace('Z', 'z')}`;
}

async function main() {
  const experimentId = process.argv[2] || timestampId();
  if (!/^phase4-[a-zA-Z0-9_-]+$/.test(experimentId)) {
    throw new Error('Experiment ID must start with phase4- and contain only letters, digits, underscore, or hyphen.');
  }

  const backendRoot = path.resolve(__dirname, '..');
  const python = path.join(backendRoot, '.venv-phase4/bin/python');
  const trainer = path.join(backendRoot, 'ml/incident_risk_experiment.py');
  const artifactDirectory = path.join(backendRoot, 'artifacts/ml-shadow', experimentId);
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alert-risk-phase4-'));
  const populationFile = path.join(temporaryDirectory, 'population.jsonl');

  try {
    if (!fs.existsSync(python)) throw new Error('Phase 4 Python environment is missing. Install ml/requirements-phase4.txt first.');
    if (fs.existsSync(artifactDirectory)) throw new Error(`Experiment artifact already exists: ${experimentId}`);

    const exported = await experimentService.exportPopulationJsonl(populationFile);
    if (!exported.summary.tierAPositives) {
      throw new Error('No defensible Tier A positive population can be constructed. Training stopped.');
    }

    const trained = spawnSync(python, [
      trainer,
      '--population', populationFile,
      '--output-dir', artifactDirectory,
      '--experiment-id', experimentId,
    ], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONHASHSEED: '20260824' },
      maxBuffer: 10 * 1024 * 1024,
    });
    if (trained.status !== 0) {
      throw new Error(`Offline training failed: ${(trained.stderr || trained.stdout || 'unknown error').trim()}`);
    }

    const metadata = JSON.parse(await fs.promises.readFile(path.join(artifactDirectory, 'report.json'), 'utf8'));
    const predictionLines = (await fs.promises.readFile(path.join(artifactDirectory, 'predictions.jsonl'), 'utf8'))
      .split('\n').filter(Boolean);
    const predictions = predictionLines.map((line) => JSON.parse(line));
    await experimentService.saveExperiment({
      artifactPath: artifactDirectory,
      experimentId,
      metadata,
      modelFamily: metadata.modelFamily,
      modelVersion: metadata.modelVersion,
      predictions,
    });

    process.stdout.write(`${JSON.stringify({
      experimentId,
      state: experimentService.EXPERIMENT_STATE,
      population: exported.summary,
      modelVersion: metadata.modelVersion,
      splits: metadata.splits,
      sanityPassed: metadata.offlineSanityPassed,
      current24h: metadata.current24h,
      predictionsStored: predictions.length,
      artifactDirectory,
    }, null, 2)}\n`);
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});


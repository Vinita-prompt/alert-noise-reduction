require('dotenv').config();

const db = require('../src/config/db');
const {
  RECONSTRUCTION_VERSION,
  service,
} = require('../src/services/appDynamicsJiraOutcomeReconstruction.service');

function optionsFromArguments(argumentsList = process.argv.slice(2)) {
  const options = { range: 'all' };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--range' && value) options.range = value;
    if (name === '--from' && value) options.from = value;
    if (name === '--to' && value) options.to = value;
  }
  return options;
}

async function main() {
  const result = await service.reconstruct(optionsFromArguments());
  console.log(JSON.stringify({
    runId: result.runId,
    reconstructionVersion: RECONSTRUCTION_VERSION,
    window: result.window,
    recordsDetected: result.recordsDetected,
    recordsStored: result.recordsStored,
    summary: result.summary,
    safety: {
      appDynamicsMutations: 0,
      jiraMutations: 0,
      slackMutations: 0,
      operationalOutcomesCreated: 0,
      confirmedNoiseLabelsCreated: 0,
      modelsTrained: 0,
    },
  }, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.safeMessage || error.message);
      process.exitCode = 1;
    })
    .finally(async () => db.pool.end());
}

module.exports = { main, optionsFromArguments };

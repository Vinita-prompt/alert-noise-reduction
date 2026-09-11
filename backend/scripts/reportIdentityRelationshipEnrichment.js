require('dotenv').config();

const db = require('../src/config/db');
const { service } = require('../src/services/identityRelationshipEnrichment.service');

async function main() {
  const report = await service.analyze({ refresh: true, limit: 100 });
  const output = {
    generatedAt: report.generatedAt,
    policy: report.policy,
    mode: report.mode,
    inventory: report.inventory,
    identityDiagnostics: report.identityDiagnostics,
    relationshipDiagnostics: report.relationshipDiagnostics,
    derivedMappingRegistry: {
      count: report.derivedMappingRegistry.count,
      persisted: report.derivedMappingRegistry.persisted,
      entries: report.derivedMappingRegistry.entries,
    },
    correlationDiscovery: report.correlationDiscovery,
    observationMode: report.observationMode,
    safeguards: report.safeguards,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.safeMessage || error?.code || error?.message || 'Identity enrichment failed.'}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});

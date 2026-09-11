require('dotenv').config();

const {
  createLegacyBasicClient,
} = require('../src/services/thousandEyesSecondaryDiagnostic.service');

async function main() {
  const client = createLegacyBasicClient();
  const result = await client.runReadOnlyDiagnostic();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ['failed', 'access_forbidden'].includes(result.authentication) ? 1 : 0;
}

main().catch((error) => {
  console.error(JSON.stringify({
    authentication: 'failed',
    safeError: error?.message || 'Secondary ThousandEyes diagnostic failed.',
  }, null, 2));
  process.exitCode = 1;
});

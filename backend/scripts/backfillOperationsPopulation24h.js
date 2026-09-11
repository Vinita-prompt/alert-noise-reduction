#!/usr/bin/env node
require('dotenv').config();

const db = require('../src/config/db');
const { service } = require('../src/services/operationsPopulationBackfill.service');

function safeError(error) {
  return String(error?.safeMessage || error?.code || error?.message || 'Population backfill failed.')
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|credential|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

(async () => {
  try {
    const result = await service.run();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      code: error?.code || 'POPULATION_BACKFILL_FAILED',
      details: error?.safeDetails || null,
      message: safeError(error),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();

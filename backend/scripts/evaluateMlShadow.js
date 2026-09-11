#!/usr/bin/env node
const database = require('../src/config/db');
const { service } = require('../src/services/mlShadow.service');

service.metrics().then((metrics) => {
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}).catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
}).finally(() => database.pool.end());

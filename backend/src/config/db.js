const { Pool } = require('pg');
const fs = require('node:fs');
require('dotenv').config();

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function databaseSslConfig(env = process.env) {
  if (!booleanValue(env.DB_SSL, false)) return false;
  const rejectUnauthorized = booleanValue(env.DB_SSL_REJECT_UNAUTHORIZED, true);
  if (String(env.NODE_ENV || '').toLowerCase() === 'production' && !rejectUnauthorized) {
    const error = new Error('Production PostgreSQL TLS certificate validation cannot be disabled.');
    error.code = 'DATABASE_TLS_VERIFICATION_REQUIRED';
    throw error;
  }
  const caFile = String(env.DB_SSL_CA_FILE || '').trim();
  return {
    rejectUnauthorized,
    ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}),
  };
}

function buildPoolConfig(env = process.env) {
  const ssl = databaseSslConfig(env);
  if (String(env.NODE_ENV || '').toLowerCase() === 'production' && !String(env.DATABASE_URL || '').trim()) {
    const error = new Error('Production requires a managed PostgreSQL DATABASE_URL.');
    error.code = 'MANAGED_DATABASE_URL_REQUIRED';
    throw error;
  }
  return env.DATABASE_URL
  ? {
      connectionString: env.DATABASE_URL,
      ssl,
    }
  : {
      host: env.DB_HOST || 'localhost',
      port: Number(env.DB_PORT || 5432),
      database: env.DB_NAME || 'alert_noise_reduction',
      user: env.DB_USER || 'postgres',
      password: Object.prototype.hasOwnProperty.call(env, 'DB_PASSWORD')
        ? env.DB_PASSWORD
        : 'postgres',
      ssl,
    };
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error', error);
});

module.exports = {
  buildPoolConfig,
  databaseSslConfig,
  query: (text, params) => pool.query(text, params),
  pool,
};

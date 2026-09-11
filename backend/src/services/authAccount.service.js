const crypto = require('node:crypto');
const db = require('../config/db');

function normalizedArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
    : [];
}

function mapAccount(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.full_name),
    email: String(row.email).trim().toLowerCase(),
    passwordHash: String(row.password_hash),
    roles: normalizedArray(row.roles),
    permissions: normalizedArray(row.permissions),
  };
}

function createAuthAccountService({ query = db.query } = {}) {
  async function ensureSchema() {
    await query(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        roles JSONB NOT NULL DEFAULT '["operator"]'::jsonb,
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query('CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_users_email ON auth_users (LOWER(email))');
  }

  async function findByEmail(email) {
    const result = await query(
      `SELECT id, full_name, email, password_hash, roles, permissions
       FROM auth_users
       WHERE LOWER(email) = LOWER($1) AND active = TRUE
       LIMIT 1`,
      [String(email || '').trim()],
    );
    return mapAccount(result.rows[0]);
  }

  async function findById(id) {
    const result = await query(
      `SELECT id, full_name, email, password_hash, roles, permissions
       FROM auth_users
       WHERE id = $1 AND active = TRUE
       LIMIT 1`,
      [String(id || '')],
    );
    return mapAccount(result.rows[0]);
  }

  async function create({ email, name, passwordHash }) {
    const result = await query(
      `INSERT INTO auth_users (id, full_name, email, password_hash, roles, permissions)
       VALUES ($1, $2, LOWER($3), $4, $5::jsonb, $6::jsonb)
       RETURNING id, full_name, email, password_hash, roles, permissions`,
      [
        `user-${crypto.randomUUID()}`,
        String(name || '').trim(),
        String(email || '').trim(),
        String(passwordHash || ''),
        JSON.stringify(['operator']),
        JSON.stringify([]),
      ],
    );
    return mapAccount(result.rows[0]);
  }

  return { create, ensureSchema, findByEmail, findById };
}

module.exports = {
  createAuthAccountService,
  service: createAuthAccountService(),
};


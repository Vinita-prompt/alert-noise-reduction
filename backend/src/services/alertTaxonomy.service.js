const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const { ALERT_DOMAINS, ALERT_SUBTYPES, SUBTYPE_DOMAINS } = require('./alertFeatureEngineering.service');

const AUTHORIZED_ROLES = new Set(['admin', 'incident_manager', 'operator']);
const migrationSql = fs.readFileSync(path.join(__dirname, '../db/migrations/039_alert_feature_engineering.sql'), 'utf8');
let schemaPromise = null;

function serviceError(message, code, status) {
  const result = new Error(message);
  result.code = code;
  result.status = status;
  result.safeMessage = message;
  return result;
}

function clean(value, name, { required = false, max = 2000 } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw serviceError(`${name} is required.`, 'INVALID_TAXONOMY_CORRECTION', 400);
  if (result.length > max) throw serviceError(`${name} must be ${max} characters or fewer.`, 'INVALID_TAXONOMY_CORRECTION', 400);
  return result || null;
}

function values(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(Boolean).map((item) => String(item).trim().toLowerCase()))];
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw serviceError('An authenticated operator is required.', 'TAXONOMY_AUTHENTICATION_REQUIRED', 401);
  }
  const roles = values([...(Array.isArray(actor.roles) ? actor.roles : []), actor.role]);
  const permissions = values(actor.permissions);
  const role = roles.find((item) => AUTHORIZED_ROLES.has(item));
  const permission = permissions.find((item) => item === 'taxonomy:write');
  if (!role && !permission) {
    throw serviceError('The authenticated user is not authorized to correct alert taxonomy.', 'TAXONOMY_FORBIDDEN', 403);
  }
  if (!['human', 'user'].includes(String(actor.type || 'user').toLowerCase())) {
    throw serviceError('Taxonomy corrections require an authenticated human user.', 'TAXONOMY_HUMAN_REQUIRED', 403);
  }
  const id = clean(actor.id || actor.accountId || actor.userId || actor.email, 'Authenticated user ID', { required: true, max: 255 });
  return {
    id,
    display: clean(actor.displayName || actor.name || actor.email || id, 'Authenticated user display', { required: true, max: 255 }),
    email: clean(actor.email, 'Authenticated user email', { max: 320 }),
    roles,
    permissions,
    authorizationBasis: permission ? `permission:${permission}` : `role:${role}`,
  };
}

function requireTaxonomyOperator(request, response, next) {
  try {
    request.taxonomyActor = normalizeActor(request.auth?.verified === true ? request.auth.user : null);
    next();
  } catch (error) {
    next(error);
  }
}

function normalizeIdempotencyKey(value) {
  const key = clean(value, 'Idempotency-Key', { required: true, max: 160 });
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) {
    throw serviceError('Idempotency-Key must contain 8-160 safe identifier characters.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  return key;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    alertId: row.alert_id,
    suggestedDomain: row.suggested_domain,
    suggestedSubtype: row.suggested_subtype,
    correctedDomain: row.corrected_domain,
    correctedSubtype: row.corrected_subtype,
    reason: row.reason,
    correctedById: row.actor_id,
    correctedBy: row.actor_display,
    correctedByEmail: row.actor_email || null,
    authorizationBasis: row.authorization_basis,
    isCurrent: Boolean(row.is_current),
    supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function validateCorrection(payload, suggestion, current) {
  const requestedDomain = clean(payload.domain, 'Domain', { max: 80 })?.toUpperCase();
  const requestedSubtype = clean(payload.subtype, 'Subtype', { max: 100 })?.toUpperCase();
  if (!requestedDomain && !requestedSubtype) {
    throw serviceError('At least one of domain or subtype is required.', 'INVALID_TAXONOMY_CORRECTION', 400);
  }
  if (requestedDomain && !ALERT_DOMAINS.includes(requestedDomain)) {
    throw serviceError('Domain is not part of the supported technical taxonomy.', 'INVALID_TAXONOMY_DOMAIN', 400);
  }
  if (requestedSubtype && !ALERT_SUBTYPES.includes(requestedSubtype)) {
    throw serviceError('Subtype is not part of the supported technical taxonomy.', 'INVALID_TAXONOMY_SUBTYPE', 400);
  }

  let subtype = requestedSubtype || current?.corrected_subtype || suggestion.subtype;
  let domain = requestedDomain || current?.corrected_domain || suggestion.domain;
  if (requestedDomain && !requestedSubtype && subtype !== 'UNKNOWN_SUBTYPE'
    && SUBTYPE_DOMAINS[subtype] !== requestedDomain) subtype = 'UNKNOWN_SUBTYPE';
  if (requestedSubtype && !requestedDomain && subtype !== 'UNKNOWN_SUBTYPE') domain = SUBTYPE_DOMAINS[subtype];
  if (subtype !== 'UNKNOWN_SUBTYPE' && SUBTYPE_DOMAINS[subtype] !== domain) {
    throw serviceError(`${subtype} belongs to ${SUBTYPE_DOMAINS[subtype]}, not ${domain}.`, 'TAXONOMY_DOMAIN_SUBTYPE_MISMATCH', 400);
  }
  return {
    domain,
    subtype,
    reason: clean(payload.reason, 'Correction reason', { required: true, max: 2000 }),
  };
}

function createAlertTaxonomyService({ database = db } = {}) {
  async function ensureSchema() {
    if (database !== db) return;
    if (!schemaPromise) schemaPromise = database.query(migrationSql).catch((error) => {
      schemaPromise = null;
      throw error;
    });
    await schemaPromise;
  }

  async function get(alertId) {
    await ensureSchema();
    const id = clean(alertId, 'Alert ID', { required: true, max: 255 });
    const result = await database.query(`
      SELECT * FROM alert_occurrence_taxonomy_corrections
      WHERE alert_id = $1 ORDER BY created_at DESC, id DESC
    `, [id]);
    return {
      alertId: id,
      current: mapRow(result.rows.find((row) => row.is_current)),
      history: result.rows.map(mapRow),
    };
  }

  async function record(alertId, payload, actorValue, options = {}) {
    await ensureSchema();
    const id = clean(alertId, 'Alert ID', { required: true, max: 255 });
    const actor = normalizeActor(actorValue);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const alertResult = await client.query(`
        SELECT id,
          learning_taxonomy_subtype(
            COALESCE(extracted_details->'normalized_alert'->>'monitoring_tool', source),
            COALESCE(extracted_details->'normalized_alert'->>'message', description, signal, title),
            COALESCE(extracted_details->'normalized_alert'->>'entity', service),
            extracted_details->'normalized_alert'->>'application',
            COALESCE(extracted_details->'normalized_alert'->>'service', service)
          ) AS suggested_subtype
        FROM alerts WHERE id = $1 FOR UPDATE
      `, [id]);
      if (!alertResult.rows[0]) throw serviceError(`Alert occurrence ${id} was not found.`, 'LEARNING_RECORD_NOT_FOUND', 404);
      const suggestedSubtype = alertResult.rows[0].suggested_subtype || 'UNKNOWN_SUBTYPE';
      const suggestion = { subtype: suggestedSubtype, domain: SUBTYPE_DOMAINS[suggestedSubtype] || 'UNKNOWN_DOMAIN' };
      const existingIdempotent = await client.query(`
        SELECT * FROM alert_occurrence_taxonomy_corrections
        WHERE alert_id = $1 AND idempotency_key = $2 LIMIT 1
      `, [id, idempotencyKey]);
      if (existingIdempotent.rows[0]) {
        await client.query('COMMIT');
        return { correction: mapRow(existingIdempotent.rows[0]), duplicateSubmission: true };
      }
      const currentResult = await client.query(`
        SELECT * FROM alert_occurrence_taxonomy_corrections
        WHERE alert_id = $1 AND is_current FOR UPDATE
      `, [id]);
      const current = currentResult.rows[0] || null;
      const correction = validateCorrection(payload || {}, suggestion, current);
      if (current) await client.query('UPDATE alert_occurrence_taxonomy_corrections SET is_current = false WHERE id = $1', [current.id]);
      const inserted = await client.query(`
        INSERT INTO alert_occurrence_taxonomy_corrections (
          alert_id, suggested_domain, suggested_subtype, corrected_domain, corrected_subtype,
          reason, actor_id, actor_display, actor_email, actor_roles, actor_permissions,
          authorization_basis, supersedes_id, idempotency_key, request_context
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb)
        RETURNING *
      `, [
        id, suggestion.domain, suggestion.subtype, correction.domain, correction.subtype,
        correction.reason, actor.id, actor.display, actor.email, JSON.stringify(actor.roles),
        JSON.stringify(actor.permissions), actor.authorizationBasis, current?.id || null,
        idempotencyKey, JSON.stringify(options.requestContext || {}),
      ]);
      await client.query('COMMIT');
      return { correction: mapRow(inserted.rows[0]), corrected: Boolean(current), duplicateSubmission: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { ensureSchema, get, record };
}

module.exports = {
  createAlertTaxonomyService,
  normalizeActor,
  requireTaxonomyOperator,
  service: createAlertTaxonomyService(),
  validateCorrection,
};

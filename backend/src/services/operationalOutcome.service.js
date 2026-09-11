const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');

const OPERATIONAL_OUTCOMES = Object.freeze([
  'CONFIRMED_INCIDENT',
  'CONFIRMED_NOISE',
  'UNKNOWN',
]);
const NOISE_REASONS = Object.freeze([
  'AUTO_RESOLVED',
  'DUPLICATE',
  'FLAPPING',
  'NON_ACTIONABLE',
  'CORRELATED',
  'STALE',
  'EXPECTED_ACTIVITY',
  'TRANSIENT',
  'EXPECTED_BEHAVIOR',
  'FALSE_POSITIVE',
  'OTHER',
]);
const UNKNOWN_REASONS = Object.freeze([
  'INSUFFICIENT_EVIDENCE',
  'CONFLICTING_EVIDENCE',
  'OPERATIONAL_OUTCOME_UNCLEAR',
  'OTHER',
]);
const AUTHORIZED_ROLES = new Set(['admin', 'incident_manager', 'operator']);
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|api.?key)/i;
const migrationSql = [
  '037_operational_outcomes.sql',
  '038_authenticated_outcome_audit.sql',
  '044_gold_review_feedback.sql',
].map((fileName) => fs.readFileSync(path.join(__dirname, `../db/migrations/${fileName}`), 'utf8')).join('\n');
let schemaPromise = null;

function error(message, code, status, safeDetails) {
  const result = new Error(message);
  result.code = code;
  result.status = status;
  result.safeMessage = message;
  if (safeDetails) result.safeDetails = safeDetails;
  return result;
}

function cleanText(value, name, { max = 4000, required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw error(`${name} is required.`, 'INVALID_OPERATIONAL_OUTCOME', 400);
  if (text.length > max) throw error(`${name} must be ${max} characters or fewer.`, 'INVALID_OPERATIONAL_OUTCOME', 400);
  return text || null;
}

function safeEvidence(value, depth = 0) {
  if (depth > 5 || value === undefined) return null;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeEvidence(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeEvidence(item, depth + 1),
    ]));
  }
  return String(value);
}

function actorValues(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(Boolean).map((item) => String(item).trim().toLowerCase()))];
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw error('An authenticated operator is required.', 'OPERATIONAL_OUTCOME_AUTHENTICATION_REQUIRED', 401);
  }
  const id = cleanText(actor.id || actor.accountId || actor.userId || actor.email, 'Authenticated user ID', { max: 255, required: true });
  const roles = actorValues([...(Array.isArray(actor.roles) ? actor.roles : []), actor.role]);
  const permissions = actorValues(actor.permissions);
  const authorizedRole = roles.find((role) => AUTHORIZED_ROLES.has(role));
  const authorizedPermission = permissions.find((permission) => permission === 'outcomes:write');
  if (!authorizedRole && !authorizedPermission) {
    throw error('The authenticated user is not authorized to record operational outcomes.', 'OPERATIONAL_OUTCOME_FORBIDDEN', 403);
  }
  const type = cleanText(actor.type || 'user', 'Authenticated user type', { max: 80, required: true }).toLowerCase();
  if (!['human', 'user'].includes(type)) {
    throw error('Operational outcomes must be recorded by an authenticated human user.', 'OPERATIONAL_OUTCOME_HUMAN_REQUIRED', 403);
  }
  return {
    authorizationBasis: authorizedPermission ? `permission:${authorizedPermission}` : `role:${authorizedRole}`,
    display: cleanText(actor.displayName || actor.name || actor.email || id, 'Authenticated user display name', { max: 255, required: true }),
    email: cleanText(actor.email, 'Authenticated user email', { max: 320 }),
    id,
    roles,
    permissions,
    type: 'user',
  };
}

function resolveAuthenticatedActor(request) {
  return request.auth?.verified === true ? request.auth.user : null;
}

function requireOutcomeOperator(request, response, next) {
  try {
    request.operationalOutcomeActor = normalizeActor(resolveAuthenticatedActor(request));
    next();
  } catch (requestError) {
    next(requestError);
  }
}

function normalizeIdempotencyKey(value) {
  const key = cleanText(value, 'Idempotency-Key', { max: 160, required: true });
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) {
    throw error('Idempotency-Key must contain 8-160 safe identifier characters.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  return key;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    alertId: row.alert_id,
    outcome: row.outcome,
    reason: row.reason,
    reasonCode: row.reason_code || null,
    source: row.source,
    confirmationMethod: row.confirmation_method,
    confirmationSource: row.source,
    confirmationConfidence: row.confirmation_confidence === null ? null : Number(row.confirmation_confidence),
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    recordedBy: row.recorded_by,
    recordedById: row.recorded_by_id,
    recordedByType: row.recorded_by_type,
    linkedIncidentId: row.linked_incident_id || null,
    linkedIncidentKey: row.linked_incident_key || null,
    linkedIncidentRelationship: row.linked_incident_relationship || null,
    linkedIncidentAt: row.linked_incident_at ? new Date(row.linked_incident_at).toISOString() : null,
    evidence: row.evidence || {},
    notes: row.notes || null,
    isCurrent: Boolean(row.is_current),
    supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function mapAuditRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    alertId: row.alert_id,
    outcomeId: Number(row.outcome_id),
    action: row.action,
    actorId: row.actor_id,
    actorDisplay: row.actor_display,
    actorEmail: row.actor_email || null,
    actorType: row.actor_type,
    actorRoles: row.actor_roles || [],
    actorPermissions: row.actor_permissions || [],
    authorizationBasis: row.authorization_basis || null,
    previousOutcomeId: row.previous_outcome_id === null ? null : Number(row.previous_outcome_id),
    previousOutcome: row.previous_outcome || null,
    newOutcome: row.new_outcome,
    reason: row.reason,
    reasonCode: row.reason_code || null,
    notes: row.notes || null,
    linkedIncidentId: row.linked_incident_id || null,
    linkedIncidentKey: row.linked_incident_key || null,
    supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function trainingReadiness(historicalOutcome, operationalOutcome) {
  if (operationalOutcome?.outcome === 'CONFIRMED_INCIDENT') {
    return { state: 'CONFIRMED_LABELED', futureTargetCandidate: 'INCIDENT', includedInTraining: false };
  }
  if (operationalOutcome?.outcome === 'CONFIRMED_NOISE') {
    return { state: 'CONFIRMED_LABELED', futureTargetCandidate: 'NOISE', includedInTraining: false };
  }
  if (operationalOutcome?.outcome === 'UNKNOWN') {
    return { state: 'UNKNOWN', futureTargetCandidate: null, includedInTraining: false };
  }
  if (historicalOutcome === 'UNKNOWN') {
    return { state: 'UNKNOWN', futureTargetCandidate: null, includedInTraining: false };
  }
  if (historicalOutcome === 'INCIDENT' || historicalOutcome === 'INCIDENT_UNLINKED') {
    return { state: 'WEAK_EVIDENCE', futureTargetCandidate: null, includedInTraining: false };
  }
  return { state: 'UNLABELED', futureTargetCandidate: null, includedInTraining: false };
}

function sameOutcome(row, candidate) {
  if (!row) return false;
  return row.outcome === candidate.outcome
    && (row.reason_code || null) === (candidate.reasonCode || null)
    && row.reason === candidate.reason
    && (row.notes || null) === (candidate.notes || null)
    && (row.linked_incident_key || null) === (candidate.linkedIncidentKey || null);
}

function createPostgresOutcomeStore(database = db) {
  async function ensureSchema() {
    if (!schemaPromise) schemaPromise = database.query(migrationSql).catch((schemaError) => {
      schemaPromise = null;
      throw schemaError;
    });
    await schemaPromise;
  }

  async function query(client, sql, values = []) {
    return (client || database).query(sql, values);
  }

  return {
    ensureSchema,
    async transaction(callback) {
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (transactionError) {
        await client.query('ROLLBACK');
        throw transactionError;
      } finally {
        client.release();
      }
    },
    async getAlert(client, alertId, lock = false) {
      const result = await query(client, `SELECT id FROM alerts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [alertId]);
      return result.rows[0] || null;
    },
    async getIncident(client, incidentKey) {
      const result = await query(client, `
        SELECT incident_key, raw_payload->>'id' AS issue_id, source_url
        FROM operations_incidents WHERE UPPER(incident_key) = UPPER($1) LIMIT 1
      `, [incidentKey]);
      return result.rows[0] || null;
    },
    async findIdempotent(client, alertId, idempotencyKey) {
      const result = await query(client, `
        SELECT * FROM alert_occurrence_outcomes
        WHERE alert_id = $1 AND idempotency_key = $2 LIMIT 1
      `, [alertId, idempotencyKey]);
      return result.rows[0] || null;
    },
    async getCurrent(client, alertId) {
      const result = await query(client, `
        SELECT * FROM alert_occurrence_outcomes
        WHERE alert_id = $1 AND is_current
        ORDER BY recorded_at DESC, id DESC LIMIT 1
      `, [alertId]);
      return result.rows[0] || null;
    },
    async supersede(client, id, at) {
      await query(client, `
        UPDATE alert_occurrence_outcomes SET is_current = false, updated_at = $2
        WHERE id = $1 AND is_current
      `, [id, at]);
    },
    async insert(client, value) {
      const result = await query(client, `
        INSERT INTO alert_occurrence_outcomes (
          alert_id, outcome, reason, reason_code, source, confirmation_method,
          confirmation_confidence, recorded_at, recorded_by, recorded_by_id,
          recorded_by_type, linked_incident_id, linked_incident_key,
          linked_incident_relationship, linked_incident_at, evidence, notes,
          is_current, supersedes_id, idempotency_key, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16::jsonb, $17, true, $18, $19, $8, $8
        ) RETURNING *
      `, [
        value.alertId, value.outcome, value.reason, value.reasonCode, value.source,
        value.confirmationMethod, value.confirmationConfidence, value.recordedAt,
        value.recordedBy, value.recordedById, value.recordedByType,
        value.linkedIncidentId, value.linkedIncidentKey, value.linkedIncidentRelationship,
        value.linkedIncidentAt, JSON.stringify(value.evidence), value.notes,
        value.supersedesId, value.idempotencyKey,
      ]);
      return result.rows[0];
    },
    async audit(client, value) {
      await query(client, `
        INSERT INTO alert_occurrence_outcome_audit (
          alert_id, outcome_id, action, actor_id, actor_display, actor_type,
          idempotency_key, request_context, actor_email, actor_roles,
          actor_permissions, authorization_basis, previous_outcome_id,
          previous_outcome, new_outcome, reason, reason_code, notes,
          linked_incident_id, linked_incident_key, supersedes_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb,
          $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
        )
      `, [value.alertId, value.outcomeId, value.action, value.actorId,
        value.actorDisplay, value.actorType, value.idempotencyKey,
        JSON.stringify(value.requestContext || {}), value.actorEmail,
        JSON.stringify(value.actorRoles || []), JSON.stringify(value.actorPermissions || []),
        value.authorizationBasis, value.previousOutcomeId, value.previousOutcome,
        value.newOutcome, value.reason, value.reasonCode, value.notes,
        value.linkedIncidentId, value.linkedIncidentKey, value.supersedesId]);
    },
    async history(client, alertId) {
      const result = await query(client, `
        SELECT * FROM alert_occurrence_outcomes
        WHERE alert_id = $1 ORDER BY recorded_at DESC, id DESC
      `, [alertId]);
      return result.rows;
    },
    async auditHistory(client, alertId) {
      const result = await query(client, `
        SELECT * FROM alert_occurrence_outcome_audit
        WHERE alert_id = $1 ORDER BY created_at DESC, id DESC
      `, [alertId]);
      return result.rows;
    },
  };
}

function createOperationalOutcomeService({ store = createPostgresOutcomeStore(), now = () => Date.now() } = {}) {
  async function prepare(input, transaction) {
    const outcome = String(input?.outcome || '').trim().toUpperCase();
    if (!OPERATIONAL_OUTCOMES.includes(outcome)) {
      throw error(`outcome must be ${OPERATIONAL_OUTCOMES.join(', ')}.`, 'INVALID_OPERATIONAL_OUTCOME', 400);
    }
    const notes = cleanText(input.notes, 'notes', { max: 4000 });
    const evidence = safeEvidence(input.evidence || {});

    if (outcome === 'CONFIRMED_NOISE') {
      const reasonCode = String(input.reasonCode || input.reason || '').trim().toUpperCase();
      if (!NOISE_REASONS.includes(reasonCode)) {
        throw error(`Confirmed Noise reason must be ${NOISE_REASONS.join(', ')}.`, 'INVALID_NOISE_REASON', 400);
      }
      if (reasonCode === 'OTHER' && !notes) {
        throw error('An explanation is required when the Confirmed Noise reason is OTHER.', 'OTHER_NOISE_EXPLANATION_REQUIRED', 400);
      }
      return {
        confirmationConfidence: 1,
        confirmationMethod: 'HUMAN_CONFIRMED',
        evidence,
        linkedIncidentAt: null,
        linkedIncidentId: null,
        linkedIncidentKey: null,
        linkedIncidentRelationship: null,
        notes,
        outcome,
        reason: reasonCode,
        reasonCode,
        source: 'OPERATOR',
      };
    }

    if (outcome === 'CONFIRMED_INCIDENT') {
      const linkedIncidentValue = cleanText(input.linkedIncidentKey, 'linkedIncidentKey', { max: 80 });
      const linkedIncidentKey = linkedIncidentValue ? linkedIncidentValue.toUpperCase() : null;
      const incident = linkedIncidentKey ? await store.getIncident(transaction, linkedIncidentKey) : null;
      if (linkedIncidentKey && !incident) {
        throw error('The linked Jira Incident must already exist in the preserved Incident store.', 'LINKED_INCIDENT_NOT_FOUND', 422);
      }
      const suppliedId = cleanText(input.linkedIncidentId, 'linkedIncidentId', { max: 120 });
      if (suppliedId && !linkedIncidentKey) {
        throw error('linkedIncidentKey is required when linkedIncidentId is supplied.', 'LINKED_INCIDENT_KEY_REQUIRED', 400);
      }
      if (suppliedId && incident?.issue_id && suppliedId !== incident.issue_id) {
        throw error('The supplied Jira Incident ID does not match the preserved Incident.', 'LINKED_INCIDENT_ID_MISMATCH', 422);
      }
      return {
        confirmationConfidence: 1,
        confirmationMethod: incident ? 'JIRA_CONFIRMED_HUMAN_REVIEWED' : 'HUMAN_CONFIRMED',
        evidence: incident ? { ...evidence, jiraIncidentKey: incident.incident_key, jiraIssueId: incident.issue_id || null } : evidence,
        linkedIncidentAt: incident ? new Date(now()).toISOString() : null,
        linkedIncidentId: incident?.issue_id || suppliedId || null,
        linkedIncidentKey: incident?.incident_key || null,
        linkedIncidentRelationship: incident ? 'CONFIRMED_BY_OPERATOR' : null,
        notes,
        outcome,
        reason: cleanText(input.reason, 'reason', { max: 1000, required: true }),
        reasonCode: null,
        source: incident ? 'JIRA_INCIDENT' : 'OPERATOR',
      };
    }

    const reasonCode = cleanText(input.reasonCode, 'reasonCode', { max: 80 });
    if (reasonCode && !UNKNOWN_REASONS.includes(reasonCode.toUpperCase())) {
      throw error(`Unknown reason must be ${UNKNOWN_REASONS.join(', ')}.`, 'INVALID_UNKNOWN_REASON', 400);
    }
    if (reasonCode?.toUpperCase() === 'OTHER' && !notes) {
      throw error('An explanation is required when the Unknown reason is OTHER.', 'OTHER_UNKNOWN_EXPLANATION_REQUIRED', 400);
    }
    return {
      confirmationConfidence: null,
      confirmationMethod: 'HUMAN_CONFIRMED',
      evidence,
      linkedIncidentAt: null,
      linkedIncidentId: null,
      linkedIncidentKey: null,
      linkedIncidentRelationship: null,
      notes,
      outcome,
      reason: cleanText(input.reason || reasonCode, 'reason', { max: 1000, required: true }),
      reasonCode: reasonCode?.toUpperCase() || null,
      source: 'OPERATOR',
    };
  }

  async function get(alertId) {
    await store.ensureSchema();
    const id = cleanText(alertId, 'alertId', { max: 255, required: true });
    const alert = await store.getAlert(null, id, false);
    if (!alert) throw error(`Alert occurrence ${id} was not found.`, 'LEARNING_RECORD_NOT_FOUND', 404);
    const rows = await store.history(null, id);
    const auditRows = store.auditHistory ? await store.auditHistory(null, id) : [];
    return {
      alertId: id,
      audit: auditRows.map(mapAuditRow),
      current: mapRow(rows.find((row) => row.is_current) || null),
      history: rows.map(mapRow),
    };
  }

  async function record(alertId, input, actorValue, options = {}) {
    await store.ensureSchema();
    const id = cleanText(alertId, 'alertId', { max: 255, required: true });
    const actor = normalizeActor(actorValue);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    return store.transaction(async (transaction) => {
      if (!await store.getAlert(transaction, id, true)) {
        throw error(`Alert occurrence ${id} was not found.`, 'LEARNING_RECORD_NOT_FOUND', 404);
      }
      const idempotent = await store.findIdempotent(transaction, id, idempotencyKey);
      if (idempotent) {
        const currentAfterDuplicate = await store.getCurrent(transaction, id);
        return {
          alertId: id,
          current: mapRow(currentAfterDuplicate || idempotent),
          duplicateSubmission: true,
          originalSubmission: mapRow(idempotent),
        };
      }
      const current = await store.getCurrent(transaction, id);
      const candidate = await prepare(input, transaction);
      if (sameOutcome(current, candidate)) {
        return { alertId: id, current: mapRow(current), duplicateSubmission: true };
      }
      const recordedAt = new Date(now()).toISOString();
      if (current) await store.supersede(transaction, current.id, recordedAt);
      const inserted = await store.insert(transaction, {
        ...candidate,
        alertId: id,
        idempotencyKey,
        recordedAt,
        recordedBy: actor.display,
        recordedById: actor.id,
        recordedByType: actor.type,
        supersedesId: current?.id || null,
      });
      await store.audit(transaction, {
        action: current ? 'OUTCOME_CORRECTED' : 'OUTCOME_RECORDED',
        actorDisplay: actor.display,
        actorEmail: actor.email,
        actorId: actor.id,
        actorPermissions: actor.permissions,
        actorRoles: actor.roles,
        actorType: actor.type,
        alertId: id,
        authorizationBasis: actor.authorizationBasis,
        idempotencyKey,
        linkedIncidentId: candidate.linkedIncidentId,
        linkedIncidentKey: candidate.linkedIncidentKey,
        newOutcome: candidate.outcome,
        notes: candidate.notes,
        outcomeId: inserted.id,
        previousOutcome: current?.outcome || null,
        previousOutcomeId: current?.id || null,
        reason: candidate.reason,
        reasonCode: candidate.reasonCode,
        requestContext: safeEvidence(options.requestContext || {}),
        supersedesId: current?.id || null,
      });
      return {
        alertId: id,
        corrected: Boolean(current),
        current: mapRow(inserted),
        duplicateSubmission: false,
        previous: mapRow(current),
      };
    });
  }

  return { get, record };
}

module.exports = {
  AUTHORIZED_ROLES,
  NOISE_REASONS,
  OPERATIONAL_OUTCOMES,
  UNKNOWN_REASONS,
  createOperationalOutcomeService,
  createPostgresOutcomeStore,
  mapRow,
  mapAuditRow,
  normalizeActor,
  requireOutcomeOperator,
  safeEvidence,
  service: createOperationalOutcomeService(),
  trainingReadiness,
};

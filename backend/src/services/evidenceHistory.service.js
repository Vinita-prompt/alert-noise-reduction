const database = require('../config/db');
const { service: humanVerificationService } = require('./humanVerification.service');

const DEFAULT_RETENTION_DAYS = 60;
const MAX_RETENTION_DAYS = 365;
const ALLOWED_PAGE_SIZES = new Set([10, 25, 50, 100]);

function safeInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${name} must be between ${minimum} and ${maximum}.`);
    error.status = 400;
    error.code = 'INVALID_EVIDENCE_HISTORY_QUERY';
    error.safeMessage = error.message;
    throw error;
  }
  return parsed;
}

function retentionDays(env = process.env) {
  return safeInteger(
    env.EVIDENCE_HISTORY_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    1,
    MAX_RETENTION_DAYS,
    'EVIDENCE_HISTORY_RETENTION_DAYS',
  );
}

function clean(value, maximum, name) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const result = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!result) return null;
  if (result.length > maximum) {
    const error = new Error(`${name} must be ${maximum} characters or fewer.`);
    error.status = 400;
    error.code = 'INVALID_EVIDENCE_HISTORY_QUERY';
    error.safeMessage = error.message;
    throw error;
  }
  return result;
}

function outcomeLabel(value) {
  if (value === 'CONFIRMED_INCIDENT') return 'Verified Incident';
  if (value === 'CONFIRMED_NOISE') return 'Verified Noise';
  return 'Insufficient Evidence';
}

function evidenceStatus(value) {
  if (value === 'CONFIRMED_INCIDENT') return 'VERIFIED_INCIDENT';
  if (value === 'CONFIRMED_NOISE') return 'VERIFIED_NOISE';
  return 'INSUFFICIENT_EVIDENCE';
}

function mapRow(row) {
  return {
    alertId: row.alert_id,
    alertNumber: row.alert_number,
    alertName: row.alert_name,
    confidence: row.confidence || null,
    evidenceCompleteness: row.evidence_completeness || 'MISSING',
    evidenceStatus: evidenceStatus(row.evidence_outcome_status),
    evidenceStatusLabel: outcomeLabel(row.evidence_outcome_status),
    finalDecision: row.evidence_outcome_status,
    finalDecisionLabel: outcomeLabel(row.evidence_outcome_status),
    firstSubmittedAt: row.first_submitted_at ? new Date(row.first_submitted_at).toISOString() : null,
    hasAttachments: Boolean(row.has_attachments),
    lastUpdatedAt: row.last_updated_at ? new Date(row.last_updated_at).toISOString() : null,
    pendingEvidenceReason: row.pending_evidence_reason || null,
    priority: row.priority || null,
    reportId: row.report_id,
    reviewer: {
      email: row.reviewer_email || null,
      id: row.reviewer_id,
      name: row.reviewer_name,
    },
    revisionCount: Number(row.revision_count || 1),
    source: row.source || null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
  };
}

function createEvidenceHistoryService({
  db = database,
  env = process.env,
  ensureSchema = () => humanVerificationService.ensureSchema(),
} = {}) {
  async function list(query = {}) {
    await ensureSchema();
    const configuredRetentionDays = retentionDays(env);
    const page = safeInteger(query.page, 1, 1, 1_000_000, 'page');
    const pageSize = safeInteger(query.pageSize, 25, 1, 100, 'pageSize');
    if (!ALLOWED_PAGE_SIZES.has(pageSize)) {
      const error = new Error('pageSize must be one of 10, 25, 50, or 100.');
      error.status = 400;
      error.code = 'INVALID_EVIDENCE_HISTORY_QUERY';
      error.safeMessage = error.message;
      throw error;
    }

    const params = [configuredRetentionDays];
    const add = (value) => { params.push(value); return `$${params.length}`; };
    const filters = [];
    const search = clean(query.search, 300, 'search');
    const source = clean(query.source, 100, 'source');
    const outcome = clean(query.outcome, 60, 'outcome');
    const completeness = clean(query.completeness, 60, 'completeness');
    const reviewer = clean(query.reviewer, 200, 'reviewer');
    if (search) {
      const parameter = add(`%${search.toLowerCase()}%`);
      filters.push(`(LOWER(COALESCE(alert_number,'')) LIKE ${parameter}
        OR LOWER(COALESCE(alert_name,'')) LIKE ${parameter}
        OR LOWER(COALESCE(reviewer_name,'')) LIKE ${parameter})`);
    }
    if (source) filters.push(`LOWER(COALESCE(source,''))=${add(source.toLowerCase())}`);
    if (outcome) filters.push(`evidence_outcome_status=${add(outcome.toUpperCase())}`);
    if (completeness) filters.push(`evidence_completeness=${add(completeness.toUpperCase())}`);
    if (reviewer) filters.push(`LOWER(reviewer_name)=${add(reviewer.toLowerCase())}`);
    const predicate = filters.length ? filters.join(' AND ') : 'TRUE';

    const base = `WITH retained AS (
      SELECT report.*,
        COALESCE(NULLIF(report.alert_name,''), alert.title) AS display_alert_name,
        COALESCE(NULLIF(report.alert_number,''), alert.atlassian_ops_tiny_id) AS display_alert_number,
        COALESCE(NULLIF(report.form_responses->>'monitoringSource',''), alert.source) AS source,
        COALESCE(NULLIF(report.form_responses->>'priority',''),
          NULLIF(alert.raw_payload->'priority'->>'name',''),
          NULLIF(alert.raw_payload->>'priority',''), alert.severity) AS priority,
        NULLIF(report.form_responses->>'decisionConfidence','') AS confidence,
        COUNT(*) OVER (PARTITION BY report.alert_id)::integer AS revision_count,
        MIN(report.submitted_at) OVER (PARTITION BY report.alert_id) AS first_submitted_at,
        MAX(report.submitted_at) OVER (PARTITION BY report.alert_id) AS last_updated_at,
        ROW_NUMBER() OVER (PARTITION BY report.alert_id ORDER BY report.submitted_at DESC, report.report_id DESC) AS row_rank
      FROM incident_verification_reports report
      JOIN alerts alert ON alert.id=report.alert_id
      WHERE report.submitted_at >= NOW() - ($1::int * INTERVAL '1 day')
    ), latest AS (
      SELECT report_id, alert_id, display_alert_number AS alert_number,
        display_alert_name AS alert_name, reviewer_id, reviewer_name,
        reviewer_email, evidence_outcome_status, pending_evidence_reason,
        evidence_completeness, submitted_at, source, priority, confidence,
        revision_count, first_submitted_at, last_updated_at,
        COALESCE(jsonb_array_length(attachment_references), 0) > 0 AS has_attachments
      FROM retained WHERE row_rank=1
    )`;
    const countResult = await db.query(`${base}
      SELECT
        COUNT(*)::integer AS total_count,
        COUNT(*) FILTER (WHERE ${predicate})::integer AS filtered_count,
        MAX(last_updated_at) AS updated_at
      FROM latest`, params);
    const totalCount = Number(countResult.rows[0]?.total_count || 0);
    const filteredCount = Number(countResult.rows[0]?.filtered_count || 0);
    const rows = await db.query(`${base}
      SELECT * FROM latest WHERE ${predicate}
      ORDER BY ${query.sort === 'oldest' ? 'last_updated_at ASC' : 'last_updated_at DESC'}, alert_id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]);

    return {
      currentPage: page,
      filteredCount,
      items: rows.rows.map(mapRow),
      page,
      pageSize,
      retentionDays: configuredRetentionDays,
      total: filteredCount,
      totalCount,
      totalPages: Math.max(1, Math.ceil(filteredCount / pageSize)),
      updatedAt: countResult.rows[0]?.updated_at
        ? new Date(countResult.rows[0].updated_at).toISOString()
        : null,
    };
  }

  return { list, retentionDays: () => retentionDays(env) };
}

const service = createEvidenceHistoryService();

module.exports = {
  DEFAULT_RETENTION_DAYS,
  createEvidenceHistoryService,
  outcomeLabel,
  retentionDays,
  service,
};

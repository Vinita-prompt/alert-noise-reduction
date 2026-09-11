const db = require('../config/db');
const { DECISION_LAYER_STATE } = require('../config/decisionLayer');
const { ensureSchema: ensureIncidentReconciliationSchema } = require('./historicalIncidentReconciliation.service');
const {
  NOISE_REASONS,
  OPERATIONAL_OUTCOMES,
  createPostgresOutcomeStore,
  trainingReadiness,
} = require('./operationalOutcome.service');
const {
  ALERT_DOMAINS,
  ALERT_SUBTYPES,
  BEHAVIOR_TYPES,
  SOURCE_SEMANTICS,
  buildTrainingPreview,
  deriveObservedBehavior,
  determineOccurrenceQuality,
  featureLeakageAudit,
  suggestTaxonomy,
} = require('./alertFeatureEngineering.service');
const { service: alertTaxonomyService } = require('./alertTaxonomy.service');

const DATASET_VERSION = 'historical-learning-dataset-v3.0';
const FEATURE_VERSION = 'provenance-aware-features-v1';
const EXPLICIT_OPERATIONS_MAPPING_REASON = 'JSM Operations alert was linked to a stored Operations incident during enrichment.';
const CORRELATION_WINDOW_SECONDS = 30 * 60;
const RANGE_MILLISECONDS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});
const OUTCOMES = new Set(['INCIDENT', 'INCIDENT_UNLINKED', 'NO_OBSERVED_INCIDENT', 'UNKNOWN']);
const OPERATIONAL_FILTERS = new Set([...OPERATIONAL_OUTCOMES, 'UNCONFIRMED']);
const TRAINING_READINESS_FILTERS = new Set(['CONFIRMED_LABELED', 'WEAK_EVIDENCE', 'UNLABELED', 'UNKNOWN']);
const operationalOutcomeStore = createPostgresOutcomeStore();

const DATA_CTES = `
mapping_rows AS (
  SELECT
    aim.id AS mapping_id,
    aim.alert_id,
    aim.incident_id,
    aim.jira_ticket_id,
    aim.mapping_reason,
    aim.created_at AS mapping_created_at,
    oi.incident_key,
    oi.raw_payload->'fields'->'issuetype'->>'name' AS issue_type,
    oi.incident_created_at,
    oi.status AS incident_status,
    oi.resolution AS incident_resolution,
    oi.closed_at AS incident_resolved_at,
    oi.source_url AS incident_source_url,
    oi.assignee AS incident_assignee,
    oi.incident_details,
    oi.raw_payload AS incident_raw_payload,
    (aim.mapping_reason = '${EXPLICIT_OPERATIONS_MAPPING_REASON.replaceAll("'", "''")}') AS explicit_operations_mapping
  FROM alert_incident_mappings aim
  LEFT JOIN operations_incidents oi ON oi.incident_key = aim.jira_ticket_id
),
mapping_rollup AS (
  SELECT
    alert_id,
    COUNT(DISTINCT incident_key) FILTER (
      WHERE explicit_operations_mapping AND issue_type = '[System] Incident'
    )::integer AS strong_incident_count,
    COUNT(*) FILTER (
      WHERE NOT explicit_operations_mapping
    )::integer AS legacy_candidate_count,
    COUNT(*) FILTER (
      WHERE explicit_operations_mapping AND incident_key IS NULL
    )::integer AS unresolved_mapping_count,
    MIN(mapping_created_at) FILTER (
      WHERE explicit_operations_mapping AND issue_type = '[System] Incident'
    ) AS first_strong_match_at,
    COALESCE(JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'mappingId', mapping_id,
        'incidentId', incident_raw_payload->>'id',
        'key', incident_key,
        'createdAt', incident_created_at,
        'status', incident_status,
        'resolution', incident_resolution,
        'resolvedAt', incident_resolved_at,
        'resolver', incident_raw_payload->'fields'->'customfield_15764',
        'team', COALESCE(incident_details->>'root_cause_owner_team', incident_details->'teams_involved'->>0),
        'sourceUrl', incident_source_url,
        'matchTimestamp', mapping_created_at,
        'mappingReason', mapping_reason,
        'evidenceId', CONCAT('alert_incident_mapping:', mapping_id)
      ) ORDER BY incident_created_at NULLS LAST, incident_key
    ) FILTER (
      WHERE explicit_operations_mapping AND issue_type = '[System] Incident'
    ), '[]'::jsonb) AS incident_candidates,
    COALESCE(JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'mappingId', mapping_id,
        'jiraTicketId', jira_ticket_id,
        'mappingReason', mapping_reason,
        'issueType', issue_type,
        'evidenceId', CONCAT('legacy_mapping:', mapping_id)
      ) ORDER BY mapping_created_at, mapping_id
    ) FILTER (WHERE NOT explicit_operations_mapping), '[]'::jsonb) AS legacy_candidates
  FROM mapping_rows
  GROUP BY alert_id
),
reconciliation_rollup AS (
  SELECT
    reconciliation.alert_id,
    COUNT(DISTINCT reconciliation.incident_key) FILTER (
      WHERE reconciliation.relationship_state = 'CONFIRMED_MATCH'
    )::integer AS confirmed_reconciliation_count,
    COUNT(DISTINCT reconciliation.incident_key) FILTER (
      WHERE reconciliation.relationship_state = 'PROBABLE_MATCH'
    )::integer AS probable_reconciliation_count,
    COUNT(DISTINCT reconciliation.incident_key) FILTER (
      WHERE reconciliation.relationship_state = 'AMBIGUOUS'
    )::integer AS ambiguous_reconciliation_count,
    MIN(reconciliation.reconciled_at) FILTER (
      WHERE reconciliation.relationship_state = 'CONFIRMED_MATCH'
    ) AS first_confirmed_reconciliation_at,
    COALESCE(JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'reconciliationId', reconciliation.id,
        'incidentId', incident.raw_payload->>'id',
        'key', reconciliation.incident_key,
        'createdAt', incident.incident_created_at,
        'status', incident.status,
        'resolution', incident.resolution,
        'resolvedAt', incident.closed_at,
        'resolver', COALESCE(incident.incident_details->'resolvedBy', incident.raw_payload->'fields'->'customfield_15764'),
        'team', COALESCE(incident.incident_details->>'root_cause_owner_team', incident.incident_details->'teams_involved'->>0),
        'sourceUrl', incident.source_url,
        'matchTimestamp', reconciliation.reconciled_at,
        'matchMethod', reconciliation.match_method,
        'matchStrength', reconciliation.match_strength,
        'matchConfidence', reconciliation.match_confidence,
        'relationshipState', reconciliation.relationship_state,
        'timeDeltaSeconds', reconciliation.time_delta_seconds,
        'matchedSource', reconciliation.matched_source,
        'matchedService', reconciliation.matched_service,
        'matchedApplication', reconciliation.matched_application,
        'matchedEnvironment', reconciliation.matched_environment,
        'evidence', reconciliation.evidence,
        'evidenceId', CONCAT('incident_reconciliation:', reconciliation.id)
      ) ORDER BY incident.incident_created_at NULLS LAST, reconciliation.incident_key
    ) FILTER (
      WHERE reconciliation.relationship_state IN ('CONFIRMED_MATCH', 'PROBABLE_MATCH', 'AMBIGUOUS')
    ), '[]'::jsonb) AS reconciliation_candidates
  FROM incident_alert_reconciliations reconciliation
  JOIN operations_incidents incident ON incident.incident_key = reconciliation.incident_key
  WHERE reconciliation.current
    AND reconciliation.alert_id IS NOT NULL
  GROUP BY reconciliation.alert_id
),
current_operational_outcomes AS (
  SELECT *
  FROM alert_occurrence_outcomes
  WHERE is_current
),
current_taxonomy_corrections AS (
  SELECT *
  FROM alert_occurrence_taxonomy_corrections
  WHERE is_current
),
jira_issue_links AS (
  SELECT
    oi.incident_key AS source_issue_key,
    COALESCE(link->'inwardIssue', link->'outwardIssue') AS linked_issue
  FROM operations_incidents oi
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(COALESCE(oi.raw_payload->'fields'->'issuelinks', '[]'::jsonb)) link
),
problem_rows AS (
  SELECT DISTINCT
    mr.alert_id,
    mr.incident_key AS problem_key,
    mr.incident_raw_payload->>'id' AS problem_id,
    mr.incident_created_at AS problem_created_at,
    mr.incident_status AS problem_status,
    mr.incident_source_url AS problem_source_url,
    mr.mapping_created_at AS match_timestamp,
    'explicit_alert_problem_mapping'::text AS match_method,
    CONCAT('alert_incident_mapping:', mr.mapping_id) AS evidence_id
  FROM mapping_rows mr
  WHERE mr.explicit_operations_mapping AND mr.issue_type = '[System] Problem'

  UNION

  SELECT DISTINCT
    mr.alert_id,
    links.linked_issue->>'key' AS problem_key,
    COALESCE(problem.raw_payload->>'id', links.linked_issue->>'id') AS problem_id,
    problem.incident_created_at AS problem_created_at,
    COALESCE(problem.status, links.linked_issue->'fields'->'status'->>'name') AS problem_status,
    problem.source_url AS problem_source_url,
    mr.mapping_created_at AS match_timestamp,
    'jira_incident_problem_link'::text AS match_method,
    CONCAT('jira_issue_link:', mr.incident_key, ':', links.linked_issue->>'key') AS evidence_id
  FROM mapping_rows mr
  JOIN jira_issue_links links ON links.source_issue_key = mr.incident_key
  LEFT JOIN operations_incidents problem ON problem.incident_key = links.linked_issue->>'key'
  WHERE mr.explicit_operations_mapping
    AND mr.issue_type = '[System] Incident'
    AND links.linked_issue->'fields'->'issuetype'->>'name' = '[System] Problem'
),
problem_incident_counts AS (
  SELECT
    linked_issue->>'key' AS problem_key,
    COUNT(DISTINCT source_issue_key)::integer AS related_incident_count
  FROM jira_issue_links
  WHERE linked_issue->'fields'->'issuetype'->>'name' = '[System] Problem'
  GROUP BY linked_issue->>'key'
),
problem_rollup AS (
  SELECT
    pr.alert_id,
    COUNT(DISTINCT pr.problem_key)::integer AS problem_count,
    MIN(pr.match_timestamp) AS first_problem_match_at,
    COALESCE(JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
      'problemId', pr.problem_id,
      'key', pr.problem_key,
      'createdAt', pr.problem_created_at,
      'status', pr.problem_status,
      'sourceUrl', pr.problem_source_url,
      'matchTimestamp', pr.match_timestamp,
      'matchMethod', pr.match_method,
      'evidenceId', pr.evidence_id,
      'relatedIncidentCount', COALESCE(pic.related_incident_count, 0)
    )), '[]'::jsonb) AS problem_candidates
  FROM problem_rows pr
  LEFT JOIN problem_incident_counts pic ON pic.problem_key = pr.problem_key
  GROUP BY pr.alert_id
),
correlation_links AS (
  SELECT DISTINCT
    ach.alert_id,
    related.value AS related_alert_id
  FROM alert_correlation_history ach
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(COALESCE(ach.related_alerts, '[]'::jsonb)) related(value)
),
correlation_rollup AS (
  SELECT
    ach.alert_id,
    MAX(ach.duplicate_count)::integer AS observed_duplicate_count,
    COALESCE(JSONB_AGG(DISTINCT CONCAT('correlation_history:', ach.id)), '[]'::jsonb) AS evidence_ids
  FROM alert_correlation_history ach
  GROUP BY ach.alert_id
),
related_rollup AS (
  SELECT
    links.alert_id,
    COUNT(DISTINCT links.related_alert_id)::integer AS related_alert_count,
    COALESCE(JSONB_AGG(DISTINCT related.source) FILTER (WHERE related.source IS NOT NULL), '[]'::jsonb) AS related_sources,
    COALESCE(JSONB_AGG(DISTINCT related.service) FILTER (WHERE related.service IS NOT NULL), '[]'::jsonb) AS correlated_services
  FROM correlation_links links
  LEFT JOIN alerts related ON related.id = links.related_alert_id
  GROUP BY links.alert_id
),
base_records AS (
  SELECT
    occurrence.*,
    operational.id AS operational_outcome_id,
    operational.outcome AS operational_outcome,
    operational.reason AS operational_outcome_reason,
    operational.reason_code AS operational_outcome_reason_code,
    operational.source AS operational_outcome_source,
    operational.confirmation_method,
    operational.confirmation_confidence,
    operational.recorded_at AS operational_outcome_recorded_at,
    operational.recorded_by AS operational_outcome_recorded_by,
    operational.recorded_by_id AS operational_outcome_recorded_by_id,
    operational.recorded_by_type AS operational_outcome_recorded_by_type,
    operational.linked_incident_id AS operational_linked_incident_id,
    operational.linked_incident_key AS operational_linked_incident_key,
    operational.linked_incident_relationship AS operational_linked_incident_relationship,
    operational.linked_incident_at AS operational_linked_incident_at,
    operational.evidence AS operational_outcome_evidence,
    operational.notes AS operational_outcome_notes,
    operational.supersedes_id AS operational_outcome_supersedes_id,
    taxonomy.id AS taxonomy_correction_id,
    taxonomy.suggested_domain AS taxonomy_original_domain,
    taxonomy.suggested_subtype AS taxonomy_original_subtype,
    taxonomy.corrected_domain AS taxonomy_corrected_domain,
    taxonomy.corrected_subtype AS taxonomy_corrected_subtype,
    taxonomy.reason AS taxonomy_correction_reason,
    taxonomy.actor_id AS taxonomy_corrected_by_id,
    taxonomy.actor_display AS taxonomy_corrected_by,
    taxonomy.created_at AS taxonomy_corrected_at,
    COALESCE(mr.strong_incident_count, 0) AS strong_incident_count,
    COALESCE(reconciliation.confirmed_reconciliation_count, 0) AS confirmed_reconciliation_count,
    COALESCE(reconciliation.probable_reconciliation_count, 0) AS probable_reconciliation_count,
    COALESCE(reconciliation.ambiguous_reconciliation_count, 0) AS ambiguous_reconciliation_count,
    COALESCE(mr.legacy_candidate_count, 0) AS legacy_candidate_count,
    COALESCE(mr.unresolved_mapping_count, 0) AS unresolved_mapping_count,
    COALESCE(mr.first_strong_match_at, reconciliation.first_confirmed_reconciliation_at) AS first_strong_match_at,
    COALESCE(mr.incident_candidates, '[]'::jsonb)
      || COALESCE(reconciliation.reconciliation_candidates, '[]'::jsonb) AS incident_candidates,
    COALESCE(mr.legacy_candidates, '[]'::jsonb) AS legacy_candidates,
    COALESCE(pr.problem_count, 0) AS problem_count,
    COALESCE(pr.problem_candidates, '[]'::jsonb) AS problem_candidates,
    correlation.observed_duplicate_count,
    COALESCE(correlation.evidence_ids, '[]'::jsonb) AS correlation_evidence_ids,
    related.related_alert_count,
    COALESCE(related.related_sources, '[]'::jsonb) AS related_sources,
    COALESCE(related.correlated_services, '[]'::jsonb) AS correlated_services
  FROM historical_alert_learning_occurrences_v1 occurrence
  LEFT JOIN current_operational_outcomes operational ON operational.alert_id = occurrence.alert_id
  LEFT JOIN current_taxonomy_corrections taxonomy ON taxonomy.alert_id = occurrence.alert_id
  LEFT JOIN mapping_rollup mr ON mr.alert_id = occurrence.alert_id
  LEFT JOIN reconciliation_rollup reconciliation ON reconciliation.alert_id = occurrence.alert_id
  LEFT JOIN problem_rollup pr ON pr.alert_id = occurrence.alert_id
  LEFT JOIN correlation_rollup correlation ON correlation.alert_id = occurrence.alert_id
  LEFT JOIN related_rollup related ON related.alert_id = occurrence.alert_id
),
labeled_records AS (
  SELECT
    base_records.*,
    CASE
      WHEN strong_incident_count > 0 OR confirmed_reconciliation_count > 0 THEN 'INCIDENT'
      WHEN probable_reconciliation_count > 0 THEN 'INCIDENT_UNLINKED'
      WHEN ambiguous_reconciliation_count > 0 OR legacy_candidate_count > 0 OR unresolved_mapping_count > 0 THEN 'UNKNOWN'
      ELSE 'NO_OBSERVED_INCIDENT'
    END AS outcome_label
  FROM base_records
),
taxonomy_suggestions AS (
  SELECT
    labeled_records.*,
    learning_taxonomy_subtype(source, message, entity, application, service) AS taxonomy_suggested_subtype
  FROM labeled_records
),
feature_records AS (
  SELECT
    taxonomy_suggestions.*,
    learning_taxonomy_domain(taxonomy_suggested_subtype) AS taxonomy_suggested_domain,
    COALESCE(taxonomy_corrected_domain, learning_taxonomy_domain(taxonomy_suggested_subtype)) AS taxonomy_domain,
    COALESCE(taxonomy_corrected_subtype, taxonomy_suggested_subtype) AS taxonomy_subtype,
    CASE
      WHEN operational_outcome IN ('CONFIRMED_INCIDENT', 'CONFIRMED_NOISE') THEN 'CONFIRMED_LABELED'
      WHEN operational_outcome = 'UNKNOWN' OR (operational_outcome IS NULL AND outcome_label = 'UNKNOWN') THEN 'UNKNOWN'
      WHEN outcome_label IN ('INCIDENT', 'INCIDENT_UNLINKED') THEN 'WEAK_EVIDENCE'
      ELSE 'UNLABELED'
    END AS training_readiness_state
  FROM taxonomy_suggestions
)
`;

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function personName(value) {
  if (!value) return null;
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return personName(value[0]);
  if (typeof value === 'object') {
    return clean(value.displayName || value.emailAddress || value.email || value.name || value.accountId || value.id);
  }
  return clean(value);
}

function usefulIdentity(value) {
  const result = clean(value);
  return result && !['unknown', 'unknown-service', 'unassigned'].includes(result.toLowerCase()) ? result : null;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRange(value = '24h', now = () => Date.now()) {
  const range = String(value || '24h').toLowerCase();
  if (range === 'all') return { from: null, range, to: new Date(now()).toISOString() };
  if (!RANGE_MILLISECONDS[range]) {
    const error = new Error('range must be 24h, 7d, 30d, 90d, or all.');
    error.code = 'INVALID_LEARNING_RANGE';
    error.status = 400;
    throw error;
  }
  const to = now();
  return { from: new Date(to - RANGE_MILLISECONDS[range]).toISOString(), range, to: new Date(to).toISOString() };
}

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  const error = new Error(`${name} must be true, false, or all.`);
  error.code = 'INVALID_LEARNING_FILTER';
  error.status = 400;
  throw error;
}

function determineHistoricalOutcome({
  ambiguousReconciliationCount = 0,
  confirmedReconciliationCount = 0,
  firstStrongMatchAt = null,
  incidentCandidates = [],
  legacyCandidateCount = 0,
  probableReconciliationCount = 0,
  strongIncidentCount = 0,
  unresolvedMappingCount = 0,
} = {}) {
  const candidates = asArray(incidentCandidates);
  const confirmedCandidate = candidates.find((item) => item.relationshipState === 'CONFIRMED_MATCH');
  const probableCandidate = candidates.find((item) => item.relationshipState === 'PROBABLE_MATCH');
  const confirmedCount = Number(strongIncidentCount) + Number(confirmedReconciliationCount);
  if (confirmedCount > 0) {
    const count = confirmedCount;
    return {
      label: 'INCIDENT',
      confidence: numeric(confirmedCandidate?.matchConfidence) ?? 1,
      reason: count === 1
        ? (confirmedCandidate
          ? 'Confirmed Jira Incident relationship found through provenance-aware reconciliation.'
          : 'Explicit alert-to-Incident mapping found.')
        : `${count} explicit alert-to-Incident mappings found; the occurrence is Incident-linked and the alternatives remain visible for audit.`,
      matchMethod: confirmedCandidate?.matchMethod || 'explicit_alert_incident_mapping',
      matchSource: confirmedCandidate
        ? 'incident_alert_reconciliations + operations_incidents'
        : 'alert_incident_mappings + operations_incidents',
      matchStrength: confirmedCandidate?.matchStrength || 'strong',
      matchTimestamp: toIso(confirmedCandidate?.matchTimestamp || firstStrongMatchAt),
      ambiguous: count > 1,
      evidence: asArray(confirmedCandidate?.evidence),
      evidenceIds: candidates.map((item) => item.evidenceId).filter(Boolean),
    };
  }

  if (Number(probableReconciliationCount) > 0) {
    return {
      label: 'INCIDENT_UNLINKED',
      confidence: numeric(probableCandidate?.matchConfidence),
      reason: 'A current Jira Incident has a probable evidence match, but the alert relationship is not confirmed.',
      matchMethod: probableCandidate?.matchMethod || 'probable_incident_reconciliation',
      matchSource: 'incident_alert_reconciliations + operations_incidents',
      matchStrength: probableCandidate?.matchStrength || 'moderate',
      matchTimestamp: toIso(probableCandidate?.matchTimestamp),
      ambiguous: false,
      evidence: asArray(probableCandidate?.evidence),
      evidenceIds: candidates.map((item) => item.evidenceId).filter(Boolean),
    };
  }

  if (Number(ambiguousReconciliationCount) > 0
    || Number(legacyCandidateCount) > 0
    || Number(unresolvedMappingCount) > 0) {
    return {
      label: 'UNKNOWN',
      confidence: null,
      reason: Number(ambiguousReconciliationCount) > 0
        ? 'Multiple plausible alert-to-Incident relationships remain ambiguous; none is a confirmed training label.'
        : 'Only legacy/non-authoritative or unresolved relationship evidence is available; it cannot establish an Incident outcome.',
      matchMethod: Number(ambiguousReconciliationCount) > 0
        ? 'ambiguous_incident_reconciliation'
        : 'legacy_or_unresolved_mapping_excluded',
      matchSource: Number(ambiguousReconciliationCount) > 0
        ? 'incident_alert_reconciliations'
        : 'preserved historical mappings',
      matchStrength: Number(ambiguousReconciliationCount) > 0 ? 'ambiguous' : null,
      matchTimestamp: null,
      ambiguous: true,
      evidence: candidates.flatMap((item) => asArray(item.evidence)),
      evidenceIds: candidates.map((item) => item.evidenceId).filter(Boolean),
    };
  }

  return {
    label: 'NO_OBSERVED_INCIDENT',
    confidence: null,
    reason: 'No Incident relationship found in preserved historical mappings.',
    matchMethod: 'no_preserved_incident_mapping',
    matchSource: 'alert_incident_mappings',
    matchStrength: null,
    matchTimestamp: null,
    ambiguous: false,
    evidence: [],
    evidenceIds: [],
  };
}

function choosePrimaryByTime(candidates, createdAt) {
  const created = new Date(createdAt || 0).getTime();
  const stateRank = { CONFIRMED_MATCH: 0, PROBABLE_MATCH: 1, AMBIGUOUS: 2 };
  return [...asArray(candidates)].sort((left, right) => {
    const leftRank = left.relationshipState ? (stateRank[left.relationshipState] ?? 3) : 0;
    const rightRank = right.relationshipState ? (stateRank[right.relationshipState] ?? 3) : 0;
    const leftTime = new Date(left.createdAt || 0).getTime();
    const rightTime = new Date(right.createdAt || 0).getTime();
    const leftDelta = Number.isFinite(created) && Number.isFinite(leftTime) ? Math.abs(leftTime - created) : Number.MAX_SAFE_INTEGER;
    const rightDelta = Number.isFinite(created) && Number.isFinite(rightTime) ? Math.abs(rightTime - created) : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || leftDelta - rightDelta || String(left.key || '').localeCompare(String(right.key || ''));
  })[0] || null;
}

function secondsBetween(left, right) {
  if (!left || !right) return null;
  const difference = new Date(right).getTime() - new Date(left).getTime();
  return Number.isFinite(difference) ? Math.round(difference / 1000) : null;
}

function evidenceItem(type, available, evidenceIds = [], detail = null) {
  return { type, available: Boolean(available), evidenceIds: asArray(evidenceIds), detail };
}

function operationalOutcomeFromRow(row) {
  if (!row.operational_outcome_id) return null;
  return {
    id: Number(row.operational_outcome_id),
    outcome: row.operational_outcome,
    reason: row.operational_outcome_reason,
    reasonCode: row.operational_outcome_reason_code || null,
    source: row.operational_outcome_source,
    confirmationMethod: row.confirmation_method,
    confirmationSource: row.operational_outcome_source,
    confirmationConfidence: numeric(row.confirmation_confidence),
    recordedAt: toIso(row.operational_outcome_recorded_at),
    recordedBy: row.operational_outcome_recorded_by,
    recordedById: row.operational_outcome_recorded_by_id,
    recordedByType: row.operational_outcome_recorded_by_type,
    linkedIncidentId: row.operational_linked_incident_id || null,
    linkedIncidentKey: row.operational_linked_incident_key || null,
    linkedIncidentRelationship: row.operational_linked_incident_relationship || null,
    linkedIncidentAt: toIso(row.operational_linked_incident_at),
    evidence: row.operational_outcome_evidence || {},
    notes: row.operational_outcome_notes || null,
    supersedesId: row.operational_outcome_supersedes_id === null
      ? null
      : Number(row.operational_outcome_supersedes_id),
  };
}

function mapRecord(row, generatedAt) {
  const incidents = asArray(row.incident_candidates);
  const problems = asArray(row.problem_candidates);
  const primaryIncident = choosePrimaryByTime(incidents, row.created_at);
  const primaryProblem = choosePrimaryByTime(problems, row.created_at);
  const outcome = determineHistoricalOutcome({
    ambiguousReconciliationCount: row.ambiguous_reconciliation_count,
    confirmedReconciliationCount: row.confirmed_reconciliation_count,
    firstStrongMatchAt: row.first_strong_match_at,
    incidentCandidates: incidents,
    legacyCandidateCount: row.legacy_candidate_count,
    probableReconciliationCount: row.probable_reconciliation_count,
    strongIncidentCount: row.strong_incident_count,
    unresolvedMappingCount: row.unresolved_mapping_count,
  });
  const relatedSources = asArray(row.related_sources);
  const evidencePackageIds = asArray(row.evidence_package_ids);
  const correlationEvidenceIds = asArray(row.correlation_evidence_ids);
  const identityEvidenceIds = row.entity_id ? [`source_identity:${row.entity_id}`] : [];
  const slackEvidenceIds = row.slack_channel_id && row.slack_message_ts
    ? [`slack_message:${row.slack_channel_id}:${row.slack_message_ts}`]
    : [];
  const incidentDelta = primaryIncident
    ? numeric(primaryIncident.timeDeltaSeconds) ?? secondsBetween(row.created_at, primaryIncident.createdAt)
    : null;
  const problemDelta = primaryProblem ? secondsBetween(row.created_at, primaryProblem.createdAt) : null;
  const durationSeconds = secondsBetween(row.first_seen, row.last_seen);
  const occurrences = Math.max(1, Number(row.occurrence_count || 1));
  const previousSignatureCount = Number(row.previous_same_signature_count || 0);
  const previousIncidentCount = Number(row.previous_incident_count || 0);
  const incidentResolved = Boolean(primaryIncident?.resolvedAt)
    && !/^(open|unresolved)$/i.test(String(primaryIncident?.resolution || ''))
    && !/^(monitoring|investigating|identified|priority triage)$/i.test(String(primaryIncident?.status || ''));
  const operationalOutcome = operationalOutcomeFromRow(row);
  const taxonomySuggestion = suggestTaxonomy({
    application: row.application,
    entity: row.entity,
    message: row.message,
    normalizedMessage: row.normalized_message,
    monitoringObjectType: row.extracted_details?.normalized_alert?.object_type,
    service: row.service,
    source: row.source,
    tags: asArray(row.raw_payload?.tags).map((item) => typeof item === 'string' ? item : item?.name || item?.value).filter(Boolean),
    title: row.title,
  });
  const suggestedSubtype = row.taxonomy_suggested_subtype || taxonomySuggestion.subtype;
  const suggestedDomain = row.taxonomy_suggested_domain || taxonomySuggestion.domain;
  const occurrenceQuality = determineOccurrenceQuality({
    createdAt: row.first_seen || row.created_at,
    ingestionSource: row.ingestion_source,
    lastSeen: row.last_seen,
    occurrenceCount: occurrences,
    source: row.source,
  });
  const observedBehavior = deriveObservedBehavior({
    correlatedSourceCount: relatedSources.length || (row.observed_duplicate_count === null || row.observed_duplicate_count === undefined ? null : 1),
    correlatedSources: relatedSources,
    correlationEvidenceIds,
    duplicateCount: numeric(row.observed_duplicate_count),
    duplicateWindowSeconds: correlationEvidenceIds.length ? CORRELATION_WINDOW_SECONDS : null,
    durationSeconds,
    extractedDetails: row.extracted_details,
    nonActionableHistoryCount: Number(row.previous_confirmed_outcome_count || 0) > 0
      ? numeric(row.non_actionable_history_count) : null,
    rawPayload: row.raw_payload,
    relatedAlertCount: numeric(row.related_alert_count),
    stateTransitionCount: numeric(row.state_transition_count),
    status: row.status,
  });
  const readiness = trainingReadiness(outcome.label, operationalOutcome);
  const alertClassification = {
    domain: row.taxonomy_corrected_domain || row.taxonomy_domain || suggestedDomain,
    subtype: row.taxonomy_corrected_subtype || row.taxonomy_subtype || suggestedSubtype,
    assignmentMethod: row.taxonomy_correction_id ? 'AUTHENTICATED_OPERATOR_CORRECTION' : taxonomySuggestion.assignmentMethod,
    assignmentEvidence: taxonomySuggestion.assignmentEvidence,
    assignmentConfidence: taxonomySuggestion.assignmentConfidence,
    manuallyCorrected: Boolean(row.taxonomy_correction_id),
    originalSuggestion: { domain: suggestedDomain, subtype: suggestedSubtype },
    correctedBy: row.taxonomy_corrected_by || null,
    correctedById: row.taxonomy_corrected_by_id || null,
    correctedAt: toIso(row.taxonomy_corrected_at),
    correctionReason: row.taxonomy_correction_reason || null,
  };

  return {
    datasetVersion: DATASET_VERSION,
    featureVersion: FEATURE_VERSION,
    featureAsOf: toIso(row.created_at),
    snapshotStrategy: {
      currentSnapshot: 'T+0',
      supportedFutureObservationPoints: ['T+0', 'T+5m', 'T+15m', 'T+30m'],
      materializedObservationPoints: ['T+0'],
    },
    learningUnit: 'ONE_STORED_ALERT_OCCURRENCE',
    alert: {
      alertId: row.alert_id,
      canonicalAlertId: row.canonical_alert_id,
      sourceAlertId: row.source_alert_id,
      source: row.source,
      ingestionSource: row.ingestion_source,
      alertSignature: row.alert_signature,
      sourceSignature: row.source_signature,
      message: row.message,
      normalizedMessage: row.normalized_message,
      severity: row.severity,
      priority: row.priority,
      status: row.status,
      sourceUrl: row.source_url,
    },
    sourceIdentity: {
      source: row.source,
      entity: usefulIdentity(row.entity) || clean(row.identity_canonical_name),
      entityId: row.entity_id,
      entityType: row.entity_type,
      application: usefulIdentity(row.application)
        || (row.entity_type === 'APPLICATION' ? clean(row.identity_canonical_name) : null),
      applicationId: row.application_id,
      service: usefulIdentity(row.service)
        || (row.entity_type === 'SERVICE' ? clean(row.identity_canonical_name) : null),
      environment: row.environment,
      matchMethod: row.identity_match_method || null,
    },
    alertClassification,
    observedBehavior,
    occurrenceQuality,
    temporalFeatures: {
      createdAt: toIso(row.created_at),
      firstSeen: toIso(row.first_seen),
      lastSeen: toIso(row.last_seen),
      durationSeconds,
      ageSeconds: secondsBetween(row.created_at, generatedAt),
      recurrenceIntervalSeconds: secondsBetween(row.previous_signature_at, row.created_at),
    },
    behaviorFeatures: {
      occurrenceCount: occurrences,
      occurrenceRatePerHour: durationSeconds && durationSeconds > 0
        ? Number((occurrences / (durationSeconds / 3600)).toFixed(4))
        : null,
      recurrenceCount: Math.max(0, Number(row.observed_duplicate_count || 1) - 1),
      persistenceSeconds: durationSeconds,
      currentStatus: row.status || null,
      stateTransitionCount: numeric(row.state_transition_count),
      autoResolutionSeconds: observedBehavior.autoResolved.resolutionSeconds,
      autoResolved: observedBehavior.autoResolved.indicator,
      flappingIndicators: {
        occurrenceCount: occurrences,
        observedDuplicateCount: numeric(row.observed_duplicate_count),
        stateTransitionCount: null,
        interpretation: null,
      },
    },
    correlationFeatures: {
      windowSeconds: CORRELATION_WINDOW_SECONDS,
      relatedAlertCount: numeric(row.related_alert_count),
      relatedSources,
      correlatedServices: asArray(row.correlated_services),
      correlatedSourceCount: row.related_alert_count === null || row.related_alert_count === undefined
        ? null : new Set([row.source, ...relatedSources].filter(Boolean)).size,
      correlatedServiceCount: row.related_alert_count === null || row.related_alert_count === undefined
        ? null : new Set(asArray(row.correlated_services).filter(Boolean)).size,
      crossSourceActivity: new Set([row.source, ...relatedSources].filter(Boolean)).size > 1
        || Number(row.time_window_source_count || 0) > 1,
      sameSignatureRecentCount: Number(row.same_signature_recent_count || 0),
      sameEntityRecentCount: Number(row.same_entity_recent_count || 0),
      alertsInTimeWindow: Number(row.alerts_in_time_window || 0),
    },
    slackFeatures: {
      slackMessageCount: Number(row.slack_message_count || 0),
      slackAcknowledged: Boolean(row.slack_acknowledged),
      slackAcknowledgedAt: toIso(row.slack_acknowledged_at),
      slackResponder: clean(row.slack_responder),
      slackThreadActivity: Number(row.slack_thread_activity || 0),
      slackChannel: clean(row.slack_channel_name || row.slack_channel_id),
      slackPermalink: clean(row.slack_permalink),
    },
    jiraIncident: primaryIncident ? {
      jiraIncidentId: primaryIncident.incidentId || null,
      jiraIncidentKey: primaryIncident.key,
      jiraIncidentCreatedAt: toIso(primaryIncident.createdAt),
      jiraIncidentStatus: primaryIncident.status || null,
      jiraIncidentResolution: primaryIncident.resolution || null,
      jiraIncidentResolvedAt: toIso(primaryIncident.resolvedAt),
      jiraIncidentResolver: personName(primaryIncident.resolver),
      jiraIncidentTeam: personName(primaryIncident.team),
      incidentTimeDeltaSeconds: incidentDelta,
      matchConfidence: numeric(primaryIncident.matchConfidence),
      matchEvidence: asArray(primaryIncident.evidence),
      matchMethod: primaryIncident.matchMethod || null,
      matchStrength: primaryIncident.matchStrength || null,
      relationshipState: primaryIncident.relationshipState || 'CONFIRMED_MATCH',
      sourceUrl: primaryIncident.sourceUrl || null,
      candidates: incidents,
    } : null,
    jiraProblem: primaryProblem ? {
      jiraProblemId: primaryProblem.problemId || null,
      jiraProblemKey: primaryProblem.key,
      jiraProblemCreatedAt: toIso(primaryProblem.createdAt),
      jiraProblemStatus: primaryProblem.status || null,
      problemTimeDeltaSeconds: problemDelta,
      relatedProblemIncidentCount: Number(primaryProblem.relatedIncidentCount || 0),
      sourceUrl: primaryProblem.sourceUrl || null,
      matchMethod: primaryProblem.matchMethod || null,
      candidates: problems,
    } : null,
    historicalFeatures: {
      previousSameSignatureCount: previousSignatureCount,
      previousSameEntityCount: Number(row.previous_same_entity_count || 0),
      previousSameServiceCount: Number(row.previous_same_service_count || 0),
      previousIncidentCount,
      previousProblemCount: Number(row.previous_problem_count || 0),
      previousConfirmedIncidentCount: Number(row.previous_confirmed_incident_count || 0),
      previousConfirmedNoiseCount: Number(row.previous_confirmed_noise_count || 0),
      previousIncidentEvidenceCount: previousIncidentCount,
      previousDuplicateBehaviorCount: Number(row.previous_correlation_observation_count || 0) > 0
        ? numeric(row.previous_duplicate_behavior_count) : null,
      previousFlappingBehaviorCount: null,
      previousAutoResolvedCount: numeric(row.previous_auto_resolved_count),
      previousCorrelatedCount: Number(row.previous_correlation_observation_count || 0) > 0
        ? numeric(row.previous_correlated_count) : null,
      historicalIncidentRate: previousSignatureCount
        ? Number((previousIncidentCount / previousSignatureCount).toFixed(6))
        : null,
      historicalConfirmedNoiseRate: Number(row.previous_confirmed_incident_count || 0) + Number(row.previous_confirmed_noise_count || 0)
        ? Number((Number(row.previous_confirmed_noise_count || 0)
          / (Number(row.previous_confirmed_incident_count || 0) + Number(row.previous_confirmed_noise_count || 0))).toFixed(6))
        : null,
      asOf: toIso(row.created_at),
      futureRecordsExcluded: true,
    },
    historicalOutcome: outcome,
    operationalOutcome,
    trainingReadiness: {
      ...readiness,
      trainingLabelCandidate: readiness.futureTargetCandidate,
    },
    workflow: {
      incidentCreated: Boolean(primaryIncident) && outcome.label === 'INCIDENT',
      incidentKnown: Boolean(primaryIncident),
      incidentKey: primaryIncident?.key || null,
      incidentRelationshipState: primaryIncident?.relationshipState || (primaryIncident ? 'CONFIRMED_MATCH' : null),
      incidentStatus: primaryIncident?.status || null,
      incidentResolved,
      incidentUnlinked: outcome.label === 'INCIDENT_UNLINKED',
      problemLinked: Boolean(primaryProblem),
      problemKey: primaryProblem?.key || null,
      slackAcknowledged: Boolean(row.slack_acknowledged),
      noIncidentObserved: outcome.label === 'NO_OBSERVED_INCIDENT',
      unknown: outcome.label === 'UNKNOWN',
    },
    evidence: [
      evidenceItem(
        'SOURCE_IDENTITY',
        Boolean(usefulIdentity(row.entity) || row.entity_id || row.identity_canonical_name),
        identityEvidenceIds,
      ),
      evidenceItem('ALERT_TIMESTAMPS', Boolean(row.created_at), [], row.created_at ? 'Stored alert occurrence timestamps.' : null),
      evidenceItem('OCCURRENCE_HISTORY', occurrences > 0),
      evidenceItem('CORRELATION_HISTORY', correlationEvidenceIds.length > 0, correlationEvidenceIds),
      evidenceItem('JIRA_INCIDENT', Boolean(primaryIncident), outcome.evidenceIds),
      evidenceItem('JIRA_PROBLEM', Boolean(primaryProblem), problems.map((item) => item.evidenceId).filter(Boolean)),
      evidenceItem('SLACK_CONTEXT', slackEvidenceIds.length > 0, slackEvidenceIds),
      evidenceItem('EVIDENCE_PACKAGE', evidencePackageIds.length > 0, evidencePackageIds),
    ],
    legacyClassification: row.classification_is_legacy ? {
      label: row.legacy_classification,
      authoritative: false,
    } : null,
    mlStatus: {
      decision: 'PENDING',
      confidence: 'NOT_TRAINED',
      modelStatus: 'ML_MODEL_NOT_TRAINED',
    },
    featureProvenance: [
      { featureName: 'source', featureValue: row.source, source: 'alerts', sourceRecordId: row.alert_id, observedAt: toIso(row.created_at), computedAt: toIso(generatedAt), featureAsOf: toIso(row.created_at), derivationMethod: 'stored_normalized_source' },
      { featureName: 'taxonomy', featureValue: `${alertClassification.domain}/${alertClassification.subtype}`, source: row.taxonomy_correction_id ? 'alert_occurrence_taxonomy_corrections' : 'stored_alert_fields', sourceRecordId: row.taxonomy_correction_id || row.alert_id, observedAt: toIso(row.taxonomy_corrected_at || row.created_at), computedAt: toIso(generatedAt), featureAsOf: toIso(row.created_at), derivationMethod: alertClassification.assignmentMethod },
      { featureName: 'previous_same_signature_count', featureValue: previousSignatureCount, source: 'historical_alert_learning_occurrences_v1', sourceRecordId: row.alert_signature, observedAt: toIso(row.created_at), computedAt: toIso(generatedAt), featureAsOf: toIso(row.created_at), derivationMethod: 'strictly_earlier_occurrence_count' },
      { featureName: 'occurrence_quality', featureValue: occurrenceQuality.quality, source: 'stored_alert_timestamps', sourceRecordId: row.alert_id, observedAt: toIso(row.last_seen), computedAt: toIso(generatedAt), featureAsOf: toIso(row.created_at), derivationMethod: 'source_semantics_and_temporal_quality_v1' },
    ],
    provenance: {
      generatedAt: toIso(generatedAt),
      storedDataOnly: true,
      externalCalls: 0,
      unavailableLiveSources: ['Jira', 'AppDynamics'],
      correlationWindowSeconds: CORRELATION_WINDOW_SECONDS,
      behaviorDoesNotDetermineOutcome: true,
      taxonomyDoesNotDetermineOutcome: true,
      postOutcomeFieldsExcludedFromTrainingPreview: true,
    },
  };
}

function buildFilters(options, now) {
  const range = parseRange(options.range || '24h', now);
  const values = [];
  const base = [];
  const outcome = [];
  const add = (value) => { values.push(value); return `$${values.length}`; };

  if (range.from) base.push(`created_at >= ${add(range.from)}::timestamptz`);
  base.push(`created_at <= ${add(range.to)}::timestamptz`);
  if (clean(options.source)) base.push(`LOWER(source) = LOWER(${add(clean(options.source))})`);
  if (clean(options.severity)) base.push(`LOWER(severity) = LOWER(${add(clean(options.severity))})`);
  if (clean(options.priority)) base.push(`LOWER(COALESCE(priority, '')) = LOWER(${add(clean(options.priority))})`);
  if (clean(options.environment)) base.push(`LOWER(environment) = LOWER(${add(clean(options.environment))})`);
  if (clean(options.service)) base.push(`LOWER(service) = LOWER(${add(clean(options.service))})`);
  if (clean(options.application)) base.push(`LOWER(COALESCE(application, '')) = LOWER(${add(clean(options.application))})`);
  if (clean(options.search)) {
    const search = `%${clean(options.search).toLowerCase()}%`;
    base.push(`LOWER(CONCAT_WS(' ', alert_id, canonical_alert_id, source_alert_id, message, source, service, application, entity)) LIKE ${add(search)}`);
  }
  if (asArray(options.alertIds).length) base.push(`alert_id = ANY(${add(options.alertIds)}::text[])`);

  const requestedOutcome = clean(options.outcome)?.toUpperCase();
  if (requestedOutcome && !OUTCOMES.has(requestedOutcome)) {
    const error = new Error('outcome must be INCIDENT, INCIDENT_UNLINKED, NO_OBSERVED_INCIDENT, UNKNOWN, or all.');
    error.code = 'INVALID_LEARNING_FILTER';
    error.status = 400;
    throw error;
  }
  if (requestedOutcome) outcome.push(`outcome_label = ${add(requestedOutcome)}`);
  const requestedOperationalOutcome = clean(options.operationalOutcome)?.toUpperCase();
  if (requestedOperationalOutcome && !OPERATIONAL_FILTERS.has(requestedOperationalOutcome)) {
    const error = new Error(`operationalOutcome must be ${[...OPERATIONAL_FILTERS].join(', ')}, or all.`);
    error.code = 'INVALID_LEARNING_FILTER';
    error.status = 400;
    throw error;
  }
  if (requestedOperationalOutcome === 'UNCONFIRMED') outcome.push('operational_outcome IS NULL');
  else if (requestedOperationalOutcome) outcome.push(`operational_outcome = ${add(requestedOperationalOutcome)}`);
  const requestedDomain = clean(options.domain)?.toUpperCase();
  if (requestedDomain && !ALERT_DOMAINS.includes(requestedDomain)) {
    const error = new Error('domain is not part of the supported alert taxonomy.');
    error.code = 'INVALID_LEARNING_FILTER';
    error.status = 400;
    throw error;
  }
  if (requestedDomain) outcome.push(`taxonomy_domain = ${add(requestedDomain)}`);
  const requestedSubtype = clean(options.subtype)?.toUpperCase();
  if (requestedSubtype && !ALERT_SUBTYPES.includes(requestedSubtype)) {
    const error = new Error('subtype is not part of the supported alert taxonomy.');
    error.code = 'INVALID_LEARNING_FILTER';
    error.status = 400;
    throw error;
  }
  if (requestedSubtype) outcome.push(`taxonomy_subtype = ${add(requestedSubtype)}`);
  const requestedTrainingReadiness = clean(options.trainingReadiness)?.toUpperCase();
  if (requestedTrainingReadiness && !TRAINING_READINESS_FILTERS.has(requestedTrainingReadiness)) {
    const error = new Error('trainingReadiness must be CONFIRMED_LABELED, WEAK_EVIDENCE, UNLABELED, UNKNOWN, or all.');
    error.code = 'INVALID_LEARNING_FILTER';
    error.status = 400;
    throw error;
  }
  if (requestedTrainingReadiness) outcome.push(`training_readiness_state = ${add(requestedTrainingReadiness)}`);
  const requestedBehavior = clean(options.behavior)?.toUpperCase();
  if (requestedBehavior && !BEHAVIOR_TYPES.includes(requestedBehavior)) {
    const error = new Error('behavior is not part of the supported observed-behavior taxonomy.');
    error.code = 'INVALID_LEARNING_FILTER';
    error.status = 400;
    throw error;
  }
  if (requestedBehavior === 'DUPLICATE') outcome.push('observed_duplicate_count > 1');
  else if (requestedBehavior === 'CORRELATED') outcome.push('related_alert_count > 0');
  else if (requestedBehavior === 'AUTO_RESOLVED') outcome.push(`LOWER(COALESCE(status, '')) = 'auto-resolved'`);
  else if (requestedBehavior === 'EXPECTED_ACTIVITY') outcome.push(`(
    LOWER(COALESCE(raw_payload->>'expectedActivity', raw_payload->>'plannedActivity', extracted_details->>'expectedActivity', '')) = 'true'
  )`);
  else if (requestedBehavior) outcome.push('FALSE');
  const incidentLinked = parseBoolean(options.incidentLinked, 'incidentLinked');
  if (incidentLinked !== null) outcome.push(incidentLinked
    ? '(strong_incident_count > 0 OR confirmed_reconciliation_count > 0)'
    : '(strong_incident_count = 0 AND confirmed_reconciliation_count = 0)');
  const problemLinked = parseBoolean(options.problemLinked, 'problemLinked');
  if (problemLinked !== null) outcome.push(problemLinked ? 'problem_count > 0' : 'problem_count = 0');

  return {
    baseWhere: base.length ? `WHERE ${base.join(' AND ')}` : '',
    outcomeWhere: outcome.length ? `WHERE ${outcome.join(' AND ')}` : '',
    range,
    values,
  };
}

function listSql(filters, pageParam, sizeParam) {
  return `
    WITH ${DATA_CTES},
    range_records AS (
      SELECT * FROM feature_records ${filters.baseWhere}
    ),
    filtered_records AS (
      SELECT * FROM range_records ${filters.outcomeWhere}
    ),
    paged AS (
      SELECT *, COUNT(*) OVER() AS total_count
      FROM filtered_records
      ORDER BY created_at DESC, alert_id DESC
      LIMIT ${sizeParam} OFFSET ${pageParam}
    )
    SELECT
      paged.*,
      identity.entity_id,
      identity.entity_type,
      identity.identity_canonical_name,
      identity.identity_match_method,
      identity.application_id,
      COALESCE(slack.reply_count, 0) + CASE WHEN slack.source_message_ts IS NULL THEN 0 ELSE 1 END AS slack_message_count,
      COALESCE(paged.acknowledged, latest_ack.acknowledged_at IS NOT NULL) AS slack_acknowledged,
      COALESCE(paged.acknowledged_at, latest_ack.acknowledged_at) AS slack_acknowledged_at,
      COALESCE(slack.responder, paged.acknowledged_by, latest_ack.acknowledged_by) AS slack_responder,
      COALESCE(slack.reply_count, 0) AS slack_thread_activity,
      slack.slack_channel_name,
      slack.slack_permalink,
      signature_history.previous_same_signature_count,
      signature_history.previous_signature_at,
      signature_history.same_signature_recent_count,
      signature_history.previous_incident_count,
      signature_history.previous_problem_count,
      signature_history.previous_confirmed_incident_count,
      signature_history.previous_confirmed_noise_count,
      signature_history.previous_confirmed_outcome_count,
      signature_history.non_actionable_history_count,
      signature_history.previous_duplicate_behavior_count,
      signature_history.previous_correlation_observation_count,
      signature_history.previous_auto_resolved_count,
      signature_history.previous_correlated_count,
      entity_history.previous_same_entity_count,
      entity_history.same_entity_recent_count,
      service_history.previous_same_service_count,
      time_window.alerts_in_time_window,
      time_window.time_window_source_count,
      COALESCE(evidence.evidence_package_ids, '[]'::jsonb) AS evidence_package_ids
    FROM paged
    LEFT JOIN LATERAL (
      SELECT
        entity.entity_id,
        entity.entity_type,
        entity.canonical_name AS identity_canonical_name,
        CASE
          WHEN learning_normalize_identity(entity.canonical_name) IN (
            learning_normalize_identity(paged.entity),
            learning_normalize_identity(paged.service),
            learning_normalize_identity(paged.application)
          ) THEN 'existing_source_identity_normalized_name'
          ELSE 'existing_source_identity_message_reference'
        END AS identity_match_method,
        mapping.source_entity_id AS application_id
      FROM source_identity_entities entity
      LEFT JOIN LATERAL (
        SELECT source_entity_id
        FROM source_identity_validated_mappings
        WHERE entity_id = entity.entity_id
          AND validation_status = 'VALID'
          AND source_entity_type = 'APPLICATION'
        ORDER BY last_validated_at DESC
        LIMIT 1
      ) mapping ON true
      WHERE learning_normalize_identity(entity.canonical_name) IN (
        learning_normalize_identity(paged.entity),
        learning_normalize_identity(paged.service),
        learning_normalize_identity(paged.application)
      )
      OR EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(entity.aliases, '[]'::jsonb)) alias
        WHERE learning_normalize_identity(COALESCE(alias->>'alias', alias #>> '{}')) IN (
          learning_normalize_identity(paged.entity),
          learning_normalize_identity(paged.service),
          learning_normalize_identity(paged.application)
        )
      )
      OR (
        LENGTH(BTRIM(entity.canonical_name)) >= 5
        AND LOWER(paged.message) LIKE CONCAT('%', LOWER(BTRIM(entity.canonical_name)), '%')
      )
      ORDER BY CASE
        WHEN learning_normalize_identity(entity.canonical_name) = learning_normalize_identity(paged.entity) THEN 0
        WHEN learning_normalize_identity(entity.canonical_name) = learning_normalize_identity(paged.service) THEN 1
        ELSE 2
      END, entity.entity_id
      LIMIT 1
    ) identity ON true
    LEFT JOIN LATERAL (
      SELECT event.*
      FROM slack_alert_events event
      WHERE event.slack_channel_id = paged.slack_channel_id
        AND event.source_message_ts = paged.slack_message_ts
      ORDER BY event.updated_at DESC NULLS LAST
      LIMIT 1
    ) slack ON true
    LEFT JOIN LATERAL (
      SELECT acknowledged_by, acknowledged_at
      FROM alert_acknowledgements
      WHERE alert_id = paged.alert_id
      ORDER BY acknowledged_at DESC
      LIMIT 1
    ) latest_ack ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::integer AS previous_same_signature_count,
        MAX(previous.created_at) AS previous_signature_at,
        COUNT(*) FILTER (
          WHERE previous.created_at >= paged.created_at - INTERVAL '${CORRELATION_WINDOW_SECONDS} seconds'
        )::integer AS same_signature_recent_count,
        COUNT(*) FILTER (
          WHERE (COALESCE(previous_mapping.strong_incident_count, 0) > 0
              AND previous_mapping.first_strong_match_at <= paged.created_at)
            OR (COALESCE(previous_reconciliation.confirmed_reconciliation_count, 0) > 0
              AND previous_reconciliation.first_confirmed_reconciliation_at <= paged.created_at)
        )::integer AS previous_incident_count,
        COUNT(*) FILTER (
          WHERE COALESCE(previous_problem.problem_count, 0) > 0
            AND previous_problem.first_problem_match_at <= paged.created_at
        )::integer AS previous_problem_count,
        COUNT(*) FILTER (
          WHERE previous_outcome.outcome = 'CONFIRMED_INCIDENT'
            AND previous_outcome.recorded_at <= paged.created_at
        )::integer AS previous_confirmed_incident_count,
        COUNT(*) FILTER (
          WHERE previous_outcome.outcome = 'CONFIRMED_NOISE'
            AND previous_outcome.recorded_at <= paged.created_at
        )::integer AS previous_confirmed_noise_count,
        COUNT(*) FILTER (
          WHERE previous_outcome.outcome IN ('CONFIRMED_INCIDENT', 'CONFIRMED_NOISE')
            AND previous_outcome.recorded_at <= paged.created_at
        )::integer AS previous_confirmed_outcome_count,
        COUNT(*) FILTER (
          WHERE previous_outcome.outcome = 'CONFIRMED_NOISE'
            AND previous_outcome.reason_code = 'NON_ACTIONABLE'
            AND previous_outcome.recorded_at <= paged.created_at
        )::integer AS non_actionable_history_count,
        COUNT(*) FILTER (WHERE previous_correlation.observed_duplicate_count > 1)::integer AS previous_duplicate_behavior_count,
        COUNT(previous_correlation.alert_id)::integer AS previous_correlation_observation_count,
        COUNT(*) FILTER (WHERE LOWER(previous.status) = 'auto-resolved')::integer AS previous_auto_resolved_count,
        COUNT(*) FILTER (WHERE previous_related.related_alert_count > 0)::integer AS previous_correlated_count
      FROM historical_alert_learning_occurrences_v1 previous
      LEFT JOIN mapping_rollup previous_mapping ON previous_mapping.alert_id = previous.alert_id
      LEFT JOIN reconciliation_rollup previous_reconciliation ON previous_reconciliation.alert_id = previous.alert_id
      LEFT JOIN problem_rollup previous_problem ON previous_problem.alert_id = previous.alert_id
      LEFT JOIN current_operational_outcomes previous_outcome ON previous_outcome.alert_id = previous.alert_id
      LEFT JOIN correlation_rollup previous_correlation ON previous_correlation.alert_id = previous.alert_id
      LEFT JOIN related_rollup previous_related ON previous_related.alert_id = previous.alert_id
      WHERE previous.alert_signature = paged.alert_signature
        AND (previous.created_at, previous.alert_id) < (paged.created_at, paged.alert_id)
    ) signature_history ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::integer AS previous_same_entity_count,
        COUNT(*) FILTER (
          WHERE previous.created_at >= paged.created_at - INTERVAL '${CORRELATION_WINDOW_SECONDS} seconds'
        )::integer AS same_entity_recent_count
      FROM historical_alert_learning_occurrences_v1 previous
      WHERE paged.entity_key IS NOT NULL
        AND previous.entity_key = paged.entity_key
        AND (previous.created_at, previous.alert_id) < (paged.created_at, paged.alert_id)
    ) entity_history ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS previous_same_service_count
      FROM historical_alert_learning_occurrences_v1 previous
      WHERE NULLIF(BTRIM(paged.service), '') IS NOT NULL
        AND LOWER(BTRIM(paged.service)) NOT IN ('unknown', 'unknown-service', 'unassigned')
        AND LOWER(previous.service) = LOWER(paged.service)
        AND (previous.created_at, previous.alert_id) < (paged.created_at, paged.alert_id)
    ) service_history ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::integer AS alerts_in_time_window,
        COUNT(DISTINCT source)::integer AS time_window_source_count
      FROM historical_alert_learning_occurrences_v1 nearby
      WHERE nearby.created_at >= paged.created_at - INTERVAL '${CORRELATION_WINDOW_SECONDS} seconds'
        AND nearby.created_at <= paged.created_at
    ) time_window ON true
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(CONCAT('evidence_package:', analysis_range, ':', evidence_version) ORDER BY collected_at DESC) AS evidence_package_ids
      FROM noise_evidence_packages
      WHERE alert_id = paged.alert_id
    ) evidence ON true
    ORDER BY paged.created_at DESC, paged.alert_id DESC
  `;
}

function summarySql(filters) {
  return `
    WITH ${DATA_CTES},
    range_records AS (
      SELECT * FROM feature_records ${filters.baseWhere}
    ),
    filtered_records AS (
      SELECT * FROM range_records ${filters.outcomeWhere}
    )
    SELECT
      COUNT(*)::bigint AS total_records,
      COUNT(*) FILTER (WHERE outcome_label = 'INCIDENT')::bigint AS incident_records,
      COUNT(*) FILTER (WHERE outcome_label = 'INCIDENT_UNLINKED')::bigint AS incident_unlinked_records,
      COUNT(*) FILTER (WHERE outcome_label = 'NO_OBSERVED_INCIDENT')::bigint AS no_observed_incident_records,
      COUNT(*) FILTER (WHERE outcome_label = 'UNKNOWN')::bigint AS unknown_records,
      COUNT(*) FILTER (WHERE operational_outcome = 'CONFIRMED_INCIDENT')::bigint AS operational_confirmed_incident,
      COUNT(*) FILTER (WHERE operational_outcome = 'CONFIRMED_NOISE')::bigint AS operational_confirmed_noise,
      COUNT(*) FILTER (WHERE operational_outcome = 'UNKNOWN')::bigint AS operational_unknown,
      COUNT(*) FILTER (WHERE operational_outcome IS NULL)::bigint AS operational_unconfirmed,
      COUNT(*) FILTER (
        WHERE operational_outcome IS NULL AND outcome_label IN ('INCIDENT', 'INCIDENT_UNLINKED')
      )::bigint AS training_weak_evidence,
      COUNT(*) FILTER (
        WHERE operational_outcome IS NULL AND outcome_label = 'NO_OBSERVED_INCIDENT'
      )::bigint AS training_unlabeled,
      COUNT(*) FILTER (
        WHERE operational_outcome = 'UNKNOWN'
          OR (operational_outcome IS NULL AND outcome_label = 'UNKNOWN')
      )::bigint AS training_unknown,
      COUNT(*) FILTER (
        WHERE operational_outcome = 'CONFIRMED_INCIDENT' AND operational_linked_incident_key IS NOT NULL
      )::bigint AS operational_linked_jira_incident,
      COUNT(*) FILTER (
        WHERE operational_outcome = 'CONFIRMED_INCIDENT' AND operational_linked_incident_key IS NULL
      )::bigint AS operational_unlinked_incident,
      COUNT(*) FILTER (WHERE confirmed_reconciliation_count > 0)::bigint AS confirmed_reconciled_alerts,
      COUNT(*) FILTER (WHERE probable_reconciliation_count > 0)::bigint AS probable_reconciled_alerts,
      COUNT(*) FILTER (WHERE ambiguous_reconciliation_count > 0)::bigint AS ambiguous_reconciled_alerts,
      COUNT(DISTINCT source)::bigint AS unique_sources,
      COUNT(*) FILTER (WHERE taxonomy_domain <> 'UNKNOWN_DOMAIN')::bigint AS taxonomy_domain_assigned,
      COUNT(*) FILTER (WHERE taxonomy_domain = 'UNKNOWN_DOMAIN')::bigint AS taxonomy_unknown_domain,
      COUNT(*) FILTER (WHERE taxonomy_subtype <> 'UNKNOWN_SUBTYPE')::bigint AS taxonomy_subtype_assigned,
      COUNT(*) FILTER (WHERE taxonomy_subtype = 'UNKNOWN_SUBTYPE')::bigint AS taxonomy_unknown_subtype,
      COUNT(*) FILTER (WHERE taxonomy_correction_id IS NOT NULL)::bigint AS taxonomy_manually_corrected,
      COUNT(*) FILTER (WHERE observed_duplicate_count IS NOT NULL AND observed_duplicate_count > 1)::bigint AS behavior_duplicate_true,
      COUNT(*) FILTER (WHERE observed_duplicate_count IS NOT NULL AND observed_duplicate_count <= 1)::bigint AS behavior_duplicate_false,
      COUNT(*) FILTER (WHERE observed_duplicate_count IS NULL)::bigint AS behavior_duplicate_unavailable,
      0::bigint AS behavior_flapping_true,
      0::bigint AS behavior_flapping_false,
      COUNT(*)::bigint AS behavior_flapping_unavailable,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'auto-resolved')::bigint AS behavior_auto_resolved_true,
      0::bigint AS behavior_auto_resolved_false,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) <> 'auto-resolved')::bigint AS behavior_auto_resolved_unavailable,
      0::bigint AS behavior_non_actionable_true,
      0::bigint AS behavior_non_actionable_false,
      COUNT(*)::bigint AS behavior_non_actionable_unavailable,
      COUNT(*) FILTER (WHERE related_alert_count IS NOT NULL AND related_alert_count > 0)::bigint AS behavior_correlated_true,
      COUNT(*) FILTER (WHERE related_alert_count IS NOT NULL AND related_alert_count = 0)::bigint AS behavior_correlated_false,
      COUNT(*) FILTER (WHERE related_alert_count IS NULL)::bigint AS behavior_correlated_unavailable,
      0::bigint AS behavior_stale_true,
      0::bigint AS behavior_stale_false,
      COUNT(*)::bigint AS behavior_stale_unavailable,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_payload->>'expectedActivity', raw_payload->>'plannedActivity', extracted_details->>'expectedActivity', '')) = 'true')::bigint AS behavior_expected_activity_true,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_payload->>'expectedActivity', raw_payload->>'plannedActivity', extracted_details->>'expectedActivity', '')) = 'false')::bigint AS behavior_expected_activity_false,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_payload->>'expectedActivity', raw_payload->>'plannedActivity', extracted_details->>'expectedActivity', '')) NOT IN ('true', 'false'))::bigint AS behavior_expected_activity_unavailable,
      COUNT(*) FILTER (WHERE source IS NOT NULL AND BTRIM(source) <> '')::bigint AS feature_source_available,
      COUNT(*) FILTER (WHERE entity IS NOT NULL OR service IS NOT NULL OR application IS NOT NULL)::bigint AS feature_identity_available,
      COUNT(*) FILTER (WHERE application IS NOT NULL AND BTRIM(application) <> '')::bigint AS feature_application_available,
      COUNT(*) FILTER (WHERE service IS NOT NULL AND BTRIM(service) <> '')::bigint AS feature_service_available,
      COUNT(*) FILTER (WHERE environment IS NOT NULL AND BTRIM(environment) <> '' AND LOWER(environment) <> 'unknown')::bigint AS feature_environment_available,
      COUNT(*) FILTER (WHERE severity IS NOT NULL AND BTRIM(severity) <> '')::bigint AS feature_severity_available,
      COUNT(*) FILTER (WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL)::bigint AS feature_duration_available,
      COUNT(*) FILTER (WHERE occurrence_count IS NOT NULL)::bigint AS feature_recurrence_available,
      COUNT(*) FILTER (WHERE observed_duplicate_count IS NOT NULL OR related_alert_count IS NOT NULL)::bigint AS feature_correlation_available,
      COUNT(*) FILTER (WHERE slack_channel_id IS NOT NULL AND slack_message_ts IS NOT NULL)::bigint AS feature_slack_available,
      COUNT(*) FILTER (WHERE alert_signature IS NOT NULL AND created_at IS NOT NULL)::bigint AS feature_historical_incident_context_available,
      COUNT(*) FILTER (
        WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL
          AND last_seen >= first_seen
          AND last_seen - first_seen <= INTERVAL '7 days'
          AND LOWER(COALESCE(source, '')) NOT IN ('slack', 'jira', 'jsm operations alerts')
      )::bigint AS occurrence_reliable,
      COUNT(*) FILTER (
        WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL
          AND last_seen >= first_seen
          AND NOT (last_seen - first_seen > INTERVAL '30 days' AND COALESCE(occurrence_count, 1) <= 3)
          AND (last_seen - first_seen > INTERVAL '7 days' OR LOWER(COALESCE(source, '')) IN ('slack', 'jira', 'jsm operations alerts'))
      )::bigint AS occurrence_source_aggregated,
      COUNT(*) FILTER (
        WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL
          AND (last_seen < first_seen OR (last_seen - first_seen > INTERVAL '30 days' AND COALESCE(occurrence_count, 1) <= 3))
      )::bigint AS occurrence_suspect,
      COUNT(*) FILTER (WHERE first_seen IS NULL OR last_seen IS NULL)::bigint AS occurrence_unavailable,
      COUNT(*) - COUNT(DISTINCT alert_id) AS duplicate_records,
      COUNT(*) FILTER (WHERE source IS NULL OR BTRIM(source) = '')::bigint AS missing_source,
      COUNT(*) FILTER (
        WHERE entity IS NULL OR BTRIM(entity) = '' OR LOWER(BTRIM(entity)) IN ('unknown', 'unknown-service')
      )::bigint AS missing_entity,
      COUNT(*) FILTER (WHERE application IS NULL OR BTRIM(application) = '')::bigint AS missing_application,
      COUNT(*) FILTER (
        WHERE service IS NULL OR BTRIM(service) = '' OR LOWER(BTRIM(service)) IN ('unknown', 'unknown-service')
      )::bigint AS missing_service,
      COUNT(*) FILTER (WHERE environment IS NULL OR BTRIM(environment) = '' OR environment = 'unknown')::bigint AS missing_environment,
      COUNT(*) FILTER (WHERE created_at IS NULL)::bigint AS missing_timestamp,
      COUNT(*) FILTER (WHERE alert_signature IS NULL OR BTRIM(alert_signature) = '')::bigint AS missing_signature,
      COUNT(*) FILTER (
        WHERE strong_incident_count = 0 AND confirmed_reconciliation_count = 0
      )::bigint AS missing_incident_evidence,
      COUNT(*) FILTER (
        WHERE strong_incident_count > 1 OR ambiguous_reconciliation_count > 0
      )::bigint AS ambiguous_incident_matches,
      COUNT(*) FILTER (WHERE legacy_candidate_count > 0 OR unresolved_mapping_count > 0)::bigint AS suspicious_matches,
      COUNT(*) FILTER (
        WHERE (strong_incident_count > 0 OR confirmed_reconciliation_count > 0) AND problem_count > 0
      )::bigint AS problem_linked_incidents,
      COALESCE((
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'reason', reason.reason,
          'count', COUNTED.count
        ) ORDER BY reason.position)
        FROM UNNEST(ARRAY[
          'AUTO_RESOLVED', 'DUPLICATE', 'FLAPPING', 'NON_ACTIONABLE',
          'TRANSIENT', 'EXPECTED_BEHAVIOR', 'FALSE_POSITIVE', 'OTHER'
        ]) WITH ORDINALITY AS reason(reason, position)
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS count
          FROM filtered_records record
          WHERE record.operational_outcome = 'CONFIRMED_NOISE'
            AND record.operational_outcome_reason_code = reason.reason
        ) COUNTED ON true
      ), '[]'::jsonb) AS operational_noise_breakdown,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY (item->>'count')::bigint DESC, item->>'value')
        FROM (
          SELECT JSONB_BUILD_OBJECT('value', COALESCE(source, 'Unknown'), 'count', COUNT(*)) item
          FROM filtered_records GROUP BY source
        ) grouped
      ), '[]'::jsonb) AS by_source,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY item->>'source', item->>'domain', item->>'subtype')
        FROM (
          SELECT JSONB_BUILD_OBJECT(
            'source', COALESCE(source, 'Unknown'),
            'domain', taxonomy_domain,
            'subtype', taxonomy_subtype,
            'count', COUNT(*)
          ) item
          FROM filtered_records
          GROUP BY source, taxonomy_domain, taxonomy_subtype
        ) grouped
      ), '[]'::jsonb) AS taxonomy_by_source,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY (item->>'count')::bigint DESC, item->>'value')
        FROM (
          SELECT JSONB_BUILD_OBJECT('value', COALESCE(severity, 'Unknown'), 'count', COUNT(*)) item
          FROM filtered_records GROUP BY severity
        ) grouped
      ), '[]'::jsonb) AS by_severity,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY (item->>'count')::bigint DESC, item->>'value')
        FROM (
          SELECT JSONB_BUILD_OBJECT('value', COALESCE(environment, 'Unknown'), 'count', COUNT(*)) item
          FROM filtered_records GROUP BY environment
        ) grouped
      ), '[]'::jsonb) AS by_environment,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY (item->>'count')::bigint DESC, item->>'value')
        FROM (
          SELECT JSONB_BUILD_OBJECT('value', COALESCE(application, 'Unknown'), 'count', COUNT(*)) item
          FROM filtered_records GROUP BY application ORDER BY COUNT(*) DESC LIMIT 100
        ) grouped
      ), '[]'::jsonb) AS by_application,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY (item->>'count')::bigint DESC, item->>'value')
        FROM (
          SELECT JSONB_BUILD_OBJECT('value', COALESCE(service, 'Unknown'), 'count', COUNT(*)) item
          FROM filtered_records GROUP BY service ORDER BY COUNT(*) DESC LIMIT 100
        ) grouped
      ), '[]'::jsonb) AS by_service
    FROM filtered_records
  `;
}

function featureAuditSql(range) {
  const rangePredicate = range.from
    ? 'occurrence.created_at >= $1::timestamptz AND occurrence.created_at <= $2::timestamptz'
    : 'occurrence.created_at <= $1::timestamptz';
  return `
    WITH mapping_flags AS (
      SELECT
        mapping.alert_id,
        BOOL_OR(mapping.mapping_reason = '${EXPLICIT_OPERATIONS_MAPPING_REASON.replaceAll("'", "''")}'
          AND incident.raw_payload->'fields'->'issuetype'->>'name' = '[System] Incident') AS strong_incident,
        BOOL_OR(mapping.mapping_reason <> '${EXPLICIT_OPERATIONS_MAPPING_REASON.replaceAll("'", "''")}'
          OR (mapping.mapping_reason = '${EXPLICIT_OPERATIONS_MAPPING_REASON.replaceAll("'", "''")}' AND incident.incident_key IS NULL)) AS uncertain_mapping
      FROM alert_incident_mappings mapping
      LEFT JOIN operations_incidents incident ON incident.incident_key = mapping.jira_ticket_id
      GROUP BY mapping.alert_id
    ),
    reconciliation_flags AS (
      SELECT
        alert_id,
        BOOL_OR(relationship_state = 'CONFIRMED_MATCH') AS confirmed_match,
        BOOL_OR(relationship_state = 'PROBABLE_MATCH') AS probable_match,
        BOOL_OR(relationship_state = 'AMBIGUOUS') AS ambiguous_match
      FROM incident_alert_reconciliations
      WHERE current AND alert_id IS NOT NULL
      GROUP BY alert_id
    ),
    correlation_flags AS (
      SELECT
        alert_id,
        MAX(duplicate_count)::integer AS duplicate_count,
        MAX(JSONB_ARRAY_LENGTH(COALESCE(related_alerts, '[]'::jsonb)))::integer AS related_count
      FROM alert_correlation_history
      GROUP BY alert_id
    ),
    current_outcomes AS (
      SELECT * FROM alert_occurrence_outcomes WHERE is_current
    ),
    current_corrections AS (
      SELECT * FROM alert_occurrence_taxonomy_corrections WHERE is_current
    ),
    occurrences AS (
      SELECT
        occurrence.alert_id,
        occurrence.alert_signature,
        occurrence.source,
        occurrence.message,
        occurrence.entity,
        occurrence.application,
        occurrence.service,
        occurrence.environment,
        occurrence.severity,
        occurrence.status,
        occurrence.created_at,
        occurrence.first_seen,
        occurrence.last_seen,
        occurrence.occurrence_count,
        occurrence.slack_channel_id,
        occurrence.slack_message_ts,
        LOWER(COALESCE(
          occurrence.raw_payload->>'expectedActivity',
          occurrence.raw_payload->>'plannedActivity',
          occurrence.extracted_details->>'expectedActivity',
          ''
        )) AS expected_activity_value
      FROM historical_alert_learning_occurrences_v1 occurrence
      WHERE ${rangePredicate}
    ),
    taxonomy_inputs AS (
      SELECT DISTINCT ON (COALESCE(alert_signature, alert_id))
        COALESCE(alert_signature, alert_id) AS taxonomy_key,
        source, message, entity, application, service
      FROM occurrences
      ORDER BY COALESCE(alert_signature, alert_id), created_at DESC, alert_id DESC
    ),
    taxonomy_values AS MATERIALIZED (
      SELECT
        taxonomy_key,
        learning_taxonomy_subtype(source, message, entity, application, service) AS suggested_subtype
      FROM taxonomy_inputs
    ),
    records AS (
      SELECT
        occurrence.*,
        outcome.outcome AS operational_outcome,
        correction.id AS correction_id,
        COALESCE(correction.corrected_subtype, taxonomy.suggested_subtype) AS taxonomy_subtype,
        COALESCE(correction.corrected_domain, learning_taxonomy_domain(taxonomy.suggested_subtype)) AS taxonomy_domain,
        correlation.duplicate_count,
        correlation.related_count,
        CASE
          WHEN COALESCE(mapping.strong_incident, false) OR COALESCE(reconciliation.confirmed_match, false) THEN 'INCIDENT'
          WHEN COALESCE(reconciliation.probable_match, false) THEN 'INCIDENT_UNLINKED'
          WHEN COALESCE(reconciliation.ambiguous_match, false) OR COALESCE(mapping.uncertain_mapping, false) THEN 'UNKNOWN'
          ELSE 'NO_OBSERVED_INCIDENT'
        END AS historical_outcome
      FROM occurrences occurrence
      JOIN taxonomy_values taxonomy ON taxonomy.taxonomy_key = COALESCE(occurrence.alert_signature, occurrence.alert_id)
      LEFT JOIN mapping_flags mapping ON mapping.alert_id = occurrence.alert_id
      LEFT JOIN reconciliation_flags reconciliation ON reconciliation.alert_id = occurrence.alert_id
      LEFT JOIN correlation_flags correlation ON correlation.alert_id = occurrence.alert_id
      LEFT JOIN current_outcomes outcome ON outcome.alert_id = occurrence.alert_id
      LEFT JOIN current_corrections correction ON correction.alert_id = occurrence.alert_id
    ),
    aggregate AS (
      SELECT
        COUNT(*)::bigint AS total_records,
        COUNT(*) FILTER (WHERE taxonomy_domain <> 'UNKNOWN_DOMAIN')::bigint AS taxonomy_domain_assigned,
        COUNT(*) FILTER (WHERE taxonomy_domain = 'UNKNOWN_DOMAIN')::bigint AS taxonomy_unknown_domain,
        COUNT(*) FILTER (WHERE taxonomy_subtype <> 'UNKNOWN_SUBTYPE')::bigint AS taxonomy_subtype_assigned,
        COUNT(*) FILTER (WHERE taxonomy_subtype = 'UNKNOWN_SUBTYPE')::bigint AS taxonomy_unknown_subtype,
        COUNT(*) FILTER (WHERE correction_id IS NOT NULL)::bigint AS taxonomy_manually_corrected,
        COUNT(*) FILTER (WHERE duplicate_count > 1)::bigint AS behavior_duplicate_true,
        COUNT(*) FILTER (WHERE duplicate_count IS NOT NULL AND duplicate_count <= 1)::bigint AS behavior_duplicate_false,
        COUNT(*) FILTER (WHERE duplicate_count IS NULL)::bigint AS behavior_duplicate_unavailable,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'auto-resolved')::bigint AS behavior_auto_resolved_true,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) <> 'auto-resolved')::bigint AS behavior_auto_resolved_unavailable,
        COUNT(*) FILTER (WHERE related_count > 0)::bigint AS behavior_correlated_true,
        COUNT(*) FILTER (WHERE related_count = 0)::bigint AS behavior_correlated_false,
        COUNT(*) FILTER (WHERE related_count IS NULL)::bigint AS behavior_correlated_unavailable,
        COUNT(*) FILTER (WHERE expected_activity_value = 'true')::bigint AS behavior_expected_activity_true,
        COUNT(*) FILTER (WHERE expected_activity_value = 'false')::bigint AS behavior_expected_activity_false,
        COUNT(*) FILTER (WHERE expected_activity_value NOT IN ('true', 'false'))::bigint AS behavior_expected_activity_unavailable,
        COUNT(*) FILTER (WHERE source IS NOT NULL AND BTRIM(source) <> '')::bigint AS feature_source_available,
        COUNT(*) FILTER (WHERE entity IS NOT NULL OR service IS NOT NULL OR application IS NOT NULL)::bigint AS feature_identity_available,
        COUNT(*) FILTER (WHERE application IS NOT NULL AND BTRIM(application) <> '')::bigint AS feature_application_available,
        COUNT(*) FILTER (WHERE service IS NOT NULL AND BTRIM(service) <> '')::bigint AS feature_service_available,
        COUNT(*) FILTER (WHERE environment IS NOT NULL AND BTRIM(environment) <> '' AND LOWER(environment) <> 'unknown')::bigint AS feature_environment_available,
        COUNT(*) FILTER (WHERE severity IS NOT NULL AND BTRIM(severity) <> '')::bigint AS feature_severity_available,
        COUNT(*) FILTER (WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL)::bigint AS feature_duration_available,
        COUNT(*) FILTER (WHERE occurrence_count IS NOT NULL)::bigint AS feature_recurrence_available,
        COUNT(*) FILTER (WHERE duplicate_count IS NOT NULL OR related_count IS NOT NULL)::bigint AS feature_correlation_available,
        COUNT(*) FILTER (WHERE slack_channel_id IS NOT NULL AND slack_message_ts IS NOT NULL)::bigint AS feature_slack_available,
        COUNT(*) FILTER (WHERE alert_signature IS NOT NULL AND created_at IS NOT NULL)::bigint AS feature_historical_incident_context_available,
        COUNT(*) FILTER (WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL AND last_seen >= first_seen AND last_seen - first_seen <= INTERVAL '7 days' AND LOWER(COALESCE(source, '')) NOT IN ('slack','jira','jsm operations alerts'))::bigint AS occurrence_reliable,
        COUNT(*) FILTER (WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL AND last_seen >= first_seen AND NOT (last_seen - first_seen > INTERVAL '30 days' AND COALESCE(occurrence_count, 1) <= 3) AND (last_seen - first_seen > INTERVAL '7 days' OR LOWER(COALESCE(source, '')) IN ('slack','jira','jsm operations alerts')))::bigint AS occurrence_source_aggregated,
        COUNT(*) FILTER (WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL AND (last_seen < first_seen OR (last_seen - first_seen > INTERVAL '30 days' AND COALESCE(occurrence_count, 1) <= 3)))::bigint AS occurrence_suspect,
        COUNT(*) FILTER (WHERE first_seen IS NULL OR last_seen IS NULL)::bigint AS occurrence_unavailable,
        COUNT(*) FILTER (WHERE operational_outcome IN ('CONFIRMED_INCIDENT','CONFIRMED_NOISE'))::bigint AS training_confirmed_labeled,
        COUNT(*) FILTER (WHERE operational_outcome IS NULL AND historical_outcome IN ('INCIDENT','INCIDENT_UNLINKED'))::bigint AS training_weak_evidence,
        COUNT(*) FILTER (WHERE operational_outcome IS NULL AND historical_outcome = 'NO_OBSERVED_INCIDENT')::bigint AS training_unlabeled,
        COUNT(*) FILTER (WHERE operational_outcome = 'UNKNOWN' OR (operational_outcome IS NULL AND historical_outcome = 'UNKNOWN'))::bigint AS training_unknown
      FROM records
    )
    SELECT aggregate.*,
      COALESCE((
        SELECT JSONB_AGG(item ORDER BY item->>'source', item->>'domain', item->>'subtype')
        FROM (
          SELECT JSONB_BUILD_OBJECT('source', COALESCE(source, 'Unknown'), 'domain', taxonomy_domain, 'subtype', taxonomy_subtype, 'count', COUNT(*)) item
          FROM records GROUP BY source, taxonomy_domain, taxonomy_subtype
        ) grouped
      ), '[]'::jsonb) AS taxonomy_by_source
    FROM aggregate
  `;
}

function mapFeatureAuditRow(row, range, generatedAt) {
  const total = Number(row?.total_records || 0);
  return {
    generatedAt: toIso(generatedAt),
    range: range.range,
    totalRecords: total,
    taxonomyCoverage: {
      domainAssigned: Number(row?.taxonomy_domain_assigned || 0),
      domainCoveragePercentage: total ? Number(((Number(row?.taxonomy_domain_assigned || 0) / total) * 100).toFixed(2)) : 0,
      unknownDomain: Number(row?.taxonomy_unknown_domain || 0),
      subtypeAssigned: Number(row?.taxonomy_subtype_assigned || 0),
      subtypeCoveragePercentage: total ? Number(((Number(row?.taxonomy_subtype_assigned || 0) / total) * 100).toFixed(2)) : 0,
      unknownSubtype: Number(row?.taxonomy_unknown_subtype || 0),
      manuallyCorrected: Number(row?.taxonomy_manually_corrected || 0),
      bySource: asArray(row?.taxonomy_by_source),
    },
    behaviorCoverage: {
      duplicate: { observed: Number(row?.behavior_duplicate_true || 0), notObserved: Number(row?.behavior_duplicate_false || 0), unavailable: Number(row?.behavior_duplicate_unavailable || 0) },
      flapping: { observed: 0, notObserved: 0, unavailable: total },
      autoResolved: { observed: Number(row?.behavior_auto_resolved_true || 0), notObserved: 0, unavailable: Number(row?.behavior_auto_resolved_unavailable || 0) },
      nonActionable: { observed: 0, notObserved: 0, unavailable: total },
      correlated: { observed: Number(row?.behavior_correlated_true || 0), notObserved: Number(row?.behavior_correlated_false || 0), unavailable: Number(row?.behavior_correlated_unavailable || 0) },
      stale: { observed: 0, notObserved: 0, unavailable: total },
      expectedActivity: { observed: Number(row?.behavior_expected_activity_true || 0), notObserved: Number(row?.behavior_expected_activity_false || 0), unavailable: Number(row?.behavior_expected_activity_unavailable || 0) },
    },
    featureCoverage: {
      source: Number(row?.feature_source_available || 0), identity: Number(row?.feature_identity_available || 0),
      application: Number(row?.feature_application_available || 0), service: Number(row?.feature_service_available || 0),
      environment: Number(row?.feature_environment_available || 0), severity: Number(row?.feature_severity_available || 0),
      duration: Number(row?.feature_duration_available || 0), recurrence: Number(row?.feature_recurrence_available || 0),
      correlation: Number(row?.feature_correlation_available || 0), slack: Number(row?.feature_slack_available || 0),
      historicalIncidentContext: Number(row?.feature_historical_incident_context_available || 0),
    },
    occurrenceQuality: {
      reliable: Number(row?.occurrence_reliable || 0), sourceAggregated: Number(row?.occurrence_source_aggregated || 0),
      suspect: Number(row?.occurrence_suspect || 0), unavailable: Number(row?.occurrence_unavailable || 0),
    },
    trainingReadiness: {
      confirmedLabeled: Number(row?.training_confirmed_labeled || 0), weakEvidence: Number(row?.training_weak_evidence || 0),
      unlabeled: Number(row?.training_unlabeled || 0), unknown: Number(row?.training_unknown || 0), mlTrainingStarted: false,
    },
  };
}

function mapSummary(row, range, generatedAt, reconciliation = {}) {
  const total = Number(row?.total_records || 0);
  const incident = Number(row?.incident_records || 0);
  const confirmedOperationalIncident = Number(row?.operational_confirmed_incident || 0);
  const confirmedOperationalNoise = Number(row?.operational_confirmed_noise || 0);
  const operationalUnknown = Number(row?.operational_unknown || 0);
  const confirmedLabeled = confirmedOperationalIncident + confirmedOperationalNoise;
  return {
    datasetVersion: DATASET_VERSION,
    generatedAt: toIso(generatedAt),
    range: range.range,
    rangeFrom: range.from,
    rangeTo: range.to,
    totalRecords: total,
    incident: incident,
    confirmedIncidentLinkedAlerts: Number(row?.confirmed_reconciled_alerts || 0),
    probableIncidentLinkedAlerts: Number(row?.probable_reconciled_alerts || 0),
    incidentUnlinked: Number(row?.incident_unlinked_records || 0),
    ambiguousAlerts: Number(row?.ambiguous_reconciled_alerts || 0),
    noObservedIncident: Number(row?.no_observed_incident_records || 0),
    unknown: Number(row?.unknown_records || 0),
    uniqueSources: Number(row?.unique_sources || 0),
    incidentMatchRate: total ? Number((incident / total).toFixed(6)) : 0,
    problemLinkedIncidents: Number(row?.problem_linked_incidents || 0),
    uniqueIncidentTickets: Number(reconciliation.uniqueIncidentTickets || 0),
    unlinkedIncidentTickets: Number(reconciliation.unlinkedIncidentTickets || 0),
    incidentReconciliation: asArray(reconciliation.incidents),
    learningStatus: 'ML_NOT_TRAINED',
    operationalOutcomes: {
      confirmedIncident: confirmedOperationalIncident,
      confirmedNoise: confirmedOperationalNoise,
      unknown: operationalUnknown,
      unconfirmed: Number(row?.operational_unconfirmed || 0),
      confirmedLabeled,
      confirmedLabeledPercentage: total ? Number(((confirmedLabeled / total) * 100).toFixed(2)) : 0,
      linkedJiraIncident: Number(row?.operational_linked_jira_incident || 0),
      unlinkedIncident: Number(row?.operational_unlinked_incident || 0),
      noiseReasonBreakdown: asArray(row?.operational_noise_breakdown),
    },
    trainingReadiness: {
      confirmedLabeled,
      weakEvidence: Number(row?.training_weak_evidence || 0),
      unlabeled: Number(row?.training_unlabeled || 0),
      unknown: Number(row?.training_unknown || 0),
      mlTrainingStarted: false,
    },
    taxonomyCoverage: {
      domainAssigned: Number(row?.taxonomy_domain_assigned || 0),
      domainCoveragePercentage: total ? Number(((Number(row?.taxonomy_domain_assigned || 0) / total) * 100).toFixed(2)) : 0,
      unknownDomain: Number(row?.taxonomy_unknown_domain || 0),
      subtypeAssigned: Number(row?.taxonomy_subtype_assigned || 0),
      subtypeCoveragePercentage: total ? Number(((Number(row?.taxonomy_subtype_assigned || 0) / total) * 100).toFixed(2)) : 0,
      unknownSubtype: Number(row?.taxonomy_unknown_subtype || 0),
      manuallyCorrected: Number(row?.taxonomy_manually_corrected || 0),
      bySource: asArray(row?.taxonomy_by_source),
    },
    behaviorCoverage: {
      duplicate: { observed: Number(row?.behavior_duplicate_true || 0), notObserved: Number(row?.behavior_duplicate_false || 0), unavailable: Number(row?.behavior_duplicate_unavailable || 0) },
      flapping: { observed: Number(row?.behavior_flapping_true || 0), notObserved: Number(row?.behavior_flapping_false || 0), unavailable: Number(row?.behavior_flapping_unavailable || 0) },
      autoResolved: { observed: Number(row?.behavior_auto_resolved_true || 0), notObserved: Number(row?.behavior_auto_resolved_false || 0), unavailable: Number(row?.behavior_auto_resolved_unavailable || 0) },
      nonActionable: { observed: Number(row?.behavior_non_actionable_true || 0), notObserved: Number(row?.behavior_non_actionable_false || 0), unavailable: Number(row?.behavior_non_actionable_unavailable || 0) },
      correlated: { observed: Number(row?.behavior_correlated_true || 0), notObserved: Number(row?.behavior_correlated_false || 0), unavailable: Number(row?.behavior_correlated_unavailable || 0) },
      stale: { observed: Number(row?.behavior_stale_true || 0), notObserved: Number(row?.behavior_stale_false || 0), unavailable: Number(row?.behavior_stale_unavailable || 0) },
      expectedActivity: { observed: Number(row?.behavior_expected_activity_true || 0), notObserved: Number(row?.behavior_expected_activity_false || 0), unavailable: Number(row?.behavior_expected_activity_unavailable || 0) },
    },
    featureCoverage: {
      source: Number(row?.feature_source_available || 0),
      identity: Number(row?.feature_identity_available || 0),
      application: Number(row?.feature_application_available || 0),
      service: Number(row?.feature_service_available || 0),
      environment: Number(row?.feature_environment_available || 0),
      severity: Number(row?.feature_severity_available || 0),
      duration: Number(row?.feature_duration_available || 0),
      recurrence: Number(row?.feature_recurrence_available || 0),
      correlation: Number(row?.feature_correlation_available || 0),
      slack: Number(row?.feature_slack_available || 0),
      historicalIncidentContext: Number(row?.feature_historical_incident_context_available || 0),
    },
    occurrenceQuality: {
      reliable: Number(row?.occurrence_reliable || 0),
      sourceAggregated: Number(row?.occurrence_source_aggregated || 0),
      suspect: Number(row?.occurrence_suspect || 0),
      unavailable: Number(row?.occurrence_unavailable || 0),
    },
    dataQuality: {
      duplicateRecords: Number(row?.duplicate_records || 0),
      missingSource: Number(row?.missing_source || 0),
      missingEntity: Number(row?.missing_entity || 0),
      missingApplication: Number(row?.missing_application || 0),
      missingService: Number(row?.missing_service || 0),
      missingEnvironment: Number(row?.missing_environment || 0),
      missingTimestamp: Number(row?.missing_timestamp || 0),
      missingSignature: Number(row?.missing_signature || 0),
      missingIncidentEvidence: Number(row?.missing_incident_evidence || 0),
      ambiguousIncidentMatches: Number(row?.ambiguous_incident_matches || 0),
      suspiciousMatches: Number(row?.suspicious_matches || 0),
    },
    breakdowns: {
      source: asArray(row?.by_source),
      severity: asArray(row?.by_severity),
      environment: asArray(row?.by_environment),
      application: asArray(row?.by_application),
      service: asArray(row?.by_service),
    },
    provenance: {
      storedDataOnly: true,
      externalCalls: 0,
      outcomeDefinitions: {
        INCIDENT: 'Confirmed mapping or strong provenance-aware reconciliation connects the occurrence to a Jira Incident.',
        INCIDENT_UNLINKED: 'A Jira Incident is known and has a probable candidate occurrence, but the relationship is not confirmed.',
        NO_OBSERVED_INCIDENT: 'No Incident relationship was observed after preserved mapping and current reconciliation. This is not Noise.',
        UNKNOWN: 'Relationship evidence is ambiguous, legacy/non-authoritative, or unresolved.',
      },
      operationalOutcomeDefinitions: {
        CONFIRMED_INCIDENT: 'An authenticated operator confirmed an authoritative Jira Incident relationship.',
        CONFIRMED_NOISE: 'An authenticated operator explicitly confirmed Noise with a controlled reason.',
        UNKNOWN: 'An authenticated operator recorded that the operational outcome could not be established.',
        UNCONFIRMED: 'No explicit operational outcome has been recorded. This does not mean Noise.',
      },
      legacyClassificationsAuthoritative: false,
      correlationWindowSeconds: CORRELATION_WINDOW_SECONDS,
      featureAsOfRequired: true,
      behaviorIndicatorsAreOutcomes: false,
      taxonomyIsOutcome: false,
    },
  };
}

async function getReconciliationSummary(database, range) {
  const values = [range.to];
  const predicates = ['reconciliation.current', 'reconciliation.incident_created_at <= $1::timestamptz'];
  if (range.from) {
    values.push(range.from);
    predicates.push('reconciliation.incident_created_at >= $2::timestamptz');
  }
  const result = await database.query(`
    SELECT
      reconciliation.id,
      reconciliation.incident_key,
      reconciliation.alert_id,
      reconciliation.relationship_state,
      reconciliation.match_method,
      reconciliation.match_strength,
      reconciliation.match_confidence,
      reconciliation.alert_timestamp,
      reconciliation.incident_created_at,
      reconciliation.time_delta_seconds,
      reconciliation.matched_source,
      reconciliation.matched_service,
      reconciliation.matched_application,
      reconciliation.matched_environment,
      reconciliation.evidence,
      incident.raw_payload->>'id' AS issue_id,
      incident.summary,
      incident.status,
      incident.priority,
      incident.resolution,
      incident.closed_at,
      incident.source_url
    FROM incident_alert_reconciliations reconciliation
    JOIN operations_incidents incident ON incident.incident_key = reconciliation.incident_key
    WHERE ${predicates.join(' AND ')}
    ORDER BY reconciliation.incident_created_at, reconciliation.incident_key, reconciliation.alert_timestamp
  `, values);
  const grouped = new Map();
  for (const row of result.rows) {
    const current = grouped.get(row.incident_key) || {
      alertMatches: [],
      createdAt: toIso(row.incident_created_at),
      incidentKey: row.incident_key,
      issueId: row.issue_id || null,
      priority: row.priority || null,
      resolution: row.resolution || null,
      resolvedAt: toIso(row.closed_at),
      sourceUrl: row.source_url || null,
      status: row.status || null,
      summary: row.summary || null,
    };
    current.alertMatches.push({
      alertId: row.alert_id || null,
      alertTimestamp: toIso(row.alert_timestamp),
      evidence: asArray(row.evidence),
      evidenceId: `incident_reconciliation:${row.id}`,
      matchConfidence: numeric(row.match_confidence),
      matchedApplication: row.matched_application || null,
      matchedEnvironment: row.matched_environment || null,
      matchedService: row.matched_service || null,
      matchedSource: row.matched_source || null,
      matchMethod: row.match_method,
      matchStrength: row.match_strength,
      relationshipState: row.relationship_state,
      timeDeltaSeconds: numeric(row.time_delta_seconds),
    });
    grouped.set(row.incident_key, current);
  }
  const stateRank = { CONFIRMED_MATCH: 0, PROBABLE_MATCH: 1, AMBIGUOUS: 2, NO_MATCH: 3 };
  const incidents = [...grouped.values()].map((incident) => {
    const relationshipState = [...incident.alertMatches]
      .sort((left, right) => stateRank[left.relationshipState] - stateRank[right.relationshipState])[0]?.relationshipState
      || 'NO_MATCH';
    return { ...incident, relationshipState };
  });
  return {
    incidents,
    uniqueIncidentTickets: incidents.length,
    unlinkedIncidentTickets: incidents.filter((incident) => incident.relationshipState !== 'CONFIRMED_MATCH').length,
  };
}

function createHistoricalLearningDatasetService({ database = db, now = () => Date.now() } = {}) {
  async function ensureDatasetSchemas() {
    if (database !== db) return;
    await Promise.all([
      ensureIncidentReconciliationSchema(database),
      operationalOutcomeStore.ensureSchema(),
      alertTaxonomyService.ensureSchema(),
    ]);
  }

  async function list(options = {}) {
    await ensureDatasetSchemas();
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(options.pageSize || options.size, 10) || 25));
    const filters = buildFilters(options, now);
    const offsetParam = `$${filters.values.length + 1}`;
    const sizeParam = `$${filters.values.length + 2}`;
    const generatedAt = new Date(now()).toISOString();
    const result = await database.query(listSql(filters, offsetParam, sizeParam), [
      ...filters.values,
      (page - 1) * pageSize,
      pageSize,
    ]);
    const totalRecords = Number(result.rows[0]?.total_count || 0);
    return {
      currentPhase: DECISION_LAYER_STATE.currentPhase,
      datasetVersion: DATASET_VERSION,
      decisionLayer: DECISION_LAYER_STATE,
      generatedAt,
      items: result.rows.map((row) => mapRecord(row, generatedAt)),
      pagination: {
        page,
        pageSize,
        totalRecords,
        totalPages: totalRecords ? Math.ceil(totalRecords / pageSize) : 0,
        newestFirst: true,
      },
      range: filters.range,
    };
  }

  async function summary(options = {}) {
    await ensureDatasetSchemas();
    const filters = buildFilters(options, now);
    const generatedAt = new Date(now()).toISOString();
    const [result, reconciliation] = await Promise.all([
      database.query(summarySql(filters), filters.values),
      getReconciliationSummary(database, filters.range),
    ]);
    return mapSummary(result.rows[0], filters.range, generatedAt, reconciliation);
  }

  async function get(alertId, options = {}) {
    const id = clean(alertId);
    if (!id) {
      const error = new Error('A stored alert occurrence ID is required.');
      error.code = 'INVALID_LEARNING_ALERT_ID';
      error.status = 400;
      throw error;
    }
    const result = await list({ ...options, range: 'all', alertIds: [id], page: 1, pageSize: 1 });
    if (!result.items.length) {
      const error = new Error(`Learning record ${id} was not found.`);
      error.code = 'LEARNING_RECORD_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    return result.items[0];
  }

  async function representativeSample(limit = 10) {
    await ensureDatasetSchemas();
    const boundedLimit = Math.min(10, Math.max(1, Number.parseInt(limit, 10) || 10));
    const filters = buildFilters({ range: 'all' }, now);
    const idResult = await database.query(`
      WITH ${DATA_CTES}, ranked AS (
        SELECT alert_id, source, outcome_label, problem_count, created_at,
          ROW_NUMBER() OVER (PARTITION BY outcome_label ORDER BY created_at DESC, alert_id DESC) AS outcome_rank,
          ROW_NUMBER() OVER (PARTITION BY source, outcome_label ORDER BY created_at DESC, alert_id DESC) AS source_outcome_rank,
          ROW_NUMBER() OVER (PARTITION BY (problem_count > 0) ORDER BY created_at DESC, alert_id DESC) AS problem_rank
        FROM feature_records
        ${filters.baseWhere}
      )
      SELECT alert_id
      FROM ranked
      ORDER BY
        CASE
          WHEN outcome_rank = 1 THEN 0
          WHEN problem_count > 0 AND problem_rank = 1 THEN 1
          ELSE 2
        END,
        source_outcome_rank,
        outcome_label,
        source,
        created_at DESC
      LIMIT $${filters.values.length + 1}
    `, [...filters.values, boundedLimit]);
    const ids = idResult.rows.map((row) => row.alert_id);
    if (!ids.length) return [];
    const result = await list({ range: 'all', alertIds: ids, page: 1, pageSize: boundedLimit });
    const order = new Map(ids.map((id, index) => [id, index]));
    return result.items.sort((left, right) => order.get(left.alert.alertId) - order.get(right.alert.alertId));
  }

  async function trainingPreview(options = {}) {
    const result = await list({
      ...options,
      page: options.page || 1,
      pageSize: Math.min(100, Math.max(1, Number.parseInt(options.pageSize || options.size, 10) || 25)),
    });
    return {
      currentPhase: DECISION_LAYER_STATE.currentPhase,
      datasetVersion: DATASET_VERSION,
      featureVersion: FEATURE_VERSION,
      generatedAt: result.generatedAt,
      items: result.items.map(buildTrainingPreview),
      pagination: result.pagination,
      range: result.range,
      modelStatus: 'ML_NOT_TRAINED',
      automaticLabelsCreated: 0,
      postOutcomeFeaturesExcluded: true,
    };
  }

  async function featureAudit(options = {}) {
    await ensureDatasetSchemas();
    const range = parseRange(options.range || 'all', now);
    const generatedAt = new Date(now()).toISOString();
    const values = range.from ? [range.from, range.to] : [range.to];
    const result = await database.query(featureAuditSql(range), values);
    const auditSummary = mapFeatureAuditRow(result.rows[0], range, generatedAt);
    const leakage = featureLeakageAudit();
    return {
      currentPhase: DECISION_LAYER_STATE.currentPhase,
      datasetVersion: DATASET_VERSION,
      featureVersion: FEATURE_VERSION,
      generatedAt: auditSummary.generatedAt,
      range: auditSummary.range,
      totalRecords: auditSummary.totalRecords,
      taxonomyCoverage: auditSummary.taxonomyCoverage,
      behaviorCoverage: auditSummary.behaviorCoverage,
      featureCoverage: auditSummary.featureCoverage,
      occurrenceQuality: auditSummary.occurrenceQuality,
      trainingReadiness: auditSummary.trainingReadiness,
      leakageAudit: leakage,
      featureAvailabilityGroups: {
        predictionTimeSafe: leakage.filter((item) => item.classification === 'PREDICTION_TIME_SAFE').map((item) => item.featureName),
        conditionalOnFeatureAsOf: leakage.filter((item) => item.classification === 'CONDITIONAL_ON_FEATURE_AS_OF').map((item) => item.featureName),
        postOutcomeOnly: leakage.filter((item) => item.classification === 'POST_OUTCOME_ONLY').map((item) => item.featureName),
        excluded: leakage.filter((item) => item.classification === 'EXCLUDE').map((item) => item.featureName),
      },
      sourceSemantics: SOURCE_SEMANTICS,
      guarantees: {
        legacyClassifierRetired: true,
        behaviorDoesNotCreateOutcome: true,
        taxonomyDoesNotCreateOutcome: true,
        mlModelTrained: false,
        mlPredictionsGenerated: false,
        futureDataExcludedFromTrainingPreview: true,
      },
    };
  }

  async function getStatus() {
    const summary24h = await summary({ range: '24h' });
    return {
      currentPhase: DECISION_LAYER_STATE.currentPhase,
      decisionLayer: DECISION_LAYER_STATE,
      foundation: {
        alertsAvailable: summary24h.totalRecords,
        uniqueSources: summary24h.uniqueSources,
        range: '24h',
        rangeFrom: summary24h.rangeFrom,
        rangeTo: summary24h.rangeTo,
        historicalOutcomes: {
          incident: summary24h.incident,
          incidentUnlinked: summary24h.incidentUnlinked,
          noObservedIncident: summary24h.noObservedIncident,
          unknown: summary24h.unknown,
        },
        operationalOutcomes: summary24h.operationalOutcomes,
        trainingReadiness: summary24h.trainingReadiness,
        uniqueIncidentTickets: summary24h.uniqueIncidentTickets,
        learningStatus: 'ML_NOT_TRAINED',
        storedDataOnly: true,
      },
    };
  }

  return { featureAudit, get, getStatus, list, representativeSample, summary, trainingPreview };
}

module.exports = {
  CORRELATION_WINDOW_SECONDS,
  DATASET_VERSION,
  EXPLICIT_OPERATIONS_MAPPING_REASON,
  FEATURE_VERSION,
  buildFilters,
  createHistoricalLearningDatasetService,
  determineHistoricalOutcome,
  featureLeakageAudit,
  mapRecord,
  mapFeatureAuditRow,
  mapSummary,
  parseRange,
  service: createHistoricalLearningDatasetService(),
};

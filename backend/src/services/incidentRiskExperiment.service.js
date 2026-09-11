const fs = require('fs');
const path = require('path');
const database = require('../config/db');
const { ensureSchema: ensureIncidentReconciliationSchema } = require('./historicalIncidentReconciliation.service');
const { createPostgresOutcomeStore } = require('./operationalOutcome.service');
const { service: taxonomyService } = require('./alertTaxonomy.service');

const migrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/040_incident_risk_shadow_experiments.sql'),
  'utf8',
);

const FEATURE_SCHEMA_VERSION = 'incident-risk-t0-v1';
const TAXONOMY_VERSION = 'structured-text-taxonomy-v1';
const EXPERIMENT_STATE = 'SHADOW_EXPERIMENT_ONLY';
const STALE_OBSERVATION_THRESHOLD_DAYS = 5;
const outcomeStore = createPostgresOutcomeStore();

let schemaReady;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = Promise.all([
      ensureIncidentReconciliationSchema(),
      outcomeStore.ensureSchema(),
      taxonomyService.ensureSchema(),
    ]).then(() => database.query(migrationSql));
  }
  return schemaReady;
}

const populationSql = `
WITH strong_mapping AS (
  SELECT DISTINCT mapping.alert_id
  FROM alert_incident_mappings mapping
  JOIN operations_incidents incident ON incident.incident_key = mapping.jira_ticket_id
  WHERE mapping.mapping_reason = 'JSM Operations alert was linked to a stored Operations incident during enrichment.'
    AND incident.raw_payload->'fields'->'issuetype'->>'name' = '[System] Incident'
),
mapping_quality AS (
  SELECT
    mapping.alert_id,
    BOOL_OR(mapping.mapping_reason <> 'JSM Operations alert was linked to a stored Operations incident during enrichment.') AS legacy_candidate,
    BOOL_OR(mapping.mapping_reason = 'JSM Operations alert was linked to a stored Operations incident during enrichment.'
      AND incident.incident_key IS NULL) AS unresolved_mapping
  FROM alert_incident_mappings mapping
  LEFT JOIN operations_incidents incident ON incident.incident_key = mapping.jira_ticket_id
  GROUP BY mapping.alert_id
),
reconciliation AS (
  SELECT
    alert_id,
    BOOL_OR(relationship_state = 'CONFIRMED_MATCH') AS confirmed_match,
    BOOL_OR(relationship_state = 'PROBABLE_MATCH') AS probable_match,
    BOOL_OR(relationship_state = 'AMBIGUOUS') AS ambiguous_match
  FROM incident_alert_reconciliations
  WHERE current AND alert_id IS NOT NULL
  GROUP BY alert_id
),
base AS (
  SELECT
    occurrence.*,
    outcome.outcome AS operational_outcome,
    correction.corrected_domain,
    correction.corrected_subtype,
    (strong_mapping.alert_id IS NOT NULL OR COALESCE(reconciliation.confirmed_match, false)) AS strong_incident_evidence,
    (strong_mapping.alert_id IS NULL
      AND NOT COALESCE(reconciliation.confirmed_match, false)
      AND COALESCE(reconciliation.probable_match, false)) AS weak_incident_evidence,
    (COALESCE(reconciliation.ambiguous_match, false)
      OR COALESCE(mapping_quality.legacy_candidate, false)
      OR COALESCE(mapping_quality.unresolved_mapping, false)) AS ambiguous_evidence,
    CASE
      WHEN occurrence.first_seen IS NULL OR occurrence.last_seen IS NULL THEN 'UNAVAILABLE'
      WHEN occurrence.last_seen < occurrence.first_seen THEN 'SUSPECT'
      WHEN occurrence.last_seen - occurrence.first_seen > INTERVAL '30 days'
        AND COALESCE(occurrence.occurrence_count, 1) <= 3 THEN 'SUSPECT'
      WHEN LOWER(COALESCE(occurrence.source, '')) IN ('slack', 'jira', 'jsm operations alerts')
        OR LOWER(COALESCE(occurrence.ingestion_source, '')) IN ('slack', 'jira')
        OR occurrence.last_seen - occurrence.first_seen > INTERVAL '7 days' THEN 'SOURCE_AGGREGATED'
      ELSE 'RELIABLE'
    END AS occurrence_quality,
    CASE
      WHEN LOWER(COALESCE(occurrence.source, '')) LIKE '%appdynamics%' THEN 'appdynamics'
      WHEN LOWER(COALESCE(occurrence.source, '')) LIKE '%grafana%' THEN 'grafana'
      WHEN LOWER(COALESCE(occurrence.source, '')) LIKE '%nagios%' THEN 'nagios'
      WHEN LOWER(COALESCE(occurrence.source, '')) LIKE '%thousandeyes%' THEN 'thousandeyes'
      WHEN LOWER(COALESCE(occurrence.source, '')) LIKE '%jsm operations%' THEN 'jsm_operations'
      WHEN LOWER(COALESCE(occurrence.source, '')) = 'jira' THEN 'jira'
      WHEN LOWER(COALESCE(occurrence.source, '')) = 'slack' THEN 'slack'
      WHEN LOWER(COALESCE(occurrence.source, '')) IN ('unknown', 'unknown-monitoring-tool', '') THEN 'unknown'
      ELSE LOWER(occurrence.source)
    END AS normalized_source,
    MD5(CONCAT_WS('|', occurrence.source, occurrence.message, occurrence.entity,
      occurrence.application, occurrence.service)) AS taxonomy_key
  FROM historical_alert_learning_occurrences_v1 occurrence
  LEFT JOIN strong_mapping ON strong_mapping.alert_id = occurrence.alert_id
  LEFT JOIN mapping_quality ON mapping_quality.alert_id = occurrence.alert_id
  LEFT JOIN reconciliation ON reconciliation.alert_id = occurrence.alert_id
  LEFT JOIN alert_occurrence_outcomes outcome ON outcome.alert_id = occurrence.alert_id AND outcome.is_current
  LEFT JOIN alert_occurrence_taxonomy_corrections correction
    ON correction.alert_id = occurrence.alert_id AND correction.is_current
),
taxonomy_lookup AS MATERIALIZED (
  SELECT
    taxonomy_key,
    learning_taxonomy_subtype(
      MIN(source), MIN(message), MIN(entity), MIN(application), MIN(service)
    ) AS suggested_subtype
  FROM base
  GROUP BY taxonomy_key
),
labeled AS (
  SELECT
    base.*,
    CASE
      WHEN operational_outcome = 'CONFIRMED_INCIDENT' THEN 'TIER_A'
      WHEN operational_outcome = 'CONFIRMED_NOISE' THEN 'CONFIRMED_NEGATIVE'
      WHEN operational_outcome = 'UNKNOWN' THEN 'UNKNOWN'
      WHEN strong_incident_evidence THEN 'TIER_A'
      WHEN weak_incident_evidence THEN 'TIER_B'
      WHEN ambiguous_evidence THEN 'UNKNOWN'
      ELSE 'UNLABELED'
    END AS learning_tier,
    taxonomy_lookup.suggested_subtype
  FROM base
  JOIN taxonomy_lookup USING (taxonomy_key)
),
features AS (
  SELECT
    labeled.*,
    COALESCE(corrected_subtype, suggested_subtype) AS taxonomy_subtype,
    COALESCE(corrected_domain, learning_taxonomy_domain(suggested_subtype)) AS taxonomy_domain,
    CASE
      WHEN corrected_subtype IS NOT NULL OR corrected_domain IS NOT NULL THEN 1.0
      WHEN suggested_subtype = 'UNKNOWN_SUBTYPE' THEN 0.0
      ELSE 0.8
    END AS taxonomy_confidence,
    CASE WHEN alert_signature IS NULL THEN 0 ELSE COUNT(*) OVER (
      PARTITION BY alert_signature ORDER BY created_at
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) END AS previous_same_signature_count,
    CASE WHEN NULLIF(LOWER(COALESCE(entity, '')), '') IS NULL THEN 0 ELSE COUNT(*) OVER (
      PARTITION BY LOWER(entity) ORDER BY created_at
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) END AS previous_same_entity_count,
    CASE WHEN NULLIF(LOWER(COALESCE(service, '')), '') IS NULL
      OR LOWER(service) IN ('unknown', 'unknown-service') THEN 0 ELSE COUNT(*) OVER (
      PARTITION BY LOWER(service) ORDER BY created_at
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) END AS previous_same_service_count,
    CASE WHEN alert_signature IS NULL THEN 0 ELSE COALESCE(SUM(
      CASE WHEN learning_tier IN ('TIER_A', 'TIER_B') THEN 1 ELSE 0 END
    ) OVER (
      PARTITION BY alert_signature ORDER BY created_at
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) END AS previous_incident_evidence_count,
    CASE WHEN alert_signature IS NULL THEN 0 ELSE COALESCE(SUM(
      CASE WHEN learning_tier = 'TIER_A' THEN 1 ELSE 0 END
    ) OVER (
      PARTITION BY alert_signature ORDER BY created_at
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) END AS previous_confirmed_incident_count,
    CASE WHEN alert_signature IS NULL THEN 0 ELSE COALESCE(SUM(
      CASE WHEN operational_outcome = 'CONFIRMED_NOISE' THEN 1 ELSE 0 END
    ) OVER (
      PARTITION BY alert_signature ORDER BY created_at
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) END AS previous_confirmed_noise_count,
    CASE WHEN alert_signature IS NULL THEN NULL ELSE LAG(created_at) OVER (
      PARTITION BY alert_signature ORDER BY created_at, alert_id
    ) END AS previous_signature_at
  FROM labeled
),
final AS (
  SELECT
    features.*,
    CASE
      WHEN occurrence_quality = 'SUSPECT' THEN 'OCCURRENCE_QUALITY_SUSPECT'
      WHEN occurrence_quality = 'SOURCE_AGGREGATED' THEN 'OCCURRENCE_QUALITY_SOURCE_AGGREGATED'
      WHEN occurrence_quality = 'UNAVAILABLE' THEN 'PREDICTION_SNAPSHOT_UNAVAILABLE'
      WHEN learning_tier = 'UNKNOWN' THEN 'INSUFFICIENT_OR_AMBIGUOUS_OUTCOME_EVIDENCE'
      WHEN learning_tier = 'TIER_B' THEN 'TIER_B_WEAK_POSITIVE_HELD_OUT'
      WHEN created_at IS NULL THEN 'PREDICTION_SNAPSHOT_UNAVAILABLE'
      ELSE NULL
    END AS exclusion_reason
  FROM features
)
SELECT
  alert_id,
  source_alert_id,
  normalized_source,
  source,
  ingestion_source,
  message,
  alert_signature,
  entity,
  entity_key AS entity_id,
  application,
  service,
  environment,
  severity,
  priority,
  status,
  created_at AS feature_as_of,
  first_seen,
  last_seen,
  occurrence_quality,
  learning_tier,
  exclusion_reason,
  taxonomy_domain,
  taxonomy_subtype,
  taxonomy_confidence,
  1::integer AS occurrence_count_so_far,
  0::integer AS duration_so_far_seconds,
  0::integer AS related_alerts_observed_so_far,
  false AS cross_source_activity_observed_so_far,
  previous_same_signature_count,
  previous_same_entity_count,
  previous_same_service_count,
  previous_incident_evidence_count,
  previous_confirmed_incident_count,
  previous_confirmed_noise_count,
  CASE WHEN previous_same_signature_count > 0
    THEN previous_incident_evidence_count::double precision / previous_same_signature_count
    ELSE NULL END AS historical_incident_association_rate,
  CASE WHEN previous_signature_at IS NOT NULL
    THEN EXTRACT(EPOCH FROM (created_at - previous_signature_at))
    ELSE NULL END AS recurrence_interval_seconds,
  CASE WHEN learning_tier = 'TIER_A' THEN 1
    WHEN learning_tier IN ('UNLABELED', 'CONFIRMED_NEGATIVE') THEN 0
    ELSE NULL END AS benchmark_target,
  (normalized_source IN ('jira', 'slack')) AS communication_derived
FROM final
ORDER BY created_at, alert_id
`;

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializePopulationRow(row) {
  return {
    ...row,
    feature_as_of: iso(row.feature_as_of),
    first_seen: iso(row.first_seen),
    last_seen: iso(row.last_seen),
    taxonomy_confidence: Number(row.taxonomy_confidence || 0),
    occurrence_count_so_far: Number(row.occurrence_count_so_far || 0),
    duration_so_far_seconds: Number(row.duration_so_far_seconds || 0),
    related_alerts_observed_so_far: Number(row.related_alerts_observed_so_far || 0),
    previous_same_signature_count: Number(row.previous_same_signature_count || 0),
    previous_same_entity_count: Number(row.previous_same_entity_count || 0),
    previous_same_service_count: Number(row.previous_same_service_count || 0),
    previous_incident_evidence_count: Number(row.previous_incident_evidence_count || 0),
    previous_confirmed_incident_count: Number(row.previous_confirmed_incident_count || 0),
    previous_confirmed_noise_count: Number(row.previous_confirmed_noise_count || 0),
    historical_incident_association_rate: row.historical_incident_association_rate === null
      ? null : Number(row.historical_incident_association_rate),
    recurrence_interval_seconds: row.recurrence_interval_seconds === null
      ? null : Number(row.recurrence_interval_seconds),
    benchmark_target: row.benchmark_target === null ? null : Number(row.benchmark_target),
  };
}

function summarizePopulation(rows) {
  const summary = {
    totalStoredRecords: rows.length,
    totalCandidates: 0,
    tierAPositives: 0,
    tierBWeakPositives: 0,
    confirmedNegatives: 0,
    unlabeled: 0,
    excluded: 0,
    exclusionReasons: {},
    sourceDistribution: {},
    timeDistribution: {},
  };
  for (const row of rows) {
    if (row.learning_tier === 'TIER_B') summary.tierBWeakPositives += 1;
    if (row.exclusion_reason) {
      summary.excluded += 1;
      summary.exclusionReasons[row.exclusion_reason] = (summary.exclusionReasons[row.exclusion_reason] || 0) + 1;
      continue;
    }
    summary.totalCandidates += 1;
    if (row.learning_tier === 'TIER_A') summary.tierAPositives += 1;
    if (row.learning_tier === 'CONFIRMED_NEGATIVE') summary.confirmedNegatives += 1;
    if (row.learning_tier === 'UNLABELED') summary.unlabeled += 1;
    const source = row.normalized_source || 'unknown';
    const current = summary.sourceDistribution[source] || { candidates: 0, tierA: 0, unlabeled: 0 };
    current.candidates += 1;
    current.tierA += row.learning_tier === 'TIER_A' ? 1 : 0;
    current.unlabeled += row.learning_tier === 'UNLABELED' ? 1 : 0;
    summary.sourceDistribution[source] = current;
    const year = String(row.feature_as_of || 'unknown').slice(0, 4);
    const period = summary.timeDistribution[year] || { candidates: 0, tierA: 0 };
    period.candidates += 1;
    period.tierA += row.learning_tier === 'TIER_A' ? 1 : 0;
    summary.timeDistribution[year] = period;
  }
  return summary;
}

async function loadPopulation() {
  await ensureSchema();
  const result = await database.query(populationSql);
  return result.rows.map(serializePopulationRow);
}

async function exportPopulationJsonl(destination) {
  const rows = await loadPopulation();
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.promises.writeFile(destination, `${content}\n`, { mode: 0o600 });
  return { file: destination, summary: summarizePopulation(rows) };
}

async function saveExperiment({ artifactPath, experimentId, metadata, modelFamily, modelVersion, predictions }) {
  await ensureSchema();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO ml_shadow_experiments (
        experiment_id, model_version, model_family, feature_schema_version,
        taxonomy_version, positive_definition, pu_strategy, artifact_path, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [
      experimentId,
      modelVersion,
      modelFamily,
      FEATURE_SCHEMA_VERSION,
      TAXONOMY_VERSION,
      metadata.positiveDefinition,
      metadata.puStrategy,
      artifactPath,
      JSON.stringify(metadata),
    ]);

    for (let index = 0; index < predictions.length; index += 500) {
      const batch = predictions.slice(index, index + 500);
      const values = [];
      const placeholders = batch.map((prediction, offset) => {
        const base = offset * 8;
        values.push(
          experimentId,
          prediction.alertId,
          modelVersion,
          prediction.featureAsOf,
          prediction.incidentRiskScore,
          prediction.scoreBand,
          JSON.stringify(prediction.explanation || {}),
          prediction.datasetSplit,
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7}::jsonb,$${base + 8})`;
      });
      if (batch.length) {
        await client.query(`
          INSERT INTO ml_shadow_predictions (
            experiment_id, alert_id, model_version, feature_as_of,
            incident_risk_score, score_band, explanation, dataset_split
          ) VALUES ${placeholders.join(',')}
        `, values);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getLatestExperiment() {
  await ensureSchema();
  const result = await database.query(`
    SELECT experiment_id, model_version, experiment_state, model_family,
      feature_schema_version, taxonomy_version, metadata, created_at
    FROM ml_shadow_experiments
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

async function getPredictions(alertIds = []) {
  await ensureSchema();
  const ids = [...new Set(alertIds.filter(Boolean))].slice(0, 100);
  if (!ids.length) return {};
  const result = await database.query(`
    WITH latest AS (
      SELECT experiment_id FROM ml_shadow_experiments ORDER BY created_at DESC LIMIT 1
    )
    SELECT prediction.alert_id, prediction.model_version, prediction.feature_as_of,
      prediction.incident_risk_score, prediction.score_band, prediction.explanation,
      prediction.dataset_split, prediction.created_at
    FROM ml_shadow_predictions prediction
    JOIN latest ON latest.experiment_id = prediction.experiment_id
    WHERE prediction.alert_id = ANY($1::text[])
      AND prediction.dataset_split = 'CURRENT_24H_SHADOW'
  `, [ids]);
  return Object.fromEntries(result.rows.map((row) => [row.alert_id, {
    incidentRiskScore: Number(row.incident_risk_score),
    scoreBand: row.score_band,
    modelVersion: row.model_version,
    featureAsOf: iso(row.feature_as_of),
    explanation: row.explanation,
    createdAt: iso(row.created_at),
    experimental: true,
    automatedAction: false,
  }]));
}

module.exports = {
  EXPERIMENT_STATE,
  FEATURE_SCHEMA_VERSION,
  STALE_OBSERVATION_THRESHOLD_DAYS,
  TAXONOMY_VERSION,
  ensureSchema,
  exportPopulationJsonl,
  getLatestExperiment,
  getPredictions,
  loadPopulation,
  populationSql,
  saveExperiment,
  serializePopulationRow,
  summarizePopulation,
};

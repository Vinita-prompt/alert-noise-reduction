const database = require('../config/db');
const { service: evaluationService } = require('./liveMultiSourceEvaluation.service');
const { service: mlService } = require('./mlShadow.service');
const { service: humanVerificationService } = require('./humanVerification.service');
const opsIngestionService = require('./atlassian/opsIngestion.service');
const { commandCenterAlertSql } = require('./commandCenterEligibility.service');
const slackCallbackInboxService = require('./slackCallbackInbox.service');

function number(value) { return Number(value || 0); }
function iso(value) { return value ? new Date(value).toISOString() : null; }

function createProductObservabilityService({ db = database } = {}) {
  async function ensureSchema() {
    await Promise.all([evaluationService.ensureSchema(), mlService.ensureSchema(), humanVerificationService.ensureSchema()]);
  }

  async function monitoringSources() {
    await ensureSchema();
    const [connectivity, evaluationRows, opsStatus, slackResult] = await Promise.all([
      evaluationService.latestConnectivity(),
      db.query(`SELECT evaluation.source,
        COALESCE(evaluation.technical_evidence->>'sourceInstance',
          evaluation.source_details->>'sourceInstance') AS source_instance,
        COUNT(*)::int AS evidence_records,
        COUNT(*) FILTER (WHERE alert.status IN ('open','acknowledged','escalated','investigating','firing','triggered'))::int AS current_alerts,
        COUNT(*) FILTER (WHERE NULLIF(evaluation.feature_snapshot->'identity'->>'entity','') IS NOT NULL
          OR NULLIF(evaluation.feature_snapshot->'identity'->>'application','') IS NOT NULL
          OR NULLIF(evaluation.feature_snapshot->'identity'->>'service','') IS NOT NULL)::int AS authoritative_identities,
        COUNT(*) FILTER (WHERE NULLIF(evaluation.feature_snapshot->'episode'->>'episodeId','') IS NOT NULL)::int AS exact_occurrences,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'coverage'->'evidenceCompleteness'->>'complete')::boolean,false))::int AS evidence_complete,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'coverage'->'evaluability'->>'evaluable')::boolean,false))::int AS evaluable,
        COUNT(*) FILTER (WHERE evaluation.technical_evidence->'monitoringLifecycle' IS NOT NULL)::int AS lifecycle_covered,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'recovery'->>'recovered')::boolean,false))::int AS recovery_covered,
        MAX(evaluation.created_at) AS last_evaluation,
        MAX(evaluation.feature_as_of) AS last_evidence
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
      GROUP BY evaluation.source, 2 ORDER BY evaluation.source, 2`),
      opsIngestionService.getStatus().catch((error) => ({ configured: false, connected: false, lastErrorMessage: error.message })),
      db.query(`SELECT COUNT(*)::int AS messages, MAX(updated_at) AS last_retrieval,
        COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '24 hours')::int AS current_messages
        FROM slack_raw_messages`).catch(() => ({ rows: [{ messages: 0, current_messages: 0, last_retrieval: null }] })),
    ]);
    const connectionFor = (source, instance = null) => connectivity.find((item) => (
      item.source === source && String(item.sourceInstance || '').toUpperCase() === String(instance || '').toUpperCase()
    ));
    const evidenceFor = (source, instance = null) => evaluationRows.rows.filter((item) => (
      item.source === source && (!instance || String(item.source_instance || '').toUpperCase().includes(String(instance).toUpperCase()))
    )).reduce((sum, row) => ({
      evidenceRecords: sum.evidenceRecords + number(row.evidence_records),
      currentAlerts: sum.currentAlerts + number(row.current_alerts),
      authoritativeIdentities: sum.authoritativeIdentities + number(row.authoritative_identities),
      exactOccurrences: sum.exactOccurrences + number(row.exact_occurrences),
      evidenceComplete: sum.evidenceComplete + number(row.evidence_complete),
      evaluable: sum.evaluable + number(row.evaluable),
      lifecycleCovered: sum.lifecycleCovered + number(row.lifecycle_covered),
      recoveryCovered: sum.recoveryCovered + number(row.recovery_covered),
      lastEvaluation: !sum.lastEvaluation || new Date(row.last_evaluation) > new Date(sum.lastEvaluation) ? row.last_evaluation : sum.lastEvaluation,
      lastEvidence: !sum.lastEvidence || new Date(row.last_evidence) > new Date(sum.lastEvidence) ? row.last_evidence : sum.lastEvidence,
    }), { evidenceRecords: 0, currentAlerts: 0, authoritativeIdentities: 0, exactOccurrences: 0, evidenceComplete: 0, evaluable: 0, lifecycleCovered: 0, recoveryCovered: 0, lastEvaluation: null, lastEvidence: null });
    const definitions = [
      ['AppDynamics', 'AppDynamics', null], ['Grafana Argus', 'Grafana', null],
      ['Nagios D01', 'Nagios', 'D01'], ['Nagios D02', 'Nagios', 'D02'],
    ];
    const sources = definitions.map(([name, source, instance]) => {
      const connection = connectionFor(source, instance);
      const evidence = evidenceFor(source, instance);
      const hasStoredEvidence = evidence.evidenceRecords > 0;
      const denominator = hasStoredEvidence ? evidence.evidenceRecords : null;
      return {
        name, source, sourceInstance: instance,
        connectionStatus: connection?.status || 'NOT_CHECKED',
        authenticationStatus: connection?.authenticated === true ? 'AUTHENTICATED'
          : connection?.authenticated === false ? 'FAILED' : 'UNKNOWN',
        apiStatus: connection?.apiResponseSuccessful ? 'AVAILABLE' : connection?.status || 'UNKNOWN',
        lastSuccessfulRetrieval: iso(evidence.lastEvidence),
        lastAttemptedRetrieval: iso(connection?.checkedAt || evidence.lastEvaluation),
        evidenceRecordsRetrieved: evidence.evidenceRecords,
        evidenceStatus: hasStoredEvidence ? 'AVAILABLE' : 'NO_STORED_EVIDENCE',
        currentAlerts: evidence.currentAlerts,
        authoritativeIdentities: evidence.authoritativeIdentities,
        exactOccurrences: evidence.exactOccurrences,
        lifecycleCoverage: denominator ? evidence.lifecycleCovered / denominator : null,
        recoveryCoverage: denominator ? evidence.recoveryCovered / denominator : null,
        evidenceCompleteness: denominator ? evidence.evidenceComplete / denominator : null,
        evaluationCoverage: denominator ? evidence.evaluable / denominator : null,
        errors: connection?.safeError ? 1 : 0,
        lastError: connection?.safeError || null,
      };
    });
    const slack = slackResult.rows[0] || {};
    sources.push({
      name: 'JSM Operations', source: 'JSM Operations', sourceInstance: null,
      connectionStatus: opsStatus.connected ? 'CONNECTED' : opsStatus.configured ? 'DEGRADED' : 'NOT_CONFIGURED',
      authenticationStatus: opsStatus.connections?.operationsRead?.configured ? 'CONFIGURED' : 'UNKNOWN',
      apiStatus: String(opsStatus.lastResult || 'UNKNOWN').toUpperCase(),
      lastSuccessfulRetrieval: iso(opsStatus.lastSuccessfulSyncAt),
      lastAttemptedRetrieval: iso(opsStatus.lastAttemptAt),
      evidenceRecordsRetrieved: number(opsStatus.alertsImported) + number(opsStatus.alertsUpdated),
      currentAlerts: number(opsStatus.alertsFetched), authoritativeIdentities: 0, exactOccurrences: 0,
      lifecycleCoverage: null, recoveryCoverage: null, evidenceCompleteness: null, evaluationCoverage: null,
      errors: opsStatus.lastErrorCode ? 1 : 0, lastError: opsStatus.lastErrorMessage || null,
    }, {
      name: 'Slack', source: 'Slack', sourceInstance: null,
      connectionStatus: slack.last_retrieval ? 'EVIDENCE_PRESENT' : 'NOT_CHECKED',
      authenticationStatus: 'NOT_CHECKED', apiStatus: slack.last_retrieval ? 'STORED_EVIDENCE_AVAILABLE' : 'UNKNOWN',
      lastSuccessfulRetrieval: iso(slack.last_retrieval), lastAttemptedRetrieval: iso(slack.last_retrieval),
      evidenceRecordsRetrieved: number(slack.messages), currentAlerts: number(slack.current_messages),
      authoritativeIdentities: 0, exactOccurrences: 0, lifecycleCoverage: null, recoveryCoverage: null,
      evidenceCompleteness: null, evaluationCoverage: null, errors: 0, lastError: null,
    }, {
      name: 'Second Grafana deployment', source: 'Grafana', sourceInstance: 'secondary',
      connectionStatus: 'NOT_CONFIGURED', authenticationStatus: 'UNKNOWN', apiStatus: 'UNAVAILABLE',
      lastSuccessfulRetrieval: null, lastAttemptedRetrieval: null, evidenceRecordsRetrieved: 0,
      currentAlerts: 0, authoritativeIdentities: 0, exactOccurrences: 0, lifecycleCoverage: null,
      recoveryCoverage: null, evidenceCompleteness: null, evaluationCoverage: null, errors: 0,
      lastError: 'Separate read-only access is not configured.',
    });
    return { generatedAt: new Date().toISOString(), sources, readOnly: true, externalMutations: 0 };
  }

  async function diagnostics() {
    await ensureSchema();
    const [blockers, evidence, invariants, episodes, humanVerification, slackCallbacks] = await Promise.all([
      db.query(`SELECT evaluation.source,
        COALESCE(alert.raw_payload->'priority'->>'name', alert.raw_payload->>'priority', 'Unknown') AS priority,
        evaluation.final_decision AS decision,
        COALESCE(evaluation.technical_evidence->'coverage'->'evidenceCompleteness'->>'status','UNKNOWN') AS evidence_status,
        CASE
          WHEN evaluation.final_decision <> 'NEEDS_REVIEW' THEN 'NOT_REVIEW'
          WHEN evaluation.explanation->>'reviewSubReason' IN ('SOURCE_EVIDENCE_UNAVAILABLE','SOURCE_API_UNAVAILABLE')
            OR evaluation.failure_reasons::text ILIKE '%SOURCE_API_UNAVAILABLE%' THEN 'SOURCE_UNAVAILABLE'
          WHEN evaluation.explanation->>'reviewSubReason' = 'IDENTITY_AMBIGUITY' THEN 'IDENTITY_AMBIGUOUS'
          WHEN evaluation.explanation->>'reviewSubReason' = 'AWAITING_LIFECYCLE_EVIDENCE' THEN 'ACTIVE_UNRESOLVED_OCCURRENCE'
          WHEN evaluation.explanation->>'reviewSubReason' IN ('EVIDENCE_CONFLICT','LIFECYCLE_CONFLICT') THEN 'LIFECYCLE_CONFLICT'
          WHEN evaluation.explanation->>'reviewSubReason' = 'MULTIPLE_CANDIDATES' THEN 'MULTIPLE_OCCURRENCE_CANDIDATES'
          WHEN evaluation.explanation->>'reviewSubReason' IN ('GENUINELY_AMBIGUOUS','EVIDENCE_EXHAUSTED') THEN 'OPERATIONAL_OUTCOME_UNKNOWN'
          ELSE 'OTHER'
        END AS blocker,
        COUNT(*)::int AS count
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1,2,3,4,5 ORDER BY count DESC`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE evaluation.failure_reasons::text ILIKE '%SOURCE_API_UNAVAILABLE%')::int AS source_api_unavailable,
        COUNT(*) FILTER (WHERE evaluation.technical_evidence->'monitoringLifecycle' IS NULL)::int AS missing_lifecycle,
        COUNT(*) FILTER (WHERE evaluation.source='Grafana' AND NULLIF(evaluation.technical_evidence->>'ruleUid','') IS NULL)::int AS missing_rule_uid,
        COUNT(*) FILTER (WHERE evaluation.source='Grafana' AND NULLIF(evaluation.technical_evidence->>'fingerprint','') IS NULL)::int AS missing_fingerprint,
        COUNT(*) FILTER (WHERE evaluation.failure_reasons::text ILIKE '%MULTIPLE%CANDIDATE%')::int AS multiple_occurrence_candidates,
        COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(evaluation.source_provenance,'[]'::jsonb))=0)::int AS missing_source_provenance,
        COUNT(*) FILTER (WHERE evaluation.observability->'evidenceFreshness'->>'status'='STALE')::int AS stale_evaluation,
        COUNT(*) FILTER (WHERE GREATEST(appd.updated_at,grafana.updated_at,nagios.updated_at) > evaluation.created_at)::int AS evidence_newer_than_evaluation
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      LEFT JOIN appdynamics_alert_occurrence_evidence appd ON appd.alert_id=alert.id
      LEFT JOIN grafana_alert_occurrence_evidence grafana ON grafana.alert_id=alert.id
      LEFT JOIN nagios_alert_occurrence_evidence nagios ON nagios.alert_id=alert.id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE evaluation.final_decision='NOISE'
          AND NOT COALESCE((evaluation.explanation->'noiseEvidence'->>'mustHavePositiveSignal')::boolean,false))::int AS noise_without_positive_evidence,
        COUNT(*) FILTER (WHERE evaluation.final_decision='INCIDENT'
          AND NOT COALESCE((evaluation.explanation->'qualityAudit'->>'incidentPositiveEvidence')::boolean,false))::int AS incident_without_strong_evidence,
        COUNT(*) FILTER (WHERE evaluation.explanation->>'invalidSourceUnavailablePromotion'='true')::int AS invalid_source_unavailable_promotion,
        COUNT(*) FILTER (WHERE evaluation.feature_snapshot->'episode'->>'episodeGroupingBasis'='TIME_ONLY')::int AS time_only_episode_grouping,
        COUNT(*) FILTER (WHERE GREATEST(appd.updated_at,grafana.updated_at,nagios.updated_at) > evaluation.created_at)::int AS stale_evaluation_count
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      LEFT JOIN appdynamics_alert_occurrence_evidence appd ON appd.alert_id=alert.id
      LEFT JOIN grafana_alert_occurrence_evidence grafana ON grafana.alert_id=alert.id
      LEFT JOIN nagios_alert_occurrence_evidence nagios ON nagios.alert_id=alert.id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'`),
      evaluationService.episodeDiagnostics().catch(() => null),
      humanVerificationService.summary(),
      slackCallbackInboxService.getStatus(),
    ]);
    const groupedBlockers = blockers.rows.filter((item) => item.blocker !== 'NOT_REVIEW').map((item) => ({
      ...item, count: number(item.count),
    }));
    return {
      generatedAt: new Date().toISOString(),
      reviewBlockers: groupedBlockers,
      reviewBlockerCounts: groupedBlockers.reduce((result, item) => {
        result[item.blocker] = number(result[item.blocker]) + item.count;
        return result;
      }, {}),
      episodeGrouping: episodes,
      evidence: Object.fromEntries(Object.entries(evidence.rows[0] || {}).map(([key, value]) => [key, number(value)])),
      decisionInvariants: Object.fromEntries(Object.entries(invariants.rows[0] || {}).map(([key, value]) => [key, number(value)])),
      humanVerification,
      slackCallbacks,
      readOnly: true,
      classifierRulesChanged: false,
      externalMutations: 0,
    };
  }

  async function daily() {
    await ensureSchema();
    const [summary, sources, noise, reviews, model, resolvedToday, openIncidents, importantAlerts, humanVerification] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE evaluation.final_decision='INCIDENT')::int AS incident,
        COUNT(*) FILTER (WHERE evaluation.final_decision='NOISE')::int AS noise,
        COUNT(*) FILTER (WHERE evaluation.final_decision='NEEDS_REVIEW')::int AS needs_review,
        COUNT(DISTINCT NULLIF(evaluation.feature_snapshot->'episode'->>'episodeId',''))::int AS episodes,
        COUNT(*) FILTER (WHERE evaluation.notification_role IN ('REDUNDANT','DUPLICATE'))::int AS redundant_notifications,
        COUNT(*) FILTER (WHERE evaluation.final_decision='NOISE'
          AND COALESCE((evaluation.explanation->'noiseEvidence'->>'mustHavePositiveSignal')::boolean,false))::int AS supported_noise,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision'='NEEDS_REVIEW' AND evaluation.final_decision='NOISE')::int AS review_to_noise,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision'='NEEDS_REVIEW' AND evaluation.final_decision='INCIDENT')::int AS review_to_incident,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision'='INCIDENT' AND evaluation.final_decision='NEEDS_REVIEW')::int AS incident_to_review,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision'='INCIDENT' AND evaluation.final_decision='NOISE')::int AS incident_to_noise,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision'='NOISE' AND evaluation.final_decision='NEEDS_REVIEW')::int AS noise_to_review,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision'='NOISE' AND evaluation.final_decision='INCIDENT')::int AS noise_to_incident,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'recovery'->>'recovered')::boolean,false))::int AS recovered,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.noise_detection->'detectors'->'AUTO_RESOLVED'->>'observed')::boolean,false))::int AS auto_resolved,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.noise_detection->'detectors'->'FLAPPING'->>'observed')::boolean,false))::int AS flapping,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.noise_detection->'detectors'->'INFORMATIONAL'->>'observed')::boolean,false))::int AS informational
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT evaluation.source, COUNT(*)::int AS alerts,
        COUNT(*) FILTER (WHERE evaluation.final_decision='INCIDENT')::int AS incident,
        COUNT(*) FILTER (WHERE evaluation.final_decision='NOISE')::int AS noise,
        COUNT(*) FILTER (WHERE evaluation.final_decision='NEEDS_REVIEW')::int AS review,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'coverage'->'evidenceCompleteness'->>'complete')::boolean,false))::int AS evidence_complete,
        COUNT(*) FILTER (WHERE evaluation.failure_reasons::text ILIKE '%SOURCE_API_UNAVAILABLE%')::int AS evidence_unavailable
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
      GROUP BY evaluation.source ORDER BY alerts DESC`),
      db.query(`SELECT COALESCE(NULLIF(evaluation.explanation->>'noiseType',''),
          NULLIF(evaluation.noise_detection->>'primary',''),'OTHER') AS type,
        COUNT(*)::int AS count
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
        AND evaluation.final_decision='NOISE'
      GROUP BY 1 ORDER BY count DESC`),
      db.query(`SELECT evaluation.source,
        COALESCE(NULLIF(evaluation.explanation->>'reviewSubReason',''),'OTHER') AS reason,
        COUNT(*)::int AS count
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
        AND evaluation.final_decision='NEEDS_REVIEW'
      GROUP BY 1,2 ORDER BY count DESC`),
      mlService.metrics(),
      db.query(`SELECT incident_key, summary, priority, status, resolution,
        closed_at, incident_created_at, assignee, root_cause_notes, comments,
        source_url, custom_fields
      FROM operations_incidents
      WHERE closed_at >= NOW() - INTERVAL '24 hours'
      ORDER BY closed_at DESC LIMIT 25`),
      db.query(`SELECT incident_key, summary, priority, status,
        incident_created_at, incident_updated_at, assignee, linked_alerts, source_url
      FROM operations_incidents
      WHERE closed_at IS NULL AND COALESCE(status_category,'') <> 'Done'
      ORDER BY incident_updated_at DESC NULLS LAST LIMIT 25`),
      db.query(`SELECT alert.id, alert.atlassian_ops_tiny_id, alert.title,
        evaluation.source, evaluation.final_decision,
        evaluation.feature_snapshot->'operationalPriority'->>'value' AS priority,
        evaluation.explanation->>'reviewSubReason' AS review_reason,
        evaluation.technical_evidence->'monitoringLifecycle'->'persistence'->>'durationSeconds' AS duration_seconds,
        evaluation.failure_reasons
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
        AND (evaluation.feature_snapshot->'operationalPriority'->>'value'='P1'
          OR evaluation.final_decision='INCIDENT'
          OR evaluation.explanation->>'reviewSubReason' IN ('EVIDENCE_CONFLICT','LIFECYCLE_CONFLICT')
          OR jsonb_array_length(COALESCE(evaluation.failure_reasons,'[]'::jsonb)) > 0)
      ORDER BY alert.received_at DESC LIMIT 25`),
      humanVerificationService.summary(),
    ]);
    const row = Object.fromEntries(Object.entries(summary.rows[0] || {}).map(([key, value]) => [key, number(value)]));
    return {
      generatedAt: new Date().toISOString(), window: 'LAST_24_HOURS',
      summary: row,
      sourceSummary: sources.rows.map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, key === 'source' ? value : number(value)]))),
      noiseBreakdown: noise.rows.map((item) => ({ type: item.type, count: number(item.count) })),
      reviewAttention: reviews.rows.map((item) => ({ source: item.source, reason: item.reason, count: number(item.count) })),
      resolvedToday: resolvedToday.rows.map((item) => ({
        incidentKey: item.incident_key, summary: item.summary, priority: item.priority,
        status: item.status, resolvedAt: iso(item.closed_at), createdAt: iso(item.incident_created_at),
        resolution: item.resolution, resolvedBy: item.assignee?.displayName || item.assignee?.emailAddress || null,
        howResolved: item.custom_fields?.howResolved || item.custom_fields?.resolutionAction || null,
        rootCause: Array.isArray(item.root_cause_notes) ? item.root_cause_notes[0] || null : null,
        sourceUrl: item.source_url,
      })),
      openIncidents: openIncidents.rows.map((item) => ({
        incidentKey: item.incident_key, summary: item.summary, priority: item.priority,
        status: item.status, createdAt: iso(item.incident_created_at), updatedAt: iso(item.incident_updated_at),
        owner: item.assignee?.displayName || item.assignee?.emailAddress || null,
        linkedAlertCount: Array.isArray(item.linked_alerts) ? item.linked_alerts.length : 0,
        sourceUrl: item.source_url,
      })),
      importantAlerts: importantAlerts.rows.map((item) => ({
        alertId: item.id, alertNumber: item.atlassian_ops_tiny_id, title: item.title,
        source: item.source, priority: item.priority, decision: item.final_decision,
        reviewReason: item.review_reason, durationSeconds: number(item.duration_seconds),
        evidenceFailures: item.failure_reasons || [],
      })),
      model: {
        status: model.status, shadowPredictions: model.shadowPredictions,
        deterministicAgreement: model.shadowPredictions - model.modelDeterministicDisagreements,
        deterministicDisagreement: model.modelDeterministicDisagreements,
        humanFeedbackReceived: model.modelHumanComparisons,
        newValidatedLabels: humanVerification.validatedToday,
      },
      humanVerification,
      reduction: {
        rawNotifications: row.total,
        episodes: row.episodes,
        redundantNotifications: row.redundant_notifications,
        supportedNoiseNotifications: row.supported_noise,
        percentageClaimed: false,
      },
      readOnly: true, externalMutations: 0,
    };
  }

  return { daily, diagnostics, monitoringSources };
}

module.exports = { createProductObservabilityService, service: createProductObservabilityService() };

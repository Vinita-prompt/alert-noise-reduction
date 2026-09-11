const HISTORY_WINDOW_DAYS = 90;
const SUFFICIENT_HISTORY_OCCURRENCES = 3;
const LIFECYCLE_SCHEMA_VERSION = 'monitoring-lifecycle-v1';

function text(value) {
  return String(value ?? '').trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(text).filter(Boolean))];
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function usableIdentity(value) {
  const candidate = text(value);
  if (!candidate || /^(unknown(?:[-_ ]?(?:service|application|entity))?|unassigned|none|null|n\/?a|not available)$/i.test(candidate)) return null;
  return candidate;
}

function ratio(numerator, denominator) {
  return Number(denominator) > 0 ? Number((Number(numerator || 0) / Number(denominator)).toFixed(6)) : null;
}

function normalizedState(value) {
  const state = text(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (!state) return 'UNKNOWN';
  if (/^(OK|UP|NORMAL|RESOLVED|RECOVERED|CANCELLED|ENDED|CLOSE|CLOSED|CLEAR|CLEARED|HEALTHY|INACTIVE)$/.test(state)
    || /(?:^|_)(RESOLVED|RECOVERED|CANCELLED|ENDED|CLOSE|CLOSED|NORMAL|CLEAR|CLEARED|HEALTHY)(?:_|$)/.test(state)) return 'RECOVERED';
  if (/^(CRITICAL|DOWN|FIRING|ALERTING|TRIGGER|TRIGGERED|OPEN|ACTIVE|PROBLEM|VIOLATION|ERROR|FAILED|FAILURE|WARNING|UNKNOWN)$/.test(state)
    || /(?:^|_)(CRITICAL|DOWN|FIRING|TRIGGERED|OPEN|ACTIVE|VIOLATION|ERROR|FAILED|FAILURE|PROBLEM|WARNING)(?:_|$)/.test(state)) return 'FIRING';
  return 'UNKNOWN';
}

function metricPoints(technicalEvidence = {}, records = []) {
  const direct = (technicalEvidence.metrics || []).map((item) => ({
    metric: item.metric || null,
    value: finite(item.value),
    unit: item.unit || null,
    timestamp: toIso(item.timestamp),
    evidenceId: item.evidenceId || null,
  }));
  const fromRecords = records.filter((item) => item.metadata?.metric && finite(item.metadata?.value) !== null).map((item) => ({
    metric: item.metadata.metric,
    value: finite(item.metadata.value),
    unit: item.metadata.unit || null,
    timestamp: toIso(item.timestamp),
    evidenceId: item.id || null,
  }));
  return [...direct, ...fromRecords]
    .filter((item) => item.metric && item.value !== null && item.timestamp)
    .filter((item, index, values) => values.findIndex((candidate) => (
      candidate.metric === item.metric && candidate.timestamp === item.timestamp && candidate.value === item.value
    )) === index)
    .sort((left, right) => (toMs(left.timestamp) || 0) - (toMs(right.timestamp) || 0));
}

function mean(values) {
  const numbers = values.map(finite).filter((value) => value !== null);
  return numbers.length ? Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(6)) : null;
}

function metricWindow(points, predicate) {
  const selected = points.filter((point) => predicate(toMs(point.timestamp))).slice(-120);
  if (!selected.length) return { available: false, metrics: [], start: null, end: null };
  const groups = selected.reduce((result, point) => {
    if (!result[point.metric]) result[point.metric] = [];
    result[point.metric].push(point);
    return result;
  }, {});
  return {
    available: true,
    metrics: Object.entries(groups).map(([metric, values]) => ({
      metric,
      unit: values.find((item) => item.unit)?.unit || null,
      average: mean(values.map((item) => item.value)),
      minimum: Math.min(...values.map((item) => item.value)),
      maximum: Math.max(...values.map((item) => item.value)),
      first: values[0]?.value ?? null,
      last: values.at(-1)?.value ?? null,
      points: values.length,
      evidenceIds: unique(values.map((item) => item.evidenceId)),
    })),
    start: selected[0]?.timestamp || null,
    end: selected.at(-1)?.timestamp || null,
  };
}

function stateTimeline(records = [], source) {
  const entries = [];
  const append = (state, timestamp, evidenceId, reason, metadata = {}) => {
    const normalized = normalizedState(state);
    const at = toIso(timestamp);
    if (normalized === 'UNKNOWN' || !at) return;
    entries.push({ state: normalized, sourceState: text(state), timestamp: at, evidenceId: evidenceId || null, reason, ...metadata });
  };
  for (const item of records) {
    const metadata = item.metadata || {};
    append(metadata.occurrenceState || metadata.state || metadata.status,
      metadata.occurrenceTimestamp || metadata.firedAt || metadata.stateObservedAt || item.timestamp,
      item.id, 'SOURCE_OCCURRENCE_STATE', {
        stateType: metadata.stateType || null,
        attempt: metadata.attempts ?? metadata.attempt ?? null,
        maxAttempts: metadata.maxAttempts ?? null,
        output: metadata.pluginOutput || null,
      });
    for (const [index, entry] of (metadata.stateHistory || []).entries()) append(
      entry.state || entry.status,
      entry.timestamp,
      item.id,
      `SOURCE_STATE_HISTORY_${index + 1}`,
      { stateType: entry.stateType || null, attempt: entry.attempt ?? null, output: entry.output || entry.pluginOutput || null },
    );
    for (const [index, entry] of (metadata.grafanaAlerting?.history || []).entries()) append(
      entry.state || entry.currentState || entry.status,
      entry.timestamp || entry.createdAt,
      item.id,
      `GRAFANA_STATE_HISTORY_${index + 1}`,
    );
    if (metadata.recovered === true || metadata.recoveryAt || metadata.recoveredAt) append(
      metadata.recoveryState || 'RECOVERED',
      metadata.recoveryAt || metadata.recoveredAt || item.timestamp,
      item.id,
      'SOURCE_RECOVERY',
    );
  }
  const sorted = entries.sort((left, right) => (toMs(left.timestamp) || 0) - (toMs(right.timestamp) || 0));
  return sorted.filter((entry, index) => index === 0 || entry.state !== sorted[index - 1].state
    || entry.timestamp !== sorted[index - 1].timestamp || entry.evidenceId !== sorted[index - 1].evidenceId)
    .map((entry) => ({ ...entry, source }));
}

function historicalProfileFromRow(row = {}, historyWindowDays = HISTORY_WINDOW_DAYS) {
  const occurrenceCount = Number(row.occurrence_count || 0);
  const lifecycleObservedCount = Number(row.lifecycle_observed_count || 0);
  const autoRecoveryCount = Number(row.auto_recovery_count || 0);
  const flappingCount = Number(row.flapping_count || 0);
  const incidentAssociationCount = Number(row.incident_association_count || 0);
  return {
    windowDays: historyWindowDays,
    historyStatus: occurrenceCount >= SUFFICIENT_HISTORY_OCCURRENCES ? 'SUFFICIENT_HISTORY' : 'INSUFFICIENT_HISTORY',
    matchMethod: row.match_method || null,
    occurrenceCount,
    medianDurationSeconds: finite(row.median_duration_seconds),
    p95DurationSeconds: finite(row.p95_duration_seconds),
    durationSampleCount: Number(row.duration_sample_count || 0),
    lifecycleObservedCount,
    autoRecoveryCount,
    autoRecoveryRate: ratio(autoRecoveryCount, lifecycleObservedCount),
    flappingCount,
    flappingRate: ratio(flappingCount, lifecycleObservedCount),
    incidentAssociationCount,
    incidentAssociationRate: ratio(incidentAssociationCount, occurrenceCount),
    recurrenceRatePerDay: occurrenceCount ? Number((occurrenceCount / historyWindowDays).toFixed(6)) : 0,
    severityDistribution: row.severity_distribution || {},
    previousAlertIds: row.previous_alert_ids || [],
    truncated: Boolean(row.truncated),
  };
}

async function loadHistoricalProfile(database, {
  alertId,
  source,
  historyWindowDays = HISTORY_WINDOW_DAYS,
  sourceIdentity = {},
  alertSignature = null,
}) {
  const identityEntity = usableIdentity(sourceIdentity.entity);
  const identityService = usableIdentity(sourceIdentity.service);
  const identityApplication = usableIdentity(sourceIdentity.application);
  const result = await database.query(`
    WITH target AS (
      SELECT alert.id, alert.received_at, alert.learning_alert_signature_v1,
        COALESCE(NULLIF($4, ''), alert.learning_alert_signature_v1) AS alert_signature,
        NULLIF($5, '') AS entity,
        NULLIF($6, '') AS service,
        NULLIF($7, '') AS application
      FROM alerts alert WHERE alert.id = $1
    ), historical_scope AS (
      SELECT historical.*
      FROM target
      JOIN alerts historical ON historical.id <> target.id
        AND historical.received_at >= target.received_at - ($3::int * INTERVAL '1 day')
        AND historical.received_at < target.received_at
      WHERE CASE
        WHEN LOWER(SPLIT_PART(COALESCE(historical.raw_payload->>'integrationName', historical.raw_payload->>'source', historical.source), '|', 1)) LIKE 'appd%' THEN 'AppDynamics'
        WHEN LOWER(SPLIT_PART(COALESCE(historical.raw_payload->>'integrationName', historical.raw_payload->>'source', historical.source), '|', 1)) LIKE 'grafana%' THEN 'Grafana'
        WHEN LOWER(SPLIT_PART(COALESCE(historical.raw_payload->>'integrationName', historical.raw_payload->>'source', historical.source), '|', 1)) LIKE 'nagios%' THEN 'Nagios'
        WHEN REPLACE(LOWER(SPLIT_PART(COALESCE(historical.raw_payload->>'integrationName', historical.raw_payload->>'source', historical.source), '|', 1)), ' ', '') LIKE 'thousandeyes%' THEN 'ThousandEyes'
        ELSE NULL END = $2
    ), historical_evaluation AS (
      SELECT DISTINCT ON (evaluation.alert_id) evaluation.alert_id,
        evaluation.feature_snapshot->'identity' AS identity,
        evaluation.noise_detection,
        evaluation.technical_evidence
      FROM live_shadow_evaluations evaluation
      JOIN historical_scope historical ON historical.id = evaluation.alert_id
      WHERE evaluation.decision_policy IN (
        'PHASE13_DECISION_QUALITY_SHADOW_V1',
        'PHASE14_MONITORING_LIFECYCLE_V1',
        'EPISODE_BASED_SHADOW_V3_PRIORITY_IS_EVIDENCE',
        'EPISODE_BASED_SHADOW_V2',
        'EPISODE_BASED_SHADOW_V1'
      )
      ORDER BY evaluation.alert_id,
        CASE evaluation.decision_policy
          WHEN 'EPISODE_BASED_SHADOW_V3_PRIORITY_IS_EVIDENCE' THEN 0
          WHEN 'EPISODE_BASED_SHADOW_V2' THEN 1
          WHEN 'EPISODE_BASED_SHADOW_V1' THEN 2
          WHEN 'PHASE14_MONITORING_LIFECYCLE_V1' THEN 3
          ELSE 4
        END,
        evaluation.created_at DESC
    ), candidates AS (
      SELECT historical.id, historical.received_at,
        GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(historical.last_seen_at, historical.received_at) - historical.received_at))) AS duration_seconds,
        historical.severity,
        CASE
          WHEN target.entity IS NOT NULL THEN 'EXACT_SOURCE_ENTITY'
          WHEN target.alert_signature IS NOT NULL THEN 'EXACT_ALERT_SIGNATURE'
          WHEN target.service IS NOT NULL THEN 'EXACT_SOURCE_SERVICE'
          WHEN target.application IS NOT NULL THEN 'EXACT_SOURCE_APPLICATION'
          ELSE NULL
        END AS match_method
      FROM target
      JOIN historical_scope historical ON true
      LEFT JOIN historical_evaluation evaluation ON evaluation.alert_id = historical.id
        AND CASE
          WHEN target.entity IS NOT NULL THEN LOWER(COALESCE(evaluation.identity->>'entity', '')) = LOWER(target.entity)
          WHEN target.alert_signature IS NOT NULL THEN historical.learning_alert_signature_v1 = target.alert_signature
          WHEN target.service IS NOT NULL THEN LOWER(COALESCE(evaluation.identity->>'service', '')) = LOWER(target.service)
          WHEN target.application IS NOT NULL THEN LOWER(COALESCE(evaluation.identity->>'application', '')) = LOWER(target.application)
          ELSE false
        END
      WHERE CASE
        WHEN target.entity IS NOT NULL THEN LOWER(COALESCE(evaluation.identity->>'entity', '')) = LOWER(target.entity)
        WHEN target.alert_signature IS NOT NULL THEN historical.learning_alert_signature_v1 = target.alert_signature
        WHEN target.service IS NOT NULL THEN LOWER(COALESCE(evaluation.identity->>'service', '')) = LOWER(target.service)
        WHEN target.application IS NOT NULL THEN LOWER(COALESCE(evaluation.identity->>'application', '')) = LOWER(target.application)
        ELSE false
      END
    ), annotated AS (
      SELECT candidate.*,
        CASE
          WHEN evaluation.technical_evidence->'monitoringLifecycle'->'recovery'->>'recovered' = 'true' THEN true
          WHEN COALESCE(evaluation.noise_detection->'observed', '[]'::jsonb) ? 'AUTO_RESOLVED' THEN true
          WHEN evaluation.alert_id IS NOT NULL THEN false
          ELSE NULL END AS auto_recovered,
        CASE
          WHEN evaluation.technical_evidence->'monitoringLifecycle'->'persistence'->>'flapping' = 'true' THEN true
          WHEN COALESCE(evaluation.noise_detection->'observed', '[]'::jsonb) ? 'FLAPPING' THEN true
          WHEN evaluation.alert_id IS NOT NULL THEN false
          ELSE NULL END AS flapping,
        EXISTS (
          SELECT 1 FROM alert_incident_mappings mapping
          JOIN operations_incidents incident ON incident.incident_key = mapping.jira_ticket_id
          WHERE mapping.alert_id = candidate.id
            AND mapping.mapping_reason = 'JSM Operations alert was linked to a stored Operations incident during enrichment.'
            AND incident.raw_payload->'fields'->'issuetype'->>'name' = '[System] Incident'
        ) OR EXISTS (
          SELECT 1 FROM incident_alert_reconciliations reconciliation
          WHERE reconciliation.alert_id = candidate.id AND reconciliation.current
            AND reconciliation.relationship_state = 'CONFIRMED_MATCH'
        ) AS incident_associated
      FROM candidates candidate
      LEFT JOIN historical_evaluation evaluation ON evaluation.alert_id = candidate.id
    ), severity_counts AS (
      SELECT COALESCE(NULLIF(severity, ''), 'Unknown') AS severity, COUNT(*)::int AS count
      FROM annotated GROUP BY 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM annotated) AS occurrence_count,
      (SELECT COUNT(duration_seconds)::int FROM annotated) AS duration_sample_count,
      (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds))::bigint FROM annotated) AS median_duration_seconds,
      (SELECT ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_seconds))::bigint FROM annotated) AS p95_duration_seconds,
      (SELECT COUNT(*)::int FROM annotated WHERE auto_recovered IS NOT NULL) AS lifecycle_observed_count,
      (SELECT COUNT(*)::int FROM annotated WHERE auto_recovered) AS auto_recovery_count,
      (SELECT COUNT(*)::int FROM annotated WHERE flapping) AS flapping_count,
      (SELECT COUNT(*)::int FROM annotated WHERE incident_associated) AS incident_association_count,
      (SELECT match_method FROM annotated LIMIT 1) AS match_method,
      COALESCE((SELECT JSONB_OBJECT_AGG(severity, count) FROM severity_counts), '{}'::jsonb) AS severity_distribution,
      COALESCE((SELECT JSONB_AGG(id ORDER BY received_at DESC) FROM (SELECT id, received_at FROM annotated ORDER BY received_at DESC LIMIT 100) sample), '[]'::jsonb) AS previous_alert_ids,
      (SELECT COUNT(*) > 100 FROM annotated) AS truncated
  `, [
    alertId,
    source,
    historyWindowDays,
    usableIdentity(alertSignature) || '',
    identityEntity || '',
    identityService || '',
    identityApplication || '',
  ]);
  return historicalProfileFromRow(result.rows[0] || {}, historyWindowDays);
}

function buildMonitoringLifecycle({ record, alert, source, blocks = [], technicalEvidence = {}, historicalProfile = {}, featureAsOf }) {
  const primary = blocks.find((block) => block.source === source);
  const records = primary?.evidence || [];
  const timeline = stateTimeline(records, source);
  const occurrenceStart = toIso(records.find((item) => item.metadata?.firedAt)?.metadata?.firedAt
    || records.find((item) => item.metadata?.occurrenceTimestamp)?.metadata?.occurrenceTimestamp
    || timeline.find((item) => item.state === 'FIRING')?.timestamp
    || alert?.createdAt || record?.temporalFeatures?.createdAt);
  const occurrenceStartMs = toMs(occurrenceStart);
  const recoveryEntry = timeline.find((item) => item.state === 'RECOVERED'
    && (occurrenceStartMs === null || (toMs(item.timestamp) || 0) >= occurrenceStartMs));
  const recoveredAt = recoveryEntry?.timestamp || toIso(records.find((item) => item.metadata?.recoveryAt || item.metadata?.recoveredAt)?.metadata?.recoveryAt
    || records.find((item) => item.metadata?.recoveredAt)?.metadata?.recoveredAt);
  const recoveredAtMs = toMs(recoveredAt);
  const explicitDuration = records.map((item) => finite(item.metadata?.durationSeconds ?? item.metadata?.persistenceSeconds))
    .find((value) => value !== null);
  const currentlyFiring = timeline.at(-1)?.state === 'FIRING';
  const durationSeconds = explicitDuration ?? (occurrenceStartMs !== null && recoveredAtMs !== null
    ? Math.max(0, Math.round((recoveredAtMs - occurrenceStartMs) / 1000))
    : occurrenceStartMs !== null && currentlyFiring && toMs(featureAsOf) !== null
      ? Math.max(0, Math.round((toMs(featureAsOf) - occurrenceStartMs) / 1000))
      : finite(record?.temporalFeatures?.durationSeconds));
  const transitions = timeline.slice(1).map((entry, index) => ({
    timestamp: entry.timestamp,
    from: timeline[index].state,
    to: entry.state,
    reason: entry.reason,
    stateType: entry.stateType || null,
    attempt: entry.attempt ?? null,
    output: entry.output || null,
    evidenceId: entry.evidenceId,
  })).filter((entry) => entry.from !== entry.to);
  const firingTransitions = timeline.filter((entry, index) => entry.state === 'FIRING'
    && (index === 0 || timeline[index - 1].state !== 'FIRING')).length;
  const recoveryTransitions = timeline.filter((entry, index) => entry.state === 'RECOVERED'
    && (index === 0 || timeline[index - 1].state !== 'RECOVERED')).length;
  const flapping = firingTransitions >= 2 && recoveryTransitions >= 2;
  const points = metricPoints(technicalEvidence, records);
  const before = metricWindow(points, (timestamp) => timestamp !== null && occurrenceStartMs !== null
    && timestamp >= occurrenceStartMs - 30 * 60 * 1000 && timestamp < occurrenceStartMs);
  const firingMetrics = metricWindow(points, (timestamp) => timestamp !== null && occurrenceStartMs !== null
    && timestamp >= occurrenceStartMs && (recoveredAtMs === null || timestamp <= recoveredAtMs));
  const after = metricWindow(points, (timestamp) => timestamp !== null && recoveredAtMs !== null
    && timestamp > recoveredAtMs && timestamp <= recoveredAtMs + 30 * 60 * 1000);
  const sourceAcknowledgements = records.filter((item) => item.metadata?.acknowledged === true);
  const slack = blocks.find((block) => block.source === 'Slack')?.evidence || [];
  const jira = blocks.find((block) => block.source === 'ACC Jira')?.evidence || [];
  const investigated = slack.filter((item) => item.metadata?.activityType === 'investigation'
    || item.metadata?.meaningfulAction === true).length > 0
    || jira.some((item) => Number(item.metadata?.commentsAvailable || 0) > 0 || Number(item.metadata?.worklogAvailable || 0) > 0);
  const remediated = slack.some((item) => item.metadata?.activityType === 'remediation')
    || jira.some((item) => item.metadata?.manualIntervention === true || Boolean(item.metadata?.howResolved || item.metadata?.resolution));
  const escalated = slack.some((item) => item.metadata?.activityType === 'escalation')
    || jira.some((item) => item.metadata?.escalated === true);
  const acknowledged = sourceAcknowledgements.length > 0 || slack.some((item) => /acknowledg/i.test(text([
    item.type, item.summary, item.metadata?.activityType,
  ].join(' '))));
  const meaningfulInterventionObserved = investigated || remediated || escalated;
  const recoveryWithoutIntervention = Boolean(recoveredAt) && !meaningfulInterventionObserved;
  const durationDeviation = durationSeconds !== null && historicalProfile.medianDurationSeconds !== null
    ? {
        currentSeconds: durationSeconds,
        medianSeconds: historicalProfile.medianDurationSeconds,
        p95Seconds: historicalProfile.p95DurationSeconds,
        ratioToMedian: historicalProfile.medianDurationSeconds > 0
          ? Number((durationSeconds / historicalProfile.medianDurationSeconds).toFixed(4)) : null,
        status: historicalProfile.p95DurationSeconds !== null && durationSeconds > historicalProfile.p95DurationSeconds
          ? 'ABOVE_HISTORICAL_P95' : durationSeconds <= historicalProfile.medianDurationSeconds
            ? 'AT_OR_BELOW_HISTORICAL_MEDIAN' : 'WITHIN_HISTORICAL_RANGE',
      }
    : null;
  const metricDeviation = before.available && firingMetrics.available ? firingMetrics.metrics.map((metric) => {
    const baseline = before.metrics.find((item) => item.metric === metric.metric);
    return {
      metric: metric.metric,
      baseline: baseline?.average ?? null,
      firing: metric.average,
      peak: metric.maximum,
      absoluteDelta: baseline ? Number((metric.average - baseline.average).toFixed(6)) : null,
      ratioToBaseline: baseline?.average ? Number((metric.average / baseline.average).toFixed(4)) : null,
    };
  }).filter((item) => item.baseline !== null) : [];
  const duplicateCandidate = Number(record?.correlationFeatures?.sameSignatureRecentCount || 0) > 0
    && Boolean(record?.sourceIdentity?.entity || record?.sourceIdentity?.service || record?.sourceIdentity?.application);
  const duplicateConfirmed = Boolean(record?.notificationRelationship?.duplicateOf);
  const correlationCandidate = Number(record?.correlationFeatures?.relatedAlertCount || 0) > 0;
  const correlationConfirmed = correlationCandidate && record?.correlationFeatures?.crossSourceActivity === true
    && (record?.observedBehavior?.correlated?.evidenceIds || []).length > 0;
  const signals = unique([
    recoveredAt ? 'AUTO_RESOLVED' : null,
    flapping ? 'FLAPPING' : null,
    duplicateCandidate ? 'DUPLICATE_CANDIDATE' : null,
    duplicateConfirmed ? 'DUPLICATE_CONFIRMED' : null,
    correlationCandidate ? 'CORRELATION_CANDIDATE' : null,
    correlationConfirmed ? 'CORRELATION_CONFIRMED' : null,
    currentlyFiring ? 'PERSISTENT' : null,
    recoveryWithoutIntervention ? 'RECOVERY_WITHOUT_INTERVENTION' : null,
    remediated ? 'INTERVENTION_OBSERVED' : null,
    durationDeviation?.status === 'ABOVE_HISTORICAL_P95' ? 'ABNORMAL_DURATION' : null,
    historicalProfile.historyStatus === 'SUFFICIENT_HISTORY' && recoveredAt
      && Number(historicalProfile.autoRecoveryRate || 0) > Number(historicalProfile.incidentAssociationRate || 0)
      ? 'HISTORICALLY_COMMON_TRANSIENT' : null,
    historicalProfile.historyStatus === 'SUFFICIENT_HISTORY' && historicalProfile.occurrenceCount <= SUFFICIENT_HISTORY_OCCURRENCES
      ? 'HISTORICALLY_RARE' : null,
  ]);
  const evidenceIds = unique(records.map((item) => item.id));
  const thresholds = technicalEvidence.thresholds || [];
  return {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    source,
    sourceAlertId: technicalEvidence.sourceAlertId || alert?.sourceAlertId || null,
    sourceEntityId: technicalEvidence.coverage?.sourceResolution?.sourceEntityId
      || record?.sourceIdentity?.entityId || null,
    identity: {
      entity: record?.sourceIdentity?.entity || alert?.canonicalEntity || null,
      entityId: record?.sourceIdentity?.entityId || null,
      application: record?.sourceIdentity?.application || alert?.application || null,
      applicationId: record?.sourceIdentity?.applicationId || alert?.sourceMetadata?.applicationId || null,
      service: record?.sourceIdentity?.service || alert?.service || null,
      environment: record?.sourceIdentity?.environment || alert?.environment || null,
    },
    occurrence: {
      startedAt: occurrenceStart,
      firstSeen: toIso(record?.temporalFeatures?.firstSeen),
      lastSeen: toIso(record?.temporalFeatures?.lastSeen),
      firingState: timeline.find((item) => item.state === 'FIRING')?.sourceState || null,
      severity: alert?.severity || record?.alert?.severity || null,
      triggerReason: records.find((item) => item.summary)?.summary || null,
    },
    before,
    firing: {
      state: timeline.find((item) => item.state === 'FIRING')?.sourceState || null,
      timestamp: occurrenceStart,
      metrics: firingMetrics.metrics,
      thresholds,
    },
    transitions,
    persistence: {
      durationSeconds,
      breachDurationSeconds: records.map((item) => finite(item.metadata?.timeAboveThresholdSeconds)).find((value) => value !== null) ?? null,
      maximumSeverity: alert?.severity || record?.alert?.severity || null,
      transitionCount: transitions.length,
      firingTransitionCount: firingTransitions,
      recoveryTransitionCount: recoveryTransitions,
      flapping,
      currentlyFiring,
    },
    recovery: {
      recovered: Boolean(recoveredAt),
      recoveredAt,
      durationSeconds,
      recoveryState: recoveryEntry?.sourceState || null,
      automaticallyRecovered: Boolean(recoveredAt) && !remediated,
    },
    after: {
      ...after,
      state: recoveryEntry?.sourceState || null,
      stabilizationTimeSeconds: after.available && recoveredAtMs !== null && toMs(after.end) !== null
        ? Math.max(0, Math.round((toMs(after.end) - recoveredAtMs) / 1000)) : null,
    },
    intervention: {
      acknowledged,
      acknowledgedAt: toIso(sourceAcknowledgements.find((item) => item.metadata?.acknowledgementAt)?.metadata?.acknowledgementAt
        || slack.find((item) => /acknowledg/i.test(text(item.type)))?.timestamp),
      investigated,
      remediated,
      escalated,
      operatorActionObserved: investigated || remediated || escalated,
      absenceOfMeaningfulIntervention: investigated || remediated || escalated
        ? null : 'NO_MEANINGFUL_INTERVENTION_OBSERVED_IN_AVAILABLE_OPERATIONAL_EVIDENCE',
      evidenceIds: unique([...sourceAcknowledgements, ...slack, ...jira].map((item) => item.id)),
    },
    historicalBehavior: historicalProfile,
    deviationFromHistory: {
      duration: durationDeviation,
      metric: metricDeviation,
      severity: null,
      recurrence: historicalProfile.occurrenceCount === undefined ? null : {
        priorOccurrences: historicalProfile.occurrenceCount,
        ratePerDay: historicalProfile.recurrenceRatePerDay,
      },
    },
    relationshipEvidence: {
      duplicateCandidate,
      duplicateConfirmed,
      duplicateOf: record?.notificationRelationship?.duplicateOf || null,
      correlationCandidate,
      correlationConfirmed,
    },
    signals,
    completeness: {
      lifecycleEvidenceAvailable: timeline.length > 0,
      historicalEvidenceAvailable: Number(historicalProfile.occurrenceCount || 0) > 0,
      interventionEvidenceAvailable: sourceAcknowledgements.length > 0 || slack.length > 0 || jira.length > 0,
      metricTimeSeriesAvailable: points.length > 0,
      stateHistoryAvailable: transitions.length > 0,
    },
    provenance: {
      generatedAt: toIso(featureAsOf),
      sourceEvidenceIds: evidenceIds,
      historicalAlertIds: historicalProfile.previousAlertIds || [],
      historyWindowDays: historicalProfile.windowDays || HISTORY_WINDOW_DAYS,
      historyStoredDataOnly: true,
      externalHistoricalCalls: 0,
      readOnly: true,
      predictionCreatesLabel: false,
    },
  };
}

module.exports = {
  HISTORY_WINDOW_DAYS,
  LIFECYCLE_SCHEMA_VERSION,
  SUFFICIENT_HISTORY_OCCURRENCES,
  buildMonitoringLifecycle,
  historicalProfileFromRow,
  loadHistoricalProfile,
  normalizedState,
  stateTimeline,
};

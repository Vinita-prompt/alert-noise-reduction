// Phase 7 unified evidence decision scaffold.
//
// This module is intentionally deterministic and transparent. It does not load
// an ML artifact, does not create a training label, and does not use a single
// score threshold as a substitute for reviewed ground truth. The recommendation
// is produced from independent semantic evidence gates and remains shadow-only.

const DECISION_POLICY_VERSION = 'EPISODE_BASED_SHADOW_V3_PRIORITY_IS_EVIDENCE';
const DECISION_CONFIDENCE = 'NOT_CALIBRATED';
const EVALUATION_STATUS = 'EXPERIMENTAL_SHADOW';
const STALE_OBSERVATION_MS = 5 * 24 * 60 * 60 * 1000;
const SHORT_LIVED_STATE_MS = 15 * 60 * 1000;
const SUSTAINED_STATE_MS = 30 * 60 * 1000;
const MONITORING_SOURCES = new Set(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);

function prioritySignal(value) {
  const priority = text(value).toUpperCase().replace(/\s+/g, '');
  if (priority === 'P1') return 'CRITICAL_OPERATIONAL_PRIORITY';
  if (priority === 'P2') return 'HIGH_OPERATIONAL_PRIORITY';
  if (priority === 'P3') return 'STANDARD_OPERATIONAL_PRIORITY';
  if (priority === 'P4' || priority === 'P5') return 'INFORMATIONAL_PRIORITY';
  return 'UNKNOWN';
}

function text(value) {
  return String(value ?? '').trim();
}

function clamp(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(Math.max(0, Math.min(1, Number(value))).toFixed(4));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(text).filter(Boolean))];
}

function combine(values) {
  const scores = (values || []).map(clamp).filter((value) => value !== null && value > 0);
  if (!scores.length) return 0;
  return clamp(1 - scores.reduce((product, value) => product * (1 - value), 1));
}

function average(values) {
  const scores = (values || []).map(clamp).filter((value) => value !== null);
  if (!scores.length) return null;
  return clamp(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

function dimension(score, reasons = [], evidenceIds = [], available = true) {
  return {
    score: available ? clamp(score) : null,
    available: Boolean(available),
    reasons: unique(reasons),
    evidenceIds: unique(evidenceIds),
  };
}

function monitoringBlocks(blocks = []) {
  return blocks.filter((block) => ['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes'].includes(block.source));
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function evidenceId(item) {
  return text(item?.id) || null;
}

function normalizedState(value) {
  const state = text(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (!state) return 'UNKNOWN';
  if (/^(OK|UP|NORMAL|RESOLVED|RECOVERED|CLOSED|CLOSE|CANCELLED|ENDED|CLEAR|CLEARED|HEALTHY|INACTIVE)$/.test(state)
    || /(?:^|_)(RESOLVED|RECOVERED|CLOSED|CLOSE|CANCELLED|ENDED|NORMAL|CLEAR|CLEARED)(?:_|$)/.test(state)) return 'RECOVERED';
  if (/^(CRITICAL|DOWN|FIRING|ALERTING|TRIGGER|TRIGGERED|OPEN|ACTIVE|PROBLEM|VIOLATION|ERROR|FAILED|FAILURE|WARNING)$/.test(state)
    || /(?:^|_)(CRITICAL|DOWN|FIRING|TRIGGERED|OPEN|ACTIVE|VIOLATION|ERROR|FAILED|FAILURE|PROBLEM)(?:_|$)/.test(state)) return 'ACTIVE';
  return 'UNKNOWN';
}

function lifecycleEntries(blocks = []) {
  const values = [];
  const append = (source, state, timestamp, id, reason) => {
    const normalized = normalizedState(state);
    if (normalized === 'UNKNOWN') return;
    values.push({ source, state: normalized, sourceState: text(state), timestamp: toIso(timestamp), evidenceId: id || null, reason: reason || null });
  };
  for (const block of monitoringBlocks(blocks)) {
    for (const item of block.evidence || []) {
      const metadata = item.metadata || {};
      append(block.source, metadata.occurrenceState || metadata.state || metadata.status,
        metadata.occurrenceTimestamp || metadata.firedAt || metadata.stateObservedAt || item.timestamp,
        evidenceId(item), 'SOURCE_OCCURRENCE_STATE');
      if (Array.isArray(metadata.stateHistory)) metadata.stateHistory.forEach((entry, index) => append(
        block.source, entry.state || entry.status, entry.timestamp, evidenceId(item), `SOURCE_STATE_HISTORY_${index + 1}`,
      ));
      if (Array.isArray(metadata.grafanaAlerting?.history)) metadata.grafanaAlerting.history.forEach((entry, index) => append(
        block.source, entry.state || entry.currentState || entry.status, entry.timestamp || entry.createdAt,
        evidenceId(item), `GRAFANA_STATE_HISTORY_${index + 1}`,
      ));
      if (metadata.recovered === true || metadata.recoveryAt || metadata.recoveredAt) append(
        block.source, metadata.recoveryState || 'RECOVERED', metadata.recoveryAt || metadata.recoveredAt || item.timestamp,
        evidenceId(item), 'SOURCE_RECOVERY',
      );
      // `currentState` is not universally the state of this alert occurrence.
      // AppDynamics, for example, can return application health beside an
      // exact policy violation. Source adapters must expose occurrence state
      // through state/status/history or an explicit recovery field above.
    }
  }
  return values.sort((left, right) => (toMs(left.timestamp) || 0) - (toMs(right.timestamp) || 0));
}

function lifecycleSummary(blocks = []) {
  const timeline = lifecycleEntries(blocks);
  const compact = timeline.filter((entry, index) => index === 0 || entry.state !== timeline[index - 1].state);
  const transitions = compact.slice(1).map((entry, index) => ({
    from: compact[index].state,
    to: entry.state,
    at: entry.timestamp,
    source: entry.source,
    evidenceId: entry.evidenceId,
  }));
  const active = timeline.filter((entry) => entry.state === 'ACTIVE');
  const recovered = timeline.filter((entry) => entry.state === 'RECOVERED');
  const currentBySource = Object.values(timeline.reduce((result, entry) => ({ ...result, [entry.source]: entry }), {}));
  const activeNow = currentBySource.filter((entry) => entry.state === 'ACTIVE');
  const recoveredNow = currentBySource.filter((entry) => entry.state === 'RECOVERED');
  const sequence = compact.map((entry) => entry.state);
  const stateDurations = compact.slice(0, -1).map((entry, index) => {
    const start = toMs(entry.timestamp);
    const end = toMs(compact[index + 1]?.timestamp);
    return {
      state: entry.state,
      startedAt: entry.timestamp,
      endedAt: compact[index + 1]?.timestamp || null,
      durationSeconds: start !== null && end !== null ? Math.max(0, Math.round((end - start) / 1000)) : null,
    };
  });
  const activeDurations = stateDurations.filter((item) => item.state === 'ACTIVE' && item.durationSeconds !== null);
  const firingTransitionCount = compact.filter((entry, index) => entry.state === 'ACTIVE'
    && (index === 0 || compact[index - 1]?.state !== 'ACTIVE')).length;
  const recoveryTransitionCount = compact.filter((entry, index) => entry.state === 'RECOVERED'
    && (index === 0 || compact[index - 1]?.state !== 'RECOVERED')).length;
  const flapping = firingTransitionCount >= 2 && recoveryTransitionCount >= 2;
  const durationValues = activeDurations.map((item) => item.durationSeconds);
  const observationStart = toMs(compact[0]?.timestamp);
  const observationEnd = toMs(compact.at(-1)?.timestamp);
  return {
    active,
    activeDurations,
    activeNow,
    averageActiveStateDurationSeconds: durationValues.length
      ? Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length) : null,
    compact,
    firingTransitionCount,
    firedAt: active.map((entry) => entry.timestamp).filter(Boolean)[0] || null,
    flapping,
    longestActiveStateDurationSeconds: durationValues.length ? Math.max(...durationValues) : null,
    observationWindowSeconds: observationStart !== null && observationEnd !== null
      ? Math.max(0, Math.round((observationEnd - observationStart) / 1000)) : null,
    recovered,
    recoveredAt: recovered.map((entry) => entry.timestamp).filter(Boolean).at(-1) || null,
    recoveredNow,
    recoveryTransitionCount,
    shortestActiveStateDurationSeconds: durationValues.length ? Math.min(...durationValues) : null,
    stateSequence: sequence,
    stateDurations,
    timeline,
    transitionCount: transitions.length,
    transitions,
  };
}

function blockSemantics(block) {
  const evidence = Array.isArray(block?.evidence) ? block.evidence : [];
  const state = (item) => normalizedState(item.metadata?.occurrenceState
    || item.metadata?.state || item.metadata?.status
    // AppDynamics `operationalState` can describe application/entity health,
    // not the exact policy occurrence. Do not let NORMAL mask a firing event.
    || (block.source === 'AppDynamics' ? null : item.metadata?.operationalState)
    || item.severity);
  const active = evidence.filter((item) => state(item) === 'ACTIVE');
  const recovered = evidence.filter((item) => state(item) === 'RECOVERED'
    || item.metadata?.recovered === true || item.metadata?.recoveryAt || item.metadata?.recoveredAt);
  const authoritative = active.filter((item) => item.metadata?.authoritative === true
    || (block.source === 'AppDynamics' && (item.metadata?.healthRule || item.metadata?.eventId || item.metadata?.violationId))
    || (block.source === 'Grafana' && item.metadata?.ruleUid)
    || (block.source === 'Nagios' && (item.metadata?.host || item.entity))
    || (block.source === 'ThousandEyes' && (item.metadata?.alertId || item.metadata?.testId)));
  return { active, authoritative, evidence, recovered };
}

function sourceDetails(blocks = []) {
  const details = {};
  for (const block of monitoringBlocks(blocks)) {
    const records = Array.isArray(block.evidence) ? block.evidence : [];
    if (!records.length) continue;
    const metadata = records.map((item) => item.metadata || {});
    const metricValue = (pattern) => {
      const matched = records.filter((item) => pattern.test(text(item.metadata?.metric || item.title))
        && item.metadata?.value !== null && item.metadata?.value !== undefined);
      return matched.length ? matched.at(-1).metadata.value : null;
    };
    const pick = (...names) => {
      for (const item of metadata) {
        for (const name of names) {
          if (item[name] !== null && item[name] !== undefined && item[name] !== '') return item[name];
        }
      }
      return null;
    };
    if (block.source === 'AppDynamics') details.AppDynamics = {
      application: pick('applicationName', 'applicationId'),
      applicationId: pick('applicationId'),
      tier: pick('tier'),
      node: pick('node'),
      businessTransaction: pick('businessTransaction'),
      healthRule: pick('healthRule'),
      violation: pick('violationId'),
      load: pick('load', 'callsPerMinute') ?? metricValue(/load|call|throughput|traffic/i),
      responseTime: pick('responseTime') ?? metricValue(/response|latency|duration/i),
      errorRate: pick('errorRate') ?? metricValue(/error|exception|failure/i),
      occurrenceState: pick('occurrenceState', 'state', 'status'),
      currentState: pick('currentState'),
      duration: pick('durationSeconds'),
      relatedEvents: records.filter((item) => /event|violation/i.test(item.type || '')).length,
      evidenceCount: records.length,
    };
    if (block.source === 'Grafana') details.Grafana = {
      alertRule: records.find((item) => item.type === 'alert_rule')?.title || null,
      ruleUid: pick('ruleUid'),
      dashboard: pick('dashboardUid'),
      panel: pick('panelId'),
      state: pick('state', 'status'),
      labels: pick('labels'),
      annotations: pick('annotations'),
      value: pick('value'),
      threshold: pick('threshold'),
      firingDuration: pick('durationSeconds'),
      evaluationResult: pick('evaluationResult'),
      evidenceCount: records.length,
    };
    if (block.source === 'Nagios') details.Nagios = {
      host: pick('host'),
      service: pick('service'),
      state: pick('state', 'status'),
      stateType: pick('stateType'),
      pluginOutput: pick('pluginOutput', 'output'),
      checkAttempts: pick('attempts'),
      lastStateChange: pick('lastStateChange'),
      acknowledgement: pick('acknowledgement', 'acknowledged'),
      notificationState: pick('notificationState'),
      duration: pick('durationSeconds'),
      evidenceCount: records.length,
    };
    if (block.source === 'ThousandEyes') details.ThousandEyes = {
      test: records.find((item) => item.metadata?.testId)?.entity || null,
      testId: pick('testId'),
      alert: records.find((item) => item.metadata?.alertId)?.title || null,
      alertId: pick('alertId'),
      ruleId: pick('ruleId'),
      state: pick('state', 'status'),
      latency: pick('latency', 'roundTripTime') ?? metricValue(/latency|round.?trip/i),
      packetLoss: pick('packetLoss') ?? metricValue(/packet.?loss/i),
      availability: pick('availability') ?? metricValue(/availability/i),
      affectedAgents: unique(metadata.flatMap((item) => item.agentIds || [])),
      locations: unique(metadata.flatMap((item) => item.locations || [])),
      duration: pick('durationSeconds'),
      failureReason: pick('failureReason'),
      evidenceCount: records.length,
    };
  }
  return details;
}

function buildFacts({ record, blocks = [], technicalEvidence = {}, source }) {
  const jira = blocks.find((block) => block.source === 'ACC Jira');
  const slack = blocks.find((block) => block.source === 'Slack');
  const monitoring = monitoringBlocks(blocks);
  const primary = monitoring.find((block) => block.source === source) || null;
  const lifecycle = lifecycleSummary(blocks);
  const monitoringLifecycle = technicalEvidence.monitoringLifecycle || null;
  const episode = record.episodeContext || technicalEvidence.episode || null;
  const monitoringSemantics = monitoring.map((block) => ({ source: block.source, ...blockSemantics(block) }));
  const activeSources = monitoringSemantics.filter((item) => item.active.length).map((item) => item.source);
  const authoritativeActiveSources = monitoringSemantics.filter((item) => item.authoritative.length).map((item) => item.source);
  const recoveredSources = monitoringSemantics.filter((item) => item.recovered.length).map((item) => item.source);
  const sameTimestampLifecycleConflict = lifecycle.timeline.some((entry) => lifecycle.timeline.some((candidate) => (
    candidate.source === entry.source && candidate.timestamp && candidate.timestamp === entry.timestamp
      && candidate.state !== entry.state
  )));
  const lifecycleConflict = sameTimestampLifecycleConflict || Boolean(
    monitoringLifecycle?.persistence?.currentlyFiring === true
      && monitoringLifecycle?.recovery?.recovered === true
  );
  const confirmedJiraEvidence = (jira?.relationships || []).filter((item) => item.relationship === 'confirmed');
  const candidateJiraEvidence = (jira?.relationships || []).filter((item) => item.relationship === 'candidate');
  const jiraEvidence = Array.isArray(jira?.evidence) ? jira.evidence : [];
  const irmIncidentEvidence = monitoring.flatMap((block) => block.evidence || []).filter((item) => (
    /grafana.*irm.*incident|irm_incident/i.test(text(item.type))
    || Array.isArray(item.metadata?.grafanaIrm?.incidents) && item.metadata.grafanaIrm.incidents.length > 0
  ));
  const slackEvidence = Array.isArray(slack?.evidence) ? slack.evidence : [];
  const meaningfulSlackActions = slackEvidence.filter((item) => item.metadata?.meaningfulAction === true);
  const humanSlackActivity = slackEvidence.filter((item) => item.metadata?.actorType === 'HUMAN');
  const humanOperationalActivity = humanSlackActivity.filter((item) => (
    ['remediation', 'investigation', 'escalation'].includes(item.metadata?.activityType)
  ));
  const jiraOperationalActivity = jiraEvidence.filter((item) => {
    const metadata = item.metadata || {};
    return metadata.meaningfulAction === true || metadata.manualIntervention === true
      || Boolean(metadata.howResolved || metadata.resolution || metadata.resolvedAt)
      || Number(metadata.commentsAvailable || 0) > 0
      || Number(metadata.changelogAvailable || 0) > 0
      || Number(metadata.worklogAvailable || 0) > 0;
  });
  const primaryStatus = technicalEvidence.provenance?.primaryStatus || primary?.status || 'not_applicable';
  const coverage = technicalEvidence.coverage || {};
  const evaluable = coverage.evaluability?.evaluable === true
    || (!coverage.evaluability && primaryStatus === 'working' && Number(primary?.evidence?.length || 0) > 0);
  const sourceUnavailable = ['error', 'not_applicable'].includes(primaryStatus)
    || primary?.pipelineState === 'QUERY_FAILED' || !evaluable;
  const currentAlertStatus = text(record.alert?.status).toUpperCase();
  const operationsOpen = /OPEN|ACTIVE|ACKNOWLEDGED|TRIGGERED/.test(currentAlertStatus);
  const allEvidence = blocks.flatMap((block) => block.evidence || []);
  const maintenanceEvidenceItems = allEvidence.filter((item) => (
    item.metadata?.maintenanceNotification?.deterministic === true
      && item.metadata.maintenanceNotification.identityValid === true
  ));
  const maintenanceProfile = maintenanceEvidenceItems[0]?.metadata?.maintenanceNotification || null;
  const maintenanceNotification = maintenanceProfile ? {
    ...maintenanceProfile,
    episodeId: episode?.episodeId || maintenanceProfile.episodeId || null,
    evidenceIds: unique(maintenanceEvidenceItems.map(evidenceId)),
    sourceProvenance: unique(maintenanceEvidenceItems.flatMap((item) => (
      item.metadata?.maintenanceNotification?.sourceProvenance || [item.source]
    ))),
  } : null;
  const explicitExpectedActivity = allEvidence.filter((item) => {
    const metadata = item.metadata || {};
    return metadata.expectedActivity === true || metadata.plannedActivity === true
      || Boolean(metadata.maintenanceWindow || metadata.changeId || metadata.deploymentId || metadata.scheduledJob)
      || /^(MAINTENANCE|DEPLOYMENT|PLANNED_RESTART|SCHEDULED_JOB|CHANGE_ACTIVITY)$/i.test(text(metadata.operationalContext));
  });
  const explicitDuplicateEvidence = allEvidence.filter((item) => Boolean(
    item.metadata?.duplicateOfAlertId || item.metadata?.duplicateOf || item.metadata?.sameCanonicalAlertId
      || /duplicate_notification|duplicate_alert/i.test(text(item.type)),
  ));
  const explicitNonActionableEvidence = allEvidence.filter((item) => item.metadata?.nonActionable === true
    || item.metadata?.actionability === 'NON_ACTIONABLE');
  const correlation = record.correlationFeatures || {};
  const identity = record.sourceIdentity || {};
  const exactHistoricalDuplicate = record.observedBehavior?.duplicate?.state === 'OBSERVED'
    && (record.observedBehavior.duplicate?.evidenceIds || []).length > 0
    && Boolean(identity.entityId || identity.entity)
    && Number(correlation.sameSignatureRecentCount || correlation.relatedAlertCount || 0) > 0;
  const boundedCrossSource = correlation.crossSourceActivity === true
    && Number(correlation.relatedAlertCount || 0) > 0
    && (correlation.relatedSources || []).length > 0;
  const monitoringSearched = !MONITORING_SOURCES.has(source) || Boolean(primary);
  const jiraSearched = Boolean(jira) || Object.prototype.hasOwnProperty.call(record, 'jiraIncident');
  const slackSearched = Boolean(slack) || Object.prototype.hasOwnProperty.call(record, 'slackFeatures');
  const historicalSearched = Boolean(record.historicalFeatures && typeof record.historicalFeatures === 'object');
  const crossSourceSearched = Boolean(record.correlationFeatures && typeof record.correlationFeatures === 'object');
  const previousOutcomesSearched = historicalSearched
    && Object.prototype.hasOwnProperty.call(record.historicalFeatures, 'previousConfirmedIncidentCount')
    && Object.prototype.hasOwnProperty.call(record.historicalFeatures, 'previousConfirmedNoiseCount');
  const evidenceSearches = [
    { system: 'JSM Operations', searched: Boolean(record.alert), status: record.alert ? 'AVAILABLE' : 'MISSING' },
    { system: source || 'Monitoring source', searched: monitoringSearched,
      status: primaryStatus === 'working' ? 'SEARCHED' : primaryStatus.toUpperCase() },
    { system: 'ACC Jira', searched: jiraSearched, status: jira?.status || (jiraSearched ? 'STORED_CONTEXT_SEARCHED' : 'NOT_SEARCHED') },
    { system: 'Slack', searched: slackSearched, status: slack?.status || (slackSearched ? 'STORED_CONTEXT_SEARCHED' : 'NOT_SEARCHED') },
    { system: 'Historical occurrences', searched: historicalSearched, status: historicalSearched ? 'SEARCHED' : 'NOT_SEARCHED' },
    { system: 'Cross-source alerts', searched: crossSourceSearched, status: crossSourceSearched ? 'SEARCHED' : 'NOT_SEARCHED' },
    { system: 'Previous confirmed human outcomes', searched: previousOutcomesSearched,
      status: previousOutcomesSearched ? 'SEARCHED' : 'NOT_SEARCHED' },
  ];
  return {
    activeSources,
    allEvidence,
    authoritativeActiveSources,
    boundedCrossSource,
    candidateJiraEvidence,
    confirmedJiraEvidence,
    currentAlertStatus,
    evaluable,
    exactHistoricalDuplicate,
    explicitDuplicateEvidence,
    explicitExpectedActivity,
    explicitNonActionableEvidence,
    evidenceExhausted: evidenceSearches.every((item) => item.searched),
    evidenceSearches,
    humanSlackActivity,
    humanOperationalActivity,
    irmIncidentEvidence,
    jiraEvidence,
    jiraOperationalActivity,
    lifecycle,
    lifecycleConflict,
    episode,
    monitoringLifecycle,
    maintenanceNotification,
    maintenanceEvidenceItems,
    meaningfulSlackActions,
    monitoring,
    operationsOpen,
    primary,
    primaryStatus,
    recoveredSources,
    source,
    sourceUnavailable,
    notificationRelationship: record.notificationRelationship || null,
    sourceEvidenceCount: monitoring.reduce((sum, block) => sum + Number(block.evidence?.length || 0), 0),
    jiraEvidenceCount: jiraEvidence.length,
    slackEvidenceCount: slackEvidence.length,
  };
}

function observation(observed, reason, evidenceIds = [], details = {}) {
  return {
    observed: Boolean(observed),
    reason,
    evidenceIds: unique(evidenceIds),
    ...details,
  };
}

function authoritativeRecoveryProfile(facts) {
  const lifecycle = facts.lifecycle || {};
  const monitoringLifecycle = facts.monitoringLifecycle || {};
  const source = facts.source;
  const sourceActiveEvidence = (lifecycle.active || []).filter((item) => (
    item.source === source && item.evidenceId
  ));
  const currentSourceRecovery = (lifecycle.recoveredNow || []).find((item) => (
    item.source === source && item.evidenceId
  )) || null;
  const contractEvidenceIds = unique(monitoringLifecycle.provenance?.sourceEvidenceIds || []);
  const contractRecovery = monitoringLifecycle.recovery?.recovered === true
    && Boolean(toIso(monitoringLifecycle.recovery?.recoveredAt))
    && contractEvidenceIds.length > 0;
  const currentlyFiring = monitoringLifecycle.persistence?.currentlyFiring === true
    || (lifecycle.activeNow || []).some((item) => item.source === source);
  const sourceLifecycleRecovery = sourceActiveEvidence.length > 0 && Boolean(currentSourceRecovery);
  const recovered = !facts.lifecycleConflict && !currentlyFiring
    && (sourceLifecycleRecovery || contractRecovery);
  const evidenceIds = unique([
    ...sourceActiveEvidence.map((item) => item.evidenceId),
    currentSourceRecovery?.evidenceId,
    ...(contractRecovery ? contractEvidenceIds : []),
  ]);
  return {
    recovered,
    currentlyFiring,
    sourceLifecycleRecovery,
    contractRecovery,
    recoveredAt: recovered
      ? monitoringLifecycle.recovery?.recoveredAt || currentSourceRecovery?.timestamp || lifecycle.recoveredAt
      : null,
    evidenceIds,
  };
}

function exactStructuredEpisodeIdentity(episode = {}) {
  return ['AUTHORITATIVE_SOURCE_IDENTITY', 'STRUCTURED_SOURCE_IDENTITY']
    .includes(text(episode.fingerprintStrength).toUpperCase());
}

function operationalNonActionabilityProfile({ record, facts }) {
  const episode = facts.episode || {};
  const lifecycle = facts.monitoringLifecycle || {};
  // A maintenance notification is evaluated from its current exact JSM/Slack
  // evidence. Do not carry a stale, previously derived episode intervention
  // flag forward; any real current action still appears in lifecycle, Slack, or
  // Jira evidence below.
  const episodeIntervention = facts.maintenanceNotification?.identityValid === true
    ? {} : episode.intervention || {};
  const intervention = lifecycle.intervention || {};
  const status = text(record.alert?.status).toUpperCase();
  const sourceKnown = MONITORING_SOURCES.has(facts.source);
  const alertId = usableFallbackIdentity(record.alert?.alertId || record.alert?.canonicalAlertId
    || record.alert?.sourceAlertId);
  const identityAvailable = Boolean(
    episode.fingerprintHash && episode.fingerprintStrength !== 'AMBIGUOUS'
  ) || Boolean(
    usableFallbackIdentity(record.sourceIdentity?.entityId)
    || usableFallbackIdentity(record.sourceIdentity?.entity)
    || usableFallbackIdentity(record.sourceIdentity?.application)
    || usableFallbackIdentity(record.sourceIdentity?.service)
  );
  const operationalIdentityValid = Boolean(record.alert && alertId && status && sourceKnown && identityAvailable);
  const investigated = intervention.investigated === true || episodeIntervention.investigated === true
    || facts.humanOperationalActivity.some((item) => item.metadata?.activityType === 'investigation');
  const remediated = intervention.remediated === true || episodeIntervention.remediated === true
    || facts.humanOperationalActivity.some((item) => item.metadata?.activityType === 'remediation');
  const escalated = intervention.escalated === true || episodeIntervention.escalated === true
    || facts.humanOperationalActivity.some((item) => item.metadata?.activityType === 'escalation');
  const confirmedJiraIncident = facts.confirmedJiraEvidence.length > 0 || facts.irmIncidentEvidence.length > 0
    || episode.relationships?.jiraIncident === true;
  const authoritativeRecovery = authoritativeRecoveryProfile(facts);
  const authoritativeCurrentlyFiring = authoritativeRecovery.currentlyFiring;
  const acceptedAuthoritativeRecovery = authoritativeRecovery.recovered;
  const sourceLifecycleUnknownOrUnavailable = facts.sourceUnavailable
    || (!authoritativeCurrentlyFiring && !acceptedAuthoritativeRecovery);
  const contradictoryStrongIncidentEvidence = confirmedJiraIncident || escalated || (investigated && remediated);
  const currentEpisodeClosureContext = operationalIdentityValid
    && status === 'CLOSED'
    && sourceLifecycleUnknownOrUnavailable
    && !acceptedAuthoritativeRecovery
    && !facts.lifecycleConflict
    && !investigated
    && !remediated
    && !escalated
    && !confirmedJiraIncident
    && !authoritativeCurrentlyFiring
    && !contradictoryStrongIncidentEvidence;
  const history = episode.historicalBehavior || {};
  const historicalPolicy = history.strongOperationalNonActionability || {};
  const historicalEpisodeCount = Number(history.operationalHandling?.totalEpisodeCount
    ?? history.episodeCount ?? 0);
  const minimumHistoricalEpisodes = Number(historicalPolicy.threshold?.minimumExactPriorEpisodes ?? 5);
  const exactHistoricalIdentity = Boolean(episode.fingerprintHash) && exactStructuredEpisodeIdentity(episode);
  const strongHistoricalSupport = historicalPolicy.supported === true
    && historicalEpisodeCount >= minimumHistoricalEpisodes
    && exactHistoricalIdentity;
  const strongHistoricalCandidate = currentEpisodeClosureContext && strongHistoricalSupport;
  return {
    currentEpisodeCandidate: false,
    currentEpisodeCandidateDisabled: true,
    currentEpisodeClosureContext,
    strongHistoricalCandidate,
    operationalIdentityValid,
    exactHistoricalIdentity,
    jsmClosed: status === 'CLOSED',
    sourceLifecycleUnknownOrUnavailable,
    authoritativeCurrentlyFiring,
    acceptedAuthoritativeRecovery,
    lifecycleConflict: facts.lifecycleConflict,
    investigated,
    remediated,
    escalated,
    confirmedJiraIncident,
    contradictoryStrongIncidentEvidence,
    acknowledgementIsMeaningfulIncidentHandling: false,
    historicalOperationalHandling: history.operationalHandling || null,
    strongHistoricalSupport,
    historicalEpisodeCount,
    historicalSupportPolicy: historicalPolicy,
    authoritativeRecoveryEvidenceIds: authoritativeRecovery.evidenceIds,
  };
}

function interpretNoiseDetection({ record, facts, featureAsOf }) {
  const lifecycle = facts.lifecycle;
  const monitoringLifecycle = facts.monitoringLifecycle || {};
  const episodeRole = facts.episode?.notificationRole?.role || null;
  const duplicateIds = unique([
    ...facts.explicitDuplicateEvidence.map(evidenceId),
    ...(record.observedBehavior?.duplicate?.evidenceIds || []),
    ...(facts.notificationRelationship?.evidenceIds || []),
    ...(facts.episode?.alertIds || []).map((id) => `episode-member:${id}`),
  ]);
  const duplicate = episodeRole === 'DUPLICATE' || Boolean(monitoringLifecycle.relationshipEvidence?.duplicateConfirmed)
    || Boolean(facts.notificationRelationship?.duplicateOf)
    || facts.explicitDuplicateEvidence.length > 0 || facts.exactHistoricalDuplicate;
  const duplicateCandidate = Boolean(monitoringLifecycle.relationshipEvidence?.duplicateCandidate);
  const monitoringFlappingEvidence = monitoringLifecycle.persistence?.flapping === true
    && (monitoringLifecycle.provenance?.sourceEvidenceIds || []).length > 0;
  const flapping = lifecycle.flapping || monitoringFlappingEvidence;
  const interventionObservable = facts.slackEvidenceCount > 0 || facts.jiraEvidenceCount > 0;
  const manualIntervention = monitoringLifecycle.intervention?.remediated === true
    || facts.meaningfulSlackActions.length > 0
    || facts.jiraEvidence.some((item) => item.metadata?.meaningfulAction === true || item.metadata?.manualIntervention === true);
  const authoritativeRecovery = authoritativeRecoveryProfile(facts);
  const autoResolved = authoritativeRecovery.recovered && !manualIntervention;
  const expectedActivity = facts.explicitExpectedActivity.length > 0
    || (record.observedBehavior?.expectedActivity?.state === 'OBSERVED'
      && (record.observedBehavior.expectedActivity.evidenceIds || []).length > 0);
  const explicitNonActionable = facts.explicitNonActionableEvidence.length > 0 || expectedActivity;
  const preservedStructuredCorrelation = record.observedBehavior?.correlated?.state === 'OBSERVED'
    && (record.observedBehavior.correlated.evidenceIds || []).length > 0
    && Number(record.correlationFeatures?.relatedAlertCount || 0) > 0
    && Boolean(record.sourceIdentity?.entityId || record.sourceIdentity?.entity
      || record.sourceIdentity?.service || record.sourceIdentity?.application);
  const correlated = episodeRole === 'CORRELATED' || facts.boundedCrossSource || preservedStructuredCorrelation || (
    Number(record.correlationFeatures?.relatedAlertCount || 0) > 0
    && (record.correlationFeatures?.relatedSources || []).length > 1
    && Boolean(record.sourceIdentity?.entityId || record.sourceIdentity?.entity
      || record.sourceIdentity?.service || record.sourceIdentity?.application)
  );
  const recoveredAtMs = toMs(lifecycle.recoveredAt);
  const evaluatedAtMs = toMs(featureAsOf);
  const staleDurationMs = recoveredAtMs !== null && evaluatedAtMs !== null
    ? Math.max(0, evaluatedAtMs - recoveredAtMs) : null;
  const stale = facts.operationsOpen && lifecycle.recoveredNow.length > 0
    && staleDurationMs !== null && staleDurationMs >= STALE_OBSERVATION_MS;
  const operationalNonActionability = operationalNonActionabilityProfile({ record, facts });
  const detectors = {
    DUPLICATE: observation(duplicate, duplicate
      ? 'Exact source identity, alert signature/event evidence, and a bounded earlier representative support duplicate notification behavior.'
      : 'No exact source-event or structured duplicate relationship is present; text similarity alone was not used.', duplicateIds, {
      role: duplicate ? 'DUPLICATE' : 'PRIMARY',
      primaryAlertId: facts.notificationRelationship?.primaryAlertId || null,
      duplicateOf: facts.notificationRelationship?.duplicateOf || null,
      duplicateGroupId: facts.notificationRelationship?.duplicateGroupId || null,
      candidateObserved: duplicateCandidate,
      confirmationRequired: duplicateCandidate && !duplicate,
      stage: duplicate ? 'DUPLICATE_CONFIRMED' : duplicateCandidate ? 'DUPLICATE_CANDIDATE' : 'NOT_OBSERVED',
    }),
    REPEAT: observation(episodeRole === 'REPEAT', episodeRole === 'REPEAT'
      ? 'Episode identity and bounded timing show that this is a later notification for the same unresolved underlying event.'
      : 'The notification is not a later member of an exact-identity active episode.',
    unique([
      ...(facts.episode?.alertIds || []).map((id) => `episode-member:${id}`),
      facts.episode?.episodeId ? `episode:${facts.episode.episodeId}` : null,
      facts.episode?.notificationRole?.primaryAlertId
        ? `episode-primary:${facts.episode.notificationRole.primaryAlertId}` : null,
      record.alert?.alertId ? `operations-alert:${record.alert.alertId}` : null,
    ]), {
      episodeId: facts.episode?.episodeId || null,
      primaryAlertId: facts.episode?.notificationRole?.primaryAlertId || null,
      notificationCount: facts.episode?.notificationCount || 1,
      addsOperationalInformation: facts.episode?.notificationRole?.addsOperationalInformation === true,
    }),
    FLAPPING: observation(flapping, flapping
      ? `${lifecycle.firingTransitionCount} firing and ${lifecycle.recoveryTransitionCount} recovery observations establish repeated source-supported state changes.`
      : 'The authoritative lifecycle does not contain at least two firing and two recovery observations; repeated text alone was not used.',
    unique([
      ...lifecycle.timeline.map((item) => item.evidenceId),
      ...(monitoringLifecycle.provenance?.sourceEvidenceIds || []),
    ]), {
      firingTransitionCount: lifecycle.firingTransitionCount,
      recoveryTransitionCount: lifecycle.recoveryTransitionCount,
      transitionCount: lifecycle.transitionCount,
      totalObservationWindowSeconds: lifecycle.observationWindowSeconds,
      averageStateDurationSeconds: lifecycle.averageActiveStateDurationSeconds,
      shortestStateDurationSeconds: lifecycle.shortestActiveStateDurationSeconds,
      longestStateDurationSeconds: lifecycle.longestActiveStateDurationSeconds,
      repeatedNotificationCount: Number(record.behaviorFeatures?.occurrenceCount || 0),
      transitionTimestamps: lifecycle.transitions.map((item) => item.at).filter(Boolean),
      flappingWindow: lifecycle.compact.length > 1 ? {
        from: lifecycle.compact[0].timestamp,
        to: lifecycle.compact.at(-1).timestamp,
      } : null,
      stateSequence: lifecycle.stateSequence,
      monitoringStateSequence: monitoringLifecycle.transitions || [],
    }),
    AUTO_RESOLVED: observation(autoResolved, autoResolved
      ? 'The authoritative source shows firing and recovery. NO_MEANINGFUL_INTERVENTION_OBSERVED_IN_AVAILABLE_OPERATIONAL_EVIDENCE.'
      : 'A complete source firing-to-recovery lifecycle without observed manual remediation is not established.',
    authoritativeRecovery.evidenceIds, {
      firedAt: monitoringLifecycle.occurrence?.startedAt || lifecycle.firedAt,
      resolvedAt: authoritativeRecovery.recoveredAt,
      activeDurationSeconds: monitoringLifecycle.persistence?.durationSeconds
        ?? (lifecycle.activeDurations.length === 1 ? lifecycle.activeDurations[0].durationSeconds : null),
      longestActiveStateDurationSeconds: lifecycle.longestActiveStateDurationSeconds,
      manualInterventionObserved: manualIntervention,
      interventionEvidenceAvailable: interventionObservable,
      currentSourceRecovered: authoritativeRecovery.recovered,
      authoritativeSameOccurrenceRecovery: authoritativeRecovery.recovered,
      authoritativeCurrentlyFiring: authoritativeRecovery.currentlyFiring,
      recoveryWithoutIntervention: monitoringLifecycle.signals?.includes('RECOVERY_WITHOUT_INTERVENTION') || false,
      historicalBehavior: monitoringLifecycle.historicalBehavior || null,
    }),
    OPERATIONALLY_NON_ACTIONABLE: observation(operationalNonActionability.strongHistoricalCandidate,
      operationalNonActionability.strongHistoricalCandidate
        ? 'At least five prior exact structured-identity episodes establish a strong closed-without-meaningful-action pattern, with no investigation, remediation, escalation, or Jira Incident association.'
        : 'Current closure and absent handling are not positive Noise evidence; strong exact structured-identity history is required.',
    unique([
      operationalNonActionability.strongHistoricalCandidate && record.alert?.alertId
        ? `operations-alert:${record.alert.alertId}` : null,
      operationalNonActionability.strongHistoricalCandidate && facts.episode?.fingerprintHash
        ? `episode-history:${facts.episode.fingerprintHash}` : null,
      ...(facts.episode?.alertIds || []).map((id) => `episode-member:${id}`),
    ]), operationalNonActionability),
    NON_ACTIONABLE: observation(explicitNonActionable, explicitNonActionable
      ? expectedActivity
        ? 'Explicit maintenance, deployment, scheduled job, change, or planned-activity evidence supports a non-actionable notification.'
        : 'A source, Jira, or Slack evidence record explicitly identifies the occurrence as non-actionable.'
      : 'No explicit non-actionable operational evidence is present.',
    unique([
      ...facts.explicitNonActionableEvidence.map(evidenceId),
      ...facts.explicitExpectedActivity.map(evidenceId),
      ...(record.observedBehavior?.expectedActivity?.evidenceIds || []),
    ])),
    CORRELATED: observation(correlated, correlated
      ? 'Bounded structured correlation links related alerts across a shared entity, service, application, or source event.'
      : 'No bounded structured same-event correlation is established; temporal proximity alone was not used.',
    unique([
      ...Object.values(record.observedBehavior || {}).flatMap((item) => item?.evidenceIds || []),
      ...(facts.episode?.alertIds || []).map((id) => `episode-member:${id}`),
    ]), {
      relatedAlertCount: record.correlationFeatures?.relatedAlertCount ?? null,
      relatedSources: record.correlationFeatures?.relatedSources || [],
      candidateObserved: monitoringLifecycle.relationshipEvidence?.correlationCandidate === true,
      confirmed: monitoringLifecycle.relationshipEvidence?.correlationConfirmed === true,
    }),
    STALE: observation(stale, stale
      ? 'Operations remains active at least five days after the authoritative source recovered.'
      : 'The required combination of an active Operations alert, recovered source condition, and five-day synchronization gap is not present.',
    lifecycle.recovered.map((item) => item.evidenceId), {
      thresholdSeconds: STALE_OBSERVATION_MS / 1000,
      sourceResolvedAt: lifecycle.recoveredAt,
      staleDurationSeconds: staleDurationMs === null ? null : Math.round(staleDurationMs / 1000),
    }),
    INFORMATIONAL_PRIORITY: observation(
      prioritySignal(record.alert?.priority) === 'INFORMATIONAL_PRIORITY'
        && facts.maintenanceNotification?.informational === true,
      prioritySignal(record.alert?.priority) !== 'INFORMATIONAL_PRIORITY'
        ? 'The alert is not P4/P5 informational priority.'
        : facts.maintenanceNotification?.informational === true
          ? facts.maintenanceNotification.evidenceReason
          : 'P4/P5 priority alone is not positive informational Noise evidence; an explicit operational notification is required.',
      facts.maintenanceNotification?.evidenceIds || [], {
        operationalSignal: true,
        sourceEvidenceRequired: false,
        notificationEvidenceRequired: true,
        maintenanceNotification: facts.maintenanceNotification,
      }),
  };
  const observed = Object.entries(detectors).filter(([, value]) => value.observed).map(([name]) => name);
  const precedence = [
    'DUPLICATE', 'REPEAT', 'CORRELATED', 'FLAPPING', 'AUTO_RESOLVED',
    'INFORMATIONAL_PRIORITY', 'OPERATIONALLY_NON_ACTIONABLE', 'NON_ACTIONABLE', 'STALE',
  ];
  const primary = precedence.find((name) => observed.includes(name))
    || (facts.evaluable ? 'NO_STRONG_NOISE_PATTERN' : 'UNKNOWN');
  const publicName = (name) => name === 'INFORMATIONAL_PRIORITY' ? 'INFORMATIONAL' : name;
  return {
    primary,
    primarySubtype: publicName(primary),
    observed,
    detectedMechanisms: unique(precedence.filter((name) => observed.includes(name)).map(publicName)),
    detectors: { ...detectors, INFORMATIONAL: detectors.INFORMATIONAL_PRIORITY },
    createsDecision: false,
    provenance: unique(Object.values(detectors).flatMap((item) => item.evidenceIds)),
  };
}

function classificationMatch(value, source) {
  const candidate = text(value).toLowerCase();
  if (!candidate) return null;
  if (/business.?transaction|transaction health|transaction response/.test(candidate)) return ['APPLICATION', 'BUSINESS_TRANSACTION'];
  if (/kafka|queue|consumer lag|batch|scheduled job|etl|data pipeline|data warehouse/.test(candidate)) return ['JOB_BATCH_DATA', /kafka|consumer/.test(candidate) ? 'STREAM_PROCESSING' : /queue/.test(candidate) ? 'QUEUE' : 'BATCH_JOB'];
  if (/payment gateway|third.?party|downstream|external api/.test(candidate)) return ['DEPENDENCY', /payment/.test(candidate) ? 'PAYMENT_GATEWAY' : /external api/.test(candidate) ? 'EXTERNAL_API' : 'DOWNSTREAM_SERVICE'];
  if (/tempdb|database unavailable|database down|database capacity|sql server|\bdatabase\b/.test(candidate)) return ['DEPENDENCY', 'DATABASE'];
  if (/database connection|connection pool/.test(candidate)) return ['APPLICATION', 'DATABASE_CONNECTION'];
  if (/packet loss/.test(candidate)) return ['NETWORK', 'PACKET_LOSS'];
  if (/latency|round.?trip/.test(candidate) && source === 'ThousandEyes') return ['NETWORK', 'LATENCY'];
  if (/\bdns\b/.test(candidate)) return ['NETWORK', 'DNS'];
  if (/network path|interface down|connectivity|unreachable/.test(candidate) && source === 'ThousandEyes') return ['NETWORK', 'CONNECTIVITY'];
  if (/response time|latency|slow response|duration/.test(candidate)) return ['APPLICATION', 'RESPONSE_TIME'];
  if (/error rate|errors per minute|exception|http 5\d\d|api failure/.test(candidate)) return ['APPLICATION', /exception/.test(candidate) ? 'EXCEPTION' : /api|http/.test(candidate) ? 'API_FAILURE' : 'ERROR_RATE'];
  if (/health rule|application health|anomaly|policy violation/.test(candidate)) return ['APPLICATION', 'APPLICATION_HEALTH'];
  if (/\bcpu\b|processor/.test(candidate)) return ['INFRASTRUCTURE', 'CPU'];
  if (/memory|heap/.test(candidate)) return ['INFRASTRUCTURE', 'MEMORY'];
  if (/disk|filesystem|storage/.test(candidate)) return ['INFRASTRUCTURE', 'DISK'];
  if (/host down|server down|node down|service unavailable|service down|daemon/.test(candidate)) return ['INFRASTRUCTURE', /service|daemon/.test(candidate) ? 'SERVICE_AVAILABILITY' : 'HOST_AVAILABILITY'];
  return null;
}

function interpretClassification({ record, facts, source }) {
  const candidates = [];
  for (const item of facts.primary?.evidence || []) {
    const metadata = item.metadata || {};
    candidates.push({
      evidenceId: evidenceId(item),
      text: [metadata.metric, metadata.metricName, metadata.healthRule, metadata.eventType,
        metadata.evidenceType, metadata.businessTransaction, metadata.pluginOutput,
        metadata.ruleName, metadata.panelTitle, metadata.testType, item.title, item.summary]
        .map(text).filter(Boolean).join(' '),
    });
  }
  for (const candidate of candidates) {
    const match = classificationMatch(candidate.text, source);
    if (match) return {
      domain: match[0],
      subtype: match[1],
      assignmentMethod: 'STRUCTURED_SOURCE_EVIDENCE',
      evidenceIds: unique([candidate.evidenceId]),
      reason: `Structured ${source} metric, rule, event, entity, or plugin evidence identifies ${match[0]} / ${match[1]}.`,
    };
  }
  const storedDomainValue = text(record.alertClassification?.domain).toUpperCase();
  const storedDomain = storedDomainValue === 'BUSINESS_TRANSACTION' ? 'APPLICATION' : storedDomainValue;
  const storedSubtype = text(record.alertClassification?.subtype).toUpperCase();
  const allowedDomains = new Set(['INFRASTRUCTURE', 'APPLICATION', 'NETWORK', 'DEPENDENCY', 'JOB_BATCH_DATA']);
  if (allowedDomains.has(storedDomain) && (record.alertClassification?.assignmentEvidence || []).length) return {
    domain: storedDomain,
    subtype: storedSubtype || (storedDomainValue === 'BUSINESS_TRANSACTION' ? 'BUSINESS_TRANSACTION' : 'UNKNOWN'),
    assignmentMethod: 'PRESERVED_STRUCTURED_TAXONOMY',
    evidenceIds: unique(record.alertClassification.assignmentEvidence.map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return item;
      return item?.id || item?.evidenceId || item?.sourceId || item?.field || null;
    })),
    reason: 'Preserved structured taxonomy evidence supplies the technical classification.',
  };
  return {
    domain: 'UNKNOWN',
    subtype: 'UNKNOWN',
    assignmentMethod: null,
    evidenceIds: [],
    reason: 'Available source evidence does not establish a supported technical domain and subtype.',
  };
}

function buildEvidenceVector({ record, blocks = [], technicalEvidence = {}, source, featureAsOf }) {
  const facts = buildFacts({ record, blocks, technicalEvidence, source });
  const noiseDetection = interpretNoiseDetection({ record, facts, featureAsOf: featureAsOf || record.featureAsOf });
  const classification = interpretClassification({ record, facts, source });
  const evidenceIds = (predicate) => blocks.flatMap((block) => (block.evidence || []).filter(predicate).map((item) => item.id));
  const confirmedJiraIds = facts.confirmedJiraEvidence.map((item) => item.evidenceId);
  const irmIncidentIds = facts.irmIncidentEvidence.map(evidenceId);
  const activeIds = unique(facts.lifecycle.active.map((item) => item.evidenceId));
  const investigationItems = facts.humanOperationalActivity.filter((item) => item.metadata?.activityType === 'investigation');
  const remediationItems = facts.humanOperationalActivity.filter((item) => item.metadata?.activityType === 'remediation');
  const escalationItems = facts.humanOperationalActivity.filter((item) => item.metadata?.activityType === 'escalation');
  const provenanceBackedHandlingIds = unique([
    ...escalationItems.map(evidenceId),
    ...(investigationItems.length && remediationItems.length
      ? [...investigationItems, ...remediationItems].map(evidenceId) : []),
  ]);
  const noiseWeights = {
    DUPLICATE: 0.72, REPEAT: 0.66, FLAPPING: 0.68, AUTO_RESOLVED: 0.7,
    NON_ACTIONABLE: 0.68, CORRELATED: 0.35, STALE: 0.62, INFORMATIONAL_PRIORITY: 0.55,
  };
  const noiseScores = noiseDetection.observed.map((item) => noiseWeights[item] || 0);
  const relatedSources = record.correlationFeatures?.relatedSources || [];
  const crossSourceCount = new Set([source, ...facts.activeSources, ...relatedSources].filter(Boolean)).size;
  const lifecycleHistory = facts.monitoringLifecycle?.historicalBehavior || {};
  const historicalIncidentRate = lifecycleHistory.incidentAssociationRate
    ?? record.historicalFeatures?.historicalIncidentRate;
  const historicalNoiseRate = record.historicalFeatures?.historicalConfirmedNoiseRate;
  const production = /prod|production/i.test(text([
    record.sourceIdentity?.environment,
    ...facts.allEvidence.flatMap((item) => [item.metadata?.environment, item.metadata?.tier, item.metadata?.applicationName]),
  ].join(' ')));
  const businessDomain = classification.subtype === 'BUSINESS_TRANSACTION';
  const multiService = Number(record.correlationFeatures?.correlatedServiceCount || 0) > 1;
  const duration = Number(facts.monitoringLifecycle?.persistence?.durationSeconds
    ?? record.temporalFeatures?.durationSeconds ?? 0);
  const occurrenceCount = Number(record.behaviorFeatures?.occurrenceCount || 0);
  const representedIncident = facts.confirmedJiraEvidence.length > 0 || facts.irmIncidentEvidence.length > 0;

  const vector = {
    incidentEvidence: dimension(combine([
      representedIncident ? 0.98 : 0,
      facts.authoritativeActiveSources.length ? 0.72 : 0,
      facts.activeSources.length > 1 ? 0.68 : facts.activeSources.length ? 0.46 : 0,
      facts.meaningfulSlackActions.length ? 0.35 : 0,
      escalationItems.length ? 0.78 : 0,
      investigationItems.length && remediationItems.length ? 0.72 : 0,
    ]), [
      facts.confirmedJiraEvidence.length ? 'A confirmed bounded Jira Incident relationship exists.' : null,
      facts.irmIncidentEvidence.length ? 'A bounded Grafana IRM Incident relationship exists.' : null,
      facts.authoritativeActiveSources.length ? `Authoritative active evidence was retrieved from ${facts.authoritativeActiveSources.join(', ')}.` : null,
      facts.activeSources.length > 1 ? 'Multiple monitoring sources show active operational evidence.' : null,
      facts.meaningfulSlackActions.length ? 'Human remediation activity is present in the bounded Slack context.' : null,
      escalationItems.length ? 'A provenance-backed escalation is present in bounded operational evidence.' : null,
      investigationItems.length && remediationItems.length
        ? 'Bounded operational evidence contains both investigation and remediation.' : null,
    ], [...confirmedJiraIds, ...irmIncidentIds, ...activeIds, ...provenanceBackedHandlingIds]),
    noiseEvidence: dimension(combine(noiseScores), noiseDetection.observed.map((item) => item === 'INFORMATIONAL_PRIORITY'
      ? 'INFORMATIONAL_PRIORITY is operational priority evidence used by the explicit P4/P5 policy.'
      : `${item} behavior is source-supported evidence, not an automatic label.`),
    noiseDetection.provenance, facts.evaluable || noiseDetection.observed.length > 0),
    redundancyEvidence: dimension(combine([
      noiseDetection.observed.includes('DUPLICATE') ? 0.86 : 0,
      noiseDetection.observed.includes('CORRELATED') && representedIncident ? 0.62 : 0,
      Number(record.correlationFeatures?.sameSignatureRecentCount || 0) > 0 ? 0.45 : 0,
    ]), [
      noiseDetection.observed.includes('DUPLICATE') ? 'A structured duplicate occurrence is observed.' : null,
      noiseDetection.observed.includes('CORRELATED') && representedIncident ? 'This notification correlates with an already represented Incident.' : null,
      Number(record.correlationFeatures?.sameSignatureRecentCount || 0) > 0 ? 'The same signature appears in the bounded recent window.' : null,
    ], noiseDetection.provenance),
    persistenceEvidence: dimension(combine([
      duration > 0 ? Math.min(0.75, duration / 3600) : 0,
      occurrenceCount > 1 ? Math.min(0.55, occurrenceCount / 20) : 0,
      facts.lifecycle.active.length && !facts.lifecycle.recovered.length ? 0.52 : 0,
    ]), [
      duration > 0 ? `The stored occurrence duration is ${duration} seconds.` : null,
      occurrenceCount > 1 ? `${occurrenceCount} occurrences are present in the current stored lifecycle.` : null,
      facts.lifecycle.active.length && !facts.lifecycle.recovered.length ? 'The bounded source lifecycle contains active evidence without recovery.' : null,
    ], [], duration > 0 || occurrenceCount > 0),
    correlationEvidence: dimension(combine([
      crossSourceCount > 1 ? Math.min(0.78, 0.35 + (crossSourceCount * 0.12)) : 0,
      Number(record.correlationFeatures?.relatedAlertCount || 0) > 0 ? 0.48 : 0,
    ]), [
      crossSourceCount > 1 ? `${crossSourceCount} sources contribute bounded correlation context.` : null,
      Number(record.correlationFeatures?.relatedAlertCount || 0) > 0 ? `${record.correlationFeatures.relatedAlertCount} related alerts are recorded.` : null,
    ], evidenceIds(() => true), record.correlationFeatures?.relatedAlertCount !== null),
    historicalEvidence: dimension(average([
      historicalIncidentRate,
      historicalNoiseRate,
      lifecycleHistory.autoRecoveryRate,
      lifecycleHistory.flappingRate,
    ]), [
      historicalIncidentRate !== null && historicalIncidentRate !== undefined ? `Historical Incident rate is ${historicalIncidentRate}.` : null,
      historicalNoiseRate !== null && historicalNoiseRate !== undefined ? `Confirmed historical Noise rate is ${historicalNoiseRate}.` : null,
      lifecycleHistory.autoRecoveryRate !== null && lifecycleHistory.autoRecoveryRate !== undefined
        ? `Source-supported historical auto-recovery rate is ${lifecycleHistory.autoRecoveryRate}.` : null,
      lifecycleHistory.flappingRate !== null && lifecycleHistory.flappingRate !== undefined
        ? `Source-supported historical flapping rate is ${lifecycleHistory.flappingRate}.` : null,
    ], facts.monitoringLifecycle?.provenance?.historicalAlertIds || [],
    lifecycleHistory.occurrenceCount > 0 || historicalIncidentRate !== null && historicalIncidentRate !== undefined
      || historicalNoiseRate !== null && historicalNoiseRate !== undefined),
    businessImpactEvidence: dimension(combine([
      production ? 0.28 : 0,
      businessDomain ? 0.48 : 0,
      multiService ? 0.32 : 0,
      representedIncident ? 0.38 : 0,
    ]), [
      production ? 'The source identity explicitly identifies a production environment.' : null,
      businessDomain ? 'The technical taxonomy identifies a business-transaction signal.' : null,
      multiService ? 'More than one service is represented in correlation evidence.' : null,
      representedIncident ? 'A confirmed operational Incident relationship contributes impact context.' : null,
    ], [...confirmedJiraIds, ...irmIncidentIds], production || businessDomain || multiService || representedIncident),
    sourceEvidence: dimension(combine([
      facts.primaryStatus === 'working' ? 0.6 : 0,
      facts.sourceEvidenceCount ? 0.42 : 0,
      facts.authoritativeActiveSources.includes(source) ? 0.32 : 0,
    ]), [
      facts.primaryStatus === 'working' ? `The ${source} adapter returned matching read-only evidence.` : null,
      facts.sourceEvidenceCount ? `${facts.sourceEvidenceCount} bounded monitoring evidence records were retained.` : null,
      facts.sourceUnavailable ? `Critical evidence from ${source || 'the primary source'} is unavailable.` : null,
    ], evidenceIds((item) => item.source === source), Boolean(source)),
    lifecycleEvidence: dimension(combine([
      facts.monitoringLifecycle?.completeness?.lifecycleEvidenceAvailable ? 0.62 : 0,
      facts.monitoringLifecycle?.recovery?.recovered ? 0.42 : 0,
      facts.monitoringLifecycle?.completeness?.stateHistoryAvailable ? 0.38 : 0,
      facts.monitoringLifecycle?.completeness?.metricTimeSeriesAvailable ? 0.35 : 0,
    ]), [
      facts.monitoringLifecycle?.completeness?.lifecycleEvidenceAvailable ? 'A source occurrence lifecycle is available.' : null,
      facts.monitoringLifecycle?.recovery?.recovered ? 'Source recovery is observed.' : null,
      facts.monitoringLifecycle?.completeness?.stateHistoryAvailable ? 'Source state transitions are available.' : null,
      facts.monitoringLifecycle?.completeness?.metricTimeSeriesAvailable ? 'A bounded source metric series is available.' : null,
    ], facts.monitoringLifecycle?.provenance?.sourceEvidenceIds || [],
    facts.monitoringLifecycle?.completeness?.lifecycleEvidenceAvailable === true),
  };
  const completenessInputs = [
    Boolean(source), facts.primaryStatus === 'working', facts.sourceEvidenceCount > 0,
    classification.domain !== 'UNKNOWN', Boolean(record.sourceIdentity?.entity || record.sourceIdentity?.service || record.sourceIdentity?.application),
    record.temporalFeatures?.createdAt !== null && record.temporalFeatures?.createdAt !== undefined,
    record.correlationFeatures?.relatedAlertCount !== null && record.correlationFeatures?.relatedAlertCount !== undefined,
    facts.jiraEvidenceCount > 0 || facts.slackEvidenceCount > 0,
  ];
  vector.dataCompleteness = dimension(completenessInputs.filter(Boolean).length / completenessInputs.length, [
    `${completenessInputs.filter(Boolean).length} of ${completenessInputs.length} evidence families are available.`,
  ], evidenceIds(() => true));
  return { classification, facts, noiseDetection, vector };
}

function usableFallbackIdentity(value) {
  const normalized = text(value).toLowerCase();
  return normalized && !/^(unknown|unknown-service|unknown-application|unresolved|unassigned|none|null|n\/a|not available)$/.test(normalized)
    ? text(value) : null;
}

function fallbackOperationalProfile({ record, facts, noiseDetection, source }) {
  const lifecycle = facts.monitoringLifecycle || {};
  const history = lifecycle.historicalBehavior || {};
  const deviation = lifecycle.deviationFromHistory?.duration || null;
  const intervention = lifecycle.intervention || {};
  const priority = prioritySignal(record.alert?.priority);
  const status = text(record.alert?.status).toUpperCase();
  const alertId = usableFallbackIdentity(record.alert?.alertId || record.alert?.canonicalAlertId
    || record.alert?.sourceAlertId);
  const sourceKnown = MONITORING_SOURCES.has(source);
  const exactHistory = ['EXACT_SOURCE_ENTITY', 'EXACT_ALERT_SIGNATURE'].includes(history.matchMethod);
  const identityAvailable = Boolean(
    usableFallbackIdentity(record.sourceIdentity?.entityId)
    || usableFallbackIdentity(record.sourceIdentity?.entity)
    || usableFallbackIdentity(record.sourceIdentity?.application)
    || usableFallbackIdentity(record.sourceIdentity?.service)
    || exactHistory
  );
  const operationalAlertValid = Boolean(record.alert && alertId && sourceKnown && status);
  const operationsOpen = /OPEN|ACTIVE|ACKNOWLEDGED|TRIGGERED/.test(status);
  const operationsClosed = /CLOSED|RESOLVED|RECOVERED|CLEARED/.test(status);
  const sourceLifecycleAvailable = lifecycle.completeness?.lifecycleEvidenceAvailable === true;
  const storedDurationSeconds = Number(record.temporalFeatures?.durationSeconds ?? 0);
  const notificationAgeSeconds = Number(record.temporalFeatures?.ageSeconds ?? storedDurationSeconds);
  const durationSeconds = Number(sourceLifecycleAvailable
    ? lifecycle.persistence?.durationSeconds ?? storedDurationSeconds
    : operationsOpen ? notificationAgeSeconds : storedDurationSeconds);
  const priorOccurrences = Number(history.occurrenceCount
    ?? record.historicalFeatures?.previousSameSignatureCount ?? 0);
  const recentRecurrence = Number(record.correlationFeatures?.sameSignatureRecentCount
    ?? record.behaviorFeatures?.recurrenceCount ?? 0);
  const historicalMedian = Number.isFinite(Number(history.medianDurationSeconds))
    ? Number(history.medianDurationSeconds) : null;
  const historicalP95 = Number.isFinite(Number(history.p95DurationSeconds))
    ? Number(history.p95DurationSeconds) : null;
  const sufficientExactDurationHistory = exactHistory && history.historyStatus === 'SUFFICIENT_HISTORY'
    && Number(history.durationSampleCount ?? history.occurrenceCount ?? 0) >= 3
    && historicalMedian !== null && historicalMedian > 0;
  const abnormalDuration = deviation?.status === 'ABOVE_HISTORICAL_P95'
    || lifecycle.signals?.includes('ABNORMAL_DURATION') === true
    || (exactHistory && historicalP95 !== null && durationSeconds > historicalP95);
  const aboveHistoricalMedian = exactHistory && historicalMedian !== null && durationSeconds > historicalMedian;
  const shortLived = durationSeconds > 0 && durationSeconds <= SHORT_LIVED_STATE_MS / 1000;
  const withinHistoricalRange = exactHistory && historicalP95 !== null && durationSeconds <= historicalP95;
  const acknowledged = intervention.acknowledged === true || record.slackFeatures?.slackAcknowledged === true
    || record.alert?.acknowledged === true;
  const investigated = intervention.investigated === true;
  const remediated = intervention.remediated === true;
  const escalated = intervention.escalated === true;
  const manualAction = investigated || remediated || escalated || manualOperationalResponse(facts);
  const production = /prod|production/i.test(text(record.sourceIdentity?.environment || record.alert?.environment));
  const representedIncident = facts.confirmedJiraEvidence.length > 0 || facts.irmIncidentEvidence.length > 0;
  const duplicateConfirmed = noiseDetection.detectors.DUPLICATE.observed === true
    && Boolean(facts.notificationRelationship?.duplicateOf
      || lifecycle.relationshipEvidence?.duplicateConfirmed
      || facts.explicitDuplicateEvidence.length > 0);
  const autoRecovered = noiseDetection.detectors.AUTO_RESOLVED.observed === true;
  const historicallyTransient = exactHistory && history.historyStatus === 'SUFFICIENT_HISTORY'
    && Number(history.autoRecoveryRate || 0) >= 0.7
    && Number(history.incidentAssociationRate || 0) <= 0.1;
  const awaitingLifecycleEvidence = facts.sourceUnavailable && operationsOpen
    && sufficientExactDurationHistory && durationSeconds < historicalMedian
    && !facts.lifecycleConflict;
  const actionableSignals = unique([
    representedIncident ? 'CONFIRMED_INCIDENT_RELATIONSHIP' : null,
    remediated ? 'REMEDIATION_OBSERVED' : null,
    escalated ? 'ESCALATION_OBSERVED' : null,
    investigated ? 'INVESTIGATION_OBSERVED' : null,
    acknowledged ? 'ACKNOWLEDGED' : null,
    abnormalDuration ? 'ABOVE_HISTORICAL_P95' : null,
    aboveHistoricalMedian ? 'ABOVE_HISTORICAL_MEDIAN' : null,
    operationsOpen ? 'OPERATIONS_ALERT_OPEN' : null,
    production ? 'PRODUCTION' : null,
    priorOccurrences > 0 || recentRecurrence > 0 ? 'EXACT_RECURRENCE' : null,
  ]);
  const nonActionableSignals = unique([
    duplicateConfirmed ? 'CONFIRMED_DUPLICATE_NOTIFICATION' : null,
    autoRecovered ? 'AUTO_RECOVERY_OBSERVED' : null,
    operationsClosed ? 'OPERATIONS_ALERT_CLOSED' : null,
    shortLived ? 'SHORT_LIVED' : null,
    withinHistoricalRange ? 'WITHIN_EXACT_HISTORICAL_RANGE' : null,
    historicallyTransient ? 'HISTORICALLY_TRANSIENT' : null,
    !manualAction ? 'NO_REMEDIATION_OR_ESCALATION' : null,
  ]);
  const strongActionable = representedIncident || remediated || escalated
    || (operationsOpen && identityAvailable && abnormalDuration && acknowledged)
    || (operationsOpen && identityAvailable && investigated && (abnormalDuration || aboveHistoricalMedian || production))
    || (operationsOpen && identityAvailable && abnormalDuration && (priorOccurrences > 0 || recentRecurrence > 0))
    || (operationsOpen && identityAvailable && durationSeconds >= SUSTAINED_STATE_MS / 1000
      && (acknowledged || investigated));
  const explicitSupportedNonActionable = noiseDetection.detectors.NON_ACTIONABLE.observed === true
    && noiseDetection.detectors.NON_ACTIONABLE.evidenceIds.length > 0;
  const strongNonActionable = explicitSupportedNonActionable
    && !representedIncident && !manualAction;
  const maintenanceNotification = facts.maintenanceNotification || null;
  const maintenanceNotificationIdentityValid = maintenanceNotification?.deterministic === true
    && maintenanceNotification?.identityValid === true
    && maintenanceNotification?.informational === true
    && maintenanceNotification?.nonActionable === true
    && maintenanceNotification?.evidenceIds?.length > 0;
  const informationalDefault = priority === 'INFORMATIONAL_PRIORITY'
    && maintenanceNotificationIdentityValid && explicitSupportedNonActionable
    && !strongActionable && !representedIncident;
  const contradictory = strongActionable && strongNonActionable;
  const meaningfulEvidence = actionableSignals.length > 1 || nonActionableSignals.length > 1
    || representedIncident || Boolean(record.slackFeatures?.slackMessageCount)
    || facts.jiraEvidenceCount > 0 || facts.slackEvidenceCount > 0;
  return {
    sourceApiUnavailable: facts.sourceUnavailable,
    operationalAlertValid,
    identityAvailable,
    exactHistory,
    operationsOpen,
    operationsClosed,
    durationSeconds,
    priorOccurrences,
    recentRecurrence,
    abnormalDuration,
    aboveHistoricalMedian,
    historicalMedian,
    historicalP95,
    sufficientExactDurationHistory,
    awaitingLifecycleEvidence,
    sourceLifecycleAvailable,
    notificationAgeSeconds,
    acknowledged,
    investigated,
    remediated,
    escalated,
    actionableSignals,
    nonActionableSignals,
    strongActionable,
    strongNonActionable,
    explicitSupportedNonActionable,
    maintenanceNotification,
    maintenanceNotificationIdentityValid,
    informationalDefault,
    contradictory,
    meaningfulEvidence,
  };
}

function operationalDimensions({ record, facts, vector, noiseDetection, classification }) {
  const fallback = fallbackOperationalProfile({ record, facts, noiseDetection, source: facts.source });
  const episode = facts.episode || {};
  const episodeIntervention = facts.maintenanceNotification?.identityValid === true
    ? {} : episode.intervention || {};
  const confirmedIncident = facts.confirmedJiraEvidence.length > 0 || facts.irmIncidentEvidence.length > 0
    || episode.relationships?.jiraIncident === true;
  const activeAuthoritative = facts.authoritativeActiveSources.length > 0;
  const multiSourceActive = facts.activeSources.length > 1;
  const recoveredOnly = !facts.lifecycleConflict && facts.recoveredSources.length > 0 && facts.activeSources.length === 0;
  const duplicate = noiseDetection.observed.includes('DUPLICATE');
  const correlated = noiseDetection.observed.includes('CORRELATED');
  const explicitNonActionable = noiseDetection.observed.includes('NON_ACTIONABLE')
    || noiseDetection.observed.includes('OPERATIONALLY_NON_ACTIONABLE');
  const impactEvidence = facts.allEvidence.filter((item) => {
    const metadata = item.metadata || {};
    return metadata.customerImpact === true || metadata.businessImpact === 'CONFIRMED'
      || Boolean(metadata.revenueImpact || metadata.affectedCustomers || metadata.customerFacingDegradation);
  });
  const explicitNoImpact = facts.allEvidence.filter((item) => item.metadata?.businessImpact === 'NOT_OBSERVED'
    || item.metadata?.customerImpact === false);
  const production = /prod|production/i.test(text([
    record.sourceIdentity?.environment,
    ...facts.allEvidence.flatMap((item) => [item.metadata?.environment, item.metadata?.tier, item.metadata?.applicationName]),
  ].join(' ')));
  const transactionSignal = classification.domain === 'BUSINESS_TRANSACTION'
    || classification.subtype === 'BUSINESS_TRANSACTION';
  const priorIncidentCount = Number(record.historicalFeatures?.previousConfirmedIncidentCount
    ?? record.historicalFeatures?.previousIncidentCount ?? 0);
  const meaningfulOperationalHandling = facts.monitoringLifecycle?.intervention?.operatorActionObserved === true
    || manualOperationalResponse(facts)
    || facts.humanOperationalActivity.length > 0 || facts.jiraOperationalActivity.length > 0
    || facts.confirmedJiraEvidence.length > 0 || facts.candidateJiraEvidence.length > 0
    || facts.irmIncidentEvidence.length > 0;
  const investigated = facts.monitoringLifecycle?.intervention?.investigated === true
    || episodeIntervention.investigated === true;
  const remediated = facts.monitoringLifecycle?.intervention?.remediated === true
    || episodeIntervention.remediated === true;
  const escalated = facts.monitoringLifecycle?.intervention?.escalated === true
    || episodeIntervention.escalated === true;
  const lifecycleDurationSeconds = facts.monitoringLifecycle?.persistence?.durationSeconds
    ?? facts.lifecycle.longestActiveStateDurationSeconds;
  const currentSourceRecovered = authoritativeRecoveryProfile(facts).recovered;
  const authoritativeCurrentlyFiring = !facts.lifecycleConflict && (
    facts.monitoringLifecycle?.persistence?.currentlyFiring === true
      || (facts.authoritativeActiveSources.includes(facts.source) && facts.lifecycle.activeNow.some((item) => item.source === facts.source))
  );
  const shortLivedSourceCondition = lifecycleDurationSeconds !== null && lifecycleDurationSeconds !== undefined
    && lifecycleDurationSeconds * 1000 <= SHORT_LIVED_STATE_MS;
  const sustainedSourceCondition = facts.monitoringLifecycle?.persistence?.currentlyFiring === true
    || facts.monitoringLifecycle?.deviationFromHistory?.duration?.status === 'ABOVE_HISTORICAL_P95'
    || facts.lifecycle.activeNow.length > 0
    || (facts.lifecycle.longestActiveStateDurationSeconds !== null
      && facts.lifecycle.longestActiveStateDurationSeconds * 1000 >= SUSTAINED_STATE_MS)
    || (facts.lifecycle.longestActiveStateDurationSeconds === null
      && Number(record.temporalFeatures?.durationSeconds || 0) >= SUSTAINED_STATE_MS / 1000);
  const strongSupportedNoisePattern = noiseDetection.observed.some((item) => (
    ['DUPLICATE', 'AUTO_RESOLVED', 'FLAPPING', 'NON_ACTIONABLE', 'OPERATIONALLY_NON_ACTIONABLE', 'CORRELATED', 'STALE'].includes(item)
  ));
  const strongAuthoritativeTechnicalIncident = facts.evaluable && facts.primaryStatus === 'working'
    && activeAuthoritative && authoritativeCurrentlyFiring && sustainedSourceCondition
    && !strongSupportedNoisePattern && !facts.lifecycleConflict;
  const operationalHandlingEvidenceIds = unique([
    ...facts.humanOperationalActivity.map(evidenceId),
    ...facts.jiraOperationalActivity.map(evidenceId),
    ...(facts.monitoringLifecycle?.intervention?.evidenceIds || []),
  ]);
  const technicalIncidentEvidenceIds = unique([
    ...facts.lifecycle.active.map((item) => item.evidenceId),
    ...(facts.monitoringLifecycle?.provenance?.sourceEvidenceIds || []),
    ...classification.evidenceIds,
  ]);
  const confirmedIncidentEvidenceIds = unique([
    ...facts.confirmedJiraEvidence.map((item) => item.evidenceId),
    ...facts.irmIncidentEvidence.map(evidenceId),
  ]);
  const independentOperationalHandling = escalated || (investigated && remediated);
  const supportingTechnicalIncidentEvidence = authoritativeCurrentlyFiring
    || strongAuthoritativeTechnicalIncident
    || currentSourceRecovered
    || (facts.sourceUnavailable && fallback.strongActionable
      && (fallback.abnormalDuration || remediated || escalated));
  const strongOperationalIncidentEvidenceIds = unique([
    ...confirmedIncidentEvidenceIds,
    ...(independentOperationalHandling ? operationalHandlingEvidenceIds : []),
    ...(independentOperationalHandling && supportingTechnicalIncidentEvidence
      ? technicalIncidentEvidenceIds : []),
  ]);
  // A PRIMARY role, an acknowledgement, investigation alone, priority, or
  // unavailable source data is not positive Incident evidence. Operational
  // handling must be independently strong and provenance-backed.
  const strongOperationalIncidentEvidence = confirmedIncident || (
    independentOperationalHandling
      && supportingTechnicalIncidentEvidence
      && operationalHandlingEvidenceIds.length > 0
      && strongOperationalIncidentEvidenceIds.length > 0
  );
  const strongLowOperationalFootprint = facts.evaluable && facts.primaryStatus === 'working'
    && activeAuthoritative && currentSourceRecovered && shortLivedSourceCondition
    && !meaningfulOperationalHandling && !facts.boundedCrossSource && priorIncidentCount === 0;

  let businessImpact = 'UNKNOWN';
  if (impactEvidence.length) businessImpact = 'CONFIRMED';
  else if (production && transactionSignal && (activeAuthoritative || multiSourceActive)) businessImpact = 'PROBABLE';
  else if (production && multiSourceActive && Number(record.correlationFeatures?.correlatedServiceCount || 0) > 1) businessImpact = 'PROBABLE';
  else if (explicitNoImpact.length) businessImpact = 'NONE_OBSERVED';
  else if (strongLowOperationalFootprint) businessImpact = 'NONE_OBSERVED';

  let underlyingEvent = 'UNKNOWN';
  if (confirmedIncident) underlyingEvent = 'CONFIRMED_INCIDENT';
  else if (strongOperationalIncidentEvidence && (authoritativeCurrentlyFiring || fallback.operationsOpen
    || meaningfulOperationalHandling)) underlyingEvent = 'PROBABLE_INCIDENT';
  else if (strongAuthoritativeTechnicalIncident || fallback.strongActionable || facts.activeSources.length
    || facts.monitoringLifecycle?.persistence?.currentlyFiring === true) underlyingEvent = 'TECHNICAL_EVENT';
  else if (fallback.strongNonActionable || fallback.informationalDefault
    || noiseDetection.observed.includes('OPERATIONALLY_NON_ACTIONABLE')) underlyingEvent = 'NO_INCIDENT_EVIDENCE';
  else if (recoveredOnly || noiseDetection.observed.includes('AUTO_RESOLVED')) underlyingEvent = 'NO_INCIDENT_EVIDENCE';

  let actionability = 'UNKNOWN';
  if (underlyingEvent === 'CONFIRMED_INCIDENT') actionability = 'ACTIONABLE';
  else if (underlyingEvent === 'PROBABLE_INCIDENT' && strongOperationalIncidentEvidence) actionability = 'ACTIONABLE';
  else if (episode.notificationRole?.role && ['REPEAT', 'DUPLICATE', 'CORRELATED'].includes(episode.notificationRole.role)
    && episode.notificationRole.addsOperationalInformation !== true) actionability = 'NON_ACTIONABLE';
  else if (explicitNonActionable && !confirmedIncident && businessImpact !== 'CONFIRMED') actionability = 'NON_ACTIONABLE';
  else if (explicitNonActionable && facts.lifecycle.recovered.length
    && !facts.lifecycle.activeNow.length && businessImpact !== 'CONFIRMED') actionability = 'NON_ACTIONABLE';
  else if (noiseDetection.observed.includes('AUTO_RESOLVED') && !manualOperationalResponse(facts)
    && businessImpact === 'NONE_OBSERVED') actionability = 'NON_ACTIONABLE';
  else if (fallback.strongNonActionable || fallback.informationalDefault
    || noiseDetection.observed.includes('OPERATIONALLY_NON_ACTIONABLE')) actionability = 'NON_ACTIONABLE';
  else if (strongLowOperationalFootprint
    && noiseDetection.observed.some((item) => ['AUTO_RESOLVED', 'FLAPPING'].includes(item))) actionability = 'NON_ACTIONABLE';

  let notificationRole = 'UNKNOWN';
  if (episode.notificationRole?.role) notificationRole = episode.notificationRole.role;
  else if (duplicate && confirmedIncident) notificationRole = 'REDUNDANT';
  else if (duplicate) notificationRole = 'REDUNDANT';
  else if (correlated) notificationRole = 'CORRELATED_SECONDARY';
  else if (confirmedIncident || strongAuthoritativeTechnicalIncident || fallback.strongActionable
    || (facts.primaryStatus === 'working' && (facts.lifecycle.active.length || facts.lifecycle.recovered.length))) notificationRole = 'PRIMARY';

  const details = {
    businessImpact: {
      value: businessImpact,
      reason: businessImpact === 'CONFIRMED' ? 'Explicit customer or business-impact evidence is present.'
        : businessImpact === 'PROBABLE' ? 'Production business-transaction or multi-service degradation supports probable impact.'
          : businessImpact === 'NONE_OBSERVED' ? explicitNoImpact.length
            ? 'The evidence explicitly reports no observed customer/business impact.'
            : 'The authoritative source recovered after a short-lived condition, and bounded Jira, Slack, cross-source, and historical evidence shows no operational handling or impact signal.'
            : 'No authoritative customer, revenue, transaction, or service-impact evidence establishes impact.',
      evidenceIds: unique(impactEvidence.map(evidenceId)),
    },
    actionability: {
      value: actionability,
      reason: actionability === 'ACTIONABLE' ? 'Confirmed Incident representation or strong episode-level operational handling supports operator action.'
        : actionability === 'NON_ACTIONABLE' ? 'Explicit non-actionable or recovered evidence supports no separate intervention.'
          : 'Evidence does not yet prove that intervention is required or unnecessary.',
      evidenceIds: unique(actionability === 'NON_ACTIONABLE'
        ? facts.explicitNonActionableEvidence.map(evidenceId) : facts.lifecycle.active.map((item) => item.evidenceId)),
    },
    underlyingEvent: {
      value: underlyingEvent,
      reason: underlyingEvent === 'CONFIRMED_INCIDENT' ? 'A bounded Jira or Grafana IRM Incident relationship represents the event.'
        : underlyingEvent === 'PROBABLE_INCIDENT' ? 'Strong operational handling combined with the active episode supports a probable Incident.'
          : underlyingEvent === 'TECHNICAL_EVENT' ? 'Source evidence confirms an operational condition without proving an Incident relationship.'
            : underlyingEvent === 'NO_INCIDENT_EVIDENCE' ? 'The source lifecycle recovered and no current represented Incident is established.'
              : 'The available evidence cannot establish the underlying event.',
      evidenceIds: unique([
        ...facts.confirmedJiraEvidence.map((item) => item.evidenceId),
        ...facts.irmIncidentEvidence.map(evidenceId),
        ...facts.lifecycle.timeline.map((item) => item.evidenceId),
      ]),
    },
    notificationRole: {
      value: notificationRole,
      reason: episode.notificationRole?.reason
        || (notificationRole === 'REDUNDANT' ? 'An existing Incident represents the event and exact duplicate evidence makes this notification redundant.'
          : notificationRole === 'CORRELATED_SECONDARY' ? 'The alert adds corroborating source evidence to a related event already represented by another notification.'
              : notificationRole === 'PRIMARY' ? 'This is the first independently useful source notification in the available event evidence.'
                : 'The notification contribution cannot be established from structured event evidence.'),
      evidenceIds: unique(episode.alertIds?.map((id) => `episode-member:${id}`)
        || (notificationRole === 'REDUNDANT'
          ? noiseDetection.detectors.DUPLICATE.evidenceIds : facts.lifecycle.timeline.map((item) => item.evidenceId))),
    },
  };

  return {
    actionability,
    businessImpact,
    details,
    notificationRole,
    prioritySignal: prioritySignal(record.alert?.priority),
    underlyingEvent,
    provenance: {
      activeSources: facts.activeSources,
      authoritativeActiveSources: facts.authoritativeActiveSources,
      confirmedJiraRelationships: facts.confirmedJiraEvidence.length,
      observedNoisePatterns: noiseDetection.observed,
      recoveredSources: facts.recoveredSources,
      currentSourceRecovered,
      meaningfulOperationalHandling,
      shortLivedSourceCondition,
      strongLowOperationalFootprint,
      sustainedSourceCondition,
      strongAuthoritativeTechnicalIncident,
      strongOperationalIncidentEvidence,
      strongOperationalIncidentEvidenceIds,
      independentOperationalHandling,
      supportingTechnicalIncidentEvidence,
      technicalConditionObserved: strongAuthoritativeTechnicalIncident || fallback.strongActionable
        || facts.activeSources.length > 0 || facts.monitoringLifecycle?.persistence?.currentlyFiring === true,
      episode,
      lifecycleConflict: facts.lifecycleConflict,
      historicalBehavior: facts.monitoringLifecycle?.historicalBehavior || null,
      lifecycleSignals: facts.monitoringLifecycle?.signals || [],
      fallbackOperationalEvidence: fallback,
      operationalNonActionability: operationalNonActionabilityProfile({ record, facts }),
    },
  };
}

function manualOperationalResponse(facts) {
  return facts.monitoringLifecycle?.intervention?.remediated === true
    || facts.monitoringLifecycle?.intervention?.escalated === true
    || facts.meaningfulSlackActions.length > 0
    || facts.jiraEvidence.some((item) => item.metadata?.meaningfulAction === true || item.metadata?.manualIntervention === true);
}

function searchedSystemNames(facts) {
  return facts.evidenceSearches.filter((item) => item.searched).map((item) => item.system);
}

function buildDecisionBlockers({ source, facts, dimensions, noiseDetection, finalDecision }) {
  if (finalDecision !== 'NEEDS_REVIEW') return [];
  const systemsSearched = searchedSystemNames(facts);
  const blockers = [];
  const add = (field, currentEvidence, missingEvidence, whyItMatters) => blockers.push({
    field,
    currentEvidence,
    missingEvidence,
    whyItMatters,
    systemsSearched,
    couldChangeDecision: true,
  });
  if (!facts.evidenceExhausted) {
    const notSearched = facts.evidenceSearches.filter((item) => !item.searched).map((item) => item.system);
    add('Evidence exhaustion',
      (systemsSearched.join(', ') || 'No bounded evidence systems') + ' searched.',
      'Complete bounded read-only lookup for ' + notSearched.join(', ') + '.',
      'The missing source may contain either intervention/impact evidence or proof that the notification was unnecessary.');
  }
  const fallback = dimensions.provenance.fallbackOperationalEvidence || {};
  if (!fallback.operationalAlertValid) {
    add('Operational alert identity',
      `The record does not provide a valid ${source || 'monitoring'} operational alert identity.`,
      'A valid JSM Operations alert ID, status, and recognized monitoring source.',
      'The engine must establish that the record is an operational alert before recommending Incident or Noise.');
  } else if (!fallback.identityAvailable && !fallback.meaningfulEvidence) {
    add('Alert identity and context',
      'No exact source entity, exact alert signature history, or meaningful operational context is available.',
      'An exact alert signature/source identity or independent Jira, Slack, lifecycle, or recurrence evidence.',
      'Generic service similarity is not sufficient to resolve this alert.');
  }
  if (facts.lifecycleConflict) {
    add('Monitoring lifecycle conflict',
      'Authoritative evidence simultaneously represents this occurrence as firing and recovered.',
      'A later authoritative state for the same exact source occurrence/entity that resolves the conflict.',
      'The engine cannot safely treat a simultaneously firing and recovered occurrence as Incident or Noise.');
  }
  if (fallback.contradictory) {
    add('Contradictory fallback evidence',
      `Actionable signals (${(fallback.actionableSignals || []).join(', ')}) conflict with non-actionable signals (${(fallback.nonActionableSignals || []).join(', ')}).`,
      'Additional evidence resolving whether this occurrence required separate intervention.',
      'Conflicting operational evidence must remain reviewable.');
  }
  if (facts.candidateJiraEvidence.length > 0 && facts.confirmedJiraEvidence.length === 0) {
    add('Operational relationship',
      facts.candidateJiraEvidence.length + ' bounded Jira candidate relationship(s) were found, but none is confirmed.',
      'A structured identifier proving or disproving that the candidate Jira work represents this occurrence.',
      'A confirmed operational relationship would support Incident handling; a disproven relationship would strengthen a notification-level Noise decision.');
  }
  if (fallback.awaitingLifecycleEvidence) {
    add('Lifecycle maturity',
      `The ${fallback.durationSeconds}-second open occurrence is still below its exact-source historical median of ${fallback.historicalMedian} seconds.`,
      'A later authoritative recovery state or enough elapsed time to make persistence meaningful relative to this exact source identity.',
      'A young alert is neither Noise nor Incident merely because its monitoring API is temporarily unavailable.');
  }
  if (dimensions.actionability === 'UNKNOWN') {
    const observed = noiseDetection.observed.length
      ? noiseDetection.observed.join(', ') + ' behavior is observed'
      : 'No strong Noise behavior is observed';
    add('Actionability',
      observed + '; ' + facts.humanOperationalActivity.length + ' meaningful Slack and '
        + facts.jiraOperationalActivity.length + ' Jira operational activity record(s) are available.',
      'Confirmed Incident representation, investigation/remediation, escalation, strong episode-level operator handling, or positive Noise lifecycle evidence.',
      'This fact directly separates an actionable Incident from an unnecessary notification.');
  }
  if (dimensions.notificationRole === 'UNKNOWN' && !facts.sourceUnavailable) {
    add('Notification role',
      (facts.notificationRelationship?.duplicateGroupId ? 'A notification group exists' : 'No primary/duplicate relationship is established')
        + ' and ' + (facts.boundedCrossSource ? 'cross-source correlation exists.' : 'no cross-source event relationship is proven.'),
      'A deterministic episode relationship establishing whether this notification is primary, repeat, duplicate, correlated, or recovery.',
      'A redundant notification can be Noise even when the underlying event is real.');
  }
  if (!blockers.length) {
    add('Operational usefulness',
      'The event is ' + dimensions.underlyingEvent + ' and the notification is ' + dimensions.notificationRole
        + ', but the evidence does not resolve intervention necessity.',
      'A source, workflow, or reviewed-outcome fact that proves whether this notification required a separate response.',
      'That fact is the remaining distinction between Incident and Noise for this occurrence.');
  }
  return blockers;
}

function noiseExplanation({ facts, dimensions, noiseDetection, decisionBasis }) {
  if (decisionBasis === 'INFORMATIONAL_PRIORITY_NOTIFICATION') {
    return 'The valid P4/P5 operational alert is informational priority and no stronger Incident, remediation, escalation, or contradictory evidence requires separate Incident handling.';
  }
  if (decisionBasis === 'FALLBACK_NON_ACTIONABLE_NOTIFICATION') {
    return 'Source monitoring API evidence is unavailable, but exact historical, lifecycle, duplicate, recovery, and intervention evidence supports a non-actionable notification.';
  }
  if (decisionBasis === 'REDUNDANT_NOTIFICATION_FOR_REPRESENTED_EVENT') {
    return 'The underlying ' + dimensions.underlyingEvent.toLowerCase().replaceAll('_', ' ')
      + ' is preserved, but this notification duplicates '
      + (facts.notificationRelationship?.duplicateOf || 'an earlier representative')
      + ' within the same exact source/entity occurrence group and did not require separate handling.';
  }
  if (decisionBasis === 'CORRELATED_SECONDARY_NOTIFICATION') {
    return 'The underlying event remains represented as an Incident, while this bounded cross-source notification is secondary and adds no separate required response.';
  }
  if (decisionBasis === 'STALE_RECOVERED_NOTIFICATION') {
    return 'JSM still presents the notification as active even though the authoritative source has been healthy for at least five days; no separate current intervention is supported.';
  }
  return 'The ' + noiseDetection.primary.toLowerCase().replaceAll('_', ' ')
    + ' source condition was real, but it recovered after a short-lived lifecycle without observed remediation, sustained business impact, escalation, or separate Incident handling.';
}

const EPISODE_NOISE_TYPES = {
  EPISODE_INFORMATIONAL_PRIORITY: 'INFORMATIONAL_PRIORITY',
  EPISODE_REPEAT_NOTIFICATION: 'REPEAT',
  EPISODE_DUPLICATE_NOTIFICATION: 'DUPLICATE',
  EPISODE_CORRELATED_NOTIFICATION: 'CORRELATED',
  EPISODE_RECOVERY_NOTIFICATION: 'AUTO_RESOLVED',
  EPISODE_FLAPPING: 'FLAPPING',
  EPISODE_AUTO_RESOLVED: 'AUTO_RESOLVED',
  EPISODE_NON_ACTIONABLE: 'NON_ACTIONABLE',
  EPISODE_OPERATIONALLY_NON_ACTIONABLE: 'OPERATIONALLY_NON_ACTIONABLE',
};

function positiveNoiseEvidenceProfile({ decisionBasis, facts, dimensions, noiseDetection }) {
  const noiseType = EPISODE_NOISE_TYPES[decisionBasis] || null;
  const detector = noiseType ? noiseDetection.detectors[noiseType] : null;
  const operationalHistory = dimensions.provenance.operationalNonActionability || {};
  const authoritativeRecovery = authoritativeRecoveryProfile(facts);
  const explicitDetectorEvidence = detector?.observed === true && detector.evidenceIds?.length > 0;
  let mustHavePositiveSignal = false;
  let strength = 'NONE';
  let reason = 'No explicit supported positive Noise signal is present.';
  let supportingSources = [];

  if (noiseType === 'INFORMATIONAL_PRIORITY'
      && dimensions.prioritySignal === 'INFORMATIONAL_PRIORITY'
      && facts.maintenanceNotification?.identityValid === true
      && facts.maintenanceNotification?.informational === true
      && facts.maintenanceNotification?.nonActionable === true
      && explicitDetectorEvidence) {
    mustHavePositiveSignal = true;
    strength = 'EXPLICIT_MAINTENANCE_NOTIFICATION';
    reason = detector.reason;
    supportingSources = facts.maintenanceNotification.sourceProvenance || ['JSM Operations'];
  } else if (noiseType === 'OPERATIONALLY_NON_ACTIONABLE'
      && operationalHistory.strongHistoricalCandidate === true
      && operationalHistory.strongHistoricalSupport === true
      && operationalHistory.exactHistoricalIdentity === true
      && explicitDetectorEvidence) {
    mustHavePositiveSignal = true;
    strength = 'STRONG_EXACT_IDENTITY_HISTORY';
    reason = detector.reason;
    supportingSources = ['Exact episode history'];
  } else if (noiseType === 'AUTO_RESOLVED'
      && authoritativeRecovery.recovered && explicitDetectorEvidence) {
    mustHavePositiveSignal = true;
    strength = 'AUTHORITATIVE_SAME_OCCURRENCE_RECOVERY';
    reason = detector.reason;
    supportingSources = [facts.source];
  } else if (['FLAPPING', 'STALE'].includes(noiseType) && explicitDetectorEvidence) {
    mustHavePositiveSignal = true;
    strength = 'AUTHORITATIVE_SOURCE_LIFECYCLE';
    reason = detector.reason;
    supportingSources = [facts.source];
  } else if (['DUPLICATE', 'REPEAT', 'CORRELATED'].includes(noiseType) && explicitDetectorEvidence) {
    mustHavePositiveSignal = true;
    strength = 'STRUCTURED_EPISODE_RELATIONSHIP';
    reason = detector.reason;
    supportingSources = ['Episode correlation'];
  } else if (noiseType === 'NON_ACTIONABLE' && explicitDetectorEvidence) {
    mustHavePositiveSignal = true;
    strength = 'EXPLICIT_NON_ACTIONABLE_EVIDENCE';
    reason = detector.reason;
    supportingSources = unique(facts.allEvidence
      .filter((item) => detector.evidenceIds.includes(evidenceId(item)))
      .map((item) => item.source));
  }

  const contradictoryEvidence = unique([
    facts.lifecycleConflict ? 'AUTHORITATIVE_LIFECYCLE_CONFLICT' : null,
    noiseType === 'AUTO_RESOLVED' && authoritativeRecovery.currentlyFiring
      ? 'AUTHORITATIVE_SOURCE_STILL_FIRING' : null,
    noiseType === 'AUTO_RESOLVED' && manualOperationalResponse(facts)
      ? 'MANUAL_INTERVENTION_OBSERVED' : null,
    noiseType === 'NON_ACTIONABLE' && detector?.observed !== true
      ? 'NON_ACTIONABLE_DETECTOR_NOT_OBSERVED' : null,
    noiseType === 'OPERATIONALLY_NON_ACTIONABLE' && !operationalHistory.exactHistoricalIdentity
      ? 'NO_EXACT_STRUCTURED_IDENTITY_HISTORY' : null,
  ]);
  return {
    mustHavePositiveSignal: mustHavePositiveSignal && contradictoryEvidence.length === 0,
    noiseType: noiseType === 'INFORMATIONAL_PRIORITY' ? 'INFORMATIONAL' : noiseType,
    positiveReason: mustHavePositiveSignal ? reason : null,
    evidenceIds: unique(detector?.evidenceIds || []),
    supportingSources: unique(supportingSources),
    strength,
    contradictoryEvidence,
  };
}

function recommendDecision({ source, facts, vector, dimensions, noiseDetection }) {
  const reasons = [];
  const failureReasons = [];
  const sourceUnavailable = facts.sourceUnavailable || facts.primaryStatus !== 'working' || !facts.evaluable;
  const informationalPriority = dimensions.prioritySignal === 'INFORMATIONAL_PRIORITY';
  const fallback = dimensions.provenance.fallbackOperationalEvidence || {};
  const episode = dimensions.provenance.episode || {};
  const notificationRole = dimensions.notificationRole || 'UNKNOWN';
  const occurrenceAwareIdentityUnconfirmed = episode.episodeIdentityStatus === 'IDENTITY_UNCONFIRMED'
    || episode.episodeGroupingBasis === 'UNRESOLVED_IDENTITY_ISOLATED';
  const validEpisodeIdentity = !occurrenceAwareIdentityUnconfirmed
    && (!episode.fingerprintHash || episode.fingerprintStrength !== 'AMBIGUOUS');
  const rawStrongOperationalIncident = dimensions.provenance.strongOperationalIncidentEvidence === true;
  const strongOperationalIncidentEvidenceIds = unique(
    dimensions.provenance.strongOperationalIncidentEvidenceIds || [],
  );
  const technicalConditionObserved = dimensions.provenance.technicalConditionObserved === true;
  const confirmedIncident = dimensions.underlyingEvent === 'CONFIRMED_INCIDENT';
  const independentStrongIncidentEvidence = confirmedIncident || (
    rawStrongOperationalIncident
      && dimensions.provenance.independentOperationalHandling === true
      && strongOperationalIncidentEvidenceIds.length > 0
  );
  const strongOperationalIncident = rawStrongOperationalIncident
    && strongOperationalIncidentEvidenceIds.length > 0
    && (validEpisodeIdentity || independentStrongIncidentEvidence);
  const operationalNonActionability = dimensions.provenance.operationalNonActionability || {};
  const authoritativeRecovery = authoritativeRecoveryProfile(facts);
  const episodeRecoveredWithoutIntervention = authoritativeRecovery.recovered
    && episode.intervention?.operatorActionObserved !== true
    && !manualOperationalResponse(facts);
  const episodeFlapping = noiseDetection.detectors.FLAPPING.observed === true;
  const episodeRepeatNoise = ['REPEAT', 'DUPLICATE', 'CORRELATED', 'REDUNDANT', 'CORRELATED_SECONDARY'].includes(notificationRole);
  const validOperationalIdentity = fallback.operationalAlertValid && validEpisodeIdentity;
  const validNotificationIdentity = fallback.maintenanceNotificationIdentityValid === true;
  const validDecisionIdentity = (validOperationalIdentity && validEpisodeIdentity)
    || validNotificationIdentity || independentStrongIncidentEvidence;
  const maintenanceNoiseSafe = validNotificationIdentity
    && !confirmedIncident
    && !strongOperationalIncident
    && facts.authoritativeActiveSources.length === 0
    && fallback.remediated !== true
    && fallback.escalated !== true
    && !facts.lifecycleConflict;
  if (sourceUnavailable) {
    failureReasons.push('SOURCE_API_UNAVAILABLE_EVIDENCE_GAP');
    reasons.push('Source monitoring API unavailable; fallback operational evidence used.');
  }

  let episodeDecision = 'REVIEW';
  let episodeDecisionBasis = 'EPISODE_OPERATIONAL_EVIDENCE_AMBIGUOUS';
  if (!validDecisionIdentity) {
    episodeDecisionBasis = 'EPISODE_IDENTITY_AMBIGUOUS';
  } else if (facts.lifecycleConflict) {
    episodeDecisionBasis = 'EPISODE_LIFECYCLE_CONFLICT';
  } else if (confirmedIncident) {
    episodeDecision = 'INCIDENT';
    episodeDecisionBasis = 'CONFIRMED_JIRA_OR_IRM_INCIDENT';
  } else if (strongOperationalIncident) {
    episodeDecision = 'INCIDENT';
    episodeDecisionBasis = 'STRONG_EPISODE_OPERATIONAL_HANDLING';
  } else if (!facts.lifecycleConflict && episodeFlapping && !strongOperationalIncident) {
    episodeDecision = 'NOISE';
    episodeDecisionBasis = 'EPISODE_FLAPPING';
  } else if (!facts.lifecycleConflict && episodeRecoveredWithoutIntervention
    && noiseDetection.observed.includes('AUTO_RESOLVED')) {
    episodeDecision = 'NOISE';
    episodeDecisionBasis = 'EPISODE_AUTO_RESOLVED';
  } else if (informationalPriority && fallback.informationalDefault
    && maintenanceNoiseSafe && !technicalConditionObserved) {
    episodeDecision = 'NOISE';
    episodeDecisionBasis = 'EPISODE_INFORMATIONAL_PRIORITY';
  } else if (operationalNonActionability.strongHistoricalCandidate
      && noiseDetection.detectors.OPERATIONALLY_NON_ACTIONABLE.observed === true) {
    episodeDecision = 'NOISE';
    episodeDecisionBasis = 'EPISODE_OPERATIONALLY_NON_ACTIONABLE';
  } else if (fallback.strongNonActionable && !strongOperationalIncident
      && noiseDetection.detectors.NON_ACTIONABLE.observed === true) {
    episodeDecision = 'NOISE';
    episodeDecisionBasis = 'EPISODE_NON_ACTIONABLE';
  }

  let finalDecision = 'NEEDS_REVIEW';
  let decisionBasis = 'EPISODE_REVIEW_REQUIRED';
  if (!validDecisionIdentity) {
    decisionBasis = 'INVALID_OR_AMBIGUOUS_OPERATIONAL_ALERT_IDENTITY';
    reasons.push('A valid operational alert and deterministic episode identity are required before Incident or Noise can be recommended.');
  } else if (episodeRepeatNoise) {
    finalDecision = 'NOISE';
    decisionBasis = ['DUPLICATE', 'REDUNDANT'].includes(notificationRole) ? 'EPISODE_DUPLICATE_NOTIFICATION'
      : ['CORRELATED', 'CORRELATED_SECONDARY'].includes(notificationRole)
        ? 'EPISODE_CORRELATED_NOTIFICATION' : 'EPISODE_REPEAT_NOTIFICATION';
    reasons.push(`The ${notificationRole.toLowerCase()} notification represents episode ${episode.episodeId || 'the current episode'} and does not represent a separate underlying event.`);
    reasons.push(`The underlying episode remains ${episodeDecision}; operational context on this notification is retained on the episode without creating another Incident.`);
  } else if (!facts.evidenceExhausted) {
    decisionBasis = 'EVIDENCE_COLLECTION_INCOMPLETE';
    reasons.push('The bounded evidence package is incomplete, so the episode remains reviewable.');
  } else if (facts.lifecycleConflict) {
    decisionBasis = 'LIFECYCLE_CONFLICT';
    reasons.push('Authoritative source evidence conflicts about whether the same episode is firing or recovered.');
  } else if (fallback.contradictory) {
    decisionBasis = 'CONTRADICTORY_FALLBACK_EVIDENCE';
    reasons.push('Actionable and non-actionable episode evidence conflict, so human review remains necessary.');
  } else if (sourceUnavailable && fallback.awaitingLifecycleEvidence) {
    decisionBasis = 'AWAITING_LIFECYCLE_EVIDENCE';
    reasons.push(`The current ${fallback.durationSeconds}-second occurrence is still below its exact-source historical median of ${fallback.historicalMedian} seconds; later lifecycle evidence is required.`);
  } else if (notificationRole === 'RECOVERY' && episodeRecoveredWithoutIntervention) {
    finalDecision = 'NOISE';
    decisionBasis = 'EPISODE_RECOVERY_NOTIFICATION';
    reasons.push('This notification reports authoritative recovery of the existing episode without separate intervention.');
  } else if (episodeDecision === 'INCIDENT') {
    finalDecision = 'INCIDENT';
    decisionBasis = episodeDecisionBasis;
    reasons.push(confirmedIncident
      ? 'A confirmed bounded Jira or IRM relationship represents the episode as an Incident.'
      : 'The active episode has strong operational handling evidence beyond acknowledgement or technical abnormality alone.');
  } else if (episodeDecision === 'NOISE') {
    finalDecision = 'NOISE';
    decisionBasis = episodeDecisionBasis;
    reasons.push(episodeDecisionBasis === 'EPISODE_FLAPPING'
      ? 'Source-supported firing and recovery transitions establish flapping for the exact episode.'
      : episodeDecisionBasis === 'EPISODE_AUTO_RESOLVED'
        ? 'The exact episode recovered without meaningful operator intervention.'
        : episodeDecisionBasis === 'EPISODE_INFORMATIONAL_PRIORITY'
          ? 'The valid informational-priority episode has no contradictory technical or operational Incident evidence.'
          : episodeDecisionBasis === 'EPISODE_OPERATIONALLY_NON_ACTIONABLE'
            ? 'Strong exact structured-identity history shows at least five prior episodes consistently closed without meaningful operational action or Jira Incident association.'
          : 'Positive episode evidence supports non-actionable behavior.');
  } else if (technicalConditionObserved) {
    decisionBasis = 'TECHNICAL_CONDITION_WITHOUT_INCIDENT_OR_NOISE_PROOF';
    reasons.push('A real technical condition is present, but persistence, severity, recurrence, or abnormal duration alone does not establish an operational Incident.');
  } else {
    reasons.push('The episode evidence does not yet establish either operational Incident handling or a supported Noise mechanism.');
  }

  const candidateNoiseEvidence = positiveNoiseEvidenceProfile({
    decisionBasis, facts, dimensions, noiseDetection,
  });
  if (finalDecision === 'NOISE' && !candidateNoiseEvidence.mustHavePositiveSignal) {
    finalDecision = 'NEEDS_REVIEW';
    decisionBasis = 'NO_POSITIVE_NOISE_EVIDENCE';
    failureReasons.push('NO_POSITIVE_NOISE_EVIDENCE');
    reasons.push('Noise requires an explicit supported positive signal; closure and absent Incident handling alone are insufficient.');
    if (episodeDecision === 'NOISE') {
      episodeDecision = 'REVIEW';
      episodeDecisionBasis = 'EPISODE_NO_POSITIVE_NOISE_EVIDENCE';
    }
  }
  const noiseEvidence = finalDecision === 'NOISE'
    ? candidateNoiseEvidence
    : { ...candidateNoiseEvidence, mustHavePositiveSignal: false };
  const decisionSupportScore = finalDecision === 'NOISE'
    ? average([vector.noiseEvidence.score, vector.redundancyEvidence.score, vector.dataCompleteness.score])
    : finalDecision === 'INCIDENT'
      ? average([vector.incidentEvidence.score, vector.sourceEvidence.score, vector.persistenceEvidence.score, vector.dataCompleteness.score])
      : average([Math.max(vector.incidentEvidence.score || 0, vector.noiseEvidence.score || 0), vector.dataCompleteness.score]);
  const decisionBlockers = buildDecisionBlockers({ source, facts, dimensions, noiseDetection, finalDecision });
  const reviewSubReason = finalDecision !== 'NEEDS_REVIEW' ? null
    : facts.lifecycleConflict ? 'LIFECYCLE_CONFLICT'
      : !validDecisionIdentity
        || !fallback.identityAvailable && !fallback.meaningfulEvidence ? 'IDENTITY_AMBIGUITY'
        : fallback.contradictory ? 'EVIDENCE_CONFLICT'
          : fallback.awaitingLifecycleEvidence ? 'AWAITING_LIFECYCLE_EVIDENCE'
            : sourceUnavailable ? 'SOURCE_EVIDENCE_UNAVAILABLE'
              : decisionBlockers.length ? 'GENUINELY_AMBIGUOUS' : 'OTHER';
  const internalNoiseType = finalDecision !== 'NOISE' ? null
    : EPISODE_NOISE_TYPES[decisionBasis]
      || (decisionBasis === 'FALLBACK_NON_ACTIONABLE_NOTIFICATION' && noiseDetection.primary === 'UNKNOWN'
        ? 'NON_ACTIONABLE' : noiseDetection.primary);
  const noiseType = internalNoiseType === 'INFORMATIONAL_PRIORITY' ? 'INFORMATIONAL' : internalNoiseType;
  return {
    confidence: DECISION_CONFIDENCE,
    decisionBasis,
    decisionSupportScore,
    evidenceScore: decisionSupportScore,
    failureReasons,
    finalDecision,
    episodeDecision,
    episodeDecisionBasis,
    episodeDecisionEvidence: {
      confirmedIncident,
      episodeFlapping,
      recoveredWithoutIntervention: episodeRecoveredWithoutIntervention,
      strongOperationalIncident,
      rawStrongOperationalIncident,
      independentStrongIncidentEvidence,
      strongOperationalIncidentEvidenceIds,
      technicalConditionObserved,
      operationalNonActionability,
    },
    reasons: unique(reasons),
    decisionBlockers,
    evidenceExhausted: facts.evidenceExhausted && reviewSubReason !== 'AWAITING_LIFECYCLE_EVIDENCE',
    decisionFinalized: facts.evidenceExhausted && reviewSubReason !== 'AWAITING_LIFECYCLE_EVIDENCE',
    noiseType,
    noiseEvidence,
    reviewQuestion: finalDecision === 'NEEDS_REVIEW'
      ? decisionBlockers.map((item) => item.field + ': ' + item.missingEvidence).join(' ') : null,
    reviewSubReason,
    whyNoise: finalDecision === 'NOISE'
      ? decisionBasis.startsWith('EPISODE_')
        ? reasons.join(' ')
        : noiseExplanation({ facts, dimensions, noiseDetection, decisionBasis }) : null,
  };
}

function evaluateUnifiedEvidence({ record, blocks = [], technicalEvidence = {}, source, featureAsOf }) {
  const { classification, facts, noiseDetection, vector } = buildEvidenceVector({
    record, blocks, technicalEvidence, source, featureAsOf,
  });
  const dimensions = operationalDimensions({ record, facts, vector, noiseDetection, classification });
  const recommendation = recommendDecision({ source, facts, vector, dimensions, noiseDetection });
  const dimensionDetails = {
    prioritySignal: {
      value: dimensions.prioritySignal,
      reason: dimensions.prioritySignal === 'CRITICAL_OPERATIONAL_PRIORITY'
        ? 'P1 is a critical operational-priority signal; corroborating evidence is still required for an Incident or Noise recommendation.'
        : dimensions.prioritySignal === 'INFORMATIONAL_PRIORITY'
          ? 'P4/P5 is an informational priority signal; it is not an automatic Noise label.'
          : 'Priority is retained as operational evidence and never decides the outcome by itself.',
      evidenceIds: [],
    },
    noiseDetection: {
      value: noiseDetection.primary,
      reason: noiseDetection.primary === 'NO_STRONG_NOISE_PATTERN'
        ? 'No supported Noise observation is present in the available lifecycle and operational evidence.'
        : noiseDetection.primary === 'UNKNOWN' ? 'Source evidence is insufficient to assess Noise behavior.'
          : noiseDetection.detectors[noiseDetection.primary]?.reason,
      evidenceIds: noiseDetection.primary in noiseDetection.detectors
        ? noiseDetection.detectors[noiseDetection.primary].evidenceIds : [],
    },
    classification: {
      value: `${classification.domain}/${classification.subtype}`,
      reason: classification.reason,
      evidenceIds: classification.evidenceIds,
    },
    ...dimensions.details,
  };
  const scores = {
    incidentEvidenceScore: vector.incidentEvidence.score,
    noiseEvidenceScore: vector.noiseEvidence.score,
    evidenceCompleteness: vector.dataCompleteness.score,
    decisionSupportScore: recommendation.decisionSupportScore,
    calibratedProbability: false,
  };
  const positiveIncidentEvidence = recommendation.finalDecision !== 'INCIDENT' || Boolean(
    facts.confirmedJiraEvidence.length || facts.irmIncidentEvidence.length
      || dimensions.provenance.strongOperationalIncidentEvidence,
  );
  const noiseEvidenceProvenance = recommendation.finalDecision !== 'NOISE'
    || recommendation.noiseEvidence.mustHavePositiveSignal === true;
  const ignoredContradictoryIncidentEvidence = recommendation.finalDecision === 'NOISE'
    && !['REPEAT', 'DUPLICATE', 'CORRELATED', 'REDUNDANT', 'CORRELATED_SECONDARY'].includes(dimensions.notificationRole)
    && dimensions.underlyingEvent === 'CONFIRMED_INCIDENT';
  return {
    actionability: dimensions.actionability,
    businessImpact: dimensions.businessImpact,
    classification,
    decisionConfidence: recommendation.confidence,
    decisionPolicy: DECISION_POLICY_VERSION,
    evaluationStatus: EVALUATION_STATUS,
    evidenceScore: recommendation.evidenceScore,
    evidenceScores: scores,
    evidenceVector: vector,
    explanation: {
      decisionBasis: recommendation.decisionBasis,
      decisionBlockers: recommendation.decisionBlockers,
      decisionFinalized: recommendation.decisionFinalized,
      dimensionDetails,
      dimensions: dimensions.provenance,
      episode: facts.episode ? {
        episodeId: facts.episode.episodeId,
        fingerprintHash: facts.episode.fingerprintHash,
        fingerprintStrength: facts.episode.fingerprintStrength,
        episodeGroupingBasis: facts.episode.episodeGroupingBasis,
        episodeIdentityStatus: facts.episode.episodeIdentityStatus,
        notificationCount: facts.episode.notificationCount,
        notificationRole: facts.episode.notificationRole,
        historicalBehavior: facts.episode.historicalBehavior,
        episodeDecision: recommendation.episodeDecision,
        episodeDecisionBasis: recommendation.episodeDecisionBasis,
        decisionEvidence: recommendation.episodeDecisionEvidence,
      } : {
        episodeId: null,
        episodeDecision: recommendation.episodeDecision,
        episodeDecisionBasis: recommendation.episodeDecisionBasis,
        decisionEvidence: recommendation.episodeDecisionEvidence,
      },
      evidenceGaps: facts.sourceUnavailable ? [{
        code: 'SOURCE_API_UNAVAILABLE',
        effect: 'REDUCED_EVIDENCE_COMPLETENESS',
        decisionBlocker: false,
      }] : [],
      evidenceExhausted: recommendation.evidenceExhausted,
      fallbackEvidenceUsed: facts.sourceUnavailable,
      fallbackResolved: facts.sourceUnavailable && recommendation.finalDecision !== 'NEEDS_REVIEW',
      maintenanceNotification: facts.maintenanceNotification,
      genuinelyAmbiguous: recommendation.reviewSubReason === 'GENUINELY_AMBIGUOUS',
      reevaluationEligible: recommendation.reviewSubReason === 'AWAITING_LIFECYCLE_EVIDENCE',
      reviewSubReason: recommendation.reviewSubReason,
      stateSemantics: {
        evidenceRetrievalState: facts.sourceUnavailable ? 'UNAVAILABLE'
          : facts.evaluable ? 'COMPLETE' : 'PARTIAL',
        jsmWorkflowState: facts.currentAlertStatus || 'UNKNOWN',
        monitoringOccurrenceLifecycle: facts.lifecycleConflict ? 'CONFLICT'
          : facts.monitoringLifecycle?.persistence?.currentlyFiring === true ? 'FIRING'
            : facts.monitoringLifecycle?.recovery?.recovered === true ? 'RECOVERED'
              : facts.lifecycle.activeNow.length > 0 ? 'FIRING'
                : facts.lifecycle.recoveredNow.length > 0 ? 'RECOVERED' : 'UNKNOWN',
      },
      evidenceSearches: facts.evidenceSearches,
      noiseType: recommendation.noiseType,
      noiseEvidence: recommendation.noiseEvidence,
      qualityAudit: {
        humanOutcomeSeparate: true,
        ignoredContradictoryIncidentEvidence,
        incidentPositiveEvidence: positiveIncidentEvidence,
        materialReviewBlocker: recommendation.finalDecision !== 'NEEDS_REVIEW'
          || recommendation.decisionBlockers.length > 0,
        noiseEvidenceProvenance,
        supportedNoiseMechanism: recommendation.finalDecision !== 'NOISE'
          || recommendation.noiseEvidence.mustHavePositiveSignal === true,
      },
      reasons: recommendation.reasons,
      reviewPriority: recommendation.finalDecision === 'NOISE' ? 1
        : recommendation.finalDecision === 'INCIDENT' ? 3 : 4,
      reviewQuestion: recommendation.reviewQuestion,
      structuredOnly: true,
      whyNoise: recommendation.whyNoise,
    },
    failureReasons: recommendation.failureReasons,
    finalDecision: recommendation.finalDecision,
    noiseDetection,
    notificationRole: dimensions.notificationRole,
    prioritySignal: dimensions.prioritySignal,
    sourceDetails: sourceDetails(blocks),
    sourceProvenance: monitoringBlocks(blocks).map((block) => ({
      adapter: block.adapter,
      evidenceCount: Number(block.evidence?.length || 0),
      failureReason: block.failureReason || null,
      readOnly: block.readOnly !== false,
      source: block.source,
      status: block.status,
    })),
    underlyingEvent: dimensions.underlyingEvent,
  };
}

module.exports = {
  DECISION_CONFIDENCE,
  DECISION_POLICY_VERSION,
  EVALUATION_STATUS,
  average,
  buildEvidenceVector,
  evaluateUnifiedEvidence,
  interpretClassification,
  interpretNoiseDetection,
  lifecycleSummary,
  operationalDimensions,
  prioritySignal,
  recommendDecision,
  sourceDetails,
  STALE_OBSERVATION_MS,
};

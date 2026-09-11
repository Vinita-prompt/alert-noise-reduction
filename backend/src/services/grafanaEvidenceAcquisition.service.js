const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const grafanaService = require('./grafanaDashboard.service');
const alertEpisodeService = require('./alertEpisode.service').service;
const identityRelationshipEnrichmentService = require('./identityRelationshipEnrichment.service').service;
const { extractRawOperationsIdentity } = require('./rawOperationsIdentity.service');

const migrationSql = [
  '../db/migrations/050_grafana_source_evidence.sql',
  '../db/migrations/052_grafana_loki_lifecycle.sql',
].map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const TRIGGER_WINDOW_MS = 10 * 60 * 1000;
// Lifecycle reads remain bounded by the acquisition window, but recovery is
// not capped at two hours. A long-running exact fingerprint must be allowed to
// reach its authoritative Normal transition inside the bounded query.
const RECOVERY_WINDOW_MS = MAX_WINDOW_MS;
const FAILURE_CLASSIFICATIONS = Object.freeze([
  'RULE_UID_MISSING', 'INSTANCE_IDENTITY_MISSING', 'MULTIPLE_CANDIDATES',
  'TIMESTAMP_MISMATCH', 'LABEL_MISMATCH', 'NO_SOURCE_STATE', 'NO_CANDIDATE',
  'API_ENDPOINT_UNAVAILABLE', 'PERMISSION_DENIED', 'OTHER',
]);
const IMPORTANT_RECONCILIATION_ALERTS = Object.freeze([
  '174694', '174780', '174833', '174814', '174813', '174698',
]);

let schemaPromise = null;

function clean(value) {
  return String(value ?? '').trim();
}

function canonical(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => String(value)))];
}

function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMs(value) {
  const date = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(date) ? date : null;
}

function safeJson(value, fallback) {
  return value && typeof value === 'object' ? value : fallback;
}

function tagMap(payload = {}) {
  return (Array.isArray(payload.tags) ? payload.tags : []).reduce((result, raw) => {
    const value = clean(raw);
    const separator = value.indexOf(':');
    if (separator <= 0) return result;
    const key = value.slice(0, separator).trim();
    const label = value.slice(separator + 1).trim();
    if (key && label && result[key] === undefined) result[key] = label;
    return result;
  }, {});
}

function tagValue(labels, names) {
  const wanted = names.map((name) => canonical(name));
  const match = Object.entries(labels || {}).find(([key]) => wanted.includes(canonical(key)));
  return match?.[1] || null;
}

function sourceIntegrationHost(payload = {}) {
  return clean(payload.integrationName || payload.integrationType)
    .match(/grafana[^()]*(?:\(|\bat\s+)([a-z0-9.-]+\.[a-z]{2,})(?:\)|\b)/i)?.[1]?.toLowerCase() || null;
}

const NON_IDENTITY_LABELS = new Set([
  'alertname', 'grafana folder', 'grafana_folder', 'severity', 'priority', 'og priority', 'og_priority',
  'page', 'room', 'slack', 'send', 'prometheus', 'prometheus replica', 'prometheus_replica',
]);

function instanceLabels(labels = {}) {
  return Object.fromEntries(Object.entries(labels).filter(([key, value]) => {
    if (value === null || value === undefined || value === '') return false;
    const normalizedKey = canonical(key);
    if (!normalizedKey || NON_IDENTITY_LABELS.has(normalizedKey) || String(key).startsWith('__')) return false;
    return true;
  }));
}

function directRuleUids(alert = {}) {
  const extraction = extractRawOperationsIdentity({
    ...safeJson(alert.raw_payload, {}),
    extractedDetails: safeJson(alert.extracted_details, {}),
    sourceUrl: alert.source_url,
    title: alert.title,
  }, { alertId: alert.id, source: 'Grafana' });
  return unique(extraction.extracted?.ruleUids || []);
}

function messageUidCandidates(alert, rules) {
  const ruleUids = new Set((rules || []).map((rule) => String(rule.uid)));
  const tokens = clean(alert.raw_payload?.message || alert.title).match(/\b[a-zA-Z][a-zA-Z0-9_-]{7,159}\b/g) || [];
  return unique(tokens.filter((token) => ruleUids.has(token)));
}

function resolveRule(alert, rules, configuredHost) {
  const payload = safeJson(alert.raw_payload, {});
  const labels = tagMap(payload);
  const alertName = tagValue(labels, ['alertname', 'rule_name']) || null;
  const folder = tagValue(labels, ['grafana_folder', 'folder']) || null;
  const integrationHost = sourceIntegrationHost(payload);
  if (integrationHost && configuredHost && integrationHost !== configuredHost) {
    return {
      rule: null, alertName, folder, labels, integrationHost,
      identityQuality: 'UNRESOLVED', failureClassification: 'API_ENDPOINT_UNAVAILABLE',
      blocker: `The stored alert belongs to Grafana host ${integrationHost}, but that host is not configured for this backend.`,
      diagnosticUidCandidates: messageUidCandidates(alert, rules),
    };
  }
  const uids = directRuleUids(alert);
  const direct = rules.filter((rule) => uids.includes(String(rule.uid)));
  if (direct.length === 1) return {
    rule: direct[0], alertName: alertName || direct[0].title, folder, labels, integrationHost,
    identityQuality: 'AUTHORITATIVE', matchMethod: 'EXACT_STRUCTURED_RULE_UID',
    failureClassification: null, blocker: null, diagnosticUidCandidates: [],
  };
  if (direct.length > 1) return {
    rule: null, alertName, folder, labels, integrationHost,
    identityQuality: 'UNRESOLVED', failureClassification: 'MULTIPLE_CANDIDATES',
    blocker: 'Multiple structured Grafana rule UIDs were present in the stored alert payload.',
    diagnosticUidCandidates: uids,
  };
  if (alertName) {
    const exact = rules.filter((rule) => canonical(rule.title) === canonical(alertName)
      && (!folder || canonical(rule.folderTitle) === canonical(folder)));
    if (exact.length === 1) return {
      rule: exact[0], alertName, folder, labels, integrationHost,
      identityQuality: 'STRUCTURED', matchMethod: 'UNIQUE_EXACT_RULE_NAME_AND_FOLDER_IN_AUTHENTICATED_INVENTORY',
      failureClassification: null, blocker: null, diagnosticUidCandidates: messageUidCandidates(alert, rules),
    };
    if (exact.length > 1) return {
      rule: null, alertName, folder, labels, integrationHost,
      identityQuality: 'UNRESOLVED', failureClassification: 'MULTIPLE_CANDIDATES',
      blocker: 'Multiple Grafana rules share the exact stored rule name and folder.',
      diagnosticUidCandidates: messageUidCandidates(alert, rules),
    };
  }
  const diagnostic = messageUidCandidates(alert, rules);
  return {
    rule: null, alertName, folder, labels, integrationHost,
    identityQuality: diagnostic.length === 1 ? 'SIGNATURE_FALLBACK' : 'UNRESOLVED',
    failureClassification: alertName ? 'NO_CANDIDATE' : 'RULE_UID_MISSING',
    blocker: diagnostic.length === 1
      ? 'A UID-like token appears only in unstructured message text; it is retained as diagnostic evidence and is not accepted as occurrence identity.'
      : alertName ? 'No rule in the authenticated Grafana inventory exactly matches the stored rule name and folder.'
        : 'No structured Grafana rule UID or rule name was preserved in the alert payload.',
    diagnosticUidCandidates: diagnostic,
  };
}

function isTrigger(item) {
  return /alerting|firing/i.test(clean(item?.state))
    && !/alerting|firing/i.test(clean(item?.previousState));
}

function isRecovery(item) {
  return /normal|ok|resolved|inactive/i.test(clean(item?.state));
}

function isPending(item) {
  return /pending/i.test(clean(item?.state));
}

function labelsMatch(actualLabels = {}, expectedLabels = {}) {
  const expected = instanceLabels(expectedLabels);
  const actual = new Map(Object.entries(instanceLabels(actualLabels))
    .map(([key, value]) => [canonical(key), clean(value)]));
  const entries = Object.entries(expected);
  return entries.length > 0 && entries.every(([key, value]) => (
    actual.has(canonical(key)) && actual.get(canonical(key)) === clean(value)
  ));
}

function matchingHistory(items, rule, labels) {
  return (items || []).filter((item) => String(item.ruleUid || '') === String(rule.uid)
    && canonical(item.ruleName || item.labels?.alertname) === canonical(rule.title)
    && labelsMatch(item.labels || {}, labels));
}

function lifecycleSequence(events = []) {
  const ordered = [...events].sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const values = [ordered[0]?.previousState, ...ordered.map((item) => item.state)].filter(Boolean);
  return values.filter((value, index) => index === 0 || canonical(value) !== canonical(values[index - 1]));
}

function lifecycleForTrigger(items, trigger, activeItems = [], observedAt = Date.now()) {
  const triggerMs = toMs(trigger?.timestamp);
  const fingerprint = clean(trigger?.fingerprint) || null;
  const exact = (items || []).filter((item) => !fingerprint || clean(item.fingerprint) === fingerprint)
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const triggerIndex = exact.indexOf(trigger);
  let pending = null;
  for (let index = triggerIndex - 1; index >= 0; index -= 1) {
    const item = exact[index];
    if (isRecovery(item) || isTrigger(item)) break;
    if (isPending(item)) { pending = item; break; }
  }
  const nextTrigger = exact.find((item) => toMs(item.timestamp) > triggerMs && isTrigger(item)) || null;
  const recovery = exact.find((item) => toMs(item.timestamp) > triggerMs
    && (!nextTrigger || toMs(item.timestamp) < toMs(nextTrigger.timestamp)) && isRecovery(item)) || null;
  const startMs = toMs(pending?.timestamp) ?? triggerMs;
  const endMs = toMs(recovery?.timestamp) ?? toMs(nextTrigger?.timestamp) ?? toMs(observedAt);
  const events = exact.filter((item) => toMs(item.timestamp) >= startMs
    && (recovery ? toMs(item.timestamp) <= toMs(recovery.timestamp)
      : nextTrigger ? toMs(item.timestamp) < toMs(nextTrigger.timestamp) : toMs(item.timestamp) <= endMs));
  const activeMatches = (activeItems || []).filter((item) => fingerprint
    && clean(item.fingerprint) === fingerprint && labelsMatch(item.labels || {}, trigger.labels || {}));
  const finalHistoryState = events.at(-1)?.state || trigger.state;
  const currentState = recovery ? 'RECOVERED'
    : activeMatches.length ? 'FIRING'
      : isTrigger({ state: finalHistoryState, previousState: null }) || /alerting|firing/i.test(clean(finalHistoryState))
        ? 'FIRING' : isPending({ state: finalHistoryState }) ? 'PENDING' : 'UNKNOWN';
  return {
    pending,
    trigger,
    recovery,
    events,
    sequence: lifecycleSequence(events),
    transitionCount: events.length,
    pendingSeconds: pending ? Math.max(0, Math.round((triggerMs - toMs(pending.timestamp)) / 1000)) : null,
    firingSeconds: recovery
      ? Math.max(0, Math.round((toMs(recovery.timestamp) - triggerMs) / 1000))
      : Math.max(0, Math.round(((toMs(observedAt) ?? Date.now()) - triggerMs) / 1000)),
    currentState,
    currentInstanceObserved: activeMatches.length > 0,
  };
}

function historicalProfile(items, rule, labels, fingerprint = null) {
  const exact = matchingHistory(items, rule, labels)
    .filter((item) => !fingerprint || clean(item.fingerprint) === clean(fingerprint))
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const triggers = exact.filter(isTrigger);
  const occurrences = triggers.map((trigger) => {
    const lifecycle = lifecycleForTrigger(exact, trigger, [], exact.at(-1)?.timestamp || Date.now());
    return {
      fingerprint: trigger.fingerprint || null,
      firingAt: toIso(trigger.timestamp),
      pendingAt: toIso(lifecycle.pending?.timestamp),
      recoveryAt: toIso(lifecycle.recovery?.timestamp),
      durationSeconds: lifecycle.recovery ? lifecycle.firingSeconds : null,
      pendingDurationSeconds: lifecycle.pendingSeconds,
      recovered: Boolean(lifecycle.recovery),
      transitionCount: lifecycle.transitionCount,
      transitionSequence: lifecycle.sequence,
    };
  });
  const durations = occurrences.map((item) => item.durationSeconds).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (ratio) => durations.length ? durations[Math.floor((durations.length - 1) * ratio)] : null;
  const recovered = occurrences.filter((item) => item.recovered).length;
  const flappingCycleCount = Math.max(0, occurrences.length - 1);
  return {
    exactRuleUid: rule.uid,
    exactFingerprint: fingerprint || null,
    exactInstanceLabels: instanceLabels(labels),
    occurrenceCount: occurrences.length,
    recoveryCount: recovered,
    autoRecoveryRate: occurrences.length
      ? Number((recovered / occurrences.length).toFixed(6)) : null,
    medianDurationSeconds: percentile(0.5),
    p95DurationSeconds: percentile(0.95),
    transitionCount: exact.length,
    transitionSequence: lifecycleSequence(exact),
    flappingCycleCount,
    flappingFrequency: occurrences.length ? Number((flappingCycleCount / occurrences.length).toFixed(6)) : 0,
    notificationsPerOccurrence: null,
    occurrences,
    matchingMethod: 'exactRuleUid+exactFingerprint+exactInstanceLabels',
  };
}

function failureResult({ alert, episodeId, resolution, classification, blocker, evidence = {} }) {
  const failureClassification = FAILURE_CLASSIFICATIONS.includes(classification) ? classification : 'OTHER';
  return {
    alertId: alert.id,
    episodeId,
    workspaceHost: null,
    integrationHost: resolution?.integrationHost || null,
    ruleUid: resolution?.rule?.uid || null,
    ruleName: resolution?.rule?.title || resolution?.alertName || null,
    instanceLabels: instanceLabels(resolution?.labels || {}),
    annotations: resolution?.rule?.annotations || {},
    dashboardUid: resolution?.rule?.dashboard?.uid || null,
    panelId: resolution?.rule?.dashboard?.panelId || null,
    datasourceReferences: resolution?.rule?.datasources || [],
    condition: resolution?.rule?.condition || null,
    pendingAt: null,
    pendingSeconds: null,
    transitionCount: 0,
    transitionSequence: [],
    lifecycleEvidenceQuality: failureClassification === 'MULTIPLE_CANDIDATES' ? 'CONFLICT' : 'UNAVAILABLE',
    firingObserved: false,
    recoveryAuthoritative: false,
    currentInstanceObserved: false,
    repeatNotificationCount: 0,
    identityQuality: resolution?.identityQuality || 'UNRESOLVED',
    mappingStatus: failureClassification,
    failureClassification,
    blocker: blocker || resolution?.blocker || 'Grafana occurrence evidence could not be resolved.',
    sourceResolved: false,
    technicalEvidenceComplete: false,
    evaluable: false,
    matchMethod: resolution?.matchMethod || null,
    matchConfidence: null,
    historicalProfile: {},
    evidence,
    provenance: [],
  };
}

function reconcileOccurrence({ alert, episodeId, resolution, history, historyFailure, workspaceHost,
  activeItems = [], observedAt = Date.now() }) {
  if (!resolution?.rule) return failureResult({
    alert, episodeId, resolution, classification: resolution?.failureClassification, blocker: resolution?.blocker,
    evidence: { diagnosticUidCandidates: resolution?.diagnosticUidCandidates || [] },
  });
  if (historyFailure) return failureResult({
    alert, episodeId, resolution,
    classification: historyFailure.httpStatus === 401 || historyFailure.httpStatus === 403
      ? 'PERMISSION_DENIED' : 'API_ENDPOINT_UNAVAILABLE',
    blocker: historyFailure.error,
    evidence: { endpointCategory: 'alert_state_history', httpStatus: historyFailure.httpStatus },
  });
  const labels = instanceLabels(resolution.labels);
  if (!Object.keys(labels).length) return failureResult({
    alert, episodeId, resolution, classification: 'INSTANCE_IDENTITY_MISSING',
    blocker: 'The stored alert contains no exact Grafana instance/entity labels.',
  });
  const alertMs = toMs(alert.received_at);
  const sameRule = (history || []).filter((item) => String(item.ruleUid) === String(resolution.rule.uid));
  if (!sameRule.length) return failureResult({
    alert, episodeId, resolution, classification: 'NO_SOURCE_STATE',
    blocker: 'No Grafana state-history records were returned for the resolved rule UID.',
  });
  const exactLabels = matchingHistory(sameRule, resolution.rule, resolution.labels);
  if (!exactLabels.length) return failureResult({
    alert, episodeId, resolution, classification: 'LABEL_MISMATCH',
    blocker: 'Grafana returned rule state, but no source occurrence had the exact stored instance/entity labels.',
    evidence: { sourceStateCount: sameRule.length },
  });
  const bounded = exactLabels.filter((item) => isTrigger(item) && alertMs !== null
    && Math.abs(toMs(item.timestamp) - alertMs) <= TRIGGER_WINDOW_MS);
  if (!bounded.length) return failureResult({
    alert, episodeId, resolution, classification: exactLabels.some(isTrigger) ? 'TIMESTAMP_MISMATCH' : 'NO_SOURCE_STATE',
    blocker: exactLabels.some(isTrigger)
      ? 'Exact rule-instance source transitions exist, but none are inside the unchanged ten-minute occurrence window.'
      : 'The exact rule-instance history contains no firing transition.',
    evidence: { exactLabelStateCount: exactLabels.length },
  });
  const byFingerprint = new Map();
  bounded.forEach((item) => {
    const key = clean(item.fingerprint) || JSON.stringify(item.labels || {});
    if (!byFingerprint.has(key)) byFingerprint.set(key, []);
    byFingerprint.get(key).push(item);
  });
  if (byFingerprint.size !== 1 || [...byFingerprint.values()][0].length !== 1) return failureResult({
    alert, episodeId, resolution, classification: 'MULTIPLE_CANDIDATES',
    blocker: 'Multiple exact rule-instance firing transitions exist in the bounded window; timestamp proximity was not used to select one.',
    evidence: { candidateFingerprints: [...byFingerprint.keys()], candidateCount: bounded.length },
  });
  const trigger = bounded[0];
  if (!clean(trigger.fingerprint)) return failureResult({
    alert, episodeId, resolution, classification: 'INSTANCE_IDENTITY_MISSING',
    blocker: 'The exact Grafana firing transition has no fingerprint, so an authoritative alert-instance identity cannot be established.',
    evidence: { exactLabelStateCount: exactLabels.length, boundedCandidateCount: bounded.length },
  });
  const triggerMs = toMs(trigger.timestamp);
  const lifecycle = lifecycleForTrigger(exactLabels, trigger, activeItems, observedAt);
  const recovery = lifecycle.recovery;
  const recoveryAt = toIso(recovery?.timestamp);
  const persistenceSeconds = lifecycle.firingSeconds;
  const sourceOccurrenceId = `${resolution.rule.uid}:${trigger.fingerprint || 'no-fingerprint'}:${toIso(trigger.timestamp)}`;
  const profile = historicalProfile(history, resolution.rule, resolution.labels, trigger.fingerprint);
  return {
    alertId: alert.id,
    episodeId,
    workspaceHost,
    integrationHost: resolution.integrationHost || null,
    ruleUid: resolution.rule.uid,
    ruleName: resolution.rule.title,
    fingerprint: trigger.fingerprint || null,
    sourceOccurrenceId,
    instanceLabels: labels,
    annotations: resolution.rule.annotations || {},
    dashboardUid: trigger.dashboardUid || resolution.rule.dashboard?.uid || null,
    panelId: trigger.panelId || resolution.rule.dashboard?.panelId || null,
    datasourceReferences: resolution.rule.datasources || [],
    condition: trigger.condition || resolution.rule.condition || null,
    occurrenceState: trigger.state,
    currentState: lifecycle.currentState,
    firingAt: toIso(trigger.timestamp),
    recoveryAt,
    persistenceSeconds,
    pendingAt: toIso(lifecycle.pending?.timestamp),
    pendingSeconds: lifecycle.pendingSeconds,
    transitionCount: lifecycle.transitionCount,
    transitionSequence: lifecycle.sequence,
    lifecycleEvidenceQuality: 'AUTHORITATIVE',
    firingObserved: true,
    recoveryAuthoritative: Boolean(recovery),
    currentInstanceObserved: lifecycle.currentInstanceObserved,
    repeatNotificationCount: 0,
    identityQuality: 'AUTHORITATIVE',
    matchMethod: `${resolution.matchMethod}+exactFingerprint+exactInstanceLabels+boundedStateTransition`,
    matchConfidence: 100,
    mappingStatus: 'EXACT_OCCURRENCE_RESOLVED',
    failureClassification: null,
    blocker: null,
    sourceResolved: true,
    technicalEvidenceComplete: true,
    evaluable: true,
    historicalProfile: profile,
    evidence: {
      trigger: { state: trigger.state, previousState: trigger.previousState, timestamp: toIso(trigger.timestamp) },
      recovery: recovery ? { state: recovery.state, previousState: recovery.previousState, timestamp: recoveryAt } : null,
      pending: lifecycle.pending ? {
        state: lifecycle.pending.state, previousState: lifecycle.pending.previousState,
        timestamp: toIso(lifecycle.pending.timestamp),
      } : null,
      lifecycle: {
        quality: 'AUTHORITATIVE', fingerprint: trigger.fingerprint,
        transitionCount: lifecycle.transitionCount, sequence: lifecycle.sequence,
        currentInstanceObserved: lifecycle.currentInstanceObserved,
      },
      rule: {
        uid: resolution.rule.uid, title: resolution.rule.title, folder: resolution.rule.folderTitle || null,
        condition: resolution.rule.condition || null, datasources: resolution.rule.datasources || [],
      },
      matchingWindowSeconds: TRIGGER_WINDOW_MS / 1000,
      lifecycleQueryBoundSeconds: RECOVERY_WINDOW_MS / 1000,
    },
    provenance: [
      { source: 'Grafana authenticated rule inventory', reference: `rule:${resolution.rule.uid}`, readOnly: true },
      { source: 'Grafana alert-state-history Loki', reference: `occurrence:${sourceOccurrenceId}`, readOnly: true },
    ],
  };
}

async function ensureSchema(database = db) {
  if (!schemaPromise) schemaPromise = database.query(migrationSql).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
}

async function persistRows(database, rows) {
  for (const row of rows) {
    await database.query(`
      INSERT INTO grafana_alert_occurrence_evidence (
        alert_id,episode_id,workspace_host,integration_host,rule_uid,rule_name,fingerprint,
        source_occurrence_id,instance_labels,annotations,dashboard_uid,panel_id,datasource_references,
        condition,occurrence_state,current_state,firing_at,recovery_at,persistence_seconds,
        pending_at,pending_seconds,transition_count,transition_sequence,lifecycle_evidence_quality,
        firing_observed,recovery_authoritative,current_instance_observed,repeat_notification_count,
        identity_quality,match_method,match_confidence,mapping_status,failure_classification,blocker,
        source_resolved,technical_evidence_complete,evaluable,historical_profile,evidence,provenance,
        observed_at,updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16,
        $17::timestamptz,$18::timestamptz,$19,$20::timestamptz,$21,$22,$23::jsonb,$24,
        $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
        $38::jsonb,$39::jsonb,$40::jsonb,NOW(),NOW()
      ) ON CONFLICT (alert_id) DO UPDATE SET
        episode_id=EXCLUDED.episode_id,workspace_host=EXCLUDED.workspace_host,
        integration_host=EXCLUDED.integration_host,rule_uid=EXCLUDED.rule_uid,rule_name=EXCLUDED.rule_name,
        fingerprint=EXCLUDED.fingerprint,source_occurrence_id=EXCLUDED.source_occurrence_id,
        instance_labels=EXCLUDED.instance_labels,annotations=EXCLUDED.annotations,
        dashboard_uid=EXCLUDED.dashboard_uid,panel_id=EXCLUDED.panel_id,
        datasource_references=EXCLUDED.datasource_references,condition=EXCLUDED.condition,
        occurrence_state=EXCLUDED.occurrence_state,current_state=EXCLUDED.current_state,
        firing_at=EXCLUDED.firing_at,recovery_at=EXCLUDED.recovery_at,
        persistence_seconds=EXCLUDED.persistence_seconds,pending_at=EXCLUDED.pending_at,
        pending_seconds=EXCLUDED.pending_seconds,transition_count=EXCLUDED.transition_count,
        transition_sequence=EXCLUDED.transition_sequence,
        lifecycle_evidence_quality=EXCLUDED.lifecycle_evidence_quality,
        firing_observed=EXCLUDED.firing_observed,recovery_authoritative=EXCLUDED.recovery_authoritative,
        current_instance_observed=EXCLUDED.current_instance_observed,
        repeat_notification_count=EXCLUDED.repeat_notification_count,
        identity_quality=EXCLUDED.identity_quality,
        match_method=EXCLUDED.match_method,match_confidence=EXCLUDED.match_confidence,
        mapping_status=EXCLUDED.mapping_status,failure_classification=EXCLUDED.failure_classification,
        blocker=EXCLUDED.blocker,source_resolved=EXCLUDED.source_resolved,
        technical_evidence_complete=EXCLUDED.technical_evidence_complete,evaluable=EXCLUDED.evaluable,
        historical_profile=EXCLUDED.historical_profile,evidence=EXCLUDED.evidence,
        provenance=EXCLUDED.provenance,observed_at=NOW(),updated_at=NOW()
    `, [
      row.alertId, row.episodeId, row.workspaceHost, row.integrationHost, row.ruleUid, row.ruleName,
      row.fingerprint, row.sourceOccurrenceId, JSON.stringify(row.instanceLabels || {}),
      JSON.stringify(row.annotations || {}), row.dashboardUid, row.panelId,
      JSON.stringify(row.datasourceReferences || []), row.condition, row.occurrenceState, row.currentState,
      row.firingAt, row.recoveryAt, row.persistenceSeconds, row.pendingAt, row.pendingSeconds,
      row.transitionCount || 0, JSON.stringify(row.transitionSequence || []),
      row.lifecycleEvidenceQuality || 'UNAVAILABLE', Boolean(row.firingObserved),
      Boolean(row.recoveryAuthoritative), Boolean(row.currentInstanceObserved),
      row.repeatNotificationCount || 0, row.identityQuality, row.matchMethod,
      row.matchConfidence, row.mappingStatus, row.failureClassification, row.blocker,
      row.sourceResolved, row.technicalEvidenceComplete, row.evaluable,
      JSON.stringify(row.historicalProfile || {}), JSON.stringify(row.evidence || {}),
      JSON.stringify(row.provenance || []),
    ]);
  }
}

async function boundedMap(values, mapper, concurrency = 3) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker));
  return output;
}

function failureCode(error) {
  const status = Number(error?.status || 0) || null;
  return {
    httpStatus: status,
    classification: status === 401 || status === 403 ? 'PERMISSION_DENIED' : 'API_ENDPOINT_UNAVAILABLE',
    error: status === 401 ? 'Grafana authentication failed for a read endpoint.'
      : status === 403 ? 'Grafana denied the required read endpoint.'
        : clean(error?.code || error?.message || 'Grafana read endpoint unavailable.'),
  };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (ratio) => sorted.length ? sorted[Math.floor((sorted.length - 1) * ratio)] : null;
  return {
    count: sorted.length, minSeconds: sorted[0] ?? null, medianSeconds: percentile(0.5),
    p95Seconds: percentile(0.95), maxSeconds: sorted.at(-1) ?? null,
  };
}

function timestampAlignment(rows, alerts) {
  const byId = new Map(alerts.map((alert) => [alert.id, alert]));
  const seconds = (later, earlier) => {
    const left = toMs(later); const right = toMs(earlier);
    return left === null || right === null ? null : Number(((left - right) / 1000).toFixed(3));
  };
  return {
    timezoneNormalization: 'UTC ISO-8601',
    sourceToJsmCreated: distribution(rows.map((row) => seconds(byId.get(row.alertId)?.raw_payload?.createdAt
      || byId.get(row.alertId)?.received_at, row.firingAt))),
    jsmCreatedToSlack: distribution(rows.map((row) => seconds(byId.get(row.alertId)?.slack_message_at,
      byId.get(row.alertId)?.raw_payload?.createdAt || byId.get(row.alertId)?.received_at))),
    jsmCreatedToAcknowledgement: distribution(rows.map((row) => seconds(byId.get(row.alertId)?.raw_payload?.ackTime,
      byId.get(row.alertId)?.raw_payload?.createdAt || byId.get(row.alertId)?.received_at))),
    triggerWindowSeconds: TRIGGER_WINDOW_MS / 1000,
    recoveryWindowSeconds: RECOVERY_WINDOW_MS / 1000,
    windowWidened: false,
  };
}

function coverage(rows) {
  const total = rows.length;
  const count = (predicate) => rows.filter(predicate).length;
  return {
    total,
    sourceResolved: count((row) => row.sourceResolved),
    technicalEvidenceComplete: count((row) => row.technicalEvidenceComplete),
    evaluable: count((row) => row.evaluable),
    recovered: count((row) => row.recoveryAt),
    sourceResolutionRate: total ? Number((count((row) => row.sourceResolved) / total).toFixed(6)) : null,
    evidenceCompleteRate: total ? Number((count((row) => row.technicalEvidenceComplete) / total).toFixed(6)) : null,
    evaluableRate: total ? Number((count((row) => row.evaluable) / total).toFixed(6)) : null,
  };
}

function lifecycleCoverage(rows = [], databaseRows = false) {
  const value = (row, camel, snake = camel) => databaseRows ? row?.[snake] : row?.[camel];
  const labels = (row) => safeJson(value(row, 'instanceLabels', 'instance_labels'), {});
  const predicates = {
    authoritativeIdentity: (row) => value(row, 'identityQuality', 'identity_quality') === 'AUTHORITATIVE',
    ruleUid: (row) => Boolean(value(row, 'ruleUid', 'rule_uid')),
    fingerprint: (row) => Boolean(value(row, 'fingerprint')),
    structuredLabels: (row) => Object.keys(labels(row)).length > 0,
    exactOccurrence: (row) => value(row, 'sourceResolved', 'source_resolved') === true,
    firingLifecycle: (row) => Boolean(value(row, 'firingAt', 'firing_at')),
    recovery: (row) => Boolean(value(row, 'recoveryAt', 'recovery_at')),
    technicalEvidenceComplete: (row) => value(row, 'technicalEvidenceComplete', 'technical_evidence_complete') === true,
  };
  const groups = new Map();
  rows.forEach((row) => {
    const key = value(row, 'episodeId', 'episode_id') || `alert:${value(row, 'alertId', 'alert_id')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const result = { alertRecords: { total: rows.length }, episodes: { total: groups.size } };
  Object.entries(predicates).forEach(([name, predicate]) => {
    result.alertRecords[name] = rows.filter(predicate).length;
    result.episodes[name] = [...groups.values()].filter((group) => group.every(predicate)).length;
  });
  return result;
}

function sourceObservationCounts(report, source) {
  const episodes = (report.episodes || []).filter((item) => item.source === source);
  const episodeIds = new Set(episodes.map((item) => item.episodeId));
  const frozen = Object.fromEntries(['INCIDENT', 'NOISE', 'REVIEW'].map((decision) => [decision,
    episodes.filter((item) => item.currentDecision === decision).length]));
  const sourceEvaluations = (report.observationMode?.evaluations || []).filter((item) => episodeIds.has(item.episodeId));
  const hypothetical = sourceEvaluations.length
    ? Object.fromEntries(['INCIDENT', 'NOISE', 'REVIEW'].map((decision) => [decision,
      sourceEvaluations.filter((item) => item.hypothetical === decision).length]))
    : { ...frozen };
  const changes = (report.observationMode?.changes || []).filter((item) => episodeIds.has(item.episodeId));
  if (!sourceEvaluations.length) changes.forEach((item) => {
    if (hypothetical[item.current] !== undefined) hypothetical[item.current] -= 1;
    if (hypothetical[item.hypothetical] !== undefined) hypothetical[item.hypothetical] += 1;
  });
  return { frozen, hypothetical, changes, evaluations: sourceEvaluations };
}

function createGrafanaEvidenceAcquisitionService({
  database = db,
  client = grafanaService,
  episodes = alertEpisodeService,
  identity = identityRelationshipEnrichmentService,
  clock = () => Date.now(),
} = {}) {
  async function reconcile(options = {}) {
    await ensureSchema(database);
    const now = clock();
    const from = new Date(options.from || now - 24 * 60 * 60 * 1000).getTime();
    const to = new Date(options.to || now).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_WINDOW_MS) {
      const error = new Error('A valid Grafana evidence window of at most 48 hours is required.');
      error.status = 400;
      throw error;
    }
    const [before, snapshot, status, inventory, activeRead, readCapabilities] = await Promise.all([
      identity.analyze({ refresh: options.refresh === true, limit: 100 }),
      episodes.buildSnapshot({ refresh: options.refresh === true }),
      client.getGrafanaWorkspaceStatus({ refresh: options.refresh === true }),
      client.getGrafanaWorkspaceRuleEvidenceInventory({ refresh: options.refresh === true }),
      client.getGrafanaWorkspaceActiveAlerts({ pageSize: 100 })
        .then((result) => ({ items: result.items || [], total: result.total || 0, failure: null }))
        .catch((error) => ({ items: [], total: 0, failure: failureCode(error) })),
      client.getGrafanaWorkspaceAlertingReadCapabilities
        ? client.getGrafanaWorkspaceAlertingReadCapabilities()
        : Promise.resolve(null),
    ]);
    const grafanaEpisodes = (snapshot.episodes || []).filter((episode) => episode.source === 'Grafana');
    const rollingAlertIds = unique(grafanaEpisodes.flatMap((episode) => episode.alertIds || []));
    const rollingAlertIdSet = new Set(rollingAlertIds);
    const importantAlertRows = (await database.query(`
      SELECT id FROM alerts WHERE atlassian_ops_tiny_id=ANY($1::text[])
    `, [IMPORTANT_RECONCILIATION_ALERTS])).rows;
    const alertIds = unique([
      ...rollingAlertIds,
      ...importantAlertRows.map((row) => row.id),
    ]);
    const alerts = alertIds.length ? (await database.query(`
      SELECT alert.id,alert.atlassian_ops_tiny_id,alert.title,alert.description,alert.status,
             alert.received_at,alert.last_seen_at,alert.raw_payload,alert.extracted_details,
             alert.source_url,slack.message_at AS slack_message_at
      FROM alerts alert
      LEFT JOIN LATERAL (
        SELECT message_at FROM slack_alert_events
        WHERE alert_number=alert.atlassian_ops_tiny_id ORDER BY message_at ASC LIMIT 1
      ) slack ON TRUE
      WHERE alert.id=ANY($1::text[])
    `, [alertIds])).rows : [];
    const priorRows = alertIds.length ? (await database.query(`
      SELECT * FROM grafana_alert_occurrence_evidence WHERE alert_id=ANY($1::text[])
    `, [alertIds])).rows : [];
    const priorByAlert = new Map(priorRows.map((row) => [row.alert_id, row]));
    const episodeByAlert = new Map(grafanaEpisodes.flatMap((episode) => (
      (episode.alertIds || []).map((alertId) => [alertId, episode])
    )));
    const resolutions = new Map(alerts.map((alert) => [
      alert.id, resolveRule(alert, inventory.rules || [], inventory.host),
    ]));
    const resolvedRules = [...new Map([...resolutions.values()].filter((item) => item.rule)
      .map((item) => [item.rule.uid, item.rule])).values()];
    const alertsByRule = new Map();
    alerts.forEach((alert) => {
      const uid = resolutions.get(alert.id)?.rule?.uid;
      if (!uid) return;
      if (!alertsByRule.has(uid)) alertsByRule.set(uid, []);
      alertsByRule.get(uid).push(alert);
    });
    const historyReads = await boundedMap(resolvedRules, async (rule) => {
      try {
        const ruleAlerts = alertsByRule.get(rule.uid) || [];
        const earliestAlert = Math.min(...ruleAlerts.map((alert) => toMs(alert.received_at)).filter(Number.isFinite));
        const ruleFrom = Math.max(to - MAX_WINDOW_MS,
          Number.isFinite(earliestAlert) ? earliestAlert - TRIGGER_WINDOW_MS : from);
        const result = await client.getGrafanaWorkspaceAlertStateHistory(rule.uid, {
          from: new Date(ruleFrom).toISOString(), to: new Date(to).toISOString(),
          refresh: options.refresh === true, limit: 1000,
        });
        return [rule.uid, { items: result.items || [], queryWindow: result.queryWindow, datasource: result.datasource }];
      } catch (error) {
        return [rule.uid, { items: [], failure: failureCode(error) }];
      }
    }, 3);
    const historyByRule = new Map(historyReads);
    const rows = alerts.map((alert) => {
      const resolution = resolutions.get(alert.id);
      const history = resolution?.rule ? historyByRule.get(resolution.rule.uid) : null;
      return reconcileOccurrence({
        alert,
        episodeId: episodeByAlert.get(alert.id)?.episodeId || priorByAlert.get(alert.id)?.episode_id || null,
        resolution,
        history: history?.items || [],
        historyFailure: history?.failure || null,
        workspaceHost: inventory.host,
        activeItems: activeRead.items,
        observedAt: to,
      });
    });
    const repeatGroups = new Map();
    rows.filter((row) => row.sourceOccurrenceId).forEach((row) => {
      const key = `${row.episodeId || 'no-episode'}|${row.sourceOccurrenceId}`;
      if (!repeatGroups.has(key)) repeatGroups.set(key, []);
      repeatGroups.get(key).push(row);
    });
    repeatGroups.forEach((group) => group.forEach((row) => {
      row.repeatNotificationCount = Math.max(0, group.length - 1);
      row.historicalProfile = {
        ...(row.historicalProfile || {}),
        notificationsPerOccurrence: group.length,
      };
      row.evidence = {
        ...(row.evidence || {}),
        repeatNotifications: {
          sameRuleUid: row.ruleUid,
          sameFingerprint: row.fingerprint,
          sameSourceOccurrenceId: row.sourceOccurrenceId,
          notificationCount: group.length,
          repeatCount: Math.max(0, group.length - 1),
          alertIds: group.map((item) => item.alertId),
        },
      };
    }));
    await persistRows(database, rows);
    require('./liveOccurrenceAutomation.service').service.enqueue(
      rows.map((row) => row.alertId),
      'SOURCE_EVIDENCE_REVISION',
    );
    // Refresh the existing local read-only rule/state inventory. This does not
    // modify Grafana or any decision/outcome table.
    const inventorySync = await client.syncAlertRulesAndStates().catch((error) => ({ error: failureCode(error).error }));
    const after = await identity.analyze({ refresh: true, limit: 100 });
    const sourceObservationBefore = sourceObservationCounts(before, 'Grafana');
    const sourceObservationAfter = sourceObservationCounts(after, 'Grafana');
    const reviewEpisodes = new Set((before.episodes || []).filter((item) => item.source === 'Grafana'
      && item.currentDecision === 'REVIEW').map((item) => item.episodeId));
    const reviewRows = rows.filter((row) => reviewEpisodes.has(row.episodeId));
    const currentRows = rows.filter((row) => rollingAlertIdSet.has(row.alertId));
    const failureBreakdown = reviewRows.filter((row) => !row.sourceResolved).reduce((summary, row) => {
      const key = row.failureClassification || 'OTHER';
      summary[key] = (summary[key] || 0) + 1;
      return summary;
    }, {});
    const positiveRecoveryCandidates = reviewRows.filter((row) => row.sourceResolved && row.recoveryAt).map((row) => ({
      alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
      episodeId: row.episodeId,
      ruleUid: row.ruleUid,
      ruleName: row.ruleName,
      fingerprint: row.fingerprint,
      firingAt: row.firingAt,
      recoveryAt: row.recoveryAt,
      persistenceSeconds: row.persistenceSeconds,
      pendingAt: row.pendingAt,
      pendingSeconds: row.pendingSeconds,
      lifecycleSequence: row.transitionSequence,
      lifecycleEvidenceQuality: row.lifecycleEvidenceQuality,
      positiveEvidence: 'Exact Grafana rule-instance recovery transition',
      classifierWritePerformed: false,
    }));
    const remainingGroups = reviewRows.filter((row) => !row.sourceResolved).reduce((groups, row) => {
      const key = row.failureClassification || 'OTHER';
      if (!groups[key]) groups[key] = [];
      groups[key].push({
        alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
        episodeId: row.episodeId,
        ruleName: row.ruleName,
        integrationHost: row.integrationHost,
        blocker: row.blocker,
      });
      return groups;
    }, {});
    const rowByAlertId = new Map(rows.map((row) => [row.alertId, row]));
    const importantCases = IMPORTANT_RECONCILIATION_ALERTS.map((tinyId) => {
      const alert = alerts.find((item) => clean(item.atlassian_ops_tiny_id) === tinyId);
      const row = alert ? rowByAlertId.get(alert.id) : null;
      return {
        alertId: tinyId,
        found: Boolean(alert),
        episodeId: row?.episodeId || episodeByAlert.get(alert?.id)?.episodeId || null,
        ruleUid: row?.ruleUid || null,
        fingerprint: row?.fingerprint || null,
        currentState: row?.currentState || null,
        firingAt: row?.firingAt || null,
        recoveryAt: row?.recoveryAt || null,
        lifecycleSequence: row?.transitionSequence || [],
        lifecycleEvidenceQuality: row?.lifecycleEvidenceQuality || 'UNAVAILABLE',
        sourceResolved: row?.sourceResolved === true,
        blocker: row?.blocker || null,
      };
    });
    return {
      generatedAt: new Date(clock()).toISOString(),
      mode: 'READ_ONLY_SHADOW_OBSERVATION',
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bounded: true },
      connectivity: {
        reachable: status.connected === true, authenticated: status.authenticated === true,
        version: status.version || null, organizationHost: inventory.host, readOnly: true,
      },
      endpointPermissions: {
        health: 'AVAILABLE', rules: inventory.counts?.rules >= 0 ? 'AVAILABLE' : 'UNKNOWN',
        dashboards: inventory.counts?.dashboards >= 0 ? 'AVAILABLE' : 'UNKNOWN',
        stateHistory: resolvedRules.length && historyReads.some(([, result]) => !result.failure) ? 'AVAILABLE'
          : resolvedRules.length ? 'UNAVAILABLE' : 'NOT_ATTEMPTED',
        fixedAlertingRulesReader: readCapabilities?.fixedAlertingRulesReader?.available === true
          ? 'AVAILABLE' : readCapabilities ? 'UNAVAILABLE' : 'NOT_REPORTED',
        fixedAlertingInstancesReader: readCapabilities?.fixedAlertingInstancesReader?.available === true
          ? 'AVAILABLE' : readCapabilities ? 'UNAVAILABLE' : 'NOT_REPORTED',
        alertProvisioningRead: readCapabilities?.alertProvisioningRead?.available === true
          ? 'AVAILABLE' : readCapabilities ? 'UNAVAILABLE' : 'NOT_REPORTED',
        datasourceQuery: historyReads.some(([, result]) => !result.failure)
          ? `AVAILABLE:${readCapabilities?.datasourceQuery?.datasourceUid || 'configured-state-history-datasource'}`
          : 'UNAVAILABLE',
        otherDatasourceUidsQueried: 0,
      },
      inventory: {
        counts: inventory.counts,
        ruleSample: (inventory.rules || []).slice(0, 10).map((rule) => ({
          uid: rule.uid, title: rule.title, folder: rule.folderTitle || null, group: rule.ruleGroup || null,
          condition: rule.condition || null, state: rule.state || rule.status || null,
          health: rule.health || null, labels: rule.labels || {}, annotations: rule.annotations || {},
          dashboardUid: rule.dashboard?.uid || null, panelId: rule.dashboard?.panelId || null,
          datasources: rule.datasources || [], queryReferences: rule.technicalDetails || [],
        })),
      },
      currentStateEvidence: {
        rulesQueried: resolvedRules.length,
        stateRecords: historyReads.reduce((sum, [, result]) => sum + (result.items?.length || 0), 0),
        activeInstances: activeRead.total,
        activeInstanceRead: activeRead.failure ? 'UNAVAILABLE' : 'AVAILABLE',
        activeInstanceReadFailure: activeRead.failure || null,
        readFailures: historyReads.filter(([, result]) => result.failure).map(([ruleUid, result]) => ({ ruleUid, ...result.failure })),
      },
      storedPayloadAudit: {
        alerts: alerts.length,
        structuredRuleUid: [...resolutions.values()].filter((item) => item.identityQuality === 'AUTHORITATIVE').length,
        structuredRuleName: [...resolutions.values()].filter((item) => item.identityQuality === 'STRUCTURED').length,
        signatureFallbackOnly: [...resolutions.values()].filter((item) => item.identityQuality === 'SIGNATURE_FALLBACK').length,
        unresolved: [...resolutions.values()].filter((item) => item.identityQuality === 'UNRESOLVED').length,
        integrationHosts: unique([...resolutions.values()].map((item) => item.integrationHost || inventory.host)),
      },
      identityResolution: {
        authoritative: rows.filter((row) => row.identityQuality === 'AUTHORITATIVE').length,
        structured: rows.filter((row) => row.identityQuality === 'STRUCTURED').length,
        signatureFallback: rows.filter((row) => row.identityQuality === 'SIGNATURE_FALLBACK').length,
        unresolved: rows.filter((row) => row.identityQuality === 'UNRESOLVED').length,
      },
      occurrenceMatching: {
        matchingMethod: 'exactRuleUid+exactInstanceLabels+boundedStateTransition',
        noProximityOnlySelection: true,
        triggerWindowSeconds: TRIGGER_WINDOW_MS / 1000,
        recoveryWindowSeconds: RECOVERY_WINDOW_MS / 1000,
        resolved: rows.filter((row) => row.sourceResolved).length,
        failureBreakdown,
      },
      timestampAlignment: timestampAlignment(rows, alerts),
      recoveryEvidence: {
        recovered: rows.filter((row) => row.recoveryAt).length,
        firing: rows.filter((row) => row.sourceResolved && row.currentState === 'FIRING').length,
        positiveRecoveryCandidates,
        jsmClosureUsedAsRecovery: false,
        slackAcknowledgementUsedAsRecovery: false,
      },
      historicalBehavior: rows.filter((row) => row.sourceResolved).map((row) => ({
        alertId: row.alertId, episodeId: row.episodeId, ruleUid: row.ruleUid,
        instanceLabels: row.instanceLabels, profile: row.historicalProfile,
      })),
      coverage: {
        before: coverage(reviewRows.map((row) => {
          const prior = priorByAlert.get(row.alertId);
          return {
            sourceResolved: prior?.source_resolved === true,
            technicalEvidenceComplete: prior?.technical_evidence_complete === true,
            evaluable: prior?.evaluable === true,
            recoveryAt: prior?.recovery_at || null,
          };
        })),
        after: coverage(reviewRows),
        reviewAlerts: reviewRows.length,
        reviewEpisodes: reviewEpisodes.size,
        detailed: {
          allCurrentGrafana: {
            before: lifecycleCoverage(currentRows.map((row) => priorByAlert.get(row.alertId) || {
              alert_id: row.alertId, episode_id: row.episodeId,
            }), true),
            after: lifecycleCoverage(currentRows),
          },
          currentGrafanaReviews: {
            before: lifecycleCoverage(reviewRows.map((row) => priorByAlert.get(row.alertId) || {
              alert_id: row.alertId, episode_id: row.episodeId,
            }), true),
            after: lifecycleCoverage(reviewRows),
          },
        },
      },
      classifierObservation: {
        before: before.observationMode,
        after: after.observationMode,
        grafana: {
          frozen: sourceObservationBefore.frozen,
          hypothetical: sourceObservationAfter.hypothetical,
          transitions: sourceObservationAfter.changes.map((change) => {
            const episodeRows = reviewRows.filter((row) => row.episodeId === change.episodeId);
            return {
              episodeId: change.episodeId,
              from: change.current,
              to: change.hypothetical,
              alerts: episodeRows.map((row) => ({
                alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
                ruleUid: row.ruleUid,
                fingerprint: row.fingerprint,
                firingAt: row.firingAt,
                recoveryAt: row.recoveryAt,
                lifecycleSequence: row.transitionSequence,
                lifecycleEvidenceQuality: row.lifecycleEvidenceQuality,
              })),
              operationalEvidence: change.decisionPath?.reasons || [],
              remainingBlockers: change.decisionPath?.blockers || [],
              finalReason: change.decisionPath?.basis || null,
            };
          }),
          remainingReviews: sourceObservationAfter.evaluations.filter((evaluation) => (
            evaluation.hypothetical === 'REVIEW'
          )).map((evaluation) => ({
            episodeId: evaluation.episodeId,
            replayStatus: evaluation.replayStatus,
            alerts: reviewRows.filter((row) => row.episodeId === evaluation.episodeId).map((row) => ({
              alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
              ruleUid: row.ruleUid,
              fingerprint: row.fingerprint,
              blocker: row.blocker,
              lifecycleEvidenceQuality: row.lifecycleEvidenceQuality,
            })),
            blockers: evaluation.decisionPath?.blockers || [],
            reasons: evaluation.decisionPath?.reasons || [],
          })),
        },
        positiveRecoveryCandidates,
        classificationWrites: 0,
        humanOutcomeWrites: 0,
      },
      correlationDiagnostics: {
        before: before.correlationDiscovery,
        after: after.correlationDiscovery,
      },
      remainingReviewGroups: remainingGroups,
      importantReconciliationCases: {
        alerts: importantCases,
        alert174813And174814SameEpisode: importantCases.find((item) => item.alertId === '174813')?.episodeId
          && importantCases.find((item) => item.alertId === '174813')?.episodeId
            === importantCases.find((item) => item.alertId === '174814')?.episodeId,
      },
      inventorySync,
      occurrenceResults: reviewRows.map((row) => ({
        alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
        episodeId: row.episodeId, ruleUid: row.ruleUid, ruleName: row.ruleName,
        fingerprint: row.fingerprint, instanceLabels: row.instanceLabels,
        pendingAt: row.pendingAt, firingAt: row.firingAt, recoveryAt: row.recoveryAt,
        pendingSeconds: row.pendingSeconds, firingDurationSeconds: row.persistenceSeconds,
        currentState: row.currentState, transitionCount: row.transitionCount,
        lifecycleSequence: row.transitionSequence,
        lifecycleEvidenceQuality: row.lifecycleEvidenceQuality,
        recoveryAuthoritative: row.recoveryAuthoritative,
        currentInstanceObserved: row.currentInstanceObserved,
        repeatNotificationCount: row.repeatNotificationCount,
        identityQuality: row.identityQuality, mappingStatus: row.mappingStatus,
        failureClassification: row.failureClassification, blocker: row.blocker,
        sourceResolved: row.sourceResolved, technicalEvidenceComplete: row.technicalEvidenceComplete,
        evaluable: row.evaluable, matchMethod: row.matchMethod, matchConfidence: row.matchConfidence,
      })),
      safeguards: {
        grafanaRequests: 'GET_ONLY', grafanaMutations: 0, classificationRulesChanged: false,
        classificationWrites: 0, humanOutcomeWrites: 0, historicalLabelChanges: 0,
        jiraWrites: 0, slackWrites: 0, automaticActionsEnabled: false,
      },
    };
  }
  return { reconcile };
}

module.exports = {
  FAILURE_CLASSIFICATIONS,
  RECOVERY_WINDOW_MS,
  TRIGGER_WINDOW_MS,
  createGrafanaEvidenceAcquisitionService,
  historicalProfile,
  instanceLabels,
  reconcileOccurrence,
  resolveRule,
  service: createGrafanaEvidenceAcquisitionService(),
  sourceIntegrationHost,
  tagMap,
  timestampAlignment,
};

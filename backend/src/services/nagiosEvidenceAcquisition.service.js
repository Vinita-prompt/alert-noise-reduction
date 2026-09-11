const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const nagiosService = require('./nagios.service');
const alertEpisodeService = require('./alertEpisode.service').service;
const identityRelationshipEnrichmentService = require('./identityRelationshipEnrichment.service').service;

const migrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/051_nagios_source_evidence.sql'),
  'utf8',
);

const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const OCCURRENCE_WINDOW_MS = 10 * 60 * 1000;
const HISTORY_AFTER_MS = 2 * 60 * 60 * 1000;
const HISTORY_LEAD_MS = 5 * 60 * 1000;
const INSTANCE_KEYS = Object.freeze(['d01', 'd02']);
const PROBLEM_STATES = new Set(['critical', 'warning', 'unknown', 'down', 'unreachable']);
const RECOVERY_STATES = new Set(['ok', 'up']);

let schemaPromise = null;

function clean(value) {
  return String(value ?? '').trim();
}

function canonical(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ');
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => String(value)))];
}

function toMs(value) {
  const result = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

function toIso(value) {
  const result = toMs(value);
  return result === null ? null : new Date(result).toISOString();
}

function safeHost(value) {
  try { return value ? new URL(value).host : null; } catch { return null; }
}

function parseNagiosTitle(title) {
  const match = clean(title).match(/^\[Nagios\]\s+(.+?)\s+on\s+(\S+)\s+is\s+/i);
  return match ? { service: clean(match[1]), host: clean(match[2]) } : { service: null, host: null };
}

function aliasIdentity(payload = {}) {
  const alias = clean(payload.alias || payload?.details?.alias || payload?.extractedDetails?.alias);
  if (!alias || !alias.includes('_')) return { host: null, service: null };
  const [host, ...service] = alias.split('_');
  return { host: clean(host), service: clean(service.join('_')) };
}

function structuredIdentity(alert = {}) {
  const payload = alert.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
  const extracted = alert.extracted_details && typeof alert.extracted_details === 'object' ? alert.extracted_details : {};
  const title = parseNagiosTitle(alert.title);
  const alias = aliasIdentity({ ...payload, extractedDetails: extracted });
  const host = unique([
    extracted.nagiosHost, extracted.host, extracted.hostName,
    payload.host, payload.host_name, payload.hostName,
    title.host, alias.host,
  ].filter(Boolean));
  const service = unique([
    extracted.nagiosService, extracted.service, extracted.serviceDescription,
    payload.service, payload.service_description, payload.serviceDescription,
    title.service, alias.service,
  ].filter(Boolean));
  return {
    host: host.length === 1 ? host[0] : null,
    service: service.length === 1 ? service[0] : null,
    hostCandidates: host,
    serviceCandidates: service,
    conflicts: { host: host.length > 1, service: service.length > 1 },
  };
}

function exactInventoryMatches(identity, inventories) {
  if (!identity.host) return [];
  const serviceExpected = Boolean(identity.service);
  return (inventories || []).flatMap((inventory) => {
    const rows = serviceExpected ? inventory.services || [] : inventory.hosts || [];
    return rows.filter((row) => canonical(row.hostName) === canonical(identity.host)
      && (!serviceExpected || canonical(row.serviceDescription) === canonical(identity.service)))
      .map((row) => ({ instance: inventory.instance?.key || inventory.instance?.environment, row }));
  });
}

function resolveInventoryIdentity(alert, inventories) {
  const identity = structuredIdentity(alert);
  if (identity.conflicts.host || identity.conflicts.service) return {
    ...identity, match: null, identityQuality: 'UNRESOLVED', failureClassification: 'MULTIPLE_CANDIDATES',
    blocker: 'Conflicting structured Nagios host or service values were preserved in the alert payload.',
  };
  if (!identity.host) return {
    ...identity, match: null, identityQuality: 'UNRESOLVED', failureClassification: 'HOST_UNRESOLVED',
    blocker: 'No exact Nagios host identity was preserved in the alert payload.',
  };
  if (!identity.service) return {
    ...identity, match: null, identityQuality: 'UNRESOLVED', failureClassification: 'SERVICE_UNRESOLVED',
    blocker: 'No exact Nagios service identity was preserved in the alert payload.',
  };
  const matches = exactInventoryMatches(identity, inventories);
  if (matches.length === 1) return {
    ...identity, match: matches[0], identityQuality: 'AUTHORITATIVE',
    matchMethod: 'EXACT_INSTANCE_HOST_SERVICE_IN_AUTHENTICATED_INVENTORY',
    failureClassification: null, blocker: null,
  };
  if (matches.length > 1) return {
    ...identity, match: null, identityQuality: 'UNRESOLVED', failureClassification: 'MULTIPLE_CANDIDATES',
    blocker: 'The exact host/service identity exists in more than one authenticated Nagios instance.',
  };
  const hostMatches = (inventories || []).flatMap((inventory) => (inventory.hosts || [])
    .filter((row) => canonical(row.hostName) === canonical(identity.host))
    .map((row) => ({ instance: inventory.instance?.key || inventory.instance?.environment, row })));
  return {
    ...identity, match: null, identityQuality: 'UNRESOLVED',
    failureClassification: hostMatches.length ? 'SERVICE_UNRESOLVED' : 'HOST_UNRESOLVED',
    blocker: hostMatches.length
      ? 'The host exists, but the exact service was not found in that instance inventory.'
      : 'The exact host was not found in any authenticated Nagios instance inventory.',
  };
}

function problemState(row) {
  return PROBLEM_STATES.has(canonical(row?.state));
}

function recoveryState(row) {
  return RECOVERY_STATES.has(canonical(row?.state));
}

function selectStrictOccurrence(history, alertAt) {
  const anchor = toMs(alertAt);
  if (!history || anchor === null) return { occurrence: null, recovery: null, ambiguous: false, candidates: [] };
  const candidates = (history.stateHistory || []).filter((row) => problemState(row)
    && toMs(row.timestamp) !== null && Math.abs(toMs(row.timestamp) - anchor) <= OCCURRENCE_WINDOW_MS);
  const hard = candidates.filter((row) => canonical(row.stateType) === 'hard');
  const accepted = hard.length ? hard : candidates.length === 1 ? candidates : [];
  if (accepted.length !== 1) return {
    occurrence: null, recovery: null, ambiguous: candidates.length > 1,
    candidates,
  };
  const occurrence = accepted[0];
  const started = toMs(occurrence.timestamp);
  const recovery = (history.stateHistory || []).filter((row) => recoveryState(row)
    && canonical(row.stateType) === 'hard' && toMs(row.timestamp) > started)
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp))[0] || null;
  return { occurrence, recovery, ambiguous: false, candidates };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = (ratio) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * ratio;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
  };
  return {
    count: sorted.length,
    medianSeconds: percentile(0.5),
    p95Seconds: percentile(0.95),
    minSeconds: sorted[0] ?? null,
    maxSeconds: sorted.at(-1) ?? null,
  };
}

function historicalProfile(histories = []) {
  const states = [...new Map(histories.flatMap((history) => history?.stateHistory || [])
    .filter((row) => row?.id).map((row) => [row.id, row])).values()]
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const activity = [...new Map(histories.flatMap((history) => history?.activity || [])
    .filter((row) => row?.id).map((row) => [row.id, row])).values()]
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const occurrences = states.filter((row) => problemState(row) && canonical(row.stateType) === 'hard');
  const records = occurrences.map((occurrence, index) => {
    const start = toMs(occurrence.timestamp);
    const nextStart = toMs(occurrences[index + 1]?.timestamp);
    const recovery = states.find((row) => recoveryState(row) && canonical(row.stateType) === 'hard'
      && toMs(row.timestamp) > start && (nextStart === null || nextStart === undefined || toMs(row.timestamp) < nextStart)) || null;
    const end = recovery ? toMs(recovery.timestamp) : nextStart;
    const acknowledged = activity.some((row) => canonical(row.kind) === 'acknowledgement'
      && toMs(row.timestamp) >= start && (end === null || end === undefined || toMs(row.timestamp) <= end));
    return {
      sourceOccurrenceId: occurrence.id,
      firingAt: toIso(occurrence.timestamp),
      recoveryAt: toIso(recovery?.timestamp),
      durationSeconds: recovery ? Math.max(0, Math.round((toMs(recovery.timestamp) - start) / 1000)) : null,
      acknowledged,
    };
  });
  const recoveries = records.filter((row) => row.recoveryAt);
  const transitions = states.filter((row) => canonical(row.stateType) === 'hard')
    .reduce((count, row, index, values) => index > 0
      && problemState(row) !== problemState(values[index - 1]) ? count + 1 : count, 0);
  const queryWindows = histories.flatMap((history) => history?.sourceProvenance?.queryWindows
    || [history?.sourceProvenance?.queryWindow]).filter(Boolean);
  return {
    occurrenceCount: records.length,
    recoveryCount: recoveries.length,
    autoRecoveryRate: records.length ? Number((recoveries.length / records.length).toFixed(6)) : null,
    flappingTransitionCount: transitions,
    explicitFlappingEventCount: activity.filter((row) => canonical(row.kind) === 'flapping alert'
      || canonical(row.kind) === 'flapping_alert').length,
    duration: distribution(records.map((row) => row.durationSeconds)),
    acknowledgementCount: records.filter((row) => row.acknowledged).length,
    acknowledgementRate: records.length
      ? Number((records.filter((row) => row.acknowledged).length / records.length).toFixed(6)) : null,
    occurrences: records,
    matchingMethod: 'exactInstance+exactHost+exactService+authoritativeHardStateHistory',
    queryWindows,
  };
}

function mergeNagiosHistories(histories = []) {
  const available = histories.filter(Boolean);
  if (!available.length) return null;
  const stateHistory = [...new Map(available.flatMap((history) => history.stateHistory || [])
    .filter((row) => row?.id).map((row) => [row.id, row])).values()]
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const activity = [...new Map(available.flatMap((history) => history.activity || [])
    .filter((row) => row?.id).map((row) => [row.id, row])).values()]
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
  const first = available[0];
  return {
    ...first,
    stateHistory,
    activity,
    retrievedAt: available.at(-1).retrievedAt || first.retrievedAt,
    sourceProvenance: {
      ...(first.sourceProvenance || {}),
      queryWindows: available.map((history) => history.sourceProvenance?.queryWindow).filter(Boolean),
      boundedSegments: available.length,
      continuationReadOnly: available.length > 1,
    },
  };
}

function failureResult({ alert, episodeId, resolution, classification, blocker, current = null, evidence = {} }) {
  const match = resolution?.match;
  return {
    alertId: alert.id, episodeId,
    sourceInstance: match?.instance || null,
    hostName: resolution?.host || null,
    serviceDescription: resolution?.service || null,
    canonicalIdentity: match ? [match.instance, resolution.host, resolution.service].join(':') : null,
    objectType: resolution?.service ? 'service' : 'host', objectId: match?.row?.id || null,
    sourceOccurrenceId: null, occurrenceState: null, occurrenceStateType: null,
    currentState: null, currentSourceState: current?.status || match?.row?.status || null,
    currentStateType: current?.stateType || match?.row?.stateType || null,
    firingAt: null, recoveryAt: null, persistenceSeconds: null,
    lastStateChange: current?.lastStateChange || match?.row?.lastStateChange || null,
    lastCheck: current?.lastCheck || match?.row?.lastCheck || null,
    nextCheck: current?.nextCheck || match?.row?.nextCheck || null,
    pluginOutput: current?.pluginOutput || match?.row?.pluginOutput || null,
    longPluginOutput: current?.longPluginOutput || match?.row?.longPluginOutput || null,
    performanceData: current?.performanceData || match?.row?.performanceData || null,
    acknowledged: current?.acknowledged ?? match?.row?.acknowledged ?? null,
    downtime: current?.scheduledDowntime ?? match?.row?.scheduledDowntime ?? null,
    notificationsEnabled: current?.notificationsEnabled ?? match?.row?.notificationsEnabled ?? null,
    recoveryAuthoritative: false, previousOccurrenceMatched: false,
    identityQuality: resolution?.identityQuality || 'UNRESOLVED', matchMethod: resolution?.matchMethod || null,
    matchConfidence: match ? 100 : null,
    mappingStatus: classification, failureClassification: classification, blocker,
    sourceResolved: Boolean(match), technicalEvidenceComplete: false, evaluable: false,
    historicalProfile: {}, evidence, provenance: [],
  };
}

function reconcileOccurrence({ alert, episodeId, resolution, history, historyFailure }) {
  if (!resolution?.match) return failureResult({
    alert, episodeId, resolution, classification: resolution?.failureClassification || 'SOURCE_DATA_INSUFFICIENT',
    blocker: resolution?.blocker || 'Nagios identity was not resolved.',
  });
  const current = resolution.match.row;
  if (historyFailure) return failureResult({
    alert, episodeId, resolution, current,
    classification: historyFailure.classification || 'HISTORICAL_LIFECYCLE_UNAVAILABLE',
    blocker: historyFailure.error || 'Nagios historical lifecycle was unavailable.',
  });
  const selected = selectStrictOccurrence(history, alert.received_at);
  if (!selected.occurrence) return failureResult({
    alert, episodeId, resolution, current,
    classification: selected.ambiguous ? 'MULTIPLE_CANDIDATES' : 'CURRENT_STATE_ONLY',
    blocker: selected.ambiguous
      ? 'Multiple exact host/service source occurrences exist in the bounded window; timestamp proximity was not used to select one.'
      : 'Current source state is available, but no exact authoritative problem occurrence was found in the bounded source history.',
    evidence: { candidateCount: selected.candidates.length, currentStateOnly: true },
  });
  const occurrence = selected.occurrence;
  const recovery = selected.recovery;
  const firingAt = toIso(occurrence.timestamp);
  const recoveryAt = toIso(recovery?.timestamp);
  const currentProblem = PROBLEM_STATES.has(canonical(current.status));
  const currentState = recovery ? 'RECOVERED' : currentProblem ? 'FIRING' : 'UNKNOWN';
  const persistenceSeconds = recoveryAt
    ? Math.max(0, Math.round((toMs(recoveryAt) - toMs(firingAt)) / 1000)) : null;
  const complete = Boolean(firingAt && occurrence.state && occurrence.pluginOutput
    && (recoveryAt || currentProblem));
  const sourceOccurrenceId = occurrence.id;
  return {
    alertId: alert.id, episodeId,
    sourceInstance: resolution.match.instance,
    hostName: resolution.host,
    serviceDescription: resolution.service,
    canonicalIdentity: [resolution.match.instance, resolution.host, resolution.service].join(':'),
    objectType: occurrence.objectType || 'service',
    objectId: occurrence.objectId || occurrence.sourceEntityId || current.id || null,
    sourceOccurrenceId,
    occurrenceState: occurrence.state,
    occurrenceStateType: occurrence.stateType,
    currentState,
    currentSourceState: current.status,
    currentStateType: current.stateType || null,
    firingAt, recoveryAt, persistenceSeconds,
    lastStateChange: current.lastStateChange || null,
    lastCheck: current.lastCheck || null,
    nextCheck: current.nextCheck || null,
    pluginOutput: occurrence.pluginOutput || current.pluginOutput || null,
    longPluginOutput: current.longPluginOutput || null,
    performanceData: current.performanceData || null,
    acknowledged: current.acknowledged ?? null,
    downtime: current.scheduledDowntime ?? null,
    notificationsEnabled: current.notificationsEnabled ?? null,
    recoveryAuthoritative: Boolean(recoveryAt),
    previousOccurrenceMatched: true,
    identityQuality: 'AUTHORITATIVE',
    matchMethod: 'EXACT_INSTANCE_HOST_SERVICE+UNIQUE_BOUNDED_HARD_STATE_OCCURRENCE',
    matchConfidence: 100,
    mappingStatus: recoveryAt ? 'EXACT_OCCURRENCE_RECOVERED'
      : currentProblem ? 'EXACT_OCCURRENCE_FIRING' : 'EXACT_OCCURRENCE_RECOVERY_NOT_PROVEN',
    failureClassification: complete ? null : 'HISTORICAL_LIFECYCLE_UNAVAILABLE',
    blocker: complete ? null
      : 'The exact occurrence was found, but neither an authoritative recovery transition nor a matching active current state was available.',
    sourceResolved: true,
    technicalEvidenceComplete: complete,
    evaluable: complete,
    historicalProfile: {},
    evidence: {
      occurrence,
      recovery: recovery || null,
      current: {
        state: current.status, stateType: current.stateType, lastStateChange: current.lastStateChange,
        lastCheck: current.lastCheck, nextCheck: current.nextCheck, pluginOutput: current.pluginOutput,
        acknowledged: current.acknowledged, downtime: current.scheduledDowntime,
        notificationsEnabled: current.notificationsEnabled,
      },
      stateHistory: history.stateHistory || [],
      activity: history.activity || [],
      recoveryContract: {
        exactInstanceHostService: true,
        previousOccurrenceMatched: true,
        sameIdentityReturnedToOk: Boolean(recoveryAt),
        jsmClosureUsed: false,
        currentOkAloneUsed: false,
      },
    },
    provenance: [{
      source: `Nagios XI ${resolution.match.instance.toUpperCase()}`,
      endpoints: ['objects/hoststatus', 'objects/servicestatus', 'objects/statehistory', 'objects/logentries', 'system/status'],
      exactIdentity: { instance: resolution.match.instance, host: resolution.host, service: resolution.service },
      sourceOccurrenceId, readOnly: true, retrievedAt: history.retrievedAt,
    }],
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
      INSERT INTO nagios_alert_occurrence_evidence (
        alert_id,episode_id,source_instance,host_name,service_description,canonical_identity,
        object_type,object_id,source_occurrence_id,occurrence_state,occurrence_state_type,
        current_state,current_source_state,current_state_type,firing_at,recovery_at,persistence_seconds,
        last_state_change,last_check,next_check,plugin_output,long_plugin_output,performance_data,
        acknowledged,downtime,notifications_enabled,recovery_authoritative,previous_occurrence_matched,
        identity_quality,match_method,match_confidence,mapping_status,failure_classification,blocker,
        source_resolved,technical_evidence_complete,evaluable,historical_profile,evidence,provenance,
        observed_at,updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17,
        $18::timestamptz,$19::timestamptz,$20::timestamptz,$21,$22,$23,$24,$25,$26,$27,$28,$29,
        $30,$31,$32,$33,$34,$35,$36,$37,$38::jsonb,$39::jsonb,$40::jsonb,NOW(),NOW()
      ) ON CONFLICT (alert_id) DO UPDATE SET
        episode_id=EXCLUDED.episode_id,source_instance=EXCLUDED.source_instance,
        host_name=EXCLUDED.host_name,service_description=EXCLUDED.service_description,
        canonical_identity=EXCLUDED.canonical_identity,object_type=EXCLUDED.object_type,
        object_id=EXCLUDED.object_id,source_occurrence_id=EXCLUDED.source_occurrence_id,
        occurrence_state=EXCLUDED.occurrence_state,occurrence_state_type=EXCLUDED.occurrence_state_type,
        current_state=EXCLUDED.current_state,current_source_state=EXCLUDED.current_source_state,
        current_state_type=EXCLUDED.current_state_type,firing_at=EXCLUDED.firing_at,
        recovery_at=EXCLUDED.recovery_at,persistence_seconds=EXCLUDED.persistence_seconds,
        last_state_change=EXCLUDED.last_state_change,last_check=EXCLUDED.last_check,next_check=EXCLUDED.next_check,
        plugin_output=EXCLUDED.plugin_output,long_plugin_output=EXCLUDED.long_plugin_output,
        performance_data=EXCLUDED.performance_data,acknowledged=EXCLUDED.acknowledged,
        downtime=EXCLUDED.downtime,notifications_enabled=EXCLUDED.notifications_enabled,
        recovery_authoritative=EXCLUDED.recovery_authoritative,
        previous_occurrence_matched=EXCLUDED.previous_occurrence_matched,
        identity_quality=EXCLUDED.identity_quality,match_method=EXCLUDED.match_method,
        match_confidence=EXCLUDED.match_confidence,mapping_status=EXCLUDED.mapping_status,
        failure_classification=EXCLUDED.failure_classification,blocker=EXCLUDED.blocker,
        source_resolved=EXCLUDED.source_resolved,
        technical_evidence_complete=EXCLUDED.technical_evidence_complete,evaluable=EXCLUDED.evaluable,
        historical_profile=EXCLUDED.historical_profile,evidence=EXCLUDED.evidence,
        provenance=EXCLUDED.provenance,observed_at=NOW(),updated_at=NOW()
    `, [
      row.alertId,row.episodeId,row.sourceInstance,row.hostName,row.serviceDescription,row.canonicalIdentity,
      row.objectType,row.objectId,row.sourceOccurrenceId,row.occurrenceState,row.occurrenceStateType,
      row.currentState,row.currentSourceState,row.currentStateType,row.firingAt,row.recoveryAt,
      row.persistenceSeconds,row.lastStateChange,row.lastCheck,row.nextCheck,row.pluginOutput,
      row.longPluginOutput,row.performanceData,row.acknowledged,row.downtime,row.notificationsEnabled,
      row.recoveryAuthoritative,row.previousOccurrenceMatched,row.identityQuality,row.matchMethod,
      row.matchConfidence,row.mappingStatus,row.failureClassification,row.blocker,row.sourceResolved,
      row.technicalEvidenceComplete,row.evaluable,JSON.stringify(row.historicalProfile || {}),
      JSON.stringify(row.evidence || {}),JSON.stringify(row.provenance || []),
    ]);
  }
}

async function boundedMap(values, mapper, concurrency = 2) {
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

function safeHistoryFailure(error) {
  const status = Number(error?.status || error?.httpStatus || 0) || null;
  return {
    httpStatus: status,
    classification: status === 401 || status === 403 ? 'AUTHENTICATION_FAILURE'
      : 'HISTORICAL_LIFECYCLE_UNAVAILABLE',
    error: status === 401 ? 'Nagios XI rejected the configured read credential.'
      : status === 403 ? 'Nagios XI denied the state-history/log read endpoints.'
        : clean(error?.safeMessage || error?.type || error?.code || error?.message || 'Nagios history read failed.'),
  };
}

function coverage(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  return {
    total: rows.length,
    authoritativeInstance: count((row) => Boolean(row.sourceInstance)),
    host: count((row) => Boolean(row.hostName)),
    service: count((row) => Boolean(row.serviceDescription)),
    exactOccurrence: count((row) => row.previousOccurrenceMatched),
    currentState: count((row) => Boolean(row.currentSourceState)),
    lifecycle: count((row) => Boolean(row.firingAt)),
    recovery: count((row) => row.recoveryAuthoritative),
    pluginOutput: count((row) => Boolean(row.pluginOutput)),
    technicalEvidenceComplete: count((row) => row.technicalEvidenceComplete),
    evaluable: count((row) => row.evaluable),
  };
}

function identityQuality(rows) {
  return Object.fromEntries(['AUTHORITATIVE','STRUCTURED','SIGNATURE_FALLBACK','UNRESOLVED']
    .map((quality) => [quality, rows.filter((row) => row.identityQuality === quality).length]));
}

function createNagiosEvidenceAcquisitionService({
  database = db,
  client = nagiosService,
  episodes = alertEpisodeService,
  identity = identityRelationshipEnrichmentService,
  clock = () => Date.now(),
} = {}) {
  async function reconcile(options = {}) {
    await ensureSchema(database);
    const now = clock();
    const from = toMs(options.from || now - 24 * 60 * 60 * 1000);
    const to = toMs(options.to || now);
    if (from === null || to === null || to <= from || to - from > MAX_WINDOW_MS) {
      const error = new Error('A valid Nagios evidence window of at most 48 hours is required.');
      error.status = 400;
      throw error;
    }

    const before = await identity.analyze({ refresh: options.refresh === true, limit: 100 });
    const snapshot = await episodes.buildSnapshot({ refresh: options.refresh === true });
    const connectionReads = await Promise.all(INSTANCE_KEYS.map(async (key) => {
      const config = client.getInstanceConfig(key);
      try {
        const inventory = await client.getWorkspaceSnapshot(key, { forceRefresh: options.refresh === true });
        return {
          key, config, inventory, error: null,
          safe: {
            instance: key.toUpperCase(), host: safeHost(config.baseUrl), credentialConfigured: Boolean(config.apiKey),
            credentialType: 'NAGIOS_XI_API_KEY_QUERY_PARAMETER', reachable: true, authenticated: true,
            readApiAvailable: true, hosts: inventory.hosts.length, services: inventory.services.length,
            hostPages: inventory.pagination?.hosts || 0, servicePages: inventory.pagination?.services || 0,
          },
        };
      } catch (error) {
        const failure = safeHistoryFailure(error);
        return {
          key, config, inventory: null, error: failure,
          safe: {
            instance: key.toUpperCase(), host: safeHost(config.baseUrl), credentialConfigured: Boolean(config.apiKey),
            credentialType: 'NAGIOS_XI_API_KEY_QUERY_PARAMETER', reachable: !/dns|connect|timeout/i.test(failure.error),
            authenticated: ![401,403].includes(failure.httpStatus) ? null : false,
            readApiAvailable: false, httpStatus: failure.httpStatus, error: failure.error,
          },
        };
      }
    }));
    const inventories = connectionReads.filter((item) => item.inventory).map((item) => item.inventory);
    const nagiosEpisodes = (snapshot.episodes || []).filter((episode) => episode.source === 'Nagios');
    const alertIds = unique(nagiosEpisodes.flatMap((episode) => episode.alertIds || []));
    const alerts = alertIds.length ? (await database.query(`
      SELECT id,atlassian_ops_tiny_id,title,description,status,received_at,last_seen_at,
        raw_payload,extracted_details,source_url
      FROM alerts WHERE id=ANY($1::text[])
    `, [alertIds])).rows : [];
    const priorRows = alertIds.length ? (await database.query(`
      SELECT * FROM nagios_alert_occurrence_evidence WHERE alert_id=ANY($1::text[])
    `, [alertIds])).rows : [];
    const priorByAlert = new Map(priorRows.map((row) => [row.alert_id, row]));
    const episodeByAlert = new Map(nagiosEpisodes.flatMap((episode) => (
      (episode.alertIds || []).map((alertId) => [alertId, episode])
    )));
    const resolutions = new Map(alerts.map((alert) => [alert.id, resolveInventoryIdentity(alert, inventories)]));
    const historyReads = await boundedMap(alerts, async (alert) => {
      const resolution = resolutions.get(alert.id);
      if (!resolution?.match) return [alert.id, { history: null, failure: null }];
      const anchor = toMs(alert.received_at);
      const queryFrom = Math.max(from, anchor - HISTORY_LEAD_MS);
      const queryTo = Math.min(to, anchor + HISTORY_AFTER_MS);
      try {
        const initial = await client.getHistoricalOccurrenceEvidence(resolution.match.instance, {
          host: resolution.host, service: resolution.service, anchor: alert.received_at,
          from: new Date(queryFrom).toISOString(), to: new Date(queryTo).toISOString(),
        });
        const segments = [initial];
        let merged = mergeNagiosHistories(segments);
        let selected = selectStrictOccurrence(merged, alert.received_at);
        let cursor = queryTo;
        const currentRecovered = RECOVERY_STATES.has(canonical(resolution.match.row.status));
        while (selected.occurrence && !selected.recovery && currentRecovered && cursor < to) {
          const segmentTo = Math.min(to, cursor + HISTORY_AFTER_MS);
          const continuation = await client.getHistoricalOccurrenceEvidence(resolution.match.instance, {
            host: resolution.host, service: resolution.service, anchor: new Date(cursor).toISOString(),
            from: new Date(cursor).toISOString(), to: new Date(segmentTo).toISOString(),
          });
          segments.push(continuation);
          merged = mergeNagiosHistories(segments);
          selected = selectStrictOccurrence(merged, alert.received_at);
          cursor = segmentTo;
        }
        return [alert.id, { history: merged, failure: null }];
      } catch (error) {
        return [alert.id, { history: null, failure: safeHistoryFailure(error) }];
      }
    }, 2);
    const historyByAlert = new Map(historyReads);
    const rows = alerts.map((alert) => {
      const history = historyByAlert.get(alert.id) || {};
      return reconcileOccurrence({
        alert, episodeId: episodeByAlert.get(alert.id)?.episodeId || null,
        resolution: resolutions.get(alert.id), history: history.history, historyFailure: history.failure,
      });
    });
    const historiesByIdentity = new Map();
    rows.forEach((row) => {
      if (!row.canonicalIdentity) return;
      if (!historiesByIdentity.has(row.canonicalIdentity)) historiesByIdentity.set(row.canonicalIdentity, []);
      const history = historyByAlert.get(row.alertId)?.history;
      if (history) historiesByIdentity.get(row.canonicalIdentity).push(history);
    });
    rows.forEach((row) => {
      row.historicalProfile = row.canonicalIdentity
        ? historicalProfile(historiesByIdentity.get(row.canonicalIdentity) || []) : {};
    });
    await persistRows(database, rows);
    require('./liveOccurrenceAutomation.service').service.enqueue(
      rows.map((row) => row.alertId),
      'SOURCE_EVIDENCE_REVISION',
    );
    const after = await identity.analyze({ refresh: true, limit: 100 });

    const reviewEpisodes = new Set((before.episodes || []).filter((item) => item.source === 'Nagios'
      && item.currentDecision === 'REVIEW').map((item) => item.episodeId));
    const reviewRows = rows.filter((row) => reviewEpisodes.has(row.episodeId));
    const beforeRows = reviewRows.map((row) => {
      const prior = priorByAlert.get(row.alertId);
      return {
        sourceInstance: prior?.source_instance || null, hostName: prior?.host_name || null,
        serviceDescription: prior?.service_description || null,
        previousOccurrenceMatched: prior?.previous_occurrence_matched === true,
        currentSourceState: prior?.current_source_state || null, firingAt: prior?.firing_at || null,
        recoveryAuthoritative: prior?.recovery_authoritative === true, pluginOutput: prior?.plugin_output || null,
        technicalEvidenceComplete: prior?.technical_evidence_complete === true,
        evaluable: prior?.evaluable === true, identityQuality: prior?.identity_quality || 'SIGNATURE_FALLBACK',
      };
    });
    const afterChanges = new Map((after.observationMode?.changes || []).map((item) => [item.episodeId, item]));
    const episodeTransitions = [...reviewEpisodes].map((episodeId) => {
      const change = afterChanges.get(episodeId);
      const episode = (after.episodes || []).find((item) => item.episodeId === episodeId);
      const episodeRows = reviewRows.filter((row) => row.episodeId === episodeId);
      return {
        episodeId,
        alertIds: episodeRows.map((row) => clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId),
        frozen: episode?.currentDecision || change?.current || 'REVIEW',
        hypothetical: change?.hypothetical || episode?.currentDecision || 'REVIEW',
        positiveNoiseEvidence: episodeRows.filter((row) => row.recoveryAuthoritative).map((row) => ({
          sourceOccurrenceId: row.sourceOccurrenceId, identity: row.canonicalIdentity,
          firingAt: row.firingAt, recoveryAt: row.recoveryAt,
          evidence: 'Exact same-instance/host/service authoritative HARD OK transition',
        })),
        operationalEvidence: change?.decisionPath?.reasons || [],
        blockers: change?.decisionPath?.blockers || episodeRows.map((row) => row.blocker).filter(Boolean),
        classificationWritePerformed: false,
      };
    });
    const countTransitions = (decision) => episodeTransitions.filter((item) => item.hypothetical === decision).length;
    const remainingGroups = reviewRows.filter((row) => !row.evaluable).reduce((groups, row) => {
      const key = row.failureClassification || 'GENUINE_AMBIGUITY';
      if (!groups[key]) groups[key] = [];
      groups[key].push({
        alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
        episodeId: row.episodeId, instance: row.sourceInstance, host: row.hostName,
        service: row.serviceDescription, blocker: row.blocker,
      });
      return groups;
    }, {});

    return {
      generatedAt: new Date(clock()).toISOString(),
      mode: 'READ_ONLY_SHADOW_OBSERVATION',
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bounded: true },
      instances: connectionReads.map((item) => item.safe),
      inventory: connectionReads.map((item) => ({
        instance: item.key.toUpperCase(),
        hosts: item.inventory?.hosts.length || 0, services: item.inventory?.services.length || 0,
        hostSample: (item.inventory?.hosts || []).slice(0, 3).map((row) => ({
          hostName: row.hostName, displayName: row.displayName, address: row.address,
          hostGroups: row.hostGroups, currentState: row.status, stateType: row.stateType,
          lastStateChange: row.lastStateChange, lastCheck: row.lastCheck, nextCheck: row.nextCheck,
          acknowledged: row.acknowledged, downtime: row.scheduledDowntime,
          pluginOutput: row.pluginOutput, customVariableNames: Object.keys(row.customVariables || {}),
        })),
        serviceSample: (item.inventory?.services || []).slice(0, 3).map((row) => ({
          host: row.hostName, serviceDescription: row.serviceDescription, displayName: row.displayName,
          serviceGroups: row.serviceGroups, currentState: row.status, stateType: row.stateType,
          lastStateChange: row.lastStateChange, lastCheck: row.lastCheck, nextCheck: row.nextCheck,
          pluginOutput: row.pluginOutput, longPluginOutput: row.longPluginOutput,
          performanceData: row.performanceData, acknowledged: row.acknowledged,
          downtime: row.scheduledDowntime, checkCommand: row.checkCommand,
        })),
      })),
      reconciliation: {
        episodes: nagiosEpisodes.length, alerts: rows.length,
        sourceResolved: rows.filter((row) => row.sourceResolved).length,
        exactOccurrences: rows.filter((row) => row.previousOccurrenceMatched).length,
        authoritativeRecoveries: rows.filter((row) => row.recoveryAuthoritative).length,
        currentStateOnly: rows.filter((row) => row.failureClassification === 'CURRENT_STATE_ONLY').length,
        multipleCandidates: rows.filter((row) => row.failureClassification === 'MULTIPLE_CANDIDATES').length,
      },
      coverage: {
        before: coverage(beforeRows), after: coverage(reviewRows),
        identityBefore: identityQuality(beforeRows), identityAfter: identityQuality(reviewRows),
        reviewEpisodes: reviewEpisodes.size, reviewAlerts: reviewRows.length,
      },
      historicalBehavior: [...historiesByIdentity.entries()].map(([canonicalIdentity, histories]) => ({
        canonicalIdentity, profile: historicalProfile(histories),
      })),
      classifierObservation: {
        frozen: {
          INCIDENT: episodeTransitions.filter((item) => item.frozen === 'INCIDENT').length,
          NOISE: episodeTransitions.filter((item) => item.frozen === 'NOISE').length,
          REVIEW: episodeTransitions.filter((item) => item.frozen === 'REVIEW').length,
        },
        hypothetical: { INCIDENT: countTransitions('INCIDENT'), NOISE: countTransitions('NOISE'), REVIEW: countTransitions('REVIEW') },
        transitions: episodeTransitions,
        classificationRulesChanged: false, classificationWrites: 0, humanOutcomeWrites: 0,
      },
      correlationDiagnostics: {
        before: before.correlationDiscovery, after: after.correlationDiscovery,
        correlatedNoiseImplemented: false, correlationThresholdsChanged: false,
      },
      remainingReviewGroups: remainingGroups,
      occurrenceResults: reviewRows.map((row) => ({
        alertId: clean(alerts.find((alert) => alert.id === row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
        episodeId: row.episodeId, instance: row.sourceInstance, host: row.hostName,
        service: row.serviceDescription, objectId: row.objectId, sourceOccurrenceId: row.sourceOccurrenceId,
        occurrenceState: row.occurrenceState, stateType: row.occurrenceStateType,
        firingAt: row.firingAt, currentState: row.currentState, currentSourceState: row.currentSourceState,
        recoveryAt: row.recoveryAt, recoveryAuthoritative: row.recoveryAuthoritative,
        pluginOutput: row.pluginOutput, acknowledged: row.acknowledged, downtime: row.downtime,
        identityQuality: row.identityQuality, mappingStatus: row.mappingStatus,
        failureClassification: row.failureClassification, blocker: row.blocker,
        sourceResolved: row.sourceResolved, technicalEvidenceComplete: row.technicalEvidenceComplete,
        evaluable: row.evaluable, historicalProfile: row.historicalProfile,
      })),
      safeguards: {
        nagiosRequests: 'GET_ONLY', nagiosCommandEndpointsCalled: 0, nagiosMutations: 0,
        classifierRulesChanged: false, episodeGroupingChanged: false, correlationThresholdsChanged: false,
        classificationWrites: 0, humanOutcomeWrites: 0, historicalLabelChanges: 0,
        jiraWrites: 0, slackWrites: 0, frontendChanges: 0, automaticActionsEnabled: false,
      },
    };
  }
  return { reconcile };
}

module.exports = {
  HISTORY_AFTER_MS,
  HISTORY_LEAD_MS,
  OCCURRENCE_WINDOW_MS,
  createNagiosEvidenceAcquisitionService,
  historicalProfile,
  mergeNagiosHistories,
  parseNagiosTitle,
  reconcileOccurrence,
  resolveInventoryIdentity,
  selectStrictOccurrence,
  service: createNagiosEvidenceAcquisitionService(),
  structuredIdentity,
};

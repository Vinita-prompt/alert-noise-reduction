const crypto = require('node:crypto');
const db = require('../config/db');
const { service: alertEpisodeService } = require('./alertEpisode.service');

const DISCOVERY_POLICY = 'READ_ONLY_EPISODE_CORRELATION_DISCOVERY_V1';
const CORRELATION_WINDOW_MS = 30 * 60 * 1000;
const LEVEL_RANK = Object.freeze({
  NO_CORRELATION: 0,
  WEAK_CORRELATION: 1,
  MODERATE_CORRELATION: 2,
  STRONG_CORRELATION: 3,
});
const GENERIC_IDENTITY_VALUES = new Set([
  'app', 'application', 'critical', 'default', 'error', 'host', 'http', 'https',
  'monitoring', 'prod', 'production', 'service', 'unknown', 'unknown-service',
]);

function clean(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeIdentity(value) {
  return normalize(value)
    .replace(/^(?:production|prod|prd|nonprod|non-prod|dev|test|qa|stage|staging)-+/, '')
    .replace(/-+(?:production|prod|prd|nonprod|non-prod|dev|test|qa|stage|staging)$/, '');
}

function usableIdentity(value) {
  const normalized = normalizeIdentity(value);
  return normalized.length >= 4 && !GENERIC_IDENTITY_VALUES.has(normalized) ? normalized : null;
}

function toMs(value) {
  const result = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

function toIso(value) {
  const result = typeof value === 'number' ? value : toMs(value);
  return Number.isFinite(result) ? new Date(result).toISOString() : null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function intersection(left, right) {
  const rightSet = new Set(right || []);
  return unique((left || []).filter((item) => rightSet.has(item)));
}

function median(values) {
  const ordered = (values || []).filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function decisionOf(episode) {
  return clean(episode?.episodeDecision || 'REVIEW').toUpperCase() || 'REVIEW';
}

function componentParts(episode, section = 'entity') {
  return (episode?.fingerprintComponents?.[section] || []).map((component) => {
    const text = clean(component);
    const separator = text.indexOf(':');
    return {
      namespace: separator >= 0 ? normalize(text.slice(0, separator)) : null,
      raw: separator >= 0 ? clean(text.slice(separator + 1)) : text,
      value: usableIdentity(separator >= 0 ? text.slice(separator + 1) : text),
    };
  }).filter((item) => item.value);
}

function identityAliases(episode) {
  const componentAliases = componentParts(episode, 'entity').map((item) => item.value);
  const canonicalAliases = clean(episode?.canonicalEntity).split('/').map(usableIdentity).filter(Boolean);
  return unique([...componentAliases, ...canonicalAliases]);
}

function ruleValues(episode) {
  return unique(componentParts(episode, 'ruleEvent').map((item) => item.value));
}

function structuredRuleValues(episode) {
  const structuredNamespaces = new Set(['alert-rule', 'check', 'health-rule', 'rule', 'rule-uid']);
  return unique(componentParts(episode, 'ruleEvent')
    .filter((item) => structuredNamespaces.has(item.namespace)).map((item) => item.value));
}

function isStructured(episode) {
  return ['AUTHORITATIVE_SOURCE_IDENTITY', 'STRUCTURED_SOURCE_IDENTITY'].includes(episode?.fingerprintStrength);
}

function episodeInterval(episode, nowMs) {
  const start = toMs(episode?.firstSeen);
  const recordedEnd = toMs(episode?.lastSeen) ?? start;
  // JSM open/acknowledged state is not authoritative monitoring lifecycle.
  // Extending it to now would create artificial overlap between distinct
  // episodes. Only current source-side firing evidence can extend the window.
  const operationallyOpen = episode?.lifecycle?.currentlyFiring === true;
  const end = start === null ? null : Math.max(start, operationallyOpen ? nowMs : (recordedEnd ?? start));
  return { start, end, recordedEnd, operationallyOpen };
}

function temporalRelationship(left, right, nowMs) {
  const leftInterval = episodeInterval(left, nowMs);
  const rightInterval = episodeInterval(right, nowMs);
  if (leftInterval.start === null || rightInterval.start === null) {
    return {
      startDifferenceSeconds: null, overlapSeconds: null, overlaps: false,
      withinBoundedWindow: false, left: leftInterval, right: rightInterval,
    };
  }
  const startDifferenceMs = Math.abs(leftInterval.start - rightInterval.start);
  const overlapMs = Math.max(0, Math.min(leftInterval.end, rightInterval.end)
    - Math.max(leftInterval.start, rightInterval.start));
  return {
    startDifferenceSeconds: Math.round(startDifferenceMs / 1000),
    overlapSeconds: Math.round(overlapMs / 1000),
    overlaps: overlapMs > 0,
    withinBoundedWindow: startDifferenceMs <= CORRELATION_WINDOW_MS,
    left: leftInterval,
    right: rightInterval,
  };
}

function symptomTags(episode) {
  const text = normalize([
    episode?.ruleEvent,
    ...(episode?.members || []).map((member) => member.title),
  ].filter(Boolean).join(' '));
  const patterns = [
    ['cpu', /(?:^|-)cpu(?:-|$)|processor/],
    ['memory', /memory|heap|out-of-memory|oom/],
    ['latency', /latency|response-time|slow-response/],
    ['error-rate', /error-rate|error-percentage|errors-per-minute|5xx|exception/],
    ['consumer-lag', /consumer-lag|kafka-lag|queue-lag/],
    ['queue', /queue-depth|queue-size|queue-full|backlog/],
    ['database-connection', /database-connection|db-connection|connection-pool/],
    ['database-capacity', /tablespace|tempdb|database-space|db-space/],
    ['availability', /unreachable|unavailable|connection-refused|host-down|service-down/],
    ['disk', /disk-space|disk-usage|filesystem/],
    ['pod-container', /pod|container|kubernetes|k8s/],
    ['network', /packet-loss|network|dns|routing|throughput/],
    ['transaction', /business-transaction|transaction-test|transaction-failure/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function buildMappingIndex(rows = []) {
  const index = new Map();
  rows.forEach((row) => {
    const source = clean(row.source_system || row.sourceSystem);
    const entityId = clean(row.entity_id || row.entityId);
    if (!source || !entityId) return;
    [row.source_entity_id || row.sourceEntityId, row.source_entity_name || row.sourceEntityName]
      .map(usableIdentity).filter(Boolean).forEach((value) => {
        const key = `${normalize(source)}|${value}`;
        if (!index.has(key)) index.set(key, new Set());
        index.get(key).add(entityId);
      });
  });
  return index;
}

function mappingIdsForEpisode(episode, mappingIndex) {
  const source = normalize(episode?.source);
  const values = unique([
    ...componentParts(episode, 'entity').map((item) => item.value),
    ...identityAliases(episode),
  ]);
  return unique(values.flatMap((value) => [...(mappingIndex.get(`${source}|${value}`) || [])]));
}

function episodeContext(episode, context) {
  const alertIds = episode?.alertIds || [];
  const tinyIds = (episode?.members || []).map((member) => clean(member.tinyId).replace(/^#/, '')).filter(Boolean);
  return {
    mappingIds: mappingIdsForEpisode(episode, context.mappingIndex),
    incidentKeys: unique(alertIds.flatMap((id) => context.incidentsByAlert.get(id) || [])),
    slackThreads: unique(tinyIds.flatMap((id) => context.slackByAlertNumber.get(id)?.threads || [])),
    slackChannels: unique(tinyIds.flatMap((id) => context.slackByAlertNumber.get(id)?.channels || [])),
    technicalFields: alertIds.map((id) => context.technicalByAlert.get(id)).filter(Boolean),
  };
}

function historicalStats(left, right, historicalEpisodes, context, nowMs) {
  if (!left?.fingerprintHash || !right?.fingerprintHash || left.fingerprintHash === right.fingerprintHash) {
    return {
      coOccurrenceCount: 0, overlappingEpisodeCount: 0, lifecycleOverlapRate: null,
      medianStartTimeDifferenceSeconds: null, sameConfirmedIncidentCount: 0,
      consistentPredecessor: null, predecessorRate: null,
    };
  }
  const cutoff = Math.min(toMs(left.firstSeen) || nowMs, toMs(right.firstSeen) || nowMs);
  const leftHistory = historicalEpisodes.filter((episode) => episode.fingerprintHash === left.fingerprintHash
    && toMs(episode.firstSeen) < cutoff && episode.episodeId !== left.episodeId);
  const rightHistory = historicalEpisodes.filter((episode) => episode.fingerprintHash === right.fingerprintHash
    && toMs(episode.firstSeen) < cutoff && episode.episodeId !== right.episodeId);
  const pairs = [];
  for (const leftEpisode of leftHistory) {
    for (const rightEpisode of rightHistory) {
      const leftAt = toMs(leftEpisode.firstSeen);
      const rightAt = toMs(rightEpisode.firstSeen);
      if (leftAt === null || rightAt === null || Math.abs(leftAt - rightAt) > CORRELATION_WINDOW_MS) continue;
      const temporal = temporalRelationship(leftEpisode, rightEpisode, nowMs);
      const leftKeys = episodeContext(leftEpisode, context).incidentKeys;
      const rightKeys = episodeContext(rightEpisode, context).incidentKeys;
      pairs.push({
        startDifferenceSeconds: Math.round(Math.abs(leftAt - rightAt) / 1000),
        overlaps: temporal.overlaps,
        sameIncident: intersection(leftKeys, rightKeys).length > 0,
        order: leftAt < rightAt ? 'LEFT' : rightAt < leftAt ? 'RIGHT' : 'SAME',
      });
    }
  }
  const leftPrecedes = pairs.filter((pair) => pair.order === 'LEFT').length;
  const rightPrecedes = pairs.filter((pair) => pair.order === 'RIGHT').length;
  const directional = leftPrecedes + rightPrecedes;
  const strongestDirection = Math.max(leftPrecedes, rightPrecedes);
  const predecessorRate = directional ? strongestDirection / directional : null;
  return {
    coOccurrenceCount: pairs.length,
    overlappingEpisodeCount: pairs.filter((pair) => pair.overlaps).length,
    lifecycleOverlapRate: pairs.length
      ? Number((pairs.filter((pair) => pair.overlaps).length / pairs.length).toFixed(4)) : null,
    medianStartTimeDifferenceSeconds: median(pairs.map((pair) => pair.startDifferenceSeconds)),
    sameConfirmedIncidentCount: pairs.filter((pair) => pair.sameIncident).length,
    consistentPredecessor: pairs.length >= 3 && predecessorRate >= 0.8
      ? (leftPrecedes > rightPrecedes ? left.episodeId : right.episodeId) : null,
    predecessorRate: predecessorRate === null ? null : Number(predecessorRate.toFixed(4)),
  };
}

function compareEpisodes(left, right, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const context = options.context || {
    mappingIndex: new Map(), incidentsByAlert: new Map(), slackByAlertNumber: new Map(), technicalByAlert: new Map(),
  };
  const historical = options.historical || historicalStats(
    left, right, options.historicalEpisodes || [], context, nowMs,
  );
  const temporal = temporalRelationship(left, right, nowMs);
  const leftContext = episodeContext(left, context);
  const rightContext = episodeContext(right, context);
  const signals = [];
  const contradictions = [];
  const add = (code, category, points, detail, strength = 'SUPPORTING') => {
    signals.push({ code, category, points, detail, strength });
  };

  if (temporal.overlaps) add('LIFECYCLE_OVERLAP', 'temporal', 18,
    `Operational windows overlap for ${temporal.overlapSeconds} seconds.`);
  else if (temporal.startDifferenceSeconds !== null && temporal.startDifferenceSeconds <= 300) {
    add('STARTS_WITHIN_5_MINUTES', 'temporal', 12,
      `Episode starts are ${temporal.startDifferenceSeconds} seconds apart.`);
  } else if (temporal.startDifferenceSeconds !== null && temporal.startDifferenceSeconds <= 900) {
    add('STARTS_WITHIN_15_MINUTES', 'temporal', 8,
      `Episode starts are ${temporal.startDifferenceSeconds} seconds apart.`);
  } else if (temporal.withinBoundedWindow) {
    add('STARTS_WITHIN_30_MINUTES', 'temporal', 4,
      `Episode starts are ${temporal.startDifferenceSeconds} seconds apart.`);
  }

  const leftEnvironment = normalize(left?.environment);
  const rightEnvironment = normalize(right?.environment);
  if (leftEnvironment && leftEnvironment !== 'unknown' && leftEnvironment === rightEnvironment) {
    add('SAME_ENVIRONMENT', 'environment', 8, `Both episodes are in ${left.environment}.`);
  } else if (leftEnvironment && rightEnvironment
    && leftEnvironment !== 'unknown' && rightEnvironment !== 'unknown'
    && leftEnvironment !== rightEnvironment) {
    contradictions.push({
      code: 'ENVIRONMENT_CONFLICT',
      detail: `Episode environments conflict: ${left.environment} versus ${right.environment}.`,
      penalty: 30,
    });
  }

  const commonIncidentKeys = intersection(leftContext.incidentKeys, rightContext.incidentKeys);
  if (commonIncidentKeys.length) add('SAME_CONFIRMED_JIRA_INCIDENT', 'jira', 55,
    `Both episodes have a confirmed relationship to ${commonIncidentKeys.join(', ')}.`, 'AUTHORITATIVE');

  const commonSlackThreads = intersection(leftContext.slackThreads, rightContext.slackThreads);
  if (commonSlackThreads.length) add('SAME_SLACK_THREAD', 'slack', 45,
    'Both episodes are referenced in the same Slack thread.', 'STRUCTURED');

  const commonMappingIds = intersection(leftContext.mappingIds, rightContext.mappingIds);
  const leftAliases = identityAliases(left);
  const rightAliases = identityAliases(right);
  const commonAliases = intersection(leftAliases, rightAliases);
  const sameStructuredSourceEntity = left.source === right.source
    && isStructured(left) && isStructured(right)
    && left.entityFingerprint && left.entityFingerprint === right.entityFingerprint
    && left.fingerprintHash !== right.fingerprintHash;
  const appDynamicsPair = left.source === 'AppDynamics' || right.source === 'AppDynamics';
  const nagiosPair = left.source === 'Nagios' || right.source === 'Nagios';
  const topologyNamespaces = new Set(['application', 'application-id', 'tier', 'node', 'host', 'service']);
  const leftTopology = componentParts(left, 'entity').filter((item) => topologyNamespaces.has(item.namespace));
  const rightTopology = componentParts(right, 'entity').filter((item) => topologyNamespaces.has(item.namespace));
  const commonTopology = intersection(leftTopology.map((item) => item.value), rightTopology.map((item) => item.value));

  const unambiguousCommonMapping = commonMappingIds.length === 1
    && leftContext.mappingIds.length === 1 && rightContext.mappingIds.length === 1;
  if (commonMappingIds.length && !unambiguousCommonMapping) {
    contradictions.push({
      code: 'AMBIGUOUS_CANONICAL_ENTITY_MAPPING',
      detail: 'The source identity aliases resolve to multiple canonical entities, so the mapping cannot anchor correlation.',
      penalty: 20,
    });
  }
  if (unambiguousCommonMapping) {
    add('VALIDATED_CANONICAL_ENTITY_MAPPING', 'identity', 45,
      `Validated mappings resolve both episodes to canonical entity ${commonMappingIds.join(', ')}.`, 'STRUCTURED');
  } else if ((appDynamicsPair || nagiosPair) && commonTopology.length && isStructured(left) && isStructured(right)) {
    add(appDynamicsPair ? 'STRUCTURED_APPDYNAMICS_TOPOLOGY' : 'STRUCTURED_NAGIOS_INFRASTRUCTURE',
      'topology', 38, `Structured source identity shares ${commonTopology.join(', ')}.`, 'STRUCTURED');
  } else if (sameStructuredSourceEntity) {
    add('SAME_STRUCTURED_SOURCE_ENTITY', 'identity', 38,
      'Different rules resolve to the same structured source entity.', 'STRUCTURED');
  } else if (commonAliases.length && isStructured(left) && isStructured(right)) {
    add('SHARED_STRUCTURED_ENTITY_ALIAS', 'identity', left.source === right.source ? 36 : 32,
      `Structured identities share ${commonAliases.join(', ')}.`, 'STRUCTURED');
  }

  const commonSymptoms = intersection(symptomTags(left), symptomTags(right));
  if (commonSymptoms.length) add('COMPATIBLE_TECHNICAL_SYMPTOM', 'symptom', 10,
    `Both episodes contain the specific technical symptom ${commonSymptoms.join(', ')}.`);

  const leftRules = structuredRuleValues(left);
  const rightRules = structuredRuleValues(right);
  const sameSourceDifferentRule = left.source === right.source
    && left.fingerprintHash !== right.fingerprintHash
    && leftRules.length && rightRules.length && intersection(leftRules, rightRules).length === 0;
  if (sameSourceDifferentRule && signals.some((signal) => ['identity', 'topology'].includes(signal.category))) {
    add('SAME_SOURCE_DIFFERENT_RULE', 'monitoring', 7,
      `${left.source} emitted different structured rules for the same entity.`);
  }

  if (historical.sameConfirmedIncidentCount > 0) {
    add('HISTORICAL_SHARED_INCIDENT', 'historical-incident', 25,
      `${historical.sameConfirmedIncidentCount} historical co-occurrences shared a confirmed Incident.`);
  }
  if (historical.coOccurrenceCount >= 3 && Number(historical.lifecycleOverlapRate || 0) >= 0.5) {
    add('REPEATED_HISTORICAL_OVERLAP', 'historical', 25,
      `${historical.coOccurrenceCount} historical co-occurrences have a ${Math.round(historical.lifecycleOverlapRate * 100)}% lifecycle overlap rate.`);
  } else if (historical.coOccurrenceCount >= 2) {
    add('REPEATED_HISTORICAL_COOCCURRENCE', 'historical', 15,
      `${historical.coOccurrenceCount} bounded historical co-occurrences were observed.`);
  } else if (historical.coOccurrenceCount === 1) {
    add('SINGLE_HISTORICAL_COOCCURRENCE', 'historical', 5,
      'One bounded historical co-occurrence was observed.');
  }

  const positiveScore = signals.reduce((sum, signal) => sum + signal.points, 0);
  const score = Math.max(0, Math.min(100,
    positiveScore - contradictions.reduce((sum, contradiction) => sum + contradiction.penalty, 0)));
  const categories = unique(signals.map((signal) => signal.category));
  const structuredAnchor = signals.some((signal) => ['identity', 'topology', 'jira', 'slack'].includes(signal.category));
  const highAuthorityAnchor = signals.some((signal) => [
    'VALIDATED_CANONICAL_ENTITY_MAPPING', 'STRUCTURED_APPDYNAMICS_TOPOLOGY',
    'STRUCTURED_NAGIOS_INFRASTRUCTURE', 'SAME_CONFIRMED_JIRA_INCIDENT', 'SAME_SLACK_THREAD',
  ].includes(signal.code));
  const grafanaSignatureFallback = [left, right].some((episode) => (
    episode.source === 'Grafana' && episode.fingerprintStrength === 'SIGNATURE_FALLBACK'
  ));
  const nonProximitySignal = signals.some((signal) => !['temporal', 'environment'].includes(signal.category));
  const currentOperationalLink = signals.some((signal) => ['temporal', 'jira', 'slack'].includes(signal.category));

  let level = 'NO_CORRELATION';
  if (score >= 70 && structuredAnchor && currentOperationalLink && categories.length >= 3
    && !contradictions.length
    && (!grafanaSignatureFallback || highAuthorityAnchor)) level = 'STRONG_CORRELATION';
  else if (score >= 45 && structuredAnchor && currentOperationalLink && categories.length >= 2) level = 'MODERATE_CORRELATION';
  else if (score >= 18 && nonProximitySignal && currentOperationalLink) level = 'WEAK_CORRELATION';

  const incidentRelationship = decisionOf(left) === 'INCIDENT' || decisionOf(right) === 'INCIDENT';
  const noiseRelationship = decisionOf(left) === 'NOISE' || decisionOf(right) === 'NOISE';
  return {
    pairId: `correlation-${hash([left.episodeId, right.episodeId].sort().join('|'))}`,
    level,
    score,
    episodeA: left.episodeId,
    episodeB: right.episodeId,
    sources: [left.source, right.source],
    crossSource: left.source !== right.source,
    sameSourceDifferentRule: Boolean(sameSourceDifferentRule),
    alertIds: {
      episodeA: (left.members || []).map((member) => member.tinyId || member.alertId),
      episodeB: (right.members || []).map((member) => member.tinyId || member.alertId),
    },
    decisions: { episodeA: decisionOf(left), episodeB: decisionOf(right) },
    titles: {
      episodeA: left.members?.[0]?.title || null,
      episodeB: right.members?.[0]?.title || null,
    },
    time: {
      episodeA: {
        start: left.firstSeen,
        recordedEnd: left.lastSeen,
        effectiveEnd: toIso(temporal.left.end),
        extendedByAuthoritativeCurrentFiring: temporal.left.operationallyOpen,
      },
      episodeB: {
        start: right.firstSeen,
        recordedEnd: right.lastSeen,
        effectiveEnd: toIso(temporal.right.end),
        extendedByAuthoritativeCurrentFiring: temporal.right.operationallyOpen,
      },
      startDifferenceSeconds: temporal.startDifferenceSeconds,
      overlapSeconds: temporal.overlapSeconds,
      overlaps: temporal.overlaps,
    },
    environment: { episodeA: left.environment, episodeB: right.environment },
    entities: { episodeA: left.canonicalEntity, episodeB: right.canonicalEntity },
    rules: { episodeA: left.ruleEvent, episodeB: right.ruleEvent },
    lifecycle: {
      episodeA: left.lifecycle || null,
      episodeB: right.lifecycle || null,
    },
    identityStrength: { episodeA: left.fingerprintStrength, episodeB: right.fingerprintStrength },
    structuredIdentityRelationship: signals.filter((signal) => ['identity', 'topology'].includes(signal.category)),
    slackRelationship: commonSlackThreads.length ? { sharedThreadCount: commonSlackThreads.length } : null,
    jiraRelationship: commonIncidentKeys.length ? { incidentKeys: commonIncidentKeys } : null,
    historical,
    evidence: signals,
    contradictoryEvidence: contradictions,
    plausibleBecause: signals.map((signal) => signal.detail),
    flags: {
      correlatedWithIncidentCandidate: level === 'STRONG_CORRELATION' && incidentRelationship,
      correlatedWithSupportedNoiseCandidate: level === 'STRONG_CORRELATION' && noiseRelationship,
      grafanaSignatureFallbackAuthorityReduced: grafanaSignatureFallback && !highAuthorityAnchor,
      timeProximityOnlyRejected: level === 'NO_CORRELATION'
        && signals.length > 0 && signals.every((signal) => ['temporal', 'environment'].includes(signal.category)),
    },
  };
}

function buildCandidateGroups(pairs) {
  const eligible = pairs.filter((pair) => LEVEL_RANK[pair.level] >= LEVEL_RANK.MODERATE_CORRELATION);
  const parent = new Map();
  const find = (value) => {
    if (!parent.has(value)) parent.set(value, value);
    if (parent.get(value) !== value) parent.set(value, find(parent.get(value)));
    return parent.get(value);
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  eligible.forEach((pair) => join(pair.episodeA, pair.episodeB));
  const components = new Map();
  eligible.forEach((pair) => {
    const root = find(pair.episodeA);
    if (!components.has(root)) components.set(root, { episodeIds: new Set(), pairs: [] });
    components.get(root).episodeIds.add(pair.episodeA);
    components.get(root).episodeIds.add(pair.episodeB);
    components.get(root).pairs.push(pair);
  });
  return [...components.values()].map((component) => {
    const pairLevels = component.pairs.map((pair) => pair.level);
    const level = pairLevels.includes('STRONG_CORRELATION') ? 'STRONG_CORRELATION' : 'MODERATE_CORRELATION';
    const episodeIds = [...component.episodeIds].sort();
    return {
      groupId: `correlation-group-${hash(episodeIds.join('|'))}`,
      level,
      episodeIds,
      pairIds: component.pairs.map((pair) => pair.pairId),
      maximumScore: Math.max(...component.pairs.map((pair) => pair.score)),
    };
  }).sort((left, right) => LEVEL_RANK[right.level] - LEVEL_RANK[left.level]
    || right.maximumScore - left.maximumScore);
}

function missingCorrelationData(episodes, context) {
  const reviewEpisodes = episodes.filter((episode) => decisionOf(episode) === 'REVIEW');
  const counts = {
    missingGrafanaRuleUid: 0,
    missingGrafanaLabels: 0,
    missingApplicationMapping: 0,
    missingNagiosHostMapping: 0,
    missingAppDynamicsTopology: 0,
    missingSlackThreadRelationship: 0,
    missingJiraRelationship: 0,
    signatureFallbackIdentity: 0,
    ambiguousOrUnsupportedIdentity: 0,
  };
  reviewEpisodes.forEach((episode) => {
    const episodeData = episodeContext(episode, context);
    const entityParts = componentParts(episode, 'entity');
    const ruleParts = componentParts(episode, 'ruleEvent');
    const technicalLabels = episodeData.technicalFields.flatMap((fields) => {
      const labels = fields?.labels;
      if (Array.isArray(labels)) return labels;
      return labels && typeof labels === 'object' ? Object.keys(labels) : [];
    });
    if (episode.source === 'Grafana' && !ruleParts.some((item) => item.namespace === 'rule-uid')) counts.missingGrafanaRuleUid += 1;
    if (episode.source === 'Grafana' && !technicalLabels.length) counts.missingGrafanaLabels += 1;
    if (!episodeData.mappingIds.length && !entityParts.some((item) => ['application', 'application-id', 'service'].includes(item.namespace))) {
      counts.missingApplicationMapping += 1;
    }
    if (episode.source === 'Nagios' && !entityParts.some((item) => item.namespace === 'host')) counts.missingNagiosHostMapping += 1;
    if (episode.source === 'AppDynamics' && !entityParts.some((item) => ['tier', 'node', 'transaction'].includes(item.namespace))) {
      counts.missingAppDynamicsTopology += 1;
    }
    if (!episodeData.slackThreads.length) counts.missingSlackThreadRelationship += 1;
    if (!episodeData.incidentKeys.length) counts.missingJiraRelationship += 1;
    if (episode.fingerprintStrength === 'SIGNATURE_FALLBACK') counts.signatureFallbackIdentity += 1;
    if (episode.fingerprintStrength === 'AMBIGUOUS' || episode.source === 'Unsupported/Unknown') counts.ambiguousOrUnsupportedIdentity += 1;
  });
  return counts;
}

function createEpisodeCorrelationDiscoveryService({
  database = db,
  episodeService = alertEpisodeService,
  clock = () => Date.now(),
  contextEnhancer = null,
} = {}) {
  async function loadContext(snapshot) {
    const allEpisodes = unique([...(snapshot.episodes || []), ...(snapshot.historicalEpisodes || [])]);
    const alertIds = unique(allEpisodes.flatMap((episode) => episode.alertIds || []));
    const alertNumbers = unique(allEpisodes.flatMap((episode) => (
      (episode.members || []).map((member) => clean(member.tinyId).replace(/^#/, '')).filter(Boolean)
    )));
    const [mappings, incidents, slack, technical] = await Promise.all([
      database.query(`
        SELECT entity_id, source_system, source_entity_id, source_entity_name,
          source_entity_type, environment, confidence_score, mapping_mechanism
        FROM source_identity_validated_mappings
        WHERE validation_status = 'VALID'
      `),
      alertIds.length ? database.query(`
        SELECT mapping.alert_id, mapping.jira_ticket_id AS incident_key, 'EXPLICIT_MAPPING' AS relationship
        FROM alert_incident_mappings mapping
        WHERE mapping.alert_id = ANY($1::text[]) AND mapping.jira_ticket_id IS NOT NULL
        UNION ALL
        SELECT reconciliation.alert_id, reconciliation.incident_key, reconciliation.relationship_state AS relationship
        FROM incident_alert_reconciliations reconciliation
        WHERE reconciliation.alert_id = ANY($1::text[]) AND reconciliation.current
          AND reconciliation.relationship_state = 'CONFIRMED_MATCH'
      `, [alertIds]) : Promise.resolve({ rows: [] }),
      alertNumbers.length ? database.query(`
        SELECT alert_number, slack_channel_id, thread_ts
        FROM slack_alert_events
        WHERE alert_number = ANY($1::text[])
      `, [alertNumbers]) : Promise.resolve({ rows: [] }),
      alertIds.length ? database.query(`
        SELECT alert.id,
          evaluation.technical_evidence #> '{coverage,evidenceCompleteness,fields}' AS technical_fields
        FROM alerts alert
        LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
        WHERE alert.id = ANY($1::text[])
      `, [alertIds]) : Promise.resolve({ rows: [] }),
    ]);
    const incidentsByAlert = new Map();
    incidents.rows.forEach((row) => {
      if (!incidentsByAlert.has(row.alert_id)) incidentsByAlert.set(row.alert_id, []);
      incidentsByAlert.get(row.alert_id).push(clean(row.incident_key));
    });
    const slackByAlertNumber = new Map();
    slack.rows.forEach((row) => {
      const key = clean(row.alert_number).replace(/^#/, '');
      if (!slackByAlertNumber.has(key)) slackByAlertNumber.set(key, { threads: [], channels: [] });
      const value = slackByAlertNumber.get(key);
      if (row.thread_ts) value.threads.push(`${clean(row.slack_channel_id)}:${clean(row.thread_ts)}`);
      if (row.slack_channel_id) value.channels.push(clean(row.slack_channel_id));
    });
    const technicalByAlert = new Map(technical.rows.map((row) => [row.id, row.technical_fields || {}]));
    return {
      mappingIndex: buildMappingIndex(mappings.rows),
      mappingRows: mappings.rows,
      incidentsByAlert,
      slackByAlertNumber,
      technicalByAlert,
    };
  }

  async function discover(options = {}) {
    const snapshot = await episodeService.buildSnapshot({ refresh: options.refresh === true });
    const storedContext = await loadContext(snapshot);
    // Observation-only enrichment can supply additional provenance-backed
    // mappings without persisting them or changing the discovery policy.
    const context = typeof contextEnhancer === 'function'
      ? await contextEnhancer(storedContext, snapshot)
      : storedContext;
    const episodes = snapshot.episodes || [];
    const historicalEpisodes = snapshot.historicalEpisodes || [];
    const nowMs = clock();
    const pairs = [];
    for (let leftIndex = 0; leftIndex < episodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < episodes.length; rightIndex += 1) {
        const left = episodes[leftIndex];
        const right = episodes[rightIndex];
        if (left.fingerprintHash === right.fingerprintHash) continue;
        pairs.push(compareEpisodes(left, right, { context, historicalEpisodes, nowMs }));
      }
    }
    const candidates = pairs.filter((pair) => pair.level !== 'NO_CORRELATION');
    const reviewEpisodes = episodes.filter((episode) => decisionOf(episode) === 'REVIEW');
    const incidentEpisodeIds = new Set(episodes.filter((episode) => decisionOf(episode) === 'INCIDENT').map((episode) => episode.episodeId));
    const noiseEpisodeIds = new Set(episodes.filter((episode) => decisionOf(episode) === 'NOISE').map((episode) => episode.episodeId));
    const reviewEpisodeIds = new Set(reviewEpisodes.map((episode) => episode.episodeId));
    const bestByReview = new Map(reviewEpisodes.map((episode) => [episode.episodeId, 'NO_CORRELATION']));
    candidates.forEach((pair) => [pair.episodeA, pair.episodeB].forEach((episodeId) => {
      if (!reviewEpisodeIds.has(episodeId)) return;
      if (LEVEL_RANK[pair.level] > LEVEL_RANK[bestByReview.get(episodeId)]) bestByReview.set(episodeId, pair.level);
    }));
    const strongReviewIncidentPairs = candidates.filter((pair) => pair.level === 'STRONG_CORRELATION'
      && ((reviewEpisodeIds.has(pair.episodeA) && incidentEpisodeIds.has(pair.episodeB))
        || (reviewEpisodeIds.has(pair.episodeB) && incidentEpisodeIds.has(pair.episodeA))));
    const strongReviewNoisePairs = candidates.filter((pair) => pair.level === 'STRONG_CORRELATION'
      && ((reviewEpisodeIds.has(pair.episodeA) && noiseEpisodeIds.has(pair.episodeB))
        || (reviewEpisodeIds.has(pair.episodeB) && noiseEpisodeIds.has(pair.episodeA))));
    const sourceBreakdown = unique(episodes.map((episode) => episode.source)).map((source) => ({
      source,
      episodes: episodes.filter((episode) => episode.source === source).length,
      reviewEpisodes: reviewEpisodes.filter((episode) => episode.source === source).length,
    })).sort((left, right) => right.episodes - left.episodes || left.source.localeCompare(right.source));
    const byLevel = (level) => candidates.filter((pair) => pair.level === level);
    const levelCounts = (selected) => ({
      strong: selected.filter((pair) => pair.level === 'STRONG_CORRELATION').length,
      moderate: selected.filter((pair) => pair.level === 'MODERATE_CORRELATION').length,
      weak: selected.filter((pair) => pair.level === 'WEAK_CORRELATION').length,
    });
    const reviewCandidateSourceDistribution = sourceBreakdown.map(({ source }) => {
      const ids = new Set(reviewEpisodes.filter((episode) => episode.source === source).map((episode) => episode.episodeId));
      const best = [...bestByReview.entries()].filter(([episodeId]) => ids.has(episodeId)).map(([, level]) => level);
      return {
        source,
        strong: best.filter((level) => level === 'STRONG_CORRELATION').length,
        moderate: best.filter((level) => level === 'MODERATE_CORRELATION').length,
        weak: best.filter((level) => level === 'WEAK_CORRELATION').length,
        none: best.filter((level) => level === 'NO_CORRELATION').length,
      };
    });
    const topCandidates = candidates.sort((left, right) => LEVEL_RANK[right.level] - LEVEL_RANK[left.level]
      || right.score - left.score || left.pairId.localeCompare(right.pairId));
    return {
      generatedAt: new Date(nowMs).toISOString(),
      policy: DISCOVERY_POLICY,
      window: { hours: 24, correlationWindowMinutes: CORRELATION_WINDOW_MS / 60000, historicalDays: 90 },
      summary: {
        totalEpisodesAnalyzed: episodes.length,
        reviewEpisodesAnalyzed: reviewEpisodes.length,
        strongCorrelationCandidates: byLevel('STRONG_CORRELATION').length,
        moderateCorrelationCandidates: byLevel('MODERATE_CORRELATION').length,
        weakCorrelationCandidates: byLevel('WEAK_CORRELATION').length,
        noCorrelationPairs: pairs.filter((pair) => pair.level === 'NO_CORRELATION').length,
        reviewEpisodesByBestCandidate: {
          strong: [...bestByReview.values()].filter((level) => level === 'STRONG_CORRELATION').length,
          moderate: [...bestByReview.values()].filter((level) => level === 'MODERATE_CORRELATION').length,
          weak: [...bestByReview.values()].filter((level) => level === 'WEAK_CORRELATION').length,
          none: [...bestByReview.values()].filter((level) => level === 'NO_CORRELATION').length,
        },
        reviewEpisodesStronglyCorrelatedWithIncident: unique(strongReviewIncidentPairs.flatMap((pair) => (
          [pair.episodeA, pair.episodeB].filter((id) => reviewEpisodeIds.has(id))
        ))).length,
        reviewEpisodesStronglyCorrelatedWithSupportedNoise: unique(strongReviewNoisePairs.flatMap((pair) => (
          [pair.episodeA, pair.episodeB].filter((id) => reviewEpisodeIds.has(id))
        ))).length,
        crossSourceCandidates: candidates.filter((pair) => pair.crossSource).length,
        crossSourceCandidatesByLevel: levelCounts(candidates.filter((pair) => pair.crossSource)),
        sameSourceDifferentRuleCandidates: candidates.filter((pair) => pair.sameSourceDifferentRule).length,
        sameSourceDifferentRuleCandidatesByLevel: levelCounts(candidates.filter((pair) => pair.sameSourceDifferentRule)),
      },
      sourceBreakdown,
      reviewCandidateSourceDistribution,
      missingData: missingCorrelationData(episodes, context),
      candidateGroups: buildCandidateGroups(candidates),
      topCandidates: topCandidates.slice(0, Math.min(50, Math.max(1, Number(options.limit) || 25))),
      strongReviewIncidentCandidates: strongReviewIncidentPairs,
      strongReviewNoiseCandidates: strongReviewNoisePairs,
      safeguards: {
        discoveryOnly: true,
        classificationsChanged: 0,
        classificationWrites: 0,
        humanOutcomeWrites: 0,
        historicalLabelChanges: 0,
        externalMutations: 0,
        automaticActionsEnabled: false,
        machineLearningTrainingPerformed: false,
        timeProximityCanEstablishCorrelationAlone: false,
        grafanaSignatureFallbackCanEstablishStrongCorrelationAlone: false,
      },
    };
  }

  return { discover, loadContext };
}

module.exports = {
  CORRELATION_WINDOW_MS,
  DISCOVERY_POLICY,
  LEVEL_RANK,
  buildCandidateGroups,
  buildMappingIndex,
  compareEpisodes,
  createEpisodeCorrelationDiscoveryService,
  episodeContext,
  historicalStats,
  identityAliases,
  missingCorrelationData,
  service: createEpisodeCorrelationDiscoveryService(),
  symptomTags,
  temporalRelationship,
};

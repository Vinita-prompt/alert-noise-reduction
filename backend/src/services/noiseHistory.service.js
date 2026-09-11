const { NOISE_ANALYSIS_CONFIG } = require('../config/noiseAnalysis');
const { NOISE_EVIDENCE_CONFIG } = require('../config/noiseEvidence');
const { NOISE_HISTORY_CONFIG } = require('../config/noiseHistory');
const accJiraReadService = require('./atlassian/accJiraRead.service');
const { service: operationsReadService } = require('./atlassian/opsReadValidation.service');
const { service: phaseOneService, lifecycleFromLogs } = require('./noiseAnalysis.service');
const { buildWindows, collectJira, groupIdentity } = require('./noiseEvidence.service');

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90 });
const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const milliseconds = typeof value === 'number' ? value : toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function percentile(values, position) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function occurrenceWeight(alert) {
  return Math.max(1, Number(alert.occurrenceCount || alert.occurrences || 1));
}

function alertDuration(alert) {
  const start = toMs(alert.createdAt);
  const end = toMs(alert.closeTime);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function acknowledgementDuration(alert) {
  const start = toMs(alert.createdAt);
  const end = toMs(alert.ackTime);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function isClosed(alert) {
  return Boolean(alert.closeTime) || /closed|resolved|recovered/i.test(String(alert.status || alert.operationsStatus || ''));
}

function isAcknowledged(alert) {
  return alert.acknowledged === true || toMs(alert.ackTime) !== null;
}

function distribution(values) {
  return values.reduce((result, value) => {
    const key = String(value || '').trim();
    if (key) result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function clusterByGap(alerts, gapMinutes) {
  const gapMs = gapMinutes * 60 * 1000;
  const sorted = alerts.filter((alert) => toMs(alert.createdAt) !== null).sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  const clusters = [];
  sorted.forEach((alert) => {
    const current = clusters.at(-1);
    const previous = current?.at(-1);
    if (!previous || toMs(alert.createdAt) - toMs(previous.createdAt) > gapMs) clusters.push([alert]);
    else current.push(alert);
  });
  return clusters;
}

function maximumInsideWindow(alerts, windowMs) {
  const sorted = alerts.filter((alert) => toMs(alert.createdAt) !== null).sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  let start = 0;
  let best = [];
  for (let end = 0; end < sorted.length; end += 1) {
    while (start < end && toMs(sorted[end].createdAt) - toMs(sorted[start].createdAt) > windowMs) start += 1;
    const candidate = sorted.slice(start, end + 1);
    if (sum(candidate.map(occurrenceWeight)) > sum(best.map(occurrenceWeight))) best = candidate;
  }
  return best;
}

function computeOccurrenceStats(alerts, options = {}) {
  const windowDays = Number(options.windowDays || 7);
  const valid = alerts.filter((alert) => toMs(alert.createdAt) !== null).sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  const timestamps = valid.map((alert) => toMs(alert.createdAt));
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]);
  const clusters = clusterByGap(valid, options.clusterWindowMinutes || 5);
  const clusterSizes = clusters.map((cluster) => sum(cluster.map(occurrenceWeight)));
  const hourBurst = maximumInsideWindow(valid, 60 * 60 * 1000);
  const stormBurst = maximumInsideWindow(valid, (options.stormWindowMinutes || 60) * 60 * 1000);
  const byDay = valid.reduce((result, alert) => {
    const key = new Date(toMs(alert.createdAt)).toISOString().slice(0, 10);
    result[key] = (result[key] || 0) + occurrenceWeight(alert);
    return result;
  }, {});
  const occurrenceCount = sum(valid.map(occurrenceWeight));
  const stormCount = sum(stormBurst.map(occurrenceWeight));
  const stormFrom = toMs(stormBurst[0]?.createdAt);
  const stormTo = toMs(stormBurst.at(-1)?.createdAt);
  return {
    activeDays: Object.keys(byDay).length,
    analysisDays: windowDays,
    averageIntervalMs: intervals.length ? Math.round(sum(intervals) / intervals.length) : null,
    distinctClusters: clusters.length,
    firstSeen: valid[0]?.createdAt || null,
    lastSeen: valid.at(-1)?.createdAt || null,
    largestCluster: clusterSizes.length ? Math.max(...clusterSizes) : 0,
    maximumOccurrencesInDay: Object.values(byDay).length ? Math.max(...Object.values(byDay)) : 0,
    maximumOccurrencesInHour: sum(hourBurst.map(occurrenceWeight)),
    medianClusterSize: percentile(clusterSizes, 0.5),
    medianIntervalMs: percentile(intervals, 0.5),
    occurrenceCount,
    occurrenceRecords: valid.length,
    occurrencesPerActiveDay: valid.length ? round(occurrenceCount / Math.max(1, Object.keys(byDay).length), 2) : 0,
    occurrencesPerDay: valid.length ? round(occurrenceCount / Math.max(1, windowDays), 2) : 0,
    storm: {
      observed: stormCount >= Number(options.stormMinimumOccurrences || 10),
      occurrences: stormCount,
      from: toIso(stormFrom),
      spanMinutes: stormFrom !== null && stormTo !== null ? round((stormTo - stormFrom) / 60000, 1) : null,
      to: toIso(stormTo),
      configuredWindowMinutes: Number(options.stormWindowMinutes || 60),
    },
  };
}

function computeDurationStats(alerts) {
  const durations = alerts.map(alertDuration).filter(Number.isFinite);
  const buckets = { under1m: 0, from1To5m: 0, from5To15m: 0, from15To60m: 0, over1h: 0 };
  durations.forEach((value) => {
    if (value < 60000) buckets.under1m += 1;
    else if (value < 5 * 60000) buckets.from1To5m += 1;
    else if (value < 15 * 60000) buckets.from5To15m += 1;
    else if (value < 60 * 60000) buckets.from15To60m += 1;
    else buckets.over1h += 1;
  });
  return {
    averageDurationMs: durations.length ? Math.round(sum(durations) / durations.length) : null,
    buckets,
    maximumDurationMs: durations.length ? Math.max(...durations) : null,
    medianDurationMs: percentile(durations, 0.5),
    minimumDurationMs: durations.length ? Math.min(...durations) : null,
    observedClosedDurations: durations.length,
    p90DurationMs: percentile(durations, 0.9),
  };
}

function computeAcknowledgementStats(alerts, observedHumanActions = 0) {
  const acknowledged = alerts.filter(isAcknowledged);
  const timings = acknowledged.map(acknowledgementDuration).filter(Number.isFinite);
  const count = alerts.length;
  return {
    acknowledgementCount: acknowledged.length,
    acknowledgementRate: count ? round(acknowledged.length / count * 100, 1) : 0,
    acknowledgementTimingCoverage: acknowledged.length ? round(timings.length / acknowledged.length * 100, 1) : 100,
    medianAckTimeMs: percentile(timings, 0.5),
    multipleHumanActions: observedHumanActions,
    observableHandlingEvents: acknowledged.length + observedHumanActions,
    p90AckTimeMs: percentile(timings, 0.9),
    unacknowledgedCount: count - acknowledged.length,
  };
}

function calculateTrend(currentValue, previousValue, options = {}) {
  const minimumSamples = Number(options.minimumSamples || 2);
  const currentSamples = Number(options.currentSamples || 0);
  const previousSamples = Number(options.previousSamples || 0);
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || currentSamples < minimumSamples || previousSamples < minimumSamples) {
    return { changePercentage: null, current: currentValue ?? null, previous: previousValue ?? null, trend: 'INSUFFICIENT_DATA' };
  }
  if (previousValue === 0) {
    if (currentValue === 0) return { changePercentage: 0, current: currentValue, previous: previousValue, trend: 'STABLE' };
    return { changePercentage: null, current: currentValue, previous: previousValue, trend: 'INCREASING' };
  }
  const changePercentage = round((currentValue - previousValue) / Math.abs(previousValue) * 100, 1);
  const absoluteChange = Math.abs(currentValue - previousValue);
  const threshold = Number(options.thresholdPercentage || 20);
  const minimumAbsoluteChange = Number(options.minimumAbsoluteChange || 0);
  const trend = absoluteChange < minimumAbsoluteChange || Math.abs(changePercentage) < threshold
    ? 'STABLE' : changePercentage > 0 ? 'INCREASING' : 'DECREASING';
  return { changePercentage, current: currentValue, previous: previousValue, trend };
}

function buildHeatmap(alerts, config = NOISE_HISTORY_CONFIG) {
  const cells = Array.from({ length: 7 }, (_, weekday) => Array.from({ length: 24 }, (_, hour) => ({ count: 0, hour, weekday })));
  alerts.forEach((alert) => {
    const value = toMs(alert.createdAt);
    if (value === null) return;
    const date = new Date(value);
    cells[date.getUTCDay()][date.getUTCHours()].count += occurrenceWeight(alert);
  });
  const flattened = cells.flat();
  const total = sum(flattened.map((cell) => cell.count));
  const peak = flattened.reduce((best, cell) => cell.count > best.count ? cell : best, { count: 0, hour: 0, weekday: 0 });
  const enough = total >= config.timePatternMinimumOccurrences && peak.count / Math.max(1, total) >= config.timePatternMinimumShare;
  return {
    cells: flattened,
    maximumCellCount: peak.count,
    timeZone: 'UTC',
    mostCommonWindow: enough ? {
      count: peak.count,
      hourFrom: peak.hour,
      hourTo: (peak.hour + 1) % 24,
      sharePercentage: round(peak.count / total * 100, 1),
      weekday: WEEKDAYS[peak.weekday],
    } : null,
  };
}

function filterPeriod(alerts, from, to) {
  return alerts.filter((alert) => {
    const value = toMs(alert.createdAt);
    return value !== null && value >= from && value < to;
  });
}

function outcomeSummary(outcomeMap, alerts) {
  const counts = {};
  alerts.forEach((alert) => {
    (outcomeMap.get(alert.id) || ['UNKNOWN']).forEach((label) => { counts[label] = (counts[label] || 0) + occurrenceWeight(alert); });
  });
  return counts;
}

function relationshipCoverage(alerts, windows = []) {
  if (!alerts.length) return { inspected: 0, percentage: 100, total: 0 };
  const inspected = alerts.filter((alert) => {
    const value = toMs(alert.createdAt);
    return value !== null && windows.some((window) => value >= toMs(window.from) && value <= toMs(window.to));
  }).length;
  return { inspected, percentage: round(inspected / alerts.length * 100, 1), total: alerts.length };
}

function jiraOutcomeFromEvidence(alerts, evidence) {
  const source = evidence?.sources?.find((item) => item.source === 'ACC Jira');
  const accepted = new Set((source?.relationships || []).filter((item) => item.relationship === 'confirmed').map((item) => item.evidenceId));
  const occurrenceIncidents = new Set();
  const occurrenceProblems = new Set();
  const distinctIncidents = new Set();
  const distinctProblems = new Set();
  const relationships = [];
  (source?.evidence || []).filter((item) => accepted.has(item.id)).forEach((item) => {
    const issueType = String(item.metadata?.issueType || '').toLowerCase();
    const isIncident = issueType.includes('incident');
    const isProblem = issueType.includes('problem');
    if (!isIncident && !isProblem) return;
    const issueKey = item.metadata?.issueKey || item.title?.match(/\bACC-\d+\b/i)?.[0]?.toUpperCase() || null;
    const exactAlertNumber = String(item.correlationKey || '').match(/^alert:(.+)$/)?.[1] || null;
    const matched = alerts.filter((alert) => (
      (exactAlertNumber && String(alert.tinyId) === exactAlertNumber)
      || (issueKey && [alert.title, alert.message, alert.description].some((value) => String(value || '').toUpperCase().includes(issueKey)))
    ));
    matched.forEach((alert) => {
      if (isIncident) occurrenceIncidents.add(alert.id);
      if (isProblem) occurrenceProblems.add(alert.id);
    });
    if (isIncident && issueKey) distinctIncidents.add(issueKey);
    if (isProblem && issueKey) distinctProblems.add(issueKey);
    relationships.push({ issueKey, issueType: item.metadata?.issueType || null, matchedOccurrenceIds: matched.map((alert) => alert.id), url: item.url || null });
  });
  const coverage = relationshipCoverage(alerts, evidence?.windows || []);
  return {
    coverage: { ...coverage, bounded: source?.bounded !== false, status: source?.status || 'unavailable' },
    distinctIncidentCount: distinctIncidents.size,
    distinctIncidents: [...distinctIncidents],
    distinctProblemCount: distinctProblems.size,
    distinctProblems: [...distinctProblems],
    incidentCount: occurrenceIncidents.size,
    incidentOccurrenceIds: occurrenceIncidents,
    incidentRate: alerts.length ? round(occurrenceIncidents.size / alerts.length * 100, 1) : 0,
    negativeOutcomesSupported: source?.bounded === false && coverage.inspected === alerts.length,
    problemCount: occurrenceProblems.size,
    problemOccurrenceIds: occurrenceProblems,
    problemRate: alerts.length ? round(occurrenceProblems.size / alerts.length * 100, 1) : 0,
    relationships,
  };
}

async function inspectAutoResolution(alerts, operationsService, config) {
  const candidates = alerts.filter((alert) => isClosed(alert) && !isAcknowledged(alert));
  const results = new Array(candidates.length);
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const alert = candidates[index];
      try {
        const response = await operationsService.getLogs(alert.id, { size: 100 });
        results[index] = { alert, lifecycle: lifecycleFromLogs(alert, response.values || []) };
      } catch {
        results[index] = { alert, lifecycle: null };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.autoResolutionConcurrency, candidates.length) }, worker));
  const provenIds = new Set();
  const humanHandledIds = new Set();
  let inspected = 0;
  let notAutoResolved = 0;
  let unknown = 0;
  let observedHumanActions = 0;
  results.forEach(({ alert, lifecycle }) => {
    if (!lifecycle || !lifecycle.verifiedClosedCycle || !lifecycle.closedBy) {
      unknown += 1;
      return;
    }
    inspected += 1;
    if (lifecycle.humanAcknowledgement || lifecycle.humanAction) humanHandledIds.add(alert.id);
    if (lifecycle.humanAction) observedHumanActions += 1;
    if (lifecycle.closedBySystem && !lifecycle.humanAcknowledgement && !lifecycle.humanAction && !isAcknowledged(alert)) provenIds.add(alert.id);
    else notAutoResolved += 1;
  });
  return {
    candidates: candidates.length,
    coveragePercentage: candidates.length ? round(inspected / candidates.length * 100, 1) : 100,
    humanHandledIds,
    inspected,
    notAutoResolved,
    observedHumanActions,
    proven: provenIds.size,
    provenIds,
    unknown,
  };
}

function classifyOutcomes(alerts, autoResolution, jiraOutcomes) {
  const result = new Map();
  alerts.forEach((alert) => {
    const labels = new Set();
    if (!isClosed(alert)) labels.add('STILL_OPEN');
    if (isAcknowledged(alert) || autoResolution.humanHandledIds.has(alert.id)) labels.add('HUMAN_HANDLED');
    if (autoResolution.provenIds.has(alert.id)) labels.add('AUTO_RESOLVED');
    if (jiraOutcomes.incidentOccurrenceIds.has(alert.id)) labels.add('INCIDENT_CREATED');
    if (jiraOutcomes.problemOccurrenceIds.has(alert.id)) labels.add('PROBLEM_LINKED');
    if (isClosed(alert) && jiraOutcomes.negativeOutcomesSupported
      && !jiraOutcomes.incidentOccurrenceIds.has(alert.id) && !jiraOutcomes.problemOccurrenceIds.has(alert.id)) {
      labels.add('CLOSED_WITHOUT_ESCALATION');
    }
    if (!labels.size || (isClosed(alert) && !labels.has('AUTO_RESOLVED') && !labels.has('INCIDENT_CREATED')
      && !labels.has('PROBLEM_LINKED') && !labels.has('CLOSED_WITHOUT_ESCALATION'))) labels.add('UNKNOWN');
    result.set(alert.id, [...labels]);
  });
  return result;
}

function deriveTypicalOutcome(alerts, occurrenceStats, durationStats, acknowledgementStats, outcomes, jiraOutcomes) {
  const count = alerts.length;
  const closureCount = alerts.filter(isClosed).length;
  const autoCount = outcomes.AUTO_RESOLVED || 0;
  const humanCount = outcomes.HUMAN_HANDLED || 0;
  let label = 'Mixed historical outcomes';
  if (count < 2) label = 'Insufficient historical evidence';
  else if (jiraOutcomes.incidentCount / count >= 0.25) label = 'Often associated with confirmed Incidents';
  else if (autoCount / count >= 0.5) label = 'Usually recovers through verified automated closure';
  else if (acknowledgementStats.acknowledgementRate >= 75 && closureCount / count >= 0.75) label = 'Usually closes after human acknowledgement';
  else if ((outcomes.CLOSED_WITHOUT_ESCALATION || 0) / count >= 0.75) label = 'Usually closes without known Jira escalation';
  else if (humanCount / count >= 0.6) label = 'Frequently creates operator acknowledgement workload';
  const evidence = [
    `${acknowledgementStats.acknowledgementCount} / ${count} alert records acknowledged`,
    `${closureCount} / ${count} alert records closed`,
    `Median duration ${durationStats.medianDurationMs === null ? 'not available' : `${Math.round(durationStats.medianDurationMs / 60000)}m`}`,
    `${jiraOutcomes.incidentCount} confirmed incident-linked occurrences in ${jiraOutcomes.coverage.inspected} inspected occurrence windows`,
    `${occurrenceStats.maximumOccurrencesInHour} maximum occurrences in one hour`,
  ];
  return { evidence, label };
}

function historicalConfidence({ alerts, autoResolution, jiraOutcomes, operationsCoverage, rangeComplete }) {
  let score = 0;
  const reasons = [];
  if (alerts.length >= 10) { score += 30; reasons.push(`${alerts.length} historical alert records`); }
  else if (alerts.length >= 3) { score += 15; reasons.push(`${alerts.length} historical alert records`); }
  const operationPercentage = operationsCoverage.total ? round(operationsCoverage.inspected / operationsCoverage.total * 100, 1) : 100;
  if (operationPercentage >= 95) { score += 30; reasons.push(`${operationPercentage}% Operations lifecycle field coverage`); }
  else if (operationPercentage >= 70) score += 15;
  if (jiraOutcomes.coverage.percentage >= 90) { score += 20; reasons.push(`${jiraOutcomes.coverage.percentage}% Jira relationship window coverage`); }
  else if (jiraOutcomes.coverage.percentage >= 25) score += 10;
  if (autoResolution.coveragePercentage >= 90) { score += 10; reasons.push(`${autoResolution.coveragePercentage}% auto-resolution candidate coverage`); }
  if (rangeComplete) { score += 10; reasons.push('Complete Operations range traversal'); }
  let level = score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';
  if (level === 'HIGH' && jiraOutcomes.coverage.percentage < 25) {
    level = 'MEDIUM';
    reasons.push('Partial Jira relationship coverage caps confidence at MEDIUM');
  }
  return { level, reasons, score: Math.min(100, score) };
}

function periodRows(alerts, outcomeMap, referenceTo, rangeDays, noiseLikelihood) {
  const definitions = [
    { key: 'current7d', label: 'Current 7d', days: 7, from: referenceTo - 7 * DAY_MS, to: referenceTo, minimumRange: 7 },
    { key: 'previous7d', label: 'Previous 7d', days: 7, from: referenceTo - 14 * DAY_MS, to: referenceTo - 7 * DAY_MS, minimumRange: 14 },
    { key: 'current30d', label: '30d', days: 30, from: referenceTo - 30 * DAY_MS, to: referenceTo, minimumRange: 30 },
    { key: 'current90d', label: '90d', days: 90, from: referenceTo - 90 * DAY_MS, to: referenceTo, minimumRange: 90 },
  ];
  return definitions.filter((item) => rangeDays >= item.minimumRange).map((item) => {
    const records = filterPeriod(alerts, item.from, item.to);
    const durations = computeDurationStats(records);
    const acknowledgements = computeAcknowledgementStats(records);
    const outcomes = outcomeSummary(outcomeMap, records);
    return {
      key: item.key,
      label: item.label,
      occurrenceCount: sum(records.map(occurrenceWeight)),
      alertRecords: records.length,
      medianDurationMs: durations.medianDurationMs,
      acknowledgedCount: acknowledgements.acknowledgementCount,
      acknowledgementRate: acknowledgements.acknowledgementRate,
      autoResolved: outcomes.AUTO_RESOLVED || 0,
      incidents: outcomes.INCIDENT_CREATED || 0,
      problems: outcomes.PROBLEM_LINKED || 0,
      noiseLikelihood,
      noiseLikelihoodScope: 'selected_phase2.6_pattern',
    };
  });
}

function trendsFor(alerts, referenceTo, rangeDays, config) {
  const current7 = filterPeriod(alerts, referenceTo - 7 * DAY_MS, referenceTo);
  const previous7 = rangeDays >= 14 ? filterPeriod(alerts, referenceTo - 14 * DAY_MS, referenceTo - 7 * DAY_MS) : [];
  const trendOptions = {
    currentSamples: current7.length,
    minimumAbsoluteChange: config.trendMinimumAbsoluteChange,
    minimumSamples: config.trendMinimumSamples,
    previousSamples: previous7.length,
    thresholdPercentage: config.trendThresholdPercentage,
  };
  const currentDuration = computeDurationStats(current7);
  const previousDuration = computeDurationStats(previous7);
  const currentAck = computeAcknowledgementStats(current7);
  const previousAck = computeAcknowledgementStats(previous7);
  const frequency = calculateTrend(sum(current7.map(occurrenceWeight)), sum(previous7.map(occurrenceWeight)), trendOptions);
  const duration = calculateTrend(currentDuration.medianDurationMs, previousDuration.medianDurationMs, {
    ...trendOptions,
    currentSamples: currentDuration.observedClosedDurations,
    minimumAbsoluteChange: 60000,
    previousSamples: previousDuration.observedClosedDurations,
  });
  const humanToil = calculateTrend(currentAck.observableHandlingEvents, previousAck.observableHandlingEvents, trendOptions);
  const acknowledgement = calculateTrend(currentAck.acknowledgementRate, previousAck.acknowledgementRate, { ...trendOptions, minimumAbsoluteChange: 5 });
  let previous30 = null;
  if (rangeDays >= 60) {
    const current30Alerts = filterPeriod(alerts, referenceTo - 30 * DAY_MS, referenceTo);
    const previous30Alerts = filterPeriod(alerts, referenceTo - 60 * DAY_MS, referenceTo - 30 * DAY_MS);
    const current30Duration = computeDurationStats(current30Alerts);
    const previous30Duration = computeDurationStats(previous30Alerts);
    const current30Ack = computeAcknowledgementStats(current30Alerts);
    const previous30Ack = computeAcknowledgementStats(previous30Alerts);
    const options30 = {
      currentSamples: current30Alerts.length,
      minimumAbsoluteChange: config.trendMinimumAbsoluteChange,
      minimumSamples: config.trendMinimumSamples,
      previousSamples: previous30Alerts.length,
      thresholdPercentage: config.trendThresholdPercentage,
    };
    previous30 = {
      acknowledgement: calculateTrend(current30Ack.acknowledgementRate, previous30Ack.acknowledgementRate, { ...options30, minimumAbsoluteChange: 5 }),
      duration: calculateTrend(current30Duration.medianDurationMs, previous30Duration.medianDurationMs, {
        ...options30,
        currentSamples: current30Duration.observedClosedDurations,
        minimumAbsoluteChange: 60000,
        previousSamples: previous30Duration.observedClosedDurations,
      }),
      frequency: calculateTrend(sum(current30Alerts.map(occurrenceWeight)), sum(previous30Alerts.map(occurrenceWeight)), options30),
      humanToil: calculateTrend(current30Ack.observableHandlingEvents, previous30Ack.observableHandlingEvents, options30),
      period: 'current_30d_vs_previous_30d',
    };
  }
  return { acknowledgement, duration, frequency, humanToil, period: 'current_7d_vs_previous_7d', previous30 };
}

function historyTimeline(alerts, outcomeMap) {
  return alerts.filter((alert) => toMs(alert.createdAt) !== null).sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt)).map((alert) => ({
    acknowledged: isAcknowledged(alert),
    alertNumber: alert.tinyId || null,
    canonicalOperationsId: alert.id,
    closedAt: alert.closeTime || null,
    createdAt: alert.createdAt,
    durationMs: alertDuration(alert),
    occurrenceCount: occurrenceWeight(alert),
    outcomes: outcomeMap.get(alert.id) || ['UNKNOWN'],
    priority: alert.priority || null,
    status: alert.status || null,
  }));
}

function paginateItems(items, page = 1, size = 10) {
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeSize = [10, 25, 50].includes(Number(size)) ? Number(size) : 10;
  const totalPages = Math.max(1, Math.ceil(items.length / safeSize));
  const selectedPage = Math.min(safePage, totalPages);
  const start = (selectedPage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    pagination: { page: selectedPage, size: safeSize, total: items.length, totalPages },
  };
}

function withIndividualAlertPage(value, options = {}) {
  const selected = paginateItems([...value.timeline].reverse(), Number(options.page || 1), Number(options.size || 10));
  return { ...value, individualAlerts: selected.items, individualAlertPagination: selected.pagination };
}

function createNoiseHistoryService({
  analysisConfig = NOISE_ANALYSIS_CONFIG,
  config = NOISE_HISTORY_CONFIG,
  evidence = null,
  jiraService = accJiraReadService,
  now = () => Date.now(),
  operationsService = operationsReadService,
  phaseOne = phaseOneService,
} = {}) {
  const cache = new Map();

  async function getHistoricalJiraEvidence(group, range) {
    if (evidence?.getEvidence) return evidence.getEvidence(group.groupId, { range });
    const windows = buildWindows(group, NOISE_EVIDENCE_CONFIG);
    try {
      const jira = await collectJira(group, groupIdentity(group), windows, {
        config: NOISE_EVIDENCE_CONFIG,
        jiraService,
      });
      return { sources: [jira], windows };
    } catch {
      return { sources: [{ bounded: true, evidence: [], relationships: [], source: 'ACC Jira', status: 'error' }], windows };
    }
  }

  async function resolveGroup(groupId, range, sourceRange, refresh) {
    try {
      return await phaseOne.getGroup(groupId, { range, refresh });
    } catch (error) {
      if (error.status !== 404 || !sourceRange || sourceRange === range) throw error;
      const source = await phaseOne.getGroup(groupId, { range: sourceRange });
      const target = await phaseOne.analyzeRange(range, refresh);
      const match = target.groups.find((group) => group.fingerprintHash === source.group.fingerprintHash);
      if (!match) throw safeError('The selected pattern was not present in the requested historical range.', 'NOISE_HISTORY_PATTERN_NOT_FOUND', 404);
      return {
        analysisCoverage: target.analysisCoverage,
        analysisExecutionTimeMs: target.analysisExecutionTimeMs,
        analysisVersion: target.analysisVersion,
        group: match,
        range,
        rangeFrom: target.rangeFrom,
        rangeTo: target.rangeTo,
      };
    }
  }

  async function getHistory(groupId, options = {}) {
    const id = String(groupId || '').trim();
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const range = String(options.range || '7d').toLowerCase();
    if (!config.allowedRanges.includes(range)) throw safeError('range must be 7d, 30d, or 90d.', 'INVALID_NOISE_HISTORY_RANGE');
    const sourceRange = ['24h', '7d', '30d', '90d'].includes(String(options.sourceRange || '').toLowerCase()) ? String(options.sourceRange).toLowerCase() : range;
    const refresh = String(options.refresh || '').toLowerCase() === 'true';
    const phaseOneResult = await resolveGroup(id, range, sourceRange, refresh);
    const group = phaseOneResult.group;
    const key = `${analysisConfig.analysisVersion}:${config.historyModelVersion}:${group.fingerprintHash}:${range}`;
    if (refresh) cache.delete(key);
    const cached = cache.get(key);
    if (!refresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) {
      return withIndividualAlertPage({ ...cached.value, cache: { ...cached.value.cache, hit: true } }, options);
    }

    const startedAt = now();
    const alerts = group.alerts || [];
    const [autoResolution, crossSourceEvidence] = await Promise.all([
      inspectAutoResolution(alerts, operationsService, config),
      getHistoricalJiraEvidence(group, range),
    ]);
    const jiraOutcomes = jiraOutcomeFromEvidence(alerts, crossSourceEvidence);
    const outcomeMap = classifyOutcomes(alerts, autoResolution, jiraOutcomes);
    const outcomes = outcomeSummary(outcomeMap, alerts);
    const windowDays = RANGE_DAYS[range];
    const occurrenceStats = computeOccurrenceStats(alerts, { ...config, windowDays });
    const durationStats = computeDurationStats(alerts);
    const acknowledgementStats = computeAcknowledgementStats(alerts, autoResolution.observedHumanActions);
    const operationsCoverage = {
      inspected: alerts.filter((alert) => toMs(alert.createdAt) !== null && (isClosed(alert) ? toMs(alert.closeTime) !== null : true)).length,
      total: alerts.length,
    };
    operationsCoverage.percentage = operationsCoverage.total ? round(operationsCoverage.inspected / operationsCoverage.total * 100, 1) : 100;
    const referenceTo = toMs(phaseOneResult.rangeTo) ?? now();
    const trends = trendsFor(alerts, referenceTo, windowDays, config);
    const typicalOutcome = deriveTypicalOutcome(alerts, occurrenceStats, durationStats, acknowledgementStats, outcomes, jiraOutcomes);
    const confidence = historicalConfidence({
      alerts,
      autoResolution,
      jiraOutcomes,
      operationsCoverage,
      rangeComplete: phaseOneResult.analysisCoverage?.complete !== false,
    });
    const crossSourceCoverage = { inspected: 0, percentage: alerts.length ? 0 : 100, status: 'on_demand_phase2', total: alerts.length };
    const value = {
      analysisModelVersion: analysisConfig.analysisModelVersion || '2.6',
      analysisVersion: analysisConfig.analysisVersion,
      analysisWindow: { from: phaseOneResult.rangeFrom || null, range, to: phaseOneResult.rangeTo || null },
      autoResolution: {
        candidates: autoResolution.candidates,
        inspected: autoResolution.inspected,
        proven: autoResolution.proven,
        notAutoResolved: autoResolution.notAutoResolved,
        unknown: autoResolution.unknown,
        coveragePercentage: autoResolution.coveragePercentage,
      },
      cache: { hit: false, key, ttlMs: config.cacheTtlMs },
      coverage: {
        autoResolution: { inspected: autoResolution.inspected, percentage: autoResolution.coveragePercentage, total: autoResolution.candidates },
        crossSourceEnrichment: crossSourceCoverage,
        jira: jiraOutcomes.coverage,
        operationsLifecycle: operationsCoverage,
      },
      durationStats,
      executionTimeMs: Math.max(0, now() - startedAt),
      fingerprint: group.fingerprintHash,
      flappingLikeTransitions: group.flappingLikeEvidence?.transitions || 0,
      groupId: group.groupId,
      heatmapData: buildHeatmap(alerts, config),
      historicalConfidence: confidence,
      historicalContext: `${occurrenceStats.occurrenceCount} occurrences across ${occurrenceStats.activeDays} active day${occurrenceStats.activeDays === 1 ? '' : 's'}. ${acknowledgementStats.acknowledgementRate}% acknowledged. Median duration ${durationStats.medianDurationMs === null ? 'is unavailable' : `is ${Math.round(durationStats.medianDurationMs / 60000)} minutes`}. ${group.flappingLikeEvidence?.transitions || 0} flapping-like transitions. ${jiraOutcomes.incidentCount} confirmed incident-linked occurrences in ${jiraOutcomes.coverage.inspected} inspected occurrence windows.`,
      historyModelVersion: config.historyModelVersion,
      humanToil: {
        acknowledgementCount: acknowledgementStats.acknowledgementCount,
        acknowledgementRate: acknowledgementStats.acknowledgementRate,
        medianAcknowledgementTimeMs: acknowledgementStats.medianAckTimeMs,
        observableHandlingEvents: acknowledgementStats.observableHandlingEvents,
      },
      jiraOutcomes: {
        coverage: jiraOutcomes.coverage,
        distinctIncidentCount: jiraOutcomes.distinctIncidentCount,
        distinctIncidents: jiraOutcomes.distinctIncidents,
        distinctProblemCount: jiraOutcomes.distinctProblemCount,
        distinctProblems: jiraOutcomes.distinctProblems,
        incidentCount: jiraOutcomes.incidentCount,
        incidentRate: jiraOutcomes.incidentRate,
        problemCount: jiraOutcomes.problemCount,
        problemRate: jiraOutcomes.problemRate,
        relationships: jiraOutcomes.relationships,
      },
      noiseLikelihood: group.noiseLikelihood,
      occurrenceStats,
      outcomeDistribution: outcomes,
      periodTable: periodRows(alerts, outcomeMap, referenceTo, windowDays, group.noiseLikelihood),
      priorityDistribution: distribution(alerts.map((alert) => alert.priority)),
      readOnly: true,
      sourceDistribution: distribution(alerts.map((alert) => alert.sourceSystem || alert.source)),
      timeline: historyTimeline(alerts, outcomeMap),
      trends,
      typicalOutcome,
      corroboration: {
        corroboratedOccurrences: 0,
        inspectedOccurrences: crossSourceCoverage.inspected,
        totalOccurrences: alerts.length,
        status: 'Use the independent Phase 2 evidence endpoint for bounded cross-source corroboration.',
      },
      externalMutations: 'none',
    };
    cache.set(key, { cachedAtMs: now(), value });
    return withIndividualAlertPage(value, options);
  }

  function invalidate() {
    cache.clear();
  }

  return { getHistory, invalidate };
}

module.exports = {
  buildHeatmap,
  calculateTrend,
  classifyOutcomes,
  computeAcknowledgementStats,
  computeDurationStats,
  computeOccurrenceStats,
  createNoiseHistoryService,
  deriveTypicalOutcome,
  historicalConfidence,
  historyTimeline,
  inspectAutoResolution,
  jiraOutcomeFromEvidence,
  paginateItems,
  periodRows,
  trendsFor,
  service: createNoiseHistoryService(),
};

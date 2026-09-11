const { NOISE_SCORING_CONFIG } = require('../config/noiseScoring');

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function hasLabel(group, label) {
  return (group.labels || []).includes(label);
}

function durationMs(alert) {
  if (Number.isFinite(alert.timeToCloseMs)) return alert.timeToCloseMs;
  const start = toMs(alert.createdAt);
  const end = toMs(alert.closeTime);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function acknowledgementMs(alert) {
  if (Number.isFinite(alert.mttaMs)) return alert.mttaMs;
  const start = toMs(alert.createdAt);
  const end = toMs(alert.ackTime);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function calculateHumanToil(group, config = NOISE_SCORING_CONFIG) {
  const alerts = group.alerts || [];
  const acknowledged = alerts.filter((alert) => alert.acknowledged === true || alert.ackTime || Number.isFinite(alert.mttaMs));
  const acknowledgementTimes = acknowledged.map(acknowledgementMs).filter(Number.isFinite);
  const humanActions = Number(group.humanActionCount || 0);
  const rate = alerts.length ? acknowledged.length / alerts.length * 100 : 0;
  const averageAcknowledgementMs = average(acknowledgementTimes);
  const signals = [];
  let score = 0;
  if (acknowledged.length >= 2) {
    const points = Math.min(6, Math.round(Math.log2(acknowledged.length + 1) * 1.5));
    score += points;
    signals.push({ detail: `${acknowledged.length} acknowledgements across ${alerts.length} alert records`, points, signal: 'Repeated acknowledgement workload' });
  }
  if (acknowledged.length >= 2 && rate >= 50) {
    score += 2;
    signals.push({ detail: `${Number(rate.toFixed(1))}% of occurrences were acknowledged`, points: 2, signal: 'High acknowledgement rate' });
  }
  if (acknowledged.length >= 2 && averageAcknowledgementMs !== null && averageAcknowledgementMs <= 5 * 60 * 1000) {
    score += 2;
    signals.push({ detail: `Average acknowledgement time ${Math.round(averageAcknowledgementMs / 1000)} seconds`, points: 2, signal: 'Rapid repeated acknowledgement' });
  }
  if (humanActions >= 2 && score < config.dimensions.humanToil.maximum) {
    const points = Math.min(2, config.dimensions.humanToil.maximum - score);
    score += points;
    signals.push({ detail: `${humanActions} identifiable human actions`, points, signal: 'Repeated human action' });
  }
  score = Math.min(config.dimensions.humanToil.maximum, score);
  let level = 'LOW';
  if (acknowledged.length >= config.highHumanToil.minimumAcknowledgements && rate >= config.highHumanToil.acknowledgementRate) level = 'HIGH';
  else if (acknowledged.length >= 2 || humanActions >= 2) level = 'MEDIUM';
  return {
    acknowledgementCount: acknowledged.length,
    acknowledgementRate: Number(rate.toFixed(1)),
    averageAcknowledgementMs: averageAcknowledgementMs === null ? null : Math.round(averageAcknowledgementMs),
    humanActionCount: humanActions,
    level,
    score,
    signals,
  };
}

function dimension(key, label, maximum, signals) {
  const raw = signals.reduce((sum, item) => sum + Number(item.points || 0), 0);
  return { key, label, maximum, score: Math.min(maximum, Math.max(0, Math.round(raw))), signals };
}

function scoreNoiseLikelihood(group, config = NOISE_SCORING_CONFIG) {
  const occurrences = Math.max(1, Number(group.occurrences || group.alerts?.length || 1));
  const clusters = Math.max(1, Number(group.clusterCount || group.distinctTimeClusters || group.duplicateBurstCount || 1));
  const dimensions = [];

  const repetitionSignals = [];
  if (occurrences > 1) repetitionSignals.push({ detail: `${occurrences} total occurrences`, points: Math.min(15, Math.round(Math.log2(occurrences) * 3.5)), signal: 'Occurrence frequency' });
  if (clusters > 1) repetitionSignals.push({ detail: `${clusters} distinct time clusters`, points: Math.min(10, Math.round(Math.log2(clusters + 1) * 2.5)), signal: 'Time-cluster recurrence' });
  dimensions.push(dimension('repetitionFrequency', 'Repetition / Frequency', config.dimensions.repetitionFrequency.maximum, repetitionSignals));

  const duplicateSignals = [];
  if (hasLabel(group, 'duplicate')) {
    const peak = Math.max(2, Number(group.duplicateOccurrencePeak || 2));
    duplicateSignals.push({ detail: `${group.duplicateBurstCount || 1} duplicate burst${group.duplicateBurstCount === 1 ? '' : 's'} detected`, points: 8, signal: 'Duplicate fingerprint behavior' });
    duplicateSignals.push({ detail: `Largest burst contained ${peak} alert records`, points: Math.min(7, Math.round((peak - 1) * 1.5)), signal: 'Duplicate burst density' });
  }
  dimensions.push(dimension('duplicateBehavior', 'Duplicate Behavior', config.dimensions.duplicateBehavior.maximum, duplicateSignals));

  const recurringSignals = [];
  if (hasLabel(group, 'recurring')) {
    recurringSignals.push({ detail: `${clusters} clusters across the selected history`, points: 8, signal: 'Recurring fingerprint behavior' });
    recurringSignals.push({ detail: `${occurrences} occurrences`, points: Math.min(7, Math.max(0, clusters - 1)), signal: 'Recurring cluster depth' });
  }
  dimensions.push(dimension('recurringBehavior', 'Recurring Behavior', config.dimensions.recurringBehavior.maximum, recurringSignals));

  const lifecycleSignals = [];
  if (hasLabel(group, 'flapping')) lifecycleSignals.push({ detail: `${group.cycles || 0} same-ID lifecycle cycles were proven`, points: 15, signal: 'Same-ID flapping' });
  else if (hasLabel(group, 'flapping_like')) {
    const transitions = Number(group.flappingLikeEvidence?.transitions || 0);
    lifecycleSignals.push({ detail: `${transitions} close → new-alert transitions inside ${group.flappingLikeEvidence?.windowMinutes || 60} minutes`, points: Math.min(15, 8 + Math.max(0, transitions - 3) * 2), signal: 'Cross-ID flapping-like burst' });
  }
  dimensions.push(dimension('lifecycleBehavior', 'Lifecycle / Flapping-like Behavior', config.dimensions.lifecycleBehavior.maximum, lifecycleSignals));

  const autoSignals = [];
  if (hasLabel(group, 'auto_resolved')) {
    const proven = Math.max(1, Number(group.autoResolvedCount || 1));
    const ratio = Math.min(1, proven / Math.max(1, group.alerts?.length || 1));
    autoSignals.push({ detail: `${proven} occurrence${proven === 1 ? '' : 's'} had proven automated closure`, points: 6, signal: 'Proven automatic resolution' });
    autoSignals.push({ detail: `${Math.round(ratio * 100)}% of grouped records`, points: Math.round(ratio * 4), signal: 'Auto-resolution coverage within pattern' });
  }
  dimensions.push(dimension('autoResolution', 'Auto-resolution', config.dimensions.autoResolution.maximum, autoSignals));

  const humanToil = calculateHumanToil(group, config);
  dimensions.push(dimension('humanToil', 'Human Toil', config.dimensions.humanToil.maximum, humanToil.signals));

  const durations = (group.alerts || []).map(durationMs).filter(Number.isFinite);
  const averageDurationMs = average(durations);
  const shortSignals = [];
  if (averageDurationMs !== null && averageDurationMs <= 10 * 60 * 1000) shortSignals.push({ detail: `Average active duration ${Math.round(averageDurationMs / 60000)} minutes`, points: 5, signal: 'Short-lived behavior' });
  dimensions.push(dimension('shortLived', 'Short-lived Behavior', config.dimensions.shortLived.maximum, shortSignals));

  const outcomeSignals = [];
  if (group.downstreamEvidenceStatus === 'complete' && !hasLabel(group, 'incident_backed') && !hasLabel(group, 'problem_backed') && occurrences >= 3) {
    outcomeSignals.push({ detail: 'Complete downstream evidence found no incident or problem relationship', points: 5, signal: 'No downstream operational consequence' });
  }
  dimensions.push(dimension('historicalOutcome', 'Historical Outcome', config.dimensions.historicalOutcome.maximum, outcomeSignals));

  const rawTotal = dimensions.reduce((sum, item) => sum + item.score, 0);
  const noiseLikelihood = Math.max(0, Math.min(100, rawTotal));
  return {
    breakdown: dimensions.flatMap((item) => item.signals.map((signal) => ({ ...signal, dimension: item.label }))),
    dimensions,
    humanToil,
    noiseLikelihood,
    normalization: {
      cappedTotal: noiseLikelihood,
      formula: 'sum(capped dimension scores); total dimension capacity = 100',
      maximum: 100,
      rawTotal,
    },
    shortLived: averageDurationMs !== null && averageDurationMs <= 10 * 60 * 1000,
  };
}

function assessReviewRisk(group, context = {}, config = NOISE_SCORING_CONFIG) {
  const alerts = group.alerts || [];
  const reasons = [];
  const add = (signal, points) => { if (points) reasons.push({ points, signal }); };
  const hasP1 = alerts.some((alert) => /^P1$/i.test(String(alert.priority || '')));
  const hasP2 = alerts.some((alert) => /^P2$/i.test(String(alert.priority || '')));
  const hasCritical = alerts.some((alert) => /^critical$/i.test(String(alert.severity || '')));
  const hasLongDuration = alerts.some((alert) => Number.isFinite(durationMs(alert)) && durationMs(alert) >= 60 * 60 * 1000);
  const production = alerts.some((alert) => /^(prod|production|aws-prod)$/i.test(String(alert.environment || '')));
  if (hasP1) add('P1 operational priority', config.risk.weights.p1);
  if (hasCritical) add('Critical monitoring severity', config.risk.weights.criticalSeverity);
  if (hasP2) add('P2 operational priority', config.risk.weights.p2);
  if (context.incidentBacked || hasLabel(group, 'incident_backed')) add('Confirmed incident relationship', config.risk.weights.incidentBacked);
  if (context.problemBacked || hasLabel(group, 'problem_backed')) add('Confirmed problem relationship', config.risk.weights.problemBacked);
  if (Number(context.correlationConfidence || 0) >= 60 || context.strongCrossSourceEvidence || hasLabel(group, 'cross_source_evidence')) add('Strong cross-source evidence', config.risk.weights.crossSourceEvidence);
  if (hasLongDuration) add('Long active duration', config.risk.weights.longDuration);
  if (production) add('Production environment', config.risk.weights.productionEnvironment);
  if (group.customerFacing === true) add('Explicit customer-facing service', config.risk.weights.customerFacing);
  const score = Math.min(100, reasons.reduce((sum, item) => sum + item.points, 0));
  let level = 'LOW';
  if (hasP1 || hasCritical) level = 'CRITICAL';
  else if (score >= config.risk.bands.high) level = 'HIGH';
  else if (score >= config.risk.bands.medium) level = 'MEDIUM';
  return { level, reasons, score };
}

function recommendationFor(noiseLikelihood, reviewRisk, config = NOISE_SCORING_CONFIG) {
  const highNoise = noiseLikelihood >= config.scoreBands.high;
  const mediumNoise = noiseLikelihood >= config.scoreBands.medium;
  const highRisk = ['HIGH', 'CRITICAL'].includes(reviewRisk?.level);
  if (highNoise && highRisk) return 'Strong noise pattern, but manual review required.';
  if (highNoise) return 'Candidate for alert-rule tuning review.';
  if (!mediumNoise && highRisk) return 'Likely actionable — retain.';
  if (mediumNoise && highRisk) return 'Possible tuning opportunity, but manual review required.';
  if (mediumNoise) return 'Review as an alert-rule tuning candidate.';
  return 'Needs more evidence.';
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function scoreDistribution(items, key = 'noiseLikelihood') {
  const values = items
    .map((item) => Number(typeof item === 'number' ? item : item?.[key]))
    .filter(Number.isFinite)
    .map((value) => Math.max(0, Math.min(100, value)))
    .sort((left, right) => left - right);
  const histogram = [
    ['0–10', 0, 10],
    ['11–20', 11, 20],
    ['21–30', 21, 30],
    ['31–40', 31, 40],
    ['41–50', 41, 50],
    ['51–60', 51, 60],
    ['61–70', 61, 70],
    ['71–80', 71, 80],
    ['81–90', 81, 90],
    ['91–100', 91, 100],
  ].map(([range, minimum, maximum]) => ({ range, count: values.filter((value) => value >= minimum && value <= maximum).length }));
  return {
    count: values.length,
    histogram,
    maximum: values.at(-1) || 0,
    mean: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0,
    median: Number(percentile(values, 0.5).toFixed(2)),
    minimum: values[0] || 0,
    p75: Number(percentile(values, 0.75).toFixed(2)),
    p90: Number(percentile(values, 0.9).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
  };
}

module.exports = {
  assessReviewRisk,
  calculateHumanToil,
  recommendationFor,
  scoreDistribution,
  scoreNoiseLikelihood,
};

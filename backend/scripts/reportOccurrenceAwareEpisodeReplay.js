#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/db');
const {
  buildEpisodes,
  buildEpisodesLegacy,
  historicalBehaviorFor,
} = require('../src/services/alertEpisode.service');
const { service: evaluationService } = require('../src/services/liveMultiSourceEvaluation.service');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function clean(value) {
  return String(value ?? '').trim();
}

function countBy(items, valueFor) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const key = valueFor(item);
    if (key) counts.set(key, Number(counts.get(key) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function selectColumns(alias) {
  return `
    ${alias}.id, ${alias}.atlassian_ops_tiny_id, ${alias}.title, ${alias}.description, ${alias}.signal,
    ${alias}.source, ${alias}.raw_payload, ${alias}.extracted_details, ${alias}.received_at, ${alias}.last_seen_at,
    ${alias}.status, ${alias}.severity, ${alias}.environment, ${alias}.service, ${alias}.acknowledged,
    ${alias}.escalation_status, ${alias}.learning_alert_signature_v1, ${alias}.learning_entity_key_v1,
    evaluation.final_decision AS evaluation_final_decision,
    evaluation.source AS evaluation_source,
    evaluation.notification_role AS evaluation_notification_role,
    evaluation.feature_snapshot AS evaluation_feature_snapshot,
    evaluation.technical_evidence AS evaluation_technical_evidence,
    evaluation.explanation AS evaluation_explanation,
    evaluation.evidence_references AS evaluation_evidence_references,
    TO_JSONB(appd_occurrence) AS appdynamics_occurrence_evidence,
    TO_JSONB(grafana_occurrence) AS grafana_occurrence_evidence,
    TO_JSONB(nagios_occurrence) AS nagios_occurrence_evidence,
    EXISTS (SELECT 1 FROM alert_incident_mappings mapping WHERE mapping.alert_id = ${alias}.id)
      OR EXISTS (SELECT 1 FROM incident_alert_reconciliations reconciliation
        WHERE reconciliation.alert_id = ${alias}.id AND reconciliation.current
          AND reconciliation.relationship_state = 'CONFIRMED_MATCH') AS explicit_incident,
    EXISTS (SELECT 1 FROM alert_occurrence_outcomes outcome
      WHERE outcome.alert_id = ${alias}.id AND outcome.is_current
        AND outcome.outcome = 'CONFIRMED_NOISE') AS confirmed_noise`;
}

function occurrenceJoins(alias) {
  return `
    LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = ${alias}.id
    LEFT JOIN appdynamics_alert_occurrence_evidence appd_occurrence ON appd_occurrence.alert_id = ${alias}.id
    LEFT JOIN grafana_alert_occurrence_evidence grafana_occurrence ON grafana_occurrence.alert_id = ${alias}.id
    LEFT JOIN nagios_alert_occurrence_evidence nagios_occurrence ON nagios_occurrence.alert_id = ${alias}.id`;
}

async function rowsForAlertIds(alertIds) {
  const result = await db.query(`
    SELECT ${selectColumns('alert')}
    FROM alerts alert
    ${occurrenceJoins('alert')}
    WHERE alert.id = ANY($1::text[])
    ORDER BY alert.received_at, alert.id
  `, [alertIds]);
  return result.rows;
}

async function historicalRows(rows) {
  const signatures = [...new Set(rows.map((row) => clean(row.learning_alert_signature_v1)).filter(Boolean))];
  const entities = [...new Set(rows.map((row) => clean(row.learning_entity_key_v1)).filter(Boolean))];
  if (!signatures.length && !entities.length) return [];
  const result = await db.query(`
    WITH ranked AS (
      SELECT alert.*,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(alert.learning_entity_key_v1, alert.learning_alert_signature_v1, alert.id)
          ORDER BY alert.received_at DESC, alert.id
        ) AS identity_rank
      FROM alerts alert
      WHERE alert.atlassian_ops_alert_id IS NOT NULL
        AND alert.received_at >= NOW() - INTERVAL '90 days'
        AND (alert.learning_alert_signature_v1 = ANY($1::text[])
          OR alert.learning_entity_key_v1 = ANY($2::text[]))
    )
    SELECT ${selectColumns('ranked')}
    FROM ranked
    ${occurrenceJoins('ranked')}
    WHERE ranked.identity_rank <= 500
    ORDER BY ranked.received_at, ranked.id
  `, [signatures, entities]);
  return result.rows;
}

function addHistoricalContext(snapshot, historicalEpisodes) {
  const episodes = snapshot.episodes.map((episode) => ({
    ...episode,
    historicalBehavior: historicalBehaviorFor(episode, historicalEpisodes),
  }));
  const membership = new Map();
  episodes.forEach((episode) => episode.alertIds.forEach((alertId) => membership.set(alertId, {
    ...episode,
    notificationRole: episode.roles[alertId],
    members: undefined,
    roles: undefined,
  })));
  return { ...snapshot, episodes, membership };
}

function populationItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data?.items)) return value.data.items;
  if (Array.isArray(value?.items)) return value.items;
  throw new Error('The population file does not contain a data.items or items array.');
}

function oldEpisodeId(item) {
  return item.evaluation?.episode?.episodeId || null;
}

function oldRole(item) {
  return item.evaluation?.notificationRole || item.evaluation?.episode?.notificationRole?.role || 'UNKNOWN';
}

function subtype(evaluation) {
  if (!evaluation) return null;
  if (evaluation.finalDecision === 'NOISE') return evaluation.noiseDetection?.primary || evaluation.classification?.subtype || null;
  return evaluation.explanation?.decisionBasis || evaluation.reviewSubReason || evaluation.classification?.subtype || null;
}

async function mapLimited(values, limit, callback) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await callback(values[index], index);
    }
  }));
  return output;
}

function identityFor(context) {
  const member = context?.members?.[0] || null;
  return {
    source: context?.source || null,
    canonicalEntity: context?.canonicalEntity || null,
    ruleEvent: context?.ruleEvent || null,
    episodeGroupingBasis: context?.episodeGroupingBasis || null,
    episodeIdentityStatus: context?.episodeIdentityStatus || null,
    authoritativeOccurrence: context?.fingerprintComponents?.authoritativeOccurrence || null,
    unconfirmedSourceAlias: context?.fingerprintComponents?.unconfirmedSourceAlias || null,
    structuredLabels: context?.fingerprintComponents?.structuredLabels || [],
    sourceAlias: member?.sourceAlias || null,
  };
}

function transitionEvidence(item, context, evaluation) {
  if (!evaluation) return null;
  const dimensions = evaluation.explanation?.dimensions || {};
  const lifecycle = evaluation.technicalEvidence?.monitoringLifecycle || {};
  const occurrence = lifecycle.occurrence || {};
  const incidentEvidence = evaluation.evidenceVector?.incidentEvidence || {};
  const noiseEvidence = evaluation.evidenceVector?.noiseEvidence || {};
  const sourceAdapter = (evaluation.adapterDiagnostics || []).find((entry) => entry.source === item.source) || null;
  const oldEpisode = item.evaluation?.episode || {};
  const evidenceReferences = evaluation.evidenceReferences || [];
  const referencesFor = (pattern) => evidenceReferences.filter((reference) => (
    pattern.test(clean(reference.source))
  )).map((reference) => ({
    id: reference.id || null,
    source: reference.source || null,
    type: reference.type || null,
    timestamp: reference.timestamp || null,
    provenance: reference.provenance || null,
  }));
  const detectorFor = (name) => {
    const detector = evaluation.noiseDetection?.detectors?.[name] || {};
    return {
      observed: detector.observed === true,
      evidenceIds: detector.evidenceIds || [],
      reason: detector.reason || null,
      candidateObserved: detector.candidateObserved === true,
    };
  };
  const duplicate = detectorFor('DUPLICATE');
  const duplicateRecheck = duplicate.observed && duplicate.evidenceIds.length
    ? 'SUPPORTED_DUPLICATE'
    : duplicate.candidateObserved ? 'POSSIBLE_DUPLICATE' : 'NONE';
  const identityConfirmed = context?.episodeIdentityStatus === 'IDENTITY_CONFIRMED';
  const isolatedUnresolved = context?.episodeGroupingBasis === 'UNRESOLVED_IDENTITY_ISOLATED';
  return {
    sourceIdentity: evaluation.context?.sourceIdentity || null,
    identityQuality: {
      oldFingerprintStrength: oldEpisode.fingerprintStrength || null,
      newFingerprintStrength: context?.fingerprintStrength || null,
      newEpisodeIdentityStatus: context?.episodeIdentityStatus || null,
      groupingBasis: context?.episodeGroupingBasis || null,
    },
    ruleUid: occurrence.ruleUid || context?.ruleEvent || null,
    fingerprint: occurrence.fingerprint || context?.fingerprintComponents?.authoritativeOccurrence || null,
    labels: occurrence.labels || context?.fingerprintComponents?.structuredLabels || [],
    sourceLifecycle: {
      currentlyFiring: lifecycle.persistence?.currentlyFiring ?? null,
      recovered: lifecycle.recovery?.recovered ?? null,
      startedAt: occurrence.startedAt || null,
      recoveredAt: lifecycle.recovery?.recoveredAt || null,
      lifecycleAvailable: lifecycle.completeness?.lifecycleEvidenceAvailable ?? null,
      signals: lifecycle.signals || [],
      intervention: lifecycle.intervention || null,
    },
    sourceEvidenceStatus: sourceAdapter ? {
      status: sourceAdapter.status,
      pipelineState: sourceAdapter.pipelineState,
      failureReason: sourceAdapter.failureReason,
      matchedRecords: sourceAdapter.matchedRecords,
    } : null,
    priority: evaluation.alert?.priority || item.priority || null,
    classification: evaluation.classification || null,
    historicalEvidence: evaluation.evidenceVector?.historicalEvidence || null,
    noiseEvidence: {
      score: noiseEvidence.score ?? null,
      reasons: noiseEvidence.reasons || [],
      evidenceIds: noiseEvidence.evidenceIds || [],
      observed: evaluation.noiseDetection?.observed || [],
    },
    incidentEvidence: {
      score: incidentEvidence.score ?? null,
      reasons: incidentEvidence.reasons || [],
      evidenceIds: incidentEvidence.evidenceIds || [],
      strongOperationalIncidentEvidence: dimensions.strongOperationalIncidentEvidence === true,
      acceptedStrongOperationalIncidentEvidence:
        evaluation.explanation?.episode?.decisionEvidence?.strongOperationalIncident === true,
      independentStrongIncidentEvidence:
        evaluation.explanation?.episode?.decisionEvidence?.independentStrongIncidentEvidence === true,
      strongOperationalIncidentEvidenceIds:
        evaluation.explanation?.episode?.decisionEvidence?.strongOperationalIncidentEvidenceIds || [],
      strongAuthoritativeTechnicalIncident: dimensions.strongAuthoritativeTechnicalIncident === true,
      confirmedJiraRelationships: dimensions.confirmedJiraRelationships || 0,
      meaningfulOperationalHandling: dimensions.meaningfulOperationalHandling === true,
    },
    slackEvidence: {
      messageCount: Number(evaluation.context?.slack?.slackMessageCount || 0),
      acknowledged: evaluation.context?.slack?.slackAcknowledged === true,
      acknowledgedAt: evaluation.context?.slack?.slackAcknowledgedAt || null,
      responder: evaluation.context?.slack?.slackResponder || null,
      threadActivity: Number(evaluation.context?.slack?.slackThreadActivity || 0),
      references: referencesFor(/^Slack$/i),
    },
    jiraEvidence: {
      incidentId: evaluation.context?.jiraIncident?.jiraIncidentId || null,
      incidentKey: evaluation.context?.jiraIncident?.jiraIncidentKey || null,
      incidentStatus: evaluation.context?.jiraIncident?.jiraIncidentStatus || null,
      references: referencesFor(/Jira/i),
    },
    duplicateRecheck,
    noiseRecheck: {
      AUTO_RESOLVED: detectorFor('AUTO_RESOLVED'),
      FLAPPING: detectorFor('FLAPPING'),
      INFORMATIONAL: detectorFor('INFORMATIONAL'),
      NON_ACTIONABLE: detectorFor('NON_ACTIONABLE'),
      DUPLICATE: duplicate,
      CORRELATED: detectorFor('CORRELATED'),
    },
    occurrenceAssessment: identityConfirmed
      ? 'SOURCE_IDENTITY_SUPPORTED_OCCURRENCE'
      : isolatedUnresolved ? 'CONSERVATIVELY_ISOLATED_UNRESOLVED_OCCURRENCE' : 'UNRESOLVED',
    fallbackOperationalEvidence: dimensions.fallbackOperationalEvidence || null,
    episodeIntervention: context?.intervention || null,
    businessImpact: evaluation.businessImpact,
    actionability: evaluation.actionability,
    decisionConfidence: evaluation.decisionConfidence || 'NOT_CALIBRATED',
    underlyingEvent: evaluation.underlyingEvent,
    notificationRole: evaluation.notificationRole,
    evaluationPath: evaluation.explanation?.decisionBasis || null,
    finalDecisionReasons: evaluation.explanation?.reasons || [],
    decisionBlockers: evaluation.explanation?.decisionBlockers || [],
    groupingDelta: {
      oldRole: oldRole(item),
      newRole: context?.notificationRole?.role || 'UNKNOWN',
      oldEpisodeSize: Number(oldEpisode.notificationCount || oldEpisode.alertIds?.length || 1),
      newEpisodeSize: Number(context?.notificationCount || context?.alertIds?.length || 1),
      oldEpisodeIdentityStatus: oldEpisode.episodeIdentityStatus || null,
      newEpisodeIdentityStatus: context?.episodeIdentityStatus || null,
    },
    oldRepeatLabelDisposition: {
      status: 'LEGACY_GROUPING_REQUIRES_REPLAY',
      supersededForTraining: true,
      trainingEligible: false,
      reason: 'The former Repeat result depended on legacy time-window grouping and is excluded from ML labels.',
    },
  };
}

function compactChangedAlert(item) {
  const evidence = item.evidence || {};
  return {
    alertId: item.alertId,
    canonicalAlertId: item.canonicalAlertId,
    source: item.source,
    oldEpisodeId: item.oldEpisodeId,
    newEpisodeId: item.newEpisodeId,
    oldDecision: item.oldDecision,
    sameEvidenceLegacyDecision: item.sameEvidenceLegacyDecision,
    newDecision: item.newDecision,
    oldRole: item.oldRole,
    newRole: item.newRole,
    identityQuality: evidence.identityQuality || null,
    sourceIdentity: evidence.sourceIdentity || null,
    ruleUid: evidence.ruleUid || null,
    fingerprint: evidence.fingerprint || null,
    labelCount: Array.isArray(evidence.labels) ? evidence.labels.length : 0,
    sourceLifecycle: evidence.sourceLifecycle ? {
      currentlyFiring: evidence.sourceLifecycle.currentlyFiring,
      recovered: evidence.sourceLifecycle.recovered,
      lifecycleAvailable: evidence.sourceLifecycle.lifecycleAvailable,
      intervention: evidence.sourceLifecycle.intervention ? {
        acknowledged: evidence.sourceLifecycle.intervention.acknowledged,
        investigated: evidence.sourceLifecycle.intervention.investigated,
        remediated: evidence.sourceLifecycle.intervention.remediated,
        escalated: evidence.sourceLifecycle.intervention.escalated,
      } : null,
    } : null,
    sourceEvidenceStatus: evidence.sourceEvidenceStatus || null,
    priority: evidence.priority || null,
    classification: evidence.classification || null,
    historicalEvidenceScore: evidence.historicalEvidence?.score ?? null,
    historicalEvidenceReasons: evidence.historicalEvidence?.reasons || [],
    noiseEvidence: evidence.noiseEvidence || null,
    incidentEvidence: evidence.incidentEvidence || null,
    slackEvidence: evidence.slackEvidence || null,
    jiraEvidence: evidence.jiraEvidence || null,
    duplicateRecheck: evidence.duplicateRecheck || 'NONE',
    noiseRecheck: evidence.noiseRecheck || null,
    occurrenceAssessment: evidence.occurrenceAssessment || 'UNRESOLVED',
    businessImpact: evidence.businessImpact || null,
    actionability: evidence.actionability || null,
    decisionConfidence: evidence.decisionConfidence || 'NOT_CALIBRATED',
    underlyingEvent: evidence.underlyingEvent || null,
    notificationRole: evidence.notificationRole || null,
    evaluationPath: evidence.evaluationPath || null,
    finalDecisionReasons: evidence.finalDecisionReasons || [],
    groupingDelta: evidence.groupingDelta || null,
    oldRepeatLabelDisposition: evidence.oldRepeatLabelDisposition || null,
    replayError: item.replayError || null,
  };
}

function activationValidation(changedAlertAudit) {
  const invalidIncidentPromotions = changedAlertAudit.filter((item) => (
    item.newDecision === 'INCIDENT'
    && !(item.evidence?.incidentEvidence?.acceptedStrongOperationalIncidentEvidence === true
      && item.evidence.incidentEvidence.strongOperationalIncidentEvidenceIds.length > 0)
    && Number(item.evidence?.incidentEvidence?.confirmedJiraRelationships || 0) === 0
  ));
  const unsupportedNoisePromotions = changedAlertAudit.filter((item) => (
    item.newDecision === 'NOISE'
    && !(item.evidence?.noiseEvidence?.observed || []).length
  ));
  const unexplainedTransitions = changedAlertAudit.filter((item) => (
    !(item.evidence?.finalDecisionReasons || []).length
  ));
  const timeWindowOnlyBoundaries = changedAlertAudit.filter((item) => (
    item.evidence?.identityQuality?.groupingBasis === 'TIME_WINDOW_ONLY'
  ));
  return {
    invalidIncidentPromotions: invalidIncidentPromotions.map((item) => item.alertId),
    unsupportedNoisePromotions: unsupportedNoisePromotions.map((item) => item.alertId),
    unexplainedTransitions: unexplainedTransitions.map((item) => item.alertId),
    timeWindowOnlyBoundaries: timeWindowOnlyBoundaries.map((item) => item.alertId),
    episodeBoundariesSourceIdentityDriven: timeWindowOnlyBoundaries.length === 0,
    decision: invalidIncidentPromotions.length === 0
      && unsupportedNoisePromotions.length === 0
      && unexplainedTransitions.length === 0
      && timeWindowOnlyBoundaries.length === 0
      ? 'READY_TO_ENABLE_OCCURRENCE_AWARE_GROUPING' : 'DO_NOT_ENABLE',
  };
}

async function main() {
  const quiet = process.argv.includes('--quiet');
  const originalConsoleLog = console.log;
  if (quiet) console.log = () => {};
  const populationPath = argument('--population');
  if (!populationPath) throw new Error('Usage: npm run report:occurrence-aware-episodes -- --population <frozen-population.json> [--evaluate]');
  const resolvedPath = path.resolve(populationPath);
  const population = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const items = populationItems(population);
  const alertIds = items.map((item) => clean(item.alertId)).filter(Boolean);
  const rows = await rowsForAlertIds(alertIds);
  if (rows.length !== alertIds.length) {
    throw new Error(`Frozen population contains ${alertIds.length} alerts, but ${rows.length} stored rows were found.`);
  }

  const [newBase, legacy, history] = await Promise.all([
    Promise.resolve(buildEpisodes(rows)),
    Promise.resolve(buildEpisodesLegacy(rows)),
    historicalRows(rows).then((historyRowsValue) => buildEpisodes(historyRowsValue).episodes),
  ]);
  const occurrenceAware = addHistoricalContext(newBase, history);
  const oldItemsById = new Map(items.map((item) => [item.alertId, item]));
  const oldEpisodes = new Map();
  items.forEach((item) => {
    const episodeId = oldEpisodeId(item);
    if (!episodeId) return;
    if (!oldEpisodes.has(episodeId)) oldEpisodes.set(episodeId, []);
    oldEpisodes.get(episodeId).push(item);
  });
  const auditedOldEpisodes = [...oldEpisodes.entries()].filter(([, members]) => (
    members.some((item) => oldRole(item) === 'REPEAT')
  ));
  const affectedAlertIds = [...new Set(auditedOldEpisodes.flatMap(([, members]) => members.map((item) => item.alertId)))];

  const evaluate = process.argv.includes('--evaluate');
  const replayRows = evaluate ? await mapLimited(affectedAlertIds, 2, async (alertId) => {
    const context = occurrenceAware.membership.get(alertId);
    const legacyContext = legacy.membership.get(alertId);
    try {
      const legacyResult = await evaluationService.evaluate(alertId, {
        persist: false,
        refresh: false,
        requestId: `legacy-same-evidence-replay-${alertId}`,
        episodeContextOverride: legacyContext,
      });
      const result = await evaluationService.evaluate(alertId, {
        persist: false,
        refresh: false,
        requestId: `occurrence-aware-replay-${alertId}`,
        episodeContextOverride: context,
      });
      return { alertId, result, legacyResult, error: null };
    } catch (error) {
      return {
        alertId, result: null, legacyResult: null,
        error: clean(error.safeMessage || error.message || error.code || 'Replay failed'),
      };
    }
  }) : [];
  const replayById = new Map(replayRows.map((item) => [item.alertId, item]));

  const changedAlertAudit = affectedAlertIds.map((alertId) => {
    const item = oldItemsById.get(alertId);
    const context = occurrenceAware.membership.get(alertId);
    const replay = replayById.get(alertId);
    return {
      alertId: item?.displayId || alertId,
      canonicalAlertId: alertId,
      source: item?.source || context?.source || null,
      oldEpisodeId: oldEpisodeId(item || {}),
      newEpisodeId: context?.episodeId || null,
      oldDecision: item?.evaluation?.finalDecision || null,
      sameEvidenceLegacyDecision: replay?.legacyResult?.finalDecision || (evaluate ? 'REPLAY_FAILED' : 'NOT_EVALUATED'),
      newDecision: replay?.result?.finalDecision || (evaluate ? 'REPLAY_FAILED' : 'NOT_EVALUATED'),
      oldRole: oldRole(item || {}),
      newRole: context?.notificationRole?.role || 'UNKNOWN',
      evidence: transitionEvidence(item || {}, context, replay?.result),
      sameEvidenceLegacy: transitionEvidence(item || {}, legacy.membership.get(alertId), replay?.legacyResult),
      replayError: replay?.error || null,
    };
  });

  const changedEpisodes = auditedOldEpisodes.map(([episodeId, members]) => {
    const newEpisodeIds = [...new Set(members.map((item) => occurrenceAware.membership.get(item.alertId)?.episodeId).filter(Boolean))];
    return {
      oldEpisodeId: episodeId,
      oldMembers: members.map((item) => item.displayId),
      newEpisodes: newEpisodeIds.map((newEpisodeId) => {
        const episode = occurrenceAware.episodes.find((candidate) => candidate.episodeId === newEpisodeId);
        return {
          newEpisodeId,
          members: episode.members.map((member) => member.tinyId ? `#${member.tinyId}` : member.alertId),
          identity: identityFor(episode),
          splitReason: episode.groupingEvidence,
        };
      }),
      whyChanged: newEpisodeIds.length > 1
        ? 'The old episode contained multiple source occurrences or unresolved identities; temporal proximity was removed as a continuation signal.'
        : 'The occurrence-aware grouping preserved this episode.',
    };
  });

  const repeatAudit = items.filter((item) => oldRole(item) === 'REPEAT').map((item) => {
    const context = occurrenceAware.membership.get(item.alertId);
    const replay = replayById.get(item.alertId);
    const newEvaluation = replay?.result || null;
    const newRole = context?.notificationRole?.role || 'UNKNOWN';
    const status = newRole === 'REPEAT' ? 'REPEAT_SUPPORTED'
      : newRole === 'DUPLICATE' ? 'DUPLICATE_CANDIDATE'
        : newEvaluation?.finalDecision === 'INCIDENT' ? 'INCIDENT'
          : newEvaluation?.noiseDetection?.primary === 'FLAPPING' ? 'FLAPPING'
            : newEvaluation?.finalDecision === 'NEEDS_REVIEW' ? 'REVIEW' : 'NEW_PRIMARY';
    return {
      alertId: item.displayId,
      canonicalAlertId: item.alertId,
      source: item.source,
      identity: identityFor(context),
      oldEpisodeId: oldEpisodeId(item),
      newEpisodeId: context?.episodeId || null,
      oldRole: oldRole(item),
      newRole,
      oldDecision: item.evaluation?.finalDecision || null,
      sameEvidenceLegacyDecision: replay?.legacyResult?.finalDecision || (evaluate ? 'REPLAY_FAILED' : 'NOT_EVALUATED'),
      newDecision: newEvaluation?.finalDecision || (evaluate ? 'REPLAY_FAILED' : 'NOT_EVALUATED'),
      oldSubtype: subtype(item.evaluation),
      newSubtype: subtype(newEvaluation),
      outcomeStatus: status,
      evidence: transitionEvidence(item, context, newEvaluation),
      sameEvidenceLegacy: transitionEvidence(item, legacy.membership.get(item.alertId), replay?.legacyResult),
      replayError: replay?.error || null,
    };
  });

  const oldDecisionCounts = countBy(items, (item) => item.evaluation?.finalDecision);
  const hypotheticalItems = items.map((item) => {
    const replay = replayById.get(item.alertId);
    return { decision: replay?.result?.finalDecision || item.evaluation?.finalDecision || null };
  });
  const sameEvidenceLegacyItems = items.map((item) => {
    const replay = replayById.get(item.alertId);
    return { decision: replay?.legacyResult?.finalDecision || item.evaluation?.finalDecision || null };
  });
  const oldRepeatCount = items.filter((item) => oldRole(item) === 'REPEAT').length;
  const newRepeatCount = [...occurrenceAware.membership.values()]
    .filter((context) => context.notificationRole?.role === 'REPEAT').length;
  const potentialDuplicateCount = [...occurrenceAware.membership.values()]
    .filter((context) => context.notificationRole?.role === 'DUPLICATE').length;
  const potentialRecurrenceCount = repeatAudit.filter((item) => {
    const context = occurrenceAware.membership.get(item.canonicalAlertId);
    return item.newRole === 'PRIMARY' && context?.episodeIdentityStatus === 'IDENTITY_CONFIRMED'
      && Number(context?.historicalBehavior?.episodeCount || 0) > 0;
  }).length;
  const potentialFlappingCount = repeatAudit.filter((item) => (
    replayById.get(item.canonicalAlertId)?.result?.noiseDetection?.primary === 'FLAPPING'
  )).length;
  const wrongGroups = changedEpisodes.filter((episode) => episode.newEpisodes.length > 1).length;
  const correctGroups = changedEpisodes.length - wrongGroups;
  const unresolvedGroups = changedEpisodes.reduce((sum, episode) => sum + episode.newEpisodes.filter((item) => (
    item.identity.episodeIdentityStatus === 'IDENTITY_UNCONFIRMED'
  )).length, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_SHADOW_REPLAY',
    frozenPopulation: { file: resolvedPath, alerts: items.length },
    comparison: {
      oldEpisodes: oldEpisodes.size,
      legacyBuilderEpisodes: legacy.episodes.length,
      newEpisodes: occurrenceAware.episodes.length,
      oldRepeatNotifications: oldRepeatCount,
      newRepeatNotifications: newRepeatCount,
      oldDecisions: oldDecisionCounts,
      sameEvidenceLegacyDecisions: evaluate ? countBy(sameEvidenceLegacyItems, (item) => item.decision) : null,
      hypotheticalDecisions: evaluate ? countBy(hypotheticalItems, (item) => item.decision) : null,
    },
    potentials: {
      repeat: newRepeatCount,
      duplicate: potentialDuplicateCount,
      recurrence: potentialRecurrenceCount,
      flapping: potentialFlappingCount,
    },
    groupingAudit: {
      wrongCurrentEpisodeGroups: wrongGroups,
      correctCurrentEpisodes: correctGroups,
      unresolvedGroups,
      timeWindowOnlyInNewGrouping: occurrenceAware.episodes.filter((episode) => episode.episodeGroupingBasis === 'TIME_WINDOW_ONLY').length,
    },
    changedEpisodes,
    changedAlertAudit,
    repeatAudit,
    activationValidation: activationValidation(changedAlertAudit),
    mlDatasetImpact: {
      affectedFormerRepeatLabels: changedAlertAudit.length,
      disposition: 'LEGACY_GROUPING_REQUIRES_REPLAY',
      trainingEligible: 0,
      systemRecommendationsCreateGoldLabels: false,
      eligibleFutureLabels: 'CORRECTED_DETERMINISTIC_DECISIONS_AND_VALIDATED_HUMAN_FEEDBACK_ONLY',
    },
    safety: {
      classificationsPersisted: 0,
      humanOutcomesWritten: 0,
      sourceMutations: 0,
      automaticActions: 'DISABLED',
      modelTraining: 'NONE',
    },
  };
  console.log = originalConsoleLog;
  const output = process.argv.includes('--audit-only') ? {
    generatedAt: report.generatedAt,
    mode: report.mode,
    changedAlertAudit: report.changedAlertAudit,
    activationValidation: report.activationValidation,
    mlDatasetImpact: report.mlDatasetImpact,
    safety: report.safety,
  } : process.argv.includes('--validation-table-only') ? {
    alerts: report.changedAlertAudit.map((item) => ({
      alertId: item.alertId,
      source: item.source,
      identity: {
        entity: item.evidence?.sourceIdentity?.entity || null,
        entityId: item.evidence?.sourceIdentity?.entityId || null,
        applicationId: item.evidence?.sourceIdentity?.applicationId || null,
        service: item.evidence?.sourceIdentity?.service || null,
        environment: item.evidence?.sourceIdentity?.environment || null,
        status: item.evidence?.identityQuality?.newEpisodeIdentityStatus || null,
      },
      lifecycle: {
        available: item.evidence?.sourceLifecycle?.lifecycleAvailable ?? null,
        firing: item.evidence?.sourceLifecycle?.currentlyFiring ?? null,
        recovered: item.evidence?.sourceLifecycle?.recovered ?? null,
        acknowledged: item.evidence?.sourceLifecycle?.intervention?.acknowledged ?? null,
        investigated: item.evidence?.sourceLifecycle?.intervention?.investigated ?? null,
        remediated: item.evidence?.sourceLifecycle?.intervention?.remediated ?? null,
        escalated: item.evidence?.sourceLifecycle?.intervention?.escalated ?? null,
      },
      incidentEvidenceIds: item.evidence?.incidentEvidence?.strongOperationalIncidentEvidenceIds || [],
      observedNoise: Object.entries(item.evidence?.noiseRecheck || {})
        .filter(([, detector]) => detector.observed).map(([name]) => name),
      duplicate: item.evidence?.duplicateRecheck || 'NONE',
      slackEvidenceIds: item.evidence?.slackEvidence?.references.map((reference) => reference.id) || [],
      jiraIncidentKey: item.evidence?.jiraEvidence?.incidentKey || null,
      priority: item.evidence?.priority || null,
      businessImpact: item.evidence?.businessImpact || null,
      actionability: item.evidence?.actionability || null,
      decision: item.newDecision,
      confidence: item.evidence?.decisionConfidence || 'NOT_CALIBRATED',
    })),
    activationValidation: report.activationValidation,
    mlDatasetImpact: report.mlDatasetImpact,
    safety: report.safety,
  } : process.argv.includes('--compact-validation-only') ? {
    generatedAt: report.generatedAt,
    alerts: report.changedAlertAudit.map((item) => ({
      alertId: item.alertId,
      source: item.source,
      oldEpisodeId: item.oldEpisodeId,
      newEpisodeId: item.newEpisodeId,
      sourceIdentity: item.evidence?.sourceIdentity || null,
      identityQuality: item.evidence?.identityQuality || null,
      lifecycle: item.evidence?.sourceLifecycle || null,
      incidentEvidence: item.evidence?.incidentEvidence || null,
      observedNoise: Object.entries(item.evidence?.noiseRecheck || {})
        .filter(([, detector]) => detector.observed).map(([name, detector]) => ({
          name, evidenceIds: detector.evidenceIds,
        })),
      duplicateRecheck: item.evidence?.duplicateRecheck || 'NONE',
      slackEvidence: item.evidence?.slackEvidence ? {
        acknowledged: item.evidence.slackEvidence.acknowledged,
        responder: item.evidence.slackEvidence.responder,
        evidenceIds: item.evidence.slackEvidence.references.map((reference) => reference.id),
      } : null,
      jiraEvidence: item.evidence?.jiraEvidence || null,
      priority: item.evidence?.priority || null,
      businessImpact: item.evidence?.businessImpact || null,
      actionability: item.evidence?.actionability || null,
      occurrenceAssessment: item.evidence?.occurrenceAssessment || null,
      decision: item.newDecision,
      confidence: item.evidence?.decisionConfidence || 'NOT_CALIBRATED',
      reasons: item.evidence?.finalDecisionReasons || [],
      oldRepeatLabelDisposition: item.evidence?.oldRepeatLabelDisposition || null,
    })),
    activationValidation: report.activationValidation,
    mlDatasetImpact: report.mlDatasetImpact,
    safety: report.safety,
  } : process.argv.includes('--final-validation-only') ? {
    generatedAt: report.generatedAt,
    mode: report.mode,
    comparison: report.comparison,
    alerts: report.changedAlertAudit.map(compactChangedAlert),
    activationValidation: report.activationValidation,
    mlDatasetImpact: report.mlDatasetImpact,
    safety: report.safety,
  } : process.argv.includes('--episodes-only') ? {
    generatedAt: report.generatedAt,
    changedEpisodes: report.changedEpisodes,
  } : process.argv.includes('--summary-only') ? {
    generatedAt: report.generatedAt,
    mode: report.mode,
    frozenPopulation: report.frozenPopulation,
    comparison: report.comparison,
    potentials: report.potentials,
    groupingAudit: report.groupingAudit,
    changedAlertAudit: report.changedAlertAudit.map(compactChangedAlert),
    repeatAudit: report.repeatAudit.map((item) => ({
      alertId: item.alertId,
      canonicalAlertId: item.canonicalAlertId,
      source: item.source,
      oldEpisodeId: item.oldEpisodeId,
      newEpisodeId: item.newEpisodeId,
      oldRole: item.oldRole,
      newRole: item.newRole,
      oldDecision: item.oldDecision,
      sameEvidenceLegacyDecision: item.sameEvidenceLegacyDecision,
      newDecision: item.newDecision,
      oldSubtype: item.oldSubtype,
      newSubtype: item.newSubtype,
      outcomeStatus: item.outcomeStatus,
      replayError: item.replayError,
    })),
    activationValidation: report.activationValidation,
    mlDatasetImpact: report.mlDatasetImpact,
    safety: report.safety,
  } : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${clean(error.safeMessage || error.message || error.code || 'Replay failed')}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    await db.pool.end().catch(() => {});
  });
}

module.exports = { activationValidation };

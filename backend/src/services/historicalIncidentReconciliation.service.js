const db = require('../config/db');
const accJiraReadService = require('./atlassian/accJiraRead.service');

const DATASET_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
const EXACT_MATCH_WINDOW_SECONDS = 15 * 60;
const CONTEXT_MATCH_WINDOW_SECONDS = 2 * 60 * 60;
const DEFAULT_TIMEZONE = 'Asia/Calcutta';
const RELATIONSHIP_STATES = Object.freeze({
  AMBIGUOUS: 'AMBIGUOUS',
  CONFIRMED: 'CONFIRMED_MATCH',
  NO_MATCH: 'NO_MATCH',
  PROBABLE: 'PROBABLE_MATCH',
});

const GENERIC_TOKENS = new Set([
  'abc', 'alert', 'alerts', 'and', 'are', 'critical', 'daemon', 'data', 'failure', 'for',
  'from', 'has', 'have', 'high', 'in', 'is', 'issue', 'monitoring', 'not', 'of', 'on',
  'or', 'prod', 'production', 'service', 'system', 'the', 'this', 'to', 'with',
]);

let schemaPromise = null;

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function knownValue(value) {
  const result = clean(value);
  return result && !['unknown', 'unknown-service', 'unassigned'].includes(result.toLowerCase()) ? result : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function significantTokens(value) {
  return [...new Set(normalizeText(value).split(' ').filter((token) => (
    token.length >= 3 && !GENERIC_TOKENS.has(token)
  )))];
}

function timeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit',
    second: '2-digit', timeZone, year: 'numeric',
  });
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function timeZoneOffsetMilliseconds(date, timeZone) {
  const parts = timeZoneParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  );
  return representedAsUtc - date.getTime();
}

function localMidnightUtc(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guess = target - timeZoneOffsetMilliseconds(new Date(guess), timeZone);
  }
  return new Date(guess);
}

function previousCalendarDate({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day - 1));
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
}

function dateString(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function buildWindows(nowValue = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const end = new Date(nowValue);
  const today = timeZoneParts(end, timeZone);
  const previous = previousCalendarDate(today);
  return {
    dataset: {
      end: end.toISOString(),
      start: new Date(end.getTime() - DATASET_WINDOW_MILLISECONDS).toISOString(),
    },
    jiraDates: { createdFrom: dateString(previous), createdTo: dateString(today) },
    operational: {
      end: end.toISOString(),
      start: localMidnightUtc(previous.year, previous.month, previous.day, timeZone).toISOString(),
    },
    timeZone,
  };
}

function incidentText(incident) {
  return [incident.summary, incident.description, ...asArray(incident.comments).map((item) => item.body)]
    .filter(Boolean)
    .join(' ');
}

function alertIdentityPhrases(alert) {
  const normalized = alert.extracted_details?.normalized_alert || {};
  const tagValues = asArray(normalized.tags).map((tag) => String(tag).split(':').slice(1).join(':') || tag);
  return [...new Set([
    alert.entity,
    alert.application,
    alert.service,
    normalized.entity,
    normalized.application,
    normalized.service,
    ...tagValues,
  ].map((value) => normalizeText(value))
    .map((value) => value.replace(/\balert\b/g, '').trim())
    .filter((value) => value.length >= 8 && !['unknown service', 'production'].includes(value)))];
}

function compareCandidate(incident, alert) {
  const summary = normalizeText(incident.summary);
  const message = normalizeText(alert.message);
  const combinedIncidentText = normalizeText(incidentText(incident));
  const source = normalizeText(alert.source);
  const incidentCreated = new Date(incident.createdAt).getTime();
  const alertCreated = new Date(alert.created_at).getTime();
  const alertLastSeen = new Date(alert.last_seen || alert.created_at).getTime();
  const timeDeltaSeconds = Math.round((alertCreated - incidentCreated) / 1000);
  const absoluteDeltaSeconds = Math.abs(timeDeltaSeconds);
  const exactSummary = Boolean(summary && message && summary === message);
  const sourceMentioned = Boolean(source && combinedIncidentText.includes(source));
  const matchedIdentityPhrases = alertIdentityPhrases(alert).filter((phrase) => (
    combinedIncidentText.includes(phrase)
    || significantTokens(phrase).every((token) => combinedIncidentText.includes(token))
  ));
  const alertTokens = significantTokens(alert.message);
  const incidentTokens = new Set(significantTokens(incidentText(incident)));
  const sharedTokens = alertTokens.filter((token) => incidentTokens.has(token));
  const tokenCoverage = alertTokens.length ? sharedTokens.length / alertTokens.length : 0;
  const activeAtIncident = Number.isFinite(incidentCreated)
    && Number.isFinite(alertCreated)
    && alertCreated <= incidentCreated
    && alertLastSeen >= incidentCreated;
  const withinContextWindow = absoluteDeltaSeconds <= CONTEXT_MATCH_WINDOW_SECONDS;
  const distinctiveTextMatch = sharedTokens.length >= 3 && tokenCoverage >= 0.35;
  const exactConfirmed = exactSummary
    && absoluteDeltaSeconds <= EXACT_MATCH_WINDOW_SECONDS
    && ['jsm operations', 'jira service management'].includes(source);
  const contextualSignals = [sourceMentioned, matchedIdentityPhrases.length > 0, distinctiveTextMatch, activeAtIncident]
    .filter(Boolean).length;
  const probable = withinContextWindow && contextualSignals >= 2;
  const score = (withinContextWindow ? 1 : 0)
    + (activeAtIncident ? 1 : 0)
    + (sourceMentioned ? 1 : 0)
    + (matchedIdentityPhrases.length ? 1 : 0)
    + (distinctiveTextMatch ? 1 : 0);

  return {
    alert,
    evidence: [
      exactSummary ? 'Jira summary exactly matches the stored alert message.' : null,
      sourceMentioned ? `The Jira evidence names ${alert.source} as the monitoring source.` : null,
      activeAtIncident ? 'The alert was active when the Jira Incident was created.' : null,
      matchedIdentityPhrases.length
        ? `Structured alert identity matched Jira context: ${matchedIdentityPhrases.join(', ')}.`
        : null,
      distinctiveTextMatch
        ? `Distinctive message terms matched: ${sharedTokens.slice(0, 8).join(', ')}.`
        : null,
      withinContextWindow ? `Alert first-seen time is within ${CONTEXT_MATCH_WINDOW_SECONDS / 3600} hours of Jira creation.` : null,
    ].filter(Boolean),
    exactConfirmed,
    matchedIdentityPhrases,
    probable,
    score,
    timeDeltaSeconds,
  };
}

function candidateRow(incident, comparison, state, method, strength, confidence) {
  const alert = comparison.alert;
  return {
    alertId: alert.alert_id,
    alertTimestamp: toIso(alert.created_at),
    evidence: comparison.evidence,
    incidentCreatedAt: toIso(incident.createdAt),
    incidentKey: incident.key,
    matchConfidence: confidence,
    matchedApplication: knownValue(alert.application),
    matchedEnvironment: knownValue(alert.environment),
    matchedService: knownValue(alert.service),
    matchedSource: clean(alert.source),
    matchMethod: method,
    matchStrength: strength,
    relationshipState: state,
    timeDeltaSeconds: comparison.timeDeltaSeconds,
  };
}

function reconcileIncident(incident, alerts) {
  const comparisons = alerts.map((alert) => compareCandidate(incident, alert));
  const exact = comparisons.filter((item) => item.exactConfirmed);
  if (exact.length) {
    return exact.map((item) => candidateRow(
      incident,
      item,
      RELATIONSHIP_STATES.CONFIRMED,
      'exact_jira_summary_jsm_operations_temporal',
      'strong',
      0.99,
    ));
  }

  const probable = comparisons.filter((item) => item.probable).sort((left, right) => (
    right.score - left.score
    || Math.abs(left.timeDeltaSeconds) - Math.abs(right.timeDeltaSeconds)
    || String(left.alert.alert_id).localeCompare(String(right.alert.alert_id))
  ));
  if (!probable.length) {
    return [{
      alertId: null,
      alertTimestamp: null,
      evidence: ['No alert met the bounded temporal plus structured-evidence threshold.'],
      incidentCreatedAt: toIso(incident.createdAt),
      incidentKey: incident.key,
      matchConfidence: null,
      matchedApplication: null,
      matchedEnvironment: null,
      matchedService: null,
      matchedSource: null,
      matchMethod: 'no_qualified_alert_candidate',
      matchStrength: 'none',
      relationshipState: RELATIONSHIP_STATES.NO_MATCH,
      timeDeltaSeconds: null,
    }];
  }

  const best = probable[0];
  const competing = probable.filter((item) => (
    item.score === best.score
    && Math.abs(Math.abs(item.timeDeltaSeconds) - Math.abs(best.timeDeltaSeconds)) <= 15 * 60
  ));
  if (competing.length > 1) {
    return competing.map((item) => candidateRow(
      incident,
      item,
      RELATIONSHIP_STATES.AMBIGUOUS,
      'multiple_contextual_candidates',
      'ambiguous',
      null,
    ));
  }

  const confidence = Math.min(0.95, Number((0.55 + (best.score * 0.075)).toFixed(2)));
  return [candidateRow(
    incident,
    best,
    RELATIONSHIP_STATES.PROBABLE,
    'structured_context_plus_temporal_proximity',
    'moderate',
    confidence,
  )];
}

function issueSnapshot(issue, reconciledAt) {
  return {
    id: issue.id || null,
    key: issue.key,
    fields: {
      assignee: issue.assignee || null,
      components: asArray(issue.components),
      created: issue.createdAt || null,
      description: issue.description || null,
      issuelinks: asArray(issue.issueLinks),
      issuetype: { name: issue.issueType || '[System] Incident' },
      labels: asArray(issue.labels),
      priority: issue.priority ? { name: issue.priority } : null,
      reporter: issue.reporter || null,
      resolution: issue.resolution ? { name: issue.resolution } : null,
      resolutiondate: issue.resolvedAt || null,
      status: issue.status ? { name: issue.status } : null,
      summary: issue.summary || null,
      updated: issue.updatedAt || null,
    },
    provenance: {
      readOnly: true,
      reconciledAt,
      source: 'Atlassian Jira Cloud-ID read API',
    },
  };
}

function jiraSourceUrl(issueKey) {
  const base = clean(process.env.ATLASSIAN_SITE_URL);
  return base ? `${base.replace(/\/$/, '')}/browse/${encodeURIComponent(issueKey)}` : null;
}

async function ensureSchema(database = db) {
  if (database === db && schemaPromise) return schemaPromise;
  const work = database.query(`
    CREATE TABLE IF NOT EXISTS incident_alert_reconciliations (
      id BIGSERIAL PRIMARY KEY,
      reconciliation_run_id TEXT NOT NULL,
      incident_key TEXT NOT NULL REFERENCES operations_incidents(incident_key) ON DELETE CASCADE,
      alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
      relationship_state TEXT NOT NULL CHECK (relationship_state IN ('CONFIRMED_MATCH', 'PROBABLE_MATCH', 'AMBIGUOUS', 'NO_MATCH')),
      match_method TEXT NOT NULL,
      match_strength TEXT NOT NULL CHECK (match_strength IN ('strong', 'moderate', 'ambiguous', 'none')),
      match_confidence NUMERIC(5, 4) CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
      alert_timestamp TIMESTAMPTZ,
      incident_created_at TIMESTAMPTZ NOT NULL,
      time_delta_seconds INTEGER,
      matched_source TEXT,
      matched_service TEXT,
      matched_application TEXT,
      matched_environment TEXT,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      operational_window_start TIMESTAMPTZ NOT NULL,
      operational_window_end TIMESTAMPTZ NOT NULL,
      dataset_window_start TIMESTAMPTZ NOT NULL,
      dataset_window_end TIMESTAMPTZ NOT NULL,
      current BOOLEAN NOT NULL DEFAULT true,
      reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_alert_reconciliation_current_unique
      ON incident_alert_reconciliations (incident_key, COALESCE(alert_id, '')) WHERE current;
    CREATE INDEX IF NOT EXISTS idx_incident_alert_reconciliation_alert_current
      ON incident_alert_reconciliations (alert_id, relationship_state) WHERE current;
    CREATE INDEX IF NOT EXISTS idx_incident_alert_reconciliation_incident_current
      ON incident_alert_reconciliations (incident_created_at DESC, incident_key) WHERE current;
  `);
  if (database === db) {
    schemaPromise = work.catch((error) => {
      schemaPromise = null;
      throw error;
    });
    return schemaPromise;
  }
  return work;
}

async function upsertIncident(client, issue, reconciledAt) {
  const snapshot = issueSnapshot(issue, reconciledAt);
  await client.query(`
    INSERT INTO operations_incidents (
      incident_key, summary, description, reporter, priority, status, resolution, source_url,
      incident_created_at, incident_updated_at, closed_at, assignee, labels, linked_alerts,
      comments, custom_fields, incident_details, raw_payload, updated_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
      $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, NOW()
    )
    ON CONFLICT (incident_key) DO UPDATE SET
      summary = EXCLUDED.summary,
      description = EXCLUDED.description,
      reporter = EXCLUDED.reporter,
      priority = EXCLUDED.priority,
      status = EXCLUDED.status,
      resolution = EXCLUDED.resolution,
      source_url = COALESCE(EXCLUDED.source_url, operations_incidents.source_url),
      incident_created_at = EXCLUDED.incident_created_at,
      incident_updated_at = EXCLUDED.incident_updated_at,
      closed_at = EXCLUDED.closed_at,
      assignee = EXCLUDED.assignee,
      labels = EXCLUDED.labels,
      linked_alerts = EXCLUDED.linked_alerts,
      comments = EXCLUDED.comments,
      custom_fields = operations_incidents.custom_fields || EXCLUDED.custom_fields,
      incident_details = operations_incidents.incident_details || EXCLUDED.incident_details,
      raw_payload = operations_incidents.raw_payload || EXCLUDED.raw_payload,
      updated_at = NOW()
  `, [
    issue.key,
    issue.summary,
    issue.description,
    JSON.stringify(issue.reporter || null),
    issue.priority,
    issue.status,
    issue.resolution,
    jiraSourceUrl(issue.key),
    issue.createdAt,
    issue.updatedAt,
    issue.resolvedAt,
    JSON.stringify(issue.assignee || null),
    JSON.stringify(asArray(issue.labels)),
    JSON.stringify(asArray(issue.relatedAlerts).map((item) => item.alertNumber).filter(Boolean)),
    JSON.stringify(asArray(issue.comments)),
    JSON.stringify({ issueId: issue.id || null, readOnlySnapshot: true }),
    JSON.stringify({
      activity: asArray(issue.activity),
      chatLinks: (String(issue.description || '').match(/https:\/\/[^\s]+/g) || []),
      howResolved: issue.howResolved || null,
      issueLinks: asArray(issue.issueLinks),
      resolvedBy: issue.resolvedBy || null,
      resolvedBySource: issue.resolvedBySource || null,
      reconciliationSource: 'jira_cloud_id_read_api',
    }),
    JSON.stringify(snapshot),
  ]);
}

function createHistoricalIncidentReconciliationService({
  database = db,
  jira = accJiraReadService,
  now = () => Date.now(),
  timeZone = process.env.TZ || DEFAULT_TIMEZONE,
} = {}) {
  async function reconcile(options = {}) {
    const windows = buildWindows(options.now || now(), options.timeZone || timeZone);
    const listed = await jira.listIncidents({
      createdFrom: windows.jiraDates.createdFrom,
      createdTo: windows.jiraDates.createdTo,
      page: 1,
      pageSize: 25,
    });
    const incidentSummaries = asArray(listed.items).filter((issue) => {
      const created = new Date(issue.createdAt).getTime();
      return created >= new Date(windows.operational.start).getTime()
        && created <= new Date(windows.operational.end).getTime();
    });
    const incidents = [];
    for (const issue of incidentSummaries) {
      incidents.push(await jira.getIssueDetail(issue.key));
    }
    const alertsResult = await database.query(`
      SELECT alert_id, canonical_alert_id, source_alert_id, source, created_at, first_seen, last_seen,
        entity, application, service, environment, occurrence_count, correlation_id, message,
        alert_signature, extracted_details
      FROM historical_alert_learning_occurrences_v1
      WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
      ORDER BY created_at, alert_id
    `, [windows.dataset.start, windows.dataset.end]);
    const reconciliations = incidents.flatMap((incident) => reconcileIncident(incident, alertsResult.rows));
    const runId = `incident-reconciliation-${new Date(windows.dataset.end).getTime()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await ensureSchema(client);
      for (const incident of incidents) await upsertIncident(client, incident, windows.dataset.end);
      if (incidents.length) {
        await client.query(`
          UPDATE incident_alert_reconciliations
          SET current = false
          WHERE current AND incident_key = ANY($1::text[])
        `, [incidents.map((item) => item.key)]);
      }
      for (const item of reconciliations) {
        await client.query(`
          INSERT INTO incident_alert_reconciliations (
            reconciliation_run_id, incident_key, alert_id, relationship_state, match_method,
            match_strength, match_confidence, alert_timestamp, incident_created_at,
            time_delta_seconds, matched_source, matched_service, matched_application,
            matched_environment, evidence, operational_window_start, operational_window_end,
            dataset_window_start, dataset_window_end, current, reconciled_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
            $16, $17, $18, $19, true, $20
          )
        `, [
          runId, item.incidentKey, item.alertId, item.relationshipState, item.matchMethod,
          item.matchStrength, item.matchConfidence, item.alertTimestamp, item.incidentCreatedAt,
          item.timeDeltaSeconds, item.matchedSource, item.matchedService, item.matchedApplication,
          item.matchedEnvironment, JSON.stringify(item.evidence), windows.operational.start,
          windows.operational.end, windows.dataset.start, windows.dataset.end, windows.dataset.end,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return {
      alertCount: alertsResult.rowCount,
      incidentCount: incidents.length,
      readOnlyJira: true,
      reconciliations,
      runId,
      windows,
    };
  }

  return { reconcile };
}

module.exports = {
  CONTEXT_MATCH_WINDOW_SECONDS,
  DATASET_WINDOW_MILLISECONDS,
  DEFAULT_TIMEZONE,
  EXACT_MATCH_WINDOW_SECONDS,
  RELATIONSHIP_STATES,
  alertIdentityPhrases,
  buildWindows,
  compareCandidate,
  createHistoricalIncidentReconciliationService,
  ensureSchema,
  normalizeText,
  reconcileIncident,
  service: createHistoricalIncidentReconciliationService(),
  significantTokens,
};

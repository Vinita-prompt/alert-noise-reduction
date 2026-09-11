const database = require('../config/db');
const jira = require('./atlassian/accJiraRead.service');

const INCIDENT_SYNC_NAME = 'jira_incidents_backfill';

function safeUnavailableError(error) {
  const unavailable = new Error('Jira data unavailable. Live Jira Incident counts could not be verified.');
  unavailable.code = error?.code === 'JIRA_INCIDENT_RECONCILIATION_MISMATCH'
    ? error.code
    : 'JIRA_DATA_UNAVAILABLE';
  unavailable.status = 503;
  unavailable.safeMessage = error?.safeMessage || unavailable.message;
  if (error?.safeDetails) unavailable.safeDetails = error.safeDetails;
  return unavailable;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createJiraIncidentMetricsService({ jiraService = jira, db = database } = {}) {
  async function readPostgresReconciliation() {
    try {
      const [incidentResult, syncResult] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*) FILTER (
              WHERE COALESCE(raw_payload -> 'fields' -> 'issuetype' ->> 'name', '') = '[System] Incident'
            )::bigint AS exact_incident_total,
            MAX(incident_created_at) FILTER (
              WHERE COALESCE(raw_payload -> 'fields' -> 'issuetype' ->> 'name', '') = '[System] Incident'
            ) AS latest_incident_created_at,
            MAX(updated_at) AS postgres_updated_at
          FROM operations_incidents
        `),
        db.query(`
          SELECT last_successful_at, updated_at
          FROM sync_state
          WHERE sync_name = $1
          LIMIT 1
        `, [INCIDENT_SYNC_NAME]),
      ]);
      const row = incidentResult.rows[0] || {};
      const sync = syncResult.rows[0] || {};
      return {
        available: true,
        exactIncidentTotal: number(row.exact_incident_total),
        lastSuccessfulSyncAt: sync.last_successful_at || null,
        latestIncidentCreatedAt: row.latest_incident_created_at || null,
        postgresUpdatedAt: row.postgres_updated_at || sync.updated_at || null,
      };
    } catch {
      return {
        available: false,
        exactIncidentTotal: null,
        lastSuccessfulSyncAt: null,
        latestIncidentCreatedAt: null,
        postgresUpdatedAt: null,
      };
    }
  }

  async function getSummary(options = {}) {
    try {
      const [live, postgres] = await Promise.all([
        jiraService.getIncidentSummary(options),
        readPostgresReconciliation(),
      ]);
      const jiraTotal = number(live.incidentsCreatedToDate);
      if (postgres.available && postgres.exactIncidentTotal > 0 && jiraTotal === 0) {
        const mismatch = new Error('Jira data unavailable. The live Jira response conflicts with synchronized Incident history.');
        mismatch.code = 'JIRA_INCIDENT_RECONCILIATION_MISMATCH';
        mismatch.status = 503;
        mismatch.safeMessage = mismatch.message;
        mismatch.safeDetails = {
          jiraSourceStatus: 'UNABLE_TO_VERIFY',
          postgresSourceStatus: 'STALE_NOT_USED_AS_LIVE',
        };
        throw mismatch;
      }

      const difference = postgres.available ? jiraTotal - postgres.exactIncidentTotal : null;
      return {
        ...live,
        reconciliation: {
          difference,
          jiraTotal,
          lastSuccessfulSyncAt: postgres.lastSuccessfulSyncAt,
          postgresLatestIncidentCreatedAt: postgres.latestIncidentCreatedAt,
          postgresTotal: postgres.exactIncidentTotal,
          postgresUpdatedAt: postgres.postgresUpdatedAt,
          status: !postgres.available ? 'UNAVAILABLE' : difference === 0 ? 'MATCHED' : 'MISMATCH',
        },
      };
    } catch (error) {
      throw safeUnavailableError(error);
    }
  }

  async function getDailyCounts(options = {}) {
    const summary = await getSummary(options);
    return {
      dailyCounts: summary.dailyCreatedCounts,
      filteredCount: summary.filteredCount,
      range: summary.range,
      source: summary.source,
      sourceStatus: summary.sourceStatus,
      timezone: summary.timezone,
      updatedAt: summary.updatedAt,
    };
  }

  async function listIncidents(options = {}) {
    try {
      return await jiraService.listExactIncidents(options);
    } catch (error) {
      throw safeUnavailableError(error);
    }
  }

  async function reconcilePostgresIncidents() {
    let client;
    try {
      const live = await jiraService.listAllExactIncidentsForSync();
      const items = live.items || [];
      const keys = items.map((item) => item.key).filter(Boolean);
      client = await db.pool.connect();
      await client.query('BEGIN');
      const existingResult = keys.length
        ? await client.query(
          'SELECT incident_key FROM operations_incidents WHERE incident_key = ANY($1::text[])',
          [keys],
        )
        : { rows: [] };
      const existingKeys = new Set(existingResult.rows.map((row) => row.incident_key));
      const missing = items.filter((item) => !existingKeys.has(item.key));

      for (const incident of missing) {
        const rawFields = incident.rawPayload?.fields || {};
        await client.query(`
          INSERT INTO operations_incidents (
            incident_key, summary, description, reporter, priority, status,
            status_category, resolution, source_url, incident_created_at,
            incident_updated_at, closed_at, assignee, labels, linked_alerts,
            custom_fields, incident_details, raw_payload, updated_at
          ) VALUES (
            $1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
            $14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,NOW()
          )
          ON CONFLICT (incident_key) DO NOTHING
        `, [
          incident.key,
          incident.summary || '',
          incident.description || incident.summary || '',
          JSON.stringify(incident.reporter || null),
          incident.priority || null,
          incident.status || null,
          rawFields.status?.statusCategory?.name || null,
          incident.resolution || null,
          incident.sourceUrl || null,
          incident.createdAt || null,
          incident.updatedAt || incident.createdAt || null,
          incident.resolvedAt || null,
          JSON.stringify(incident.assignee || null),
          JSON.stringify(incident.labels || []),
          JSON.stringify(incident.relatedAlerts || []),
          JSON.stringify({
            components: incident.components || [],
            issueLinks: incident.issueLinks || [],
            relatedIncidents: incident.relatedIncidents || [],
          }),
          JSON.stringify({
            issueType: incident.issueType,
            readOnly: true,
            reconciliationSource: 'live_exact_jira_incident_query',
          }),
          JSON.stringify(incident.rawPayload || {}),
        ]);
      }

      const afterResult = await client.query(`
        SELECT COUNT(*)::int AS total
        FROM operations_incidents
        WHERE COALESCE(raw_payload -> 'fields' -> 'issuetype' ->> 'name', '') = '[System] Incident'
      `);
      const postgresTotal = number(afterResult.rows[0]?.total);
      const reconciledAt = new Date().toISOString();
      await client.query(`
        INSERT INTO sync_state (sync_name, source, last_successful_at, metadata, updated_at)
        VALUES ($1, 'Jira Incident Tickets', $2, $3::jsonb, NOW())
        ON CONFLICT (sync_name) DO UPDATE SET
          source=EXCLUDED.source,
          last_successful_at=EXCLUDED.last_successful_at,
          metadata=sync_state.metadata || EXCLUDED.metadata,
          updated_at=NOW()
      `, [INCIDENT_SYNC_NAME, reconciledAt, JSON.stringify({
        authoritativeJiraTotal: number(live.totalCount),
        inserted: missing.length,
        postgresTotal,
        reconciliationSource: 'live_exact_jira_incident_query',
      })]);
      await client.query('COMMIT');

      return {
        authoritativeJiraTotal: number(live.totalCount),
        inserted: missing.length,
        matched: postgresTotal === number(live.totalCount),
        pageCount: number(live.pageCount),
        postgresTotal,
        readOnlyJira: true,
        reconciledAt,
        updatedExisting: 0,
      };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw safeUnavailableError(error);
    } finally {
      client?.release();
    }
  }

  return {
    getDailyCounts,
    getSummary,
    listIncidents,
    reconcilePostgresIncidents,
    readPostgresReconciliation,
  };
}

module.exports = {
  INCIDENT_SYNC_NAME,
  createJiraIncidentMetricsService,
  ...createJiraIncidentMetricsService(),
};

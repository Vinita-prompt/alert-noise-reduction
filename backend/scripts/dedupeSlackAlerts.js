require('dotenv').config({ path: './.env' });

const db = require('../src/config/db');

const BATCH_SIZE = Number(process.env.SLACK_DEDUPE_BATCH_SIZE || 5000);

async function getRemainingDuplicateSummary() {
  const result = await db.query(`
    SELECT COUNT(*)::int AS duplicate_groups, COALESCE(SUM(count - 1), 0)::int AS rows_to_merge
    FROM (
      SELECT COALESCE((regexp_match(title, '#([0-9]{3,})'))[1], (regexp_match(signal, '#([0-9]{3,})'))[1]) AS alert_no,
             COUNT(*)::int AS count
      FROM alerts
      WHERE slack_channel_id IS NOT NULL
      GROUP BY alert_no
      HAVING COALESCE((regexp_match(title, '#([0-9]{3,})'))[1], (regexp_match(signal, '#([0-9]{3,})'))[1]) IS NOT NULL
         AND COUNT(*) > 1
    ) duplicate_groups
  `);

  return result.rows[0] || { duplicate_groups: 0, rows_to_merge: 0 };
}

async function processBatch(client) {
  await client.query('BEGIN');

  try {
    await client.query(`
      CREATE TEMP TABLE tmp_slack_dedupe_ranked ON COMMIT DROP AS
      WITH slack_rows AS (
        SELECT
          alerts.*,
          COALESCE((regexp_match(title, '#([0-9]{3,})'))[1], (regexp_match(signal, '#([0-9]{3,})'))[1]) AS alert_no,
          CASE
            WHEN slack_channel_id IS NOT NULL AND slack_message_ts IS NOT NULL
              THEN slack_channel_id || ':' || slack_message_ts
            ELSE NULL
          END AS message_ref
        FROM alerts
        WHERE slack_channel_id IS NOT NULL
      ),
      duplicate_groups AS (
        SELECT alert_no
        FROM slack_rows
        WHERE alert_no IS NOT NULL
        GROUP BY alert_no
        HAVING COUNT(*) > 1
        ORDER BY MAX(last_seen_at) DESC
        LIMIT ${BATCH_SIZE}
      )
      SELECT
        slack_rows.*,
        FIRST_VALUE(id) OVER (
          PARTITION BY alert_no
          ORDER BY acknowledged DESC, last_seen_at DESC, updated_at DESC, id
        ) AS canonical_id
      FROM slack_rows
      JOIN duplicate_groups USING (alert_no)
    `);

    const statsResult = await client.query(`
      SELECT
        COUNT(DISTINCT alert_no)::int AS groups,
        COUNT(*)::int AS rows,
        COUNT(*)::int - COUNT(DISTINCT alert_no)::int AS duplicates
      FROM tmp_slack_dedupe_ranked
    `);
    const stats = statsResult.rows[0] || { groups: 0, rows: 0, duplicates: 0 };

    if (Number(stats.groups) === 0) {
      await client.query('ROLLBACK');
      return stats;
    }

    await client.query(`
      CREATE TEMP TABLE tmp_slack_dedupe_updates ON COMMIT DROP AS
      SELECT
        alert_no,
        canonical_id,
        'ops-alert:' || alert_no AS stable_source_alert_id,
        '#'
          || alert_no AS related_alert,
        (array_agg(title ORDER BY last_seen_at DESC, updated_at DESC))[1] AS title,
        (array_agg(service ORDER BY (service IS NOT NULL AND service NOT IN ('unknown-service', 'Unknown', 'unknown')) DESC, last_seen_at DESC))[1] AS service,
        (array_agg(environment ORDER BY (environment IS NOT NULL AND environment <> 'unknown') DESC, last_seen_at DESC))[1] AS environment,
        (array_agg(severity ORDER BY last_seen_at DESC))[1] AS severity,
        CASE
          WHEN BOOL_OR(status IN ('resolved', 'recovered', 'closed')) THEN
            (array_agg(status ORDER BY (status IN ('resolved', 'recovered', 'closed')) DESC, last_seen_at DESC))[1]
          WHEN BOOL_OR(acknowledged) THEN 'acknowledged'
          ELSE (array_agg(status ORDER BY last_seen_at DESC))[1]
        END AS status,
        (array_agg(source ORDER BY (source IS NOT NULL AND source NOT IN ('unknown', 'unknown-monitoring-tool')) DESC, last_seen_at DESC))[1] AS source,
        (array_agg(source_type ORDER BY last_seen_at DESC))[1] AS source_type,
        (array_agg(source_url ORDER BY (source_url IS NOT NULL) DESC, last_seen_at DESC))[1] AS source_url,
        BOOL_OR(acknowledged) AS acknowledged,
        (array_agg(acknowledged_by ORDER BY acknowledged_at DESC NULLS LAST, last_seen_at DESC) FILTER (WHERE acknowledged_by IS NOT NULL))[1] AS acknowledged_by,
        MIN(acknowledged_at) FILTER (WHERE acknowledged_at IS NOT NULL) AS acknowledged_at,
        (array_agg(acknowledgement_source ORDER BY acknowledged_at DESC NULLS LAST, last_seen_at DESC) FILTER (WHERE acknowledgement_source IS NOT NULL))[1] AS acknowledgement_source,
        (array_agg(raw_payload ORDER BY last_seen_at DESC))[1] AS raw_payload,
        (array_agg(extracted_details ORDER BY (extracted_details->'jira'->>'summary' IS NOT NULL) DESC, last_seen_at DESC))[1] AS extracted_details,
        (array_agg(duplicate_signature ORDER BY last_seen_at DESC))[1] AS duplicate_signature,
        'ops-alert:' || alert_no AS correlation_id,
        MIN(received_at) AS received_at,
        MAX(last_seen_at) AS last_seen_at,
        GREATEST(SUM(occurrences), COUNT(DISTINCT message_ref))::int AS occurrences,
        (array_agg(owner ORDER BY (owner IS NOT NULL AND owner <> 'Unassigned') DESC, last_seen_at DESC))[1] AS owner,
        (array_agg(signal ORDER BY last_seen_at DESC))[1] AS signal,
        (array_agg(description ORDER BY last_seen_at DESC))[1] AS description,
        (array_agg(jira_ticket_id ORDER BY (jira_ticket_id IS NOT NULL) DESC, last_seen_at DESC) FILTER (WHERE jira_ticket_id IS NOT NULL))[1] AS jira_ticket_id,
        BOOL_OR(recurring_incident) AS recurring_incident,
        COALESCE(jsonb_agg(DISTINCT message_ref) FILTER (WHERE message_ref IS NOT NULL), '[]'::jsonb) AS message_refs,
        jsonb_agg(id ORDER BY last_seen_at DESC) FILTER (WHERE id <> canonical_id) AS merged_duplicate_ids
      FROM tmp_slack_dedupe_ranked
      GROUP BY alert_no, canonical_id
    `);

    await client.query(`
      CREATE TEMP TABLE tmp_slack_dedupe_mapping ON COMMIT DROP AS
      SELECT alert_no, canonical_id, id AS duplicate_id
      FROM tmp_slack_dedupe_ranked
      WHERE id <> canonical_id
    `);

    await client.query(`
      UPDATE alerts AS target
      SET
        title = updates.title,
        service = updates.service,
        environment = updates.environment,
        severity = updates.severity,
        status = updates.status,
        source = updates.source,
        source_type = updates.source_type,
        source_alert_id = updates.stable_source_alert_id,
        source_url = updates.source_url,
        acknowledged = updates.acknowledged,
        acknowledged_by = updates.acknowledged_by,
        acknowledged_at = updates.acknowledged_at,
        acknowledgement_source = COALESCE(updates.acknowledgement_source, CASE WHEN updates.acknowledged THEN 'slack_message' ELSE target.acknowledgement_source END),
        raw_payload = updates.raw_payload,
        extracted_details = jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(updates.extracted_details, '{}'::jsonb),
              '{slack,message_refs}',
              updates.message_refs,
              true
            ),
            '{stable_identity}',
            jsonb_build_object(
              'id', target.id,
              'type', 'ops_alert_number',
              'value', updates.alert_no,
              'sourceAlertId', updates.stable_source_alert_id,
              'dedupedExistingRows', true
            ),
            true
          ),
          '{dedupe}',
          jsonb_build_object(
            'merged_duplicate_ids', COALESCE(updates.merged_duplicate_ids, '[]'::jsonb),
            'merged_at', NOW()
          ),
          true
        ),
        duplicate_signature = updates.duplicate_signature,
        correlation_id = updates.correlation_id,
        received_at = updates.received_at,
        last_seen_at = updates.last_seen_at,
        occurrences = updates.occurrences,
        owner = COALESCE(updates.owner, 'Unassigned'),
        signal = updates.signal,
        description = updates.description,
        jira_ticket_id = COALESCE(updates.jira_ticket_id, target.jira_ticket_id),
        recurring_incident = updates.recurring_incident,
        related_alerts = jsonb_build_array(updates.related_alert),
        updated_at = NOW()
      FROM tmp_slack_dedupe_updates AS updates
      WHERE target.id = updates.canonical_id
    `);

    const reassignTables = [
      ['raw_alerts', 'normalized_alert_id'],
      ['alert_classification_history', 'alert_id'],
      ['alert_correlation_history', 'alert_id'],
      ['alert_incident_mappings', 'alert_id'],
      ['alert_acknowledgements', 'alert_id'],
      ['alert_escalations', 'alert_id'],
      ['alert_relations', 'alert_id'],
      ['audit_events', 'alert_id'],
      ['alert_notes', 'alert_id'],
      ['slack_notifications', 'alert_id'],
    ];

    for (const [table, column] of reassignTables) {
      await client.query(`
        UPDATE ${table} AS child
        SET ${column} = mapping.canonical_id
        FROM tmp_slack_dedupe_mapping AS mapping
        WHERE child.${column} = mapping.duplicate_id
      `);
    }

    await client.query(`
      UPDATE incidents AS incident
      SET alert_id = mapping.canonical_id,
          updated_at = NOW()
      FROM tmp_slack_dedupe_mapping AS mapping
      WHERE incident.alert_id = mapping.duplicate_id
        AND NOT EXISTS (
          SELECT 1
          FROM incidents existing
          WHERE existing.alert_id = mapping.canonical_id
        )
    `);

    await client.query(`
      DELETE FROM incidents AS incident
      USING tmp_slack_dedupe_mapping AS mapping
      WHERE incident.alert_id = mapping.duplicate_id
    `);

    await client.query(`
      DELETE FROM alerts AS duplicate
      USING tmp_slack_dedupe_mapping AS mapping
      WHERE duplicate.id = mapping.duplicate_id
    `);

    await client.query('COMMIT');
    return stats;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const before = await getRemainingDuplicateSummary();
  console.log(`Starting Slack dedupe cleanup. duplicate_groups=${before.duplicate_groups} rows_to_merge=${before.rows_to_merge}`);

  const client = await db.pool.connect();
  let totalGroups = 0;
  let totalRowsMerged = 0;
  let batchNumber = 0;

  try {
    while (true) {
      batchNumber += 1;
      const stats = await processBatch(client);
      const groups = Number(stats.groups || 0);
      const duplicates = Number(stats.duplicates || 0);

      if (groups === 0) {
        break;
      }

      totalGroups += groups;
      totalRowsMerged += duplicates;
      console.log(`Batch ${batchNumber}: merged ${duplicates} duplicate rows across ${groups} alert groups.`);
    }
  } finally {
    client.release();
  }

  const after = await getRemainingDuplicateSummary();
  console.log(`Slack dedupe cleanup complete. groups_processed=${totalGroups} rows_merged=${totalRowsMerged}`);
  console.log(`Remaining duplicate_groups=${after.duplicate_groups} rows_to_merge=${after.rows_to_merge}`);
  await db.pool.end();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});

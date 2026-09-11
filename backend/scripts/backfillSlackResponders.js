const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/config/db');
const slackUserService = require('../src/services/slackUser.service');
const slackParser = require('../src/services/slackParser.service');

function parseSlackUserMap() {
  const value = process.env.SLACK_USER_MAP;

  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall through to comma-separated parsing.
  }

  return String(value)
    .split(',')
    .map((entry) => entry.split('='))
    .reduce((mapping, [key, name]) => {
      const normalizedKey = String(key || '').trim();
      const normalizedName = String(name || '').trim();

      if (normalizedKey && normalizedName) {
        mapping[normalizedKey] = normalizedName;
      }

      return mapping;
    }, {});
}

function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{4,}$/i.test(String(value || '').trim());
}

function getDisplayName(value, slackUserId, userMap) {
  const id = slackUserId || (isSlackUserId(value) ? value : null);
  const mapped = id ? userMap[id] : null;
  const fallback = String(value || '').replace(/^@+/, '').trim();

  return mapped || fallback || null;
}

function buildResponder(value, options = {}) {
  const slackUserId = options.slackUserId || (isSlackUserId(value) ? value : null);
  const displayName = getDisplayName(value, slackUserId, options.userMap || {});

  if (!slackUserId && !displayName) {
    return null;
  }

  return {
    id: slackUserId || displayName,
    slackUserId,
    name: displayName || slackUserId,
    displayName: displayName || null,
    role: options.role || 'acknowledger',
    source: options.source || 'slack_backfill',
    acknowledgedAt: options.acknowledgedAt || null,
    assignedAt: options.acknowledgedAt || new Date().toISOString(),
    assignmentStatus: options.status || 'acknowledged',
    needsNameMapping: Boolean(slackUserId && (!displayName || displayName === slackUserId)),
  };
}

function mergeResponders(responders) {
  const seen = new Set();

  return responders.filter((responder) => {
    if (!responder) {
      return false;
    }

    const key = String(
      responder.slackUserId
      || responder.id
      || responder.displayName
      || responder.name
      || ''
    ).toLowerCase();

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getNested(object, path) {
  return path.reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : null
  ), object);
}

function buildStoredSlackEvent(row = {}) {
  const rawPayload = row.raw_payload || {};
  const message = rawPayload.message || rawPayload.event || rawPayload;

  return {
    ...message,
    channel: row.slack_channel_id || message.channel || rawPayload.channel,
    ts: row.slack_message_ts || message.ts,
    permalink: message.permalink || rawPayload.permalink || null,
  };
}

function parseRespondersFromRawPayload(row = {}) {
  if (!row.raw_payload) {
    return {
      responders: [],
      acknowledgement: {},
      assignee: null,
    };
  }

  const event = buildStoredSlackEvent(row);

  if (!event.channel && !event.ts && !event.text && !event.blocks && !event.attachments) {
    return {
      responders: [],
      acknowledgement: {},
      assignee: null,
    };
  }

  try {
    const parsed = slackParser.parseSlackAlertMessage(event, row.raw_payload);

    return {
      responders: parsed.slackResponders || [],
      acknowledgement: parsed.slackAcknowledgement || {},
      assignee: parsed.slackAssignee || null,
    };
  } catch (error) {
    return {
      responders: [],
      acknowledgement: {},
      assignee: null,
    };
  }
}

async function backfillSlackResponders() {
  const userMap = parseSlackUserMap();
  const result = await db.query(`
    SELECT
      id,
      status,
      slack_channel_id,
      slack_message_ts,
      acknowledged_by,
      acknowledged_at,
      responders,
      extracted_details,
      raw_payload
    FROM alerts
    WHERE (
        COALESCE(jsonb_array_length(responders), 0) > 0
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(responders) responder
          WHERE responder->>'needsNameMapping' = 'true'
            OR responder->>'displayName' ~ '^[UW][A-Z0-9]{4,}$'
            OR responder->>'name' ~ '^[UW][A-Z0-9]{4,}$'
        )
      )
      OR (
        COALESCE(jsonb_array_length(responders), 0) = 0
        AND (
          acknowledged_by IS NOT NULL
          OR extracted_details->'slack_acknowledgement'->>'acknowledged_by' IS NOT NULL
          OR extracted_details->'slack'->'acknowledgement'->>'acknowledged_by' IS NOT NULL
          OR extracted_details->'slack'->>'assignee' IS NOT NULL
          OR raw_payload::text ~* '<@[A-Z0-9]+'
          OR raw_payload::text ~* 'acknowledged the alert'
          OR raw_payload::text ~* '\\b(assignee|assigned to|responder|responders)\\b'
        )
      )
  `);
  let updated = 0;

  for (const row of result.rows) {
    const details = row.extracted_details || {};
    const slackAcknowledgement = details.slack_acknowledgement
      || getNested(details, ['slack', 'acknowledgement'])
      || {};
    const acknowledgedBy = row.acknowledged_by
      || slackAcknowledgement.acknowledged_by
      || null;
    const acknowledgedBySlackUserId = slackAcknowledgement.acknowledged_by_slack_user_id
      || (isSlackUserId(acknowledgedBy) ? acknowledgedBy : null);
    const assignee = getNested(details, ['slack', 'assignee'])
      || getNested(details, ['alert', 'slack_assignee'])
      || null;
    const acknowledgedAt = row.acknowledged_at
      || slackAcknowledgement.acknowledged_at
      || null;
    const parsedSlack = parseRespondersFromRawPayload(row);
    const parsedAcknowledgement = parsedSlack.acknowledgement || {};
    const parsedAcknowledgedBy = parsedAcknowledgement.acknowledged_by || null;
    const parsedAcknowledgedBySlackUserId = parsedAcknowledgement.acknowledged_by_slack_user_id
      || (isSlackUserId(parsedAcknowledgedBy) ? parsedAcknowledgedBy : null);
    const parsedAcknowledgedAt = parsedAcknowledgement.acknowledged_at || null;
    const existingResponders = Array.isArray(row.responders) ? row.responders : [];
    const responders = await slackUserService.resolveResponders(existingResponders.length > 0
      ? existingResponders
      : mergeResponders([
          ...parsedSlack.responders,
          buildResponder(acknowledgedBy, {
            slackUserId: acknowledgedBySlackUserId,
            acknowledgedAt,
            userMap,
            role: 'acknowledger',
          }),
          buildResponder(parsedAcknowledgedBy, {
            slackUserId: parsedAcknowledgedBySlackUserId,
            acknowledgedAt: parsedAcknowledgedAt,
            userMap,
            role: 'acknowledger',
          }),
          buildResponder(assignee, {
            acknowledgedAt,
            userMap,
            role: 'assignee',
            status: 'assigned',
          }),
          buildResponder(parsedSlack.assignee, {
            acknowledgedAt: parsedAcknowledgedAt,
            userMap,
            role: 'assignee',
            status: 'assigned',
          }),
        ]));
    const nextAcknowledgedBy = row.acknowledged_by
      || parsedAcknowledgedBySlackUserId
      || parsedAcknowledgedBy
      || acknowledgedBySlackUserId
      || acknowledgedBy;
    const nextAcknowledgedAt = row.acknowledged_at || parsedAcknowledgedAt || acknowledgedAt;
    const nextAcknowledged = Boolean(nextAcknowledgedBy && (parsedAcknowledgement.acknowledged || slackAcknowledgement.acknowledged || row.acknowledged_at));

    if (responders.length === 0) {
      continue;
    }

    const nextDetails = {
      ...details,
      alert: {
        ...(details.alert || {}),
        responders,
        slack_responders: responders,
      },
      normalized_alert: {
        ...(details.normalized_alert || {}),
        responders,
      },
      slack: {
        ...(details.slack || {}),
        responders,
      },
      slack_acknowledgement: {
        ...slackAcknowledgement,
        ...parsedAcknowledgement,
        acknowledged_by_user_id: parsedAcknowledgedBySlackUserId || acknowledgedBySlackUserId || null,
        acknowledged_by_name: responders.find((responder) => String(responder.role || '').includes('acknowledger'))?.displayName || null,
        responders,
      },
    };

    await db.query(
      `
        UPDATE alerts
        SET responders = $2::jsonb,
            extracted_details = $3::jsonb,
            acknowledged = CASE WHEN $4::boolean THEN true ELSE acknowledged END,
            acknowledged_by = COALESCE($5, acknowledged_by),
            acknowledged_at = COALESCE($6::timestamptz, acknowledged_at),
            acknowledgement_source = CASE WHEN $4::boolean THEN COALESCE(acknowledgement_source, 'slack_backfill') ELSE acknowledgement_source END,
            status = CASE
              WHEN $4::boolean AND status NOT IN ('resolved', 'recovered', 'auto-resolved', 'closed') THEN 'acknowledged'
              ELSE status
            END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        row.id,
        JSON.stringify(responders),
        JSON.stringify(nextDetails),
        nextAcknowledged,
        nextAcknowledgedBy || null,
        nextAcknowledgedAt || null,
      ],
    );
    updated += 1;
  }

  return {
    scanned: result.rows.length,
    updated,
  };
}

backfillSlackResponders()
  .then((summary) => {
    console.log(`Slack responder backfill complete: ${summary.updated} updated from ${summary.scanned} candidate alerts.`);
  })
  .catch((error) => {
    console.error('Slack responder backfill failed', error);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

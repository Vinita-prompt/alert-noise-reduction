const db = require('../../config/db');
const { jiraWriteClient } = require('./clients');

function makeAdfDocument(text) {
  return {
    content: [
      {
        content: [
          {
            text: String(text || ''),
            type: 'text',
          },
        ],
        type: 'paragraph',
      },
    ],
    type: 'doc',
    version: 1,
  };
}

function normalizeIssueKey(value) {
  const key = String(value || '').trim().toUpperCase();

  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    const error = new Error('Enter a valid Jira issue key, for example ACC-1234.');
    error.status = 400;
    error.code = 'INVALID_JIRA_KEY';
    throw error;
  }

  return key;
}

async function recordAuditEvent(client, alertId, eventType, actor, details = {}) {
  await client.query(
    `
      INSERT INTO audit_events (alert_id, event_type, actor, source, details)
      VALUES ($1, $2, $3, 'website', $4::jsonb)
    `,
    [alertId, eventType, actor || null, JSON.stringify(details || {})],
  );
}

async function createIssueForAlert(alertId, options = {}) {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [alertId]);
    const alert = result.rows[0];

    if (!alert) {
      await client.query('ROLLBACK');
      return null;
    }

    const projectKey = options.projectKey || process.env.JIRA_PROJECT_KEY;
    const issueType = options.issueType || 'Incident';

    if (!projectKey) {
      const error = new Error('Jira project key is required to create an issue.');
      error.status = 400;
      error.code = 'MISSING_JIRA_PROJECT_KEY';
      throw error;
    }

    const summary = String(options.summary || alert.title || `Alert ${alert.id}`).slice(0, 255);
    const description = [
      alert.description,
      '',
      `Source: ${alert.source || 'unknown'}`,
      `Severity: ${alert.severity || 'unknown'}`,
      alert.source_url ? `Monitoring link: ${alert.source_url}` : null,
    ].filter(Boolean).join('\n');
    const jiraResponse = await jiraWriteClient.request('/rest/api/3/issue', {
      body: {
        fields: {
          description: makeAdfDocument(description),
          issuetype: {
            name: issueType,
          },
          priority: options.priority ? { name: options.priority } : undefined,
          project: {
            key: projectKey,
          },
          summary,
        },
      },
      method: 'POST',
    });
    const issueKey = jiraResponse.body?.key || jiraResponse.body?.id || null;

    await client.query(
      `
        UPDATE alerts
        SET
          jira_ticket_id = COALESCE($2, jira_ticket_id),
          extracted_details = COALESCE(extracted_details, '{}'::jsonb) || $3::jsonb,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        alertId,
        issueKey,
        JSON.stringify({
          jira_create_result: {
            issueKey,
            raw_payload: jiraResponse.body || {},
          },
        }),
      ],
    );

    await recordAuditEvent(client, alertId, 'jira_issue_created', options.actor || 'Website operator', {
      issueKey,
      responseStatus: jiraResponse.status,
    });

    await client.query('COMMIT');

    return {
      alertId,
      issueKey,
      metadata: jiraResponse.body || {},
      success: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addIssueComment(issueKey, options = {}) {
  const key = normalizeIssueKey(issueKey);
  const bodyText = String(options.comment || options.body || options.text || '').trim();

  if (!bodyText) {
    const error = new Error('Comment cannot be empty.');
    error.status = 400;
    error.code = 'EMPTY_COMMENT';
    throw error;
  }

  const response = await jiraWriteClient.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    body: {
      body: makeAdfDocument(bodyText),
    },
    method: 'POST',
  });

  return {
    issueKey: key,
    metadata: response.body || {},
    status: response.status,
    success: true,
  };
}

async function transitionIssue(issueKey, options = {}) {
  const key = normalizeIssueKey(issueKey);
  const requestedTransitionId = options.transitionId ? String(options.transitionId) : null;
  const requestedTransitionName = options.transitionName ? String(options.transitionName).toLowerCase() : null;

  if (!requestedTransitionId && !requestedTransitionName) {
    const error = new Error('transitionId or transitionName is required.');
    error.status = 400;
    error.code = 'MISSING_TRANSITION';
    throw error;
  }

  const transitionsResponse = await jiraWriteClient.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const transitions = Array.isArray(transitionsResponse.body?.transitions)
    ? transitionsResponse.body.transitions
    : [];
  const transition = transitions.find((item) => (
    (requestedTransitionId && String(item.id) === requestedTransitionId)
    || (requestedTransitionName && String(item.name || '').toLowerCase() === requestedTransitionName)
  ));

  if (!transition) {
    const error = new Error('Requested Jira transition is not available for this issue.');
    error.status = 409;
    error.code = 'INVALID_JIRA_TRANSITION';
    throw error;
  }

  const response = await jiraWriteClient.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    body: {
      transition: {
        id: transition.id,
      },
    },
    method: 'POST',
  });

  return {
    issueKey: key,
    status: response.status,
    success: true,
    transition: {
      id: transition.id,
      name: transition.name,
    },
  };
}

module.exports = {
  addIssueComment,
  createIssueForAlert,
  makeAdfDocument,
  transitionIssue,
};

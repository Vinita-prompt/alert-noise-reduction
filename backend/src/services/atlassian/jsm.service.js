const db = require('../../config/db');
const {
  getConfig,
  jsmReadClient,
  sanitizeError,
} = require('./clients');

let storageEnsured = false;

async function ensureStorage() {
  if (storageEnsured) {
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS atlassian_jsm_service_desks (
      service_desk_id TEXT PRIMARY KEY,
      project_id TEXT,
      project_key TEXT,
      project_name TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS atlassian_jsm_queues (
      id BIGSERIAL PRIMARY KEY,
      service_desk_id TEXT,
      queue_id TEXT NOT NULL,
      queue_name TEXT,
      issue_count INTEGER,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (service_desk_id, queue_id)
    );

    CREATE TABLE IF NOT EXISTS atlassian_jsm_requests (
      issue_id TEXT,
      issue_key TEXT PRIMARY KEY,
      request_type_id TEXT,
      request_type_name TEXT,
      service_desk_id TEXT,
      service_desk_name TEXT,
      summary TEXT,
      status TEXT,
      reporter JSONB,
      request_participants JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_sla JSONB NOT NULL DEFAULT '[]'::jsonb,
      approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
      comments JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_created_at TIMESTAMPTZ,
      request_updated_at TIMESTAMPTZ,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS integration_errors (
      id BIGSERIAL PRIMARY KEY,
      integration_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_atlassian_jsm_requests_status ON atlassian_jsm_requests(status);
    CREATE INDEX IF NOT EXISTS idx_atlassian_jsm_requests_updated ON atlassian_jsm_requests(request_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_errors_name_created ON integration_errors(integration_name, created_at DESC);
  `);

  storageEnsured = true;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getValues(payload) {
  if (Array.isArray(payload?.values)) return payload.values;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function isLastPage(payload, values, start, limit) {
  if (typeof payload?.isLastPage === 'boolean') return payload.isLastPage;
  if (typeof payload?.last === 'boolean') return payload.last;
  const size = Number(payload?.size || values.length || 0);
  const total = Number(payload?.total || 0);

  return values.length === 0 || (total > 0 && start + size >= total) || values.length < limit;
}

async function listPaged(path, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 100);
  let start = Math.max(Number(query.start || 0), 0);
  const rows = [];
  let pages = 0;

  while (pages < 200) {
    const response = await jsmReadClient.request(path, {
      query: {
        ...query,
        limit,
        start,
      },
    });
    const values = getValues(response.body);

    rows.push(...values);
    pages += 1;

    if (isLastPage(response.body, values, start, limit)) {
      break;
    }

    start += limit;
  }

  return {
    pages,
    values: rows,
  };
}

async function recordIntegrationError(operation, error, context = {}) {
  await ensureStorage();
  const sanitized = sanitizeError(error);

  await db.query(
    `
      INSERT INTO integration_errors (integration_name, operation, error_code, error_message, context)
      VALUES ('atlassian-jsm', $1, $2, $3, $4::jsonb)
    `,
    [operation, sanitized.code, sanitized.message, JSON.stringify(context)],
  );

  return sanitized;
}

function getIsoFromJsmDate(value) {
  if (!value) return null;
  const raw = value.iso8601 || value.jira || value.friendly || value;
  const date = new Date(raw);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function storeServiceDesks(serviceDesks = []) {
  for (const desk of serviceDesks) {
    await db.query(
      `
        INSERT INTO atlassian_jsm_service_desks (
          service_desk_id,
          project_id,
          project_key,
          project_name,
          raw_payload,
          last_synced_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
        ON CONFLICT (service_desk_id)
        DO UPDATE SET
          project_id = EXCLUDED.project_id,
          project_key = EXCLUDED.project_key,
          project_name = EXCLUDED.project_name,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        String(desk.id),
        desk.projectId ? String(desk.projectId) : null,
        desk.projectKey || null,
        desk.projectName || desk.name || null,
        JSON.stringify(desk),
      ],
    );
  }
}

async function storeQueues(serviceDeskId, queues = []) {
  for (const queue of queues) {
    await db.query(
      `
        INSERT INTO atlassian_jsm_queues (
          service_desk_id,
          queue_id,
          queue_name,
          issue_count,
          raw_payload,
          last_synced_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
        ON CONFLICT (service_desk_id, queue_id)
        DO UPDATE SET
          queue_name = EXCLUDED.queue_name,
          issue_count = EXCLUDED.issue_count,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        serviceDeskId,
        String(queue.id || queue.queueId),
        queue.name || queue.jql || 'JSM queue',
        Number(queue.issueCount || queue.count || 0),
        JSON.stringify(queue),
      ],
    );
  }
}

async function storeRequests(requests = []) {
  for (const item of requests) {
    const issueKey = item.issueKey || item.key;

    if (!issueKey) {
      continue;
    }

    const currentStatus = item.currentStatus || item.status || {};
    const requestType = item.requestType || {};
    const serviceDesk = item.serviceDesk || {};

    await db.query(
      `
        INSERT INTO atlassian_jsm_requests (
          issue_id,
          issue_key,
          request_type_id,
          request_type_name,
          service_desk_id,
          service_desk_name,
          summary,
          status,
          reporter,
          request_participants,
          current_sla,
          approvals,
          comments,
          attachments,
          raw_payload,
          request_created_at,
          request_updated_at,
          last_synced_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
          $13::jsonb, $14::jsonb, $15::jsonb,
          $16::timestamptz, $17::timestamptz, NOW(), NOW()
        )
        ON CONFLICT (issue_key)
        DO UPDATE SET
          issue_id = EXCLUDED.issue_id,
          request_type_id = EXCLUDED.request_type_id,
          request_type_name = EXCLUDED.request_type_name,
          service_desk_id = EXCLUDED.service_desk_id,
          service_desk_name = EXCLUDED.service_desk_name,
          summary = EXCLUDED.summary,
          status = EXCLUDED.status,
          reporter = EXCLUDED.reporter,
          request_participants = EXCLUDED.request_participants,
          current_sla = EXCLUDED.current_sla,
          approvals = EXCLUDED.approvals,
          comments = EXCLUDED.comments,
          attachments = EXCLUDED.attachments,
          raw_payload = EXCLUDED.raw_payload,
          request_created_at = COALESCE(EXCLUDED.request_created_at, atlassian_jsm_requests.request_created_at),
          request_updated_at = COALESCE(EXCLUDED.request_updated_at, atlassian_jsm_requests.request_updated_at),
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        item.issueId ? String(item.issueId) : null,
        String(issueKey),
        requestType.id ? String(requestType.id) : null,
        requestType.name || null,
        serviceDesk.id ? String(serviceDesk.id) : null,
        serviceDesk.projectName || serviceDesk.name || null,
        item.requestFieldValues?.summary || item.summary || item.issueKey || item.key,
        currentStatus.status || currentStatus.name || null,
        JSON.stringify(item.reporter || item.customer || {}),
        JSON.stringify(asArray(item.requestParticipants || item.participants)),
        JSON.stringify(asArray(item.currentSla || item.sla)),
        JSON.stringify(asArray(item.approvals)),
        JSON.stringify(asArray(item.comments || item.comment?.values)),
        JSON.stringify(asArray(item.attachments || item.attachment?.values)),
        JSON.stringify(item),
        getIsoFromJsmDate(item.createdDate || item.created),
        getIsoFromJsmDate(item.updatedDate || item.updated),
      ],
    );
  }
}

async function getServiceDesks() {
  await ensureStorage();

  const serviceDeskResult = await listPaged('/rest/servicedeskapi/servicedesk', {
    limit: 50,
  });

  await storeServiceDesks(serviceDeskResult.values);

  const queueErrors = [];

  for (const desk of serviceDeskResult.values) {
    try {
      const queueResult = await listPaged(`/rest/servicedeskapi/servicedesk/${encodeURIComponent(desk.id)}/queue`, {
        includeCount: true,
        limit: 50,
      });

      await storeQueues(String(desk.id), queueResult.values);
    } catch (error) {
      queueErrors.push(await recordIntegrationError('list_service_desk_queues', error, {
        serviceDeskId: desk.id,
      }));
    }
  }

  return {
    cloudIdConfigured: Boolean(getConfig().cloudId),
    data: serviceDeskResult.values,
    errors: queueErrors,
    fetched: serviceDeskResult.values.length,
    pages: serviceDeskResult.pages,
  };
}

async function getRequests(options = {}) {
  await ensureStorage();

  const query = {
    expand: options.expand || 'sla,requestType,serviceDesk,participant,attachment,comment',
    limit: Math.min(Math.max(Number(options.limit || 50), 1), 100),
    searchTerm: options.searchTerm || undefined,
    serviceDeskId: options.serviceDeskId || undefined,
  };
  const result = await listPaged('/rest/servicedeskapi/request', query);

  await storeRequests(result.values);

  return {
    data: result.values,
    fetched: result.values.length,
    pages: result.pages,
  };
}

module.exports = {
  ensureStorage,
  getRequests,
  getServiceDesks,
  listPaged,
};

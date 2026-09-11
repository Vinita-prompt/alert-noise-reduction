const { service: operationsReadService } = require('./opsReadValidation.service');
const slackAlertStoreService = require('../slackAlertStore.service');
const {
  extractRawOperationsIdentity,
  redactRawPayload,
} = require('../rawOperationsIdentity.service');
const {
  COMMAND_CENTER_TEAM,
  asCommandCenterAlert,
} = require('../commandCenterEligibility.service');

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const DEFAULT_PAGE_SIZE = 50;
const MAX_OFFSET_AND_SIZE = 20000;
const POLL_INTERVAL_SECONDS = 30;
const COMMAND_CENTER_OPERATIONS_QUERY = 'teams:"Command Center"';

function createError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function parsePageSize(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(value, 10);
  if (!ALLOWED_PAGE_SIZES.has(parsed)) {
    throw createError('pageSize must be one of 25, 50, or 100.', 'INVALID_LIVE_ALERT_PAGE_SIZE');
  }
  return parsed;
}

function parsePage(value) {
  if (value === undefined || value === null || value === '') return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw createError('page must be a positive integer.', 'INVALID_LIVE_ALERT_PAGE');
  }
  return parsed;
}

function cleanFilter(value, name, maximum = 250) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length > maximum) {
    throw createError(`${name} must be ${maximum} characters or fewer.`, 'LIVE_ALERT_FILTER_TOO_LONG');
  }
  return cleaned;
}

function queryPhrase(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dateBoundary(value, endOfDay = false) {
  const date = cleanFilter(value, endOfDay ? 'to' : 'from', 10);
  if (!date) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw createError(`${endOfDay ? 'to' : 'from'} must use YYYY-MM-DD format.`, 'INVALID_LIVE_ALERT_DATE');
  }
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw createError('Invalid Live Alerts date filter.', 'INVALID_LIVE_ALERT_DATE');
  }
  return endOfDay ? timestamp + (24 * 60 * 60 * 1000) - 1 : timestamp;
}

function buildSourceClause(value) {
  const normalized = value.toLowerCase();
  if (normalized === 'grafana') return '(source:Grafana* OR integration.type:Grafana*)';
  if (normalized === 'appdynamics') return '(source:AppDynamics* OR integration.type:AppDynamics)';
  if (normalized === 'nagios') return '(source:Nagios* OR integration.type:Nagios*)';
  if (normalized === 'thousandeyes') return '(source:ThousandEyes* OR integration.type:ThousandEyes)';
  if (normalized === 'email' || normalized === 'email / halcyon') {
    return '(integration.type:Email OR source:Email*)';
  }
  return `(source:${queryPhrase(value)} OR integration.name:${queryPhrase(value)} OR integration.type:${queryPhrase(value)})`;
}

function buildStatusClause(value) {
  const normalized = value.toLowerCase();
  if (['acknowledged', 'acked'].includes(normalized)) return '(status:open AND acknowledged:true)';
  if (['unacknowledged', 'open'].includes(normalized)) {
    return normalized === 'unacknowledged'
      ? '(status:open AND acknowledged:false)'
      : 'status:open';
  }
  if (['closed', 'resolved'].includes(normalized)) return 'status:closed';
  throw createError('Unsupported Operations status filter.', 'INVALID_LIVE_ALERT_STATUS');
}

function buildOperationsQuery(options = {}) {
  const clauses = [COMMAND_CENTER_OPERATIONS_QUERY];
  const search = cleanFilter(options.search, 'search', 300);
  const alertNumber = cleanFilter(options.alertNumber, 'alertNumber', 30);
  const source = cleanFilter(options.source, 'source');
  const priority = cleanFilter(options.priority, 'priority', 10);
  const severity = cleanFilter(options.severity, 'severity', 30);
  const status = cleanFilter(options.status, 'status', 30);
  const service = cleanFilter(options.service, 'service');
  const team = cleanFilter(options.team, 'team');
  const environment = cleanFilter(options.environment, 'environment');
  const tag = cleanFilter(options.tag, 'tag');

  const numericSearch = search?.match(/^(?:alert\s*)?#?\s*(\d+)$/i)?.[1];
  const normalizedAlertNumber = alertNumber?.replace(/\D/g, '');
  if (alertNumber && !normalizedAlertNumber) {
    throw createError('alertNumber must contain a numeric Operations tinyId.', 'INVALID_LIVE_ALERT_NUMBER');
  }
  const tinyId = normalizedAlertNumber || numericSearch;
  if (tinyId) clauses.push(`tinyId:${tinyId}`);

  if (search && !numericSearch) {
    const phrase = queryPhrase(search);
    clauses.push(`(message:${phrase} OR description:${phrase} OR source:${phrase} OR entity:${phrase} OR integration.name:${phrase})`);
  }
  if (source) clauses.push(buildSourceClause(source));
  if (priority) {
    const normalized = priority.toUpperCase();
    if (!/^P[1-5]$/.test(normalized)) {
      throw createError('priority must be P1, P2, P3, P4, or P5.', 'INVALID_LIVE_ALERT_PRIORITY');
    }
    clauses.push(`priority:${normalized}`);
  }
  if (severity) clauses.push(`tag:${queryPhrase(`severity:${severity.toLowerCase()}`)}`);
  if (status) clauses.push(buildStatusClause(status));
  if (service) clauses.push(`(tag:${queryPhrase(`service:${service}`)} OR entity:${queryPhrase(service)})`);
  if (team && team.trim().toLowerCase() !== 'command center') {
    clauses.push(`teams:${queryPhrase(team)}`);
  }
  if (environment) clauses.push(`tag:${queryPhrase(`environment:${environment}`)}`);
  if (tag) clauses.push(`tag:${queryPhrase(tag)}`);

  return clauses.length ? clauses.join(' AND ') : undefined;
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function elapsedMilliseconds(from, to) {
  const start = from ? new Date(from).getTime() : Number.NaN;
  const end = to ? new Date(to).getTime() : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function parseTags(tags = []) {
  const values = Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const byKey = {};
  for (const tag of values) {
    const match = tag.match(/^([^:=]+)[:=](.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!byKey[key]) byKey[key] = [];
    if (value) byKey[key].push(value);
  }
  return { byKey, values };
}

function firstTag(tagData, key) {
  return tagData.byKey[key]?.[0] || null;
}

function displaySource(alert) {
  const haystack = [alert.source, alert.integrationName, alert.integrationType, alert.message]
    .filter(Boolean)
    .join(' ');
  if (/grafana/i.test(haystack)) return 'Grafana';
  if (/appdynamics|\bappd\b/i.test(haystack)) return 'AppDynamics';
  if (/nagios/i.test(haystack)) return 'Nagios';
  if (/thousand\s*eyes/i.test(haystack)) return 'ThousandEyes';
  if (/email|halcyon/i.test(haystack)) return 'Email / Halcyon';
  return alert.source || alert.integrationName || alert.integrationType || 'Unknown';
}

function cleanTitle(message) {
  if (!message) return null;
  return String(message)
    .replace(/^\[[^\]]+\]\s*:?\s*/, '')
    .replace(/\s*\[(?:critical|high|medium|low|warning|info)\]\s*$/i, '')
    .trim() || String(message);
}

function mapStatus(alert) {
  const status = String(alert.status || '').toLowerCase();
  if (['closed', 'resolved', 'recovered'].includes(status)) return 'Closed';
  if (['acked', 'acknowledged'].includes(status) || (status === 'open' && alert.acknowledged === true)) return 'Acknowledged';
  if (['open', 'firing', 'triggered'].includes(status)) return 'Open';
  return alert.status || null;
}

function extractUrls(value, urls = new Set(), depth = 0) {
  if (depth > 4 || value === null || value === undefined) return urls;
  if (typeof value === 'string') {
    for (const match of value.match(/https?:\/\/[^\s<>"')\]]+/g) || []) {
      urls.add(match.replace(/[.,;:]$/, ''));
    }
    return urls;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => extractUrls(item, urls, depth + 1));
    return urls;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => extractUrls(item, urls, depth + 1));
  }
  return urls;
}

function serviceFromSource(source) {
  const segments = String(source || '').split('|').map((value) => value.trim()).filter(Boolean);
  return segments.length > 1 ? segments[1] : null;
}

function titleCaseValue(value) {
  if (!value) return null;
  const text = String(value).trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1).toLowerCase()}` : null;
}

function normalizeResponder(responder) {
  if (!responder || typeof responder !== 'object') return null;
  const id = responder.id || responder.accountId || responder.teamId || null;
  const name = responder.name || responder.username || responder.displayName || id;
  if (!id && !name) return null;
  return { id, name, type: responder.type || null };
}

function normalizeOperationsAlert(alert = {}, options = {}) {
  const tags = parseTags(alert.tags);
  const services = (Array.isArray(alert.services) ? alert.services : [])
    .map(normalizeResponder)
    .filter(Boolean);
  const createdAt = toIso(alert.createdAt);
  const updatedAt = toIso(alert.updatedAt);
  const ackTime = toIso(alert.ackTime);
  const closeTime = toIso(alert.closeTime);
  const lastOccurredAt = toIso(alert.lastOccurredAt);
  const links = [...extractUrls([
    alert.description,
    alert.extraProperties,
    alert.message,
    alert.tags,
  ])];
  const sourceUrl = links.find((link) => !/atlassian\.net|api\.atlassian\.com|j\.opsg\.in/i.test(link)) || null;
  const runbook = firstTag(tags, 'runbook')
    || links.find((link) => /runbook|playbook|wiki|confluence/i.test(link))
    || null;
  const sourceSystem = displaySource(alert);
  const slackCorrelation = options.slackCorrelation || null;
  const rawPayload = redactRawPayload(alert.rawOperationsPayload || alert);
  const identityExtractionMetadata = extractRawOperationsIdentity(rawPayload, {
    alertId: alert.id,
    source: sourceSystem,
  });

  const originalTeam = firstTag(tags, 'team');
  const normalized = {
    ackTime,
    acknowledged: alert.acknowledged ?? null,
    acknowledgedBy: options.acknowledgedBy || null,
    actions: [],
    alertId: alert.id || null,
    alertNumber: alert.tinyId || null,
    alias: alert.alias || null,
    application: firstTag(tags, 'application'),
    authoritativeSource: 'jsm_operations',
    canonicalOperationsId: alert.id || null,
    closeTime,
    closedBy: options.closedBy || null,
    createdAt,
    currentOwner: alert.owner || null,
    description: alert.description || null,
    entity: alert.entity || null,
    environment: firstTag(tags, 'environment'),
    externalId: alert.id || null,
    firstSeen: createdAt,
    id: alert.id || null,
    integration: {
      name: alert.integrationName || null,
      type: alert.integrationType || null,
    },
    integrationName: alert.integrationName || null,
    integrationType: alert.integrationType || null,
    isNew: false,
    lastOccurredAt,
    lastSeen: updatedAt || lastOccurredAt || createdAt,
    links,
    liveData: true,
    message: alert.message || null,
    mttaMs: elapsedMilliseconds(createdAt, ackTime),
    occurrenceCount: alert.count ?? null,
    occurrences: alert.count ?? null,
    operationsStatus: alert.status || null,
    owner: alert.owner || null,
    priority: alert.priority || null,
    extraProperties: alert.extraProperties && typeof alert.extraProperties === 'object'
      ? alert.extraProperties
      : {},
    rawTags: tags.values,
    readOnlyActions: true,
    recordOrigin: 'operations_api',
    responders: (Array.isArray(alert.responders) ? alert.responders : [])
      .map(normalizeResponder)
      .filter(Boolean),
    runbook,
    seen: alert.seen ?? null,
    service: firstTag(tags, 'service') || services[0]?.name || serviceFromSource(alert.source),
    services,
    severity: titleCaseValue(firstTag(tags, 'severity')),
    slackCorrelation,
    slackPermalink: slackCorrelation?.slackPermalink || null,
    snoozed: alert.snoozed ?? null,
    snoozedUntil: toIso(alert.snoozedUntil),
    slackMessages: null,
    source: sourceSystem,
    sourceDetails: {
      alias: alert.alias || null,
      cluster: firstTag(tags, 'cluster'),
      controllerUrl: firstTag(tags, 'controller_url') || firstTag(tags, 'controllerurl'),
      eventLink: firstTag(tags, 'event_link') || firstTag(tags, 'eventlink'),
      entity: alert.entity || null,
      grafanaFolder: firstTag(tags, 'grafana_folder'),
      host: firstTag(tags, 'host'),
      integrationName: alert.integrationName || null,
      integrationType: alert.integrationType || null,
      metricKey: firstTag(tags, 'metric-key') || firstTag(tags, 'metric_key'),
      nagiosService: firstTag(tags, 'nagios_service') || firstTag(tags, 'service_name'),
      originalSource: alert.source || null,
      operationalTeam: originalTeam,
      room: firstTag(tags, 'room'),
    },
    sourceEventId: alert.id || null,
    sourceSystem,
    sourceType: 'jsm_operations',
    sourceUrl,
    sources: [sourceSystem],
    status: mapStatus(alert),
    tags: tags.values,
    responderTeam: options.commandCenterAssignmentConfirmed ? COMMAND_CENTER_TEAM : null,
    responder: options.commandCenterAssignmentConfirmed ? COMMAND_CENTER_TEAM : null,
    team: options.commandCenterAssignmentConfirmed ? COMMAND_CENTER_TEAM : originalTeam,
    tier: firstTag(tags, 'tier'),
    timeToCloseMs: elapsedMilliseconds(createdAt, closeTime),
    tinyId: alert.tinyId || null,
    title: cleanTitle(alert.message || alert.summary),
    updatedAt,
    ...(options.includeRaw ? { rawOperationsPayload: rawPayload } : {}),
  };
  Object.defineProperties(normalized, {
    rawPayload: { enumerable: false, value: rawPayload },
    normalizedPayload: {
      enumerable: false,
      value: {
        alertId: normalized.id,
        application: normalized.application,
        environment: normalized.environment,
        service: normalized.service,
        source: normalized.sourceSystem,
        sourceDetails: normalized.sourceDetails,
        sourceUrl: normalized.sourceUrl,
        tags: normalized.tags,
      },
    },
    identityExtractionMetadata: { enumerable: false, value: identityExtractionMetadata },
  });
  return options.commandCenterAssignmentConfirmed ? asCommandCenterAlert(normalized) : normalized;
}

function assertCanonicalId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 300 || /^\d+$/.test(id) || /[/?#]/.test(id)) {
    throw createError('A canonical JSM Operations alert ID is required.', 'INVALID_CANONICAL_OPERATIONS_ID');
  }
  return id;
}

function sourceCounts(items) {
  return items.reduce((counts, alert) => {
    const key = alert.sourceSystem || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function publicError(error) {
  return {
    code: error?.code || 'OPERATIONS_LIVE_ALERTS_UNAVAILABLE',
    message: error?.safeMessage || error?.message || 'JSM Operations Live Alerts are unavailable.',
    status: error?.status || null,
  };
}

function cacheKey(options) {
  return JSON.stringify(options, Object.keys(options).sort());
}

function createOperationsLiveAlertsService({
  operationsService = operationsReadService,
  slackStore = slackAlertStoreService,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const runtimeState = {
    lastAlertAt: null,
    lastError: null,
    lastSuccessfulFetchAt: null,
  };

  async function correlationsFor(alerts, includeMessages = false) {
    const tinyIds = alerts.map((alert) => alert.tinyId).filter(Boolean);
    if (!tinyIds.length || !slackStore?.getCorrelationsByAlertNumbers) {
      return { correlations: {}, status: 'not_available' };
    }
    try {
      return {
        correlations: await slackStore.getCorrelationsByAlertNumbers(tinyIds, { includeMessages }),
        status: 'available',
      };
    } catch {
      return { correlations: {}, status: 'unavailable' };
    }
  }

  async function listLiveAlerts(options = {}) {
    const page = parsePage(options.page);
    const pageSize = parsePageSize(options.pageSize);
    const offset = (page - 1) * pageSize;
    if (offset + pageSize >= MAX_OFFSET_AND_SIZE) {
      throw createError(
        'This page exceeds the Atlassian 20,000-result retrieval boundary. Narrow the time window or filters.',
        'OPERATIONS_RETRIEVAL_BOUNDARY',
        422,
      );
    }
    const sort = options.sort === 'oldest' ? 'createdAt' : 'createdAt';
    const order = options.sort === 'oldest' ? 'asc' : 'desc';
    const request = {
      from: dateBoundary(options.from),
      offset,
      order,
      page,
      pageSize,
      query: buildOperationsQuery(options),
      size: pageSize,
      sort,
      to: dateBoundary(options.to, true),
    };
    const key = cacheKey(request);

    try {
      const response = await operationsService.listAlerts(request);
      const slack = await correlationsFor(response.values);
      const items = response.values.map((alert) => normalizeOperationsAlert(alert, {
        commandCenterAssignmentConfirmed: true,
        slackCorrelation: slack.correlations[alert.tinyId] || null,
      }));
      const total = Number(response.count || 0);
      const maxPageAtBoundary = Math.floor((MAX_OFFSET_AND_SIZE - 1 - pageSize) / pageSize) + 1;
      const totalPages = Math.max(1, Math.min(Math.ceil(total / pageSize), maxPageAtBoundary));
      const fetchedAt = new Date(now()).toISOString();
      const lastAlertAt = items[0]?.createdAt || items[0]?.lastSeen || null;
      runtimeState.lastAlertAt = lastAlertAt;
      runtimeState.lastError = null;
      runtimeState.lastSuccessfulFetchAt = fetchedAt;

      const result = {
        authoritativeSource: 'jsm_operations',
        connections: {
          operations: 'connected',
          slackCorrelation: slack.status,
        },
        freshness: 'Fresh',
        freshnessSeconds: 0,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
        items,
        lastAlertAt,
        lastOperationsSync: fetchedAt,
        operationsWriteEnabled: false,
        page,
        pageSize,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
        query: response.request?.query || request.query || null,
        readOnly: true,
        retrievalBoundary: response.pagination?.retrievalBoundary || 'offset + size must be lower than 20000',
        retrievableTotal: Math.min(total, maxPageAtBoundary * pageSize),
        sourceCounts: sourceCounts(items),
        stale: false,
        total,
        totalPages,
      };
      cache.set(key, result);
      return result;
    } catch (error) {
      runtimeState.lastError = publicError(error);
      const cached = cache.get(key);
      if (cached) {
        const freshnessSeconds = cached.lastOperationsSync
          ? Math.max(0, Math.floor((now() - new Date(cached.lastOperationsSync).getTime()) / 1000))
          : null;
        return {
          ...cached,
          connections: { ...cached.connections, operations: 'degraded' },
          freshness: 'Stale',
          freshnessSeconds,
          stale: true,
          warning: 'The latest Operations refresh failed. Showing the last successful result for these filters.',
        };
      }
      throw error;
    }
  }

  async function getLiveAlert(alertId) {
    const canonicalId = assertCanonicalId(alertId);
    const response = await operationsService.getAlert(canonicalId);
    await assertCommandCenterAssignment(response.alert);
    const slack = await correlationsFor([response.alert]);
    return normalizeOperationsAlert(response.alert, {
      commandCenterAssignmentConfirmed: true,
      includeRaw: true,
      slackCorrelation: slack.correlations[response.alert.tinyId] || null,
    });
  }

  async function assertCommandCenterAssignment(alert) {
    const tinyId = String(alert?.tinyId || '').replace(/\D/g, '');
    if (!tinyId) {
      throw createError('The requested alert is not visible.', 'OPERATIONS_ALERT_NOT_VISIBLE', 404);
    }
    const response = await operationsService.listAlerts({
      offset: 0,
      order: 'desc',
      query: `tinyId:${tinyId} AND ${COMMAND_CENTER_OPERATIONS_QUERY}`,
      size: 1,
      sort: 'createdAt',
    });
    const visible = response.values.some((candidate) => String(candidate.id) === String(alert.id));
    if (!visible) {
      throw createError('The requested alert is not visible.', 'OPERATIONS_ALERT_NOT_VISIBLE', 404);
    }
  }

  function normalizeLog(log = {}, index = 0) {
    const message = log.log || log.message || log.description || log.text || null;
    const type = log.logType || log.type || log.eventType || 'activity';
    const timestamp = toIso(log.logTime || log.createdAt || log.timestamp || log.time);
    const actor = log.owner || log.actor?.name || log.actor || log.user?.name || log.user || null;
    const lower = String(message || '').toLowerCase();
    let category = 'activity';
    if (/alert created/.test(lower)) category = 'created';
    else if (/alert acknowledged/.test(lower) && !/unacknowledged/.test(lower)) category = 'acknowledged';
    else if (/alert closed/.test(lower)) category = 'closed';
    else if (/added as recipient|routing rule|assigned/.test(lower)) category = 'routing';
    else if (/notification/.test(String(type).toLowerCase())) category = 'notification';
    return {
      actor,
      category,
      id: log.id || log.logId || `${timestamp || 'unknown'}-${index}`,
      message,
      timestamp,
      type,
    };
  }

  async function getActivity(alertId, options = {}) {
    const canonicalId = assertCanonicalId(alertId);
    const alertResponse = await operationsService.getAlert(canonicalId);
    await assertCommandCenterAssignment(alertResponse.alert);
    const logsResponse = await operationsService.getLogs(canonicalId, { size: options.size || 100 });
    const allItems = logsResponse.values.map(normalizeLog);
    const meaningfulItems = allItems.filter((item) => (
      ['acknowledged', 'closed', 'created', 'routing'].includes(item.category)
      || item.type === 'alertAction'
      || (item.type === 'system' && /executed|action|sent \[|slack-plugin/i.test(item.message || ''))
    ));
    const items = String(options.full || '').toLowerCase() === 'true' ? allItems : meaningfulItems;
    const acknowledgement = allItems.find((item) => item.type === 'alertAction' && item.category === 'acknowledged') || null;
    const closure = allItems.find((item) => item.category === 'closed' && item.type === 'alertAction')
      || allItems.find((item) => item.category === 'closed')
      || null;
    const alert = alertResponse.alert;
    return {
      fullCount: allItems.length,
      items,
      readOnly: true,
      summary: {
        ackTime: toIso(alert.ackTime),
        acknowledgedBy: acknowledgement?.actor || null,
        closeTime: toIso(alert.closeTime),
        closedBy: closure?.actor || null,
        mttaMs: elapsedMilliseconds(alert.createdAt, alert.ackTime),
        timeToCloseMs: elapsedMilliseconds(alert.createdAt, alert.closeTime),
      },
    };
  }

  async function getNotes(alertId, options = {}) {
    const canonicalId = assertCanonicalId(alertId);
    const alertResponse = await operationsService.getAlert(canonicalId);
    await assertCommandCenterAssignment(alertResponse.alert);
    const response = await operationsService.getNotes(canonicalId, { size: options.size || 100 });
    return {
      items: response.values.map((note, index) => ({
        author: note.owner || note.author?.name || note.author || note.createdBy || null,
        id: note.id || note.noteId || `${note.createdAt || 'unknown'}-${index}`,
        note: note.note || note.message || note.text || note.body || null,
        timestamp: toIso(note.createdAt || note.created_at || note.timestamp || note.time),
      })),
      readOnly: true,
    };
  }

  async function getSlackContext(alertId) {
    const canonicalId = assertCanonicalId(alertId);
    const response = await operationsService.getAlert(canonicalId);
    await assertCommandCenterAssignment(response.alert);
    const slack = await correlationsFor([response.alert], true);
    return {
      alertNumber: response.alert.tinyId || null,
      correlation: slack.correlations[response.alert.tinyId] || {
        alertNumber: response.alert.tinyId || null,
        available: false,
        messages: [],
      },
      readOnly: true,
      status: slack.status,
    };
  }

  async function getStatus() {
    try {
      const response = await operationsService.listAlerts({
        offset: 0,
        order: 'desc',
        query: COMMAND_CENTER_OPERATIONS_QUERY,
        size: 1,
        sort: 'createdAt',
      });
      const checkedAt = new Date(now()).toISOString();
      runtimeState.lastAlertAt = response.values[0]?.createdAt || runtimeState.lastAlertAt;
      runtimeState.lastError = null;
      runtimeState.lastSuccessfulFetchAt = checkedAt;
      return {
        connected: true,
        lastAlertAt: runtimeState.lastAlertAt,
        lastSuccessfulFetchAt: checkedAt,
        operationsWriteEnabled: false,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
        readOnly: true,
      };
    } catch (error) {
      runtimeState.lastError = publicError(error);
      return {
        connected: false,
        lastAlertAt: runtimeState.lastAlertAt,
        lastError: runtimeState.lastError,
        lastSuccessfulFetchAt: runtimeState.lastSuccessfulFetchAt,
        operationsWriteEnabled: false,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
        readOnly: true,
      };
    }
  }

  return {
    getActivity,
    getLiveAlert,
    getNotes,
    getSlackContext,
    getStatus,
    listLiveAlerts,
  };
}

module.exports = {
  ALLOWED_PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  MAX_OFFSET_AND_SIZE,
  COMMAND_CENTER_OPERATIONS_QUERY,
  buildOperationsQuery,
  createOperationsLiveAlertsService,
  normalizeOperationsAlert,
  service: createOperationsLiveAlertsService(),
};

const { jiraReadClient } = require('./clients');
const { adfToText } = require('../../utils/jiraAdf');

const ACC_PROJECT_KEY = 'ACC';
const PROBLEM_JQL = '"Ticket category" = Problems AND project = ACC';
const INCIDENT_JQL = '"Ticket category" = Incidents AND project = ACC';
const EXACT_INCIDENT_JQL = 'project = ACC AND issuetype = "[System] Incident"';
const SEARCH_PATH = '/rest/api/3/search/jql';
const COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_TOKEN_CACHE_TTL_MS = 10 * 60 * 1000;
// Jira's enhanced search endpoint accepts up to 1,000 key-only results. Using
// that supported size keeps the exact count read-only without issuing one
// request for every browser-sized page.
const COUNT_PAGE_SIZE = 1000;
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MAX_DAILY_RANGE_DAYS = 366;

const LIST_FIELDS = [
  'key',
  'summary',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'created',
  'updated',
  'resolutiondate',
  'resolution',
  'issuelinks',
  'description',
  'customfield_15764',
  'customfield_11693',
];

const DETAIL_FIELDS = [
  ...LIST_FIELDS,
  'labels',
  'components',
  'parent',
  'subtasks',
];

function createSafeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.safeMessage = message;
  return error;
}

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeJqlString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}

function exactClause(field, value) {
  const escaped = escapeJqlString(value);
  return escaped ? `${field} = "${escaped}"` : null;
}

function dateClause(field, operator, value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw createSafeError(`Invalid ${field} date. Use YYYY-MM-DD.`, 'INVALID_JIRA_DATE_FILTER');
  }
  return `${field} ${operator} "${value}"`;
}

function buildIncidentJql(filters = {}) {
  const clauses = [INCIDENT_JQL];
  const search = String(filters.search || '').trim();

  [
    exactClause('status', filters.status),
    exactClause('priority', filters.priority),
    exactClause('assignee', filters.assignee),
    exactClause('resolution', filters.resolution),
    dateClause('created', '>=', filters.createdFrom),
    dateClause('created', '<=', filters.createdTo),
    dateClause('updated', '>=', filters.updatedFrom),
    dateClause('updated', '<=', filters.updatedTo),
    dateClause('resolved', '>=', filters.resolvedFrom),
    dateClause('resolved', '<=', filters.resolvedTo),
  ].filter(Boolean).forEach((clause) => clauses.push(clause));

  if (search) {
    const escaped = escapeJqlString(search);
    if (/^ACC-\d+$/i.test(search)) {
      clauses.push(`key = "${escaped.toUpperCase()}"`);
    } else {
      const summaryTerm = escapeJqlString(`${search}*`);
      clauses.push(`(summary ~ "${summaryTerm}" OR assignee = "${escaped}")`);
    }
  }

  return `${clauses.map((clause) => `(${clause})`).join(' AND ')} ORDER BY updated DESC`;
}

function buildExactIncidentJql(filters = {}) {
  const clauses = [EXACT_INCIDENT_JQL];
  const search = String(filters.search || '').trim();

  [
    exactClause('status', filters.status),
    exactClause('priority', filters.priority),
    exactClause('assignee', filters.assignee),
    exactClause('resolution', filters.resolution),
    dateClause('created', '>=', filters.createdFrom),
    dateClause('created', '<=', filters.createdTo),
    dateClause('updated', '>=', filters.updatedFrom),
    dateClause('updated', '<=', filters.updatedTo),
    dateClause('resolved', '>=', filters.resolvedFrom),
    dateClause('resolved', '<=', filters.resolvedTo),
  ].filter(Boolean).forEach((clause) => clauses.push(clause));

  if (search) {
    const escaped = escapeJqlString(search);
    if (/^ACC-\d+$/i.test(search)) clauses.push(`key = "${escaped.toUpperCase()}"`);
    else clauses.push(`(summary ~ "${escapeJqlString(`${search}*`)}" OR assignee = "${escaped}")`);
  }

  return `${clauses.map((clause) => `(${clause})`).join(' AND ')} ORDER BY created DESC`;
}

function istDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parseIstDate(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw createSafeError('Date filters must use YYYY-MM-DD.', 'INVALID_JIRA_DATE_FILTER');
  }
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  if (Number.isNaN(parsed.getTime())) {
    throw createSafeError('Date filters must use a valid calendar date.', 'INVALID_JIRA_DATE_FILTER');
  }
  return parsed;
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function resolveDailyRange(options = {}, nowValue = new Date()) {
  const nowDate = new Date(nowValue);
  const today = istDateKey(nowDate);
  const todayStart = parseIstDate(today);
  const range = String(options.range || '30d').toLowerCase();
  let from = today;
  let to = today;

  if (range === '7d') from = istDateKey(addUtcDays(todayStart, -6));
  else if (range === '30d') from = istDateKey(addUtcDays(todayStart, -29));
  else if (range === 'custom') {
    from = String(options.from || '');
    to = String(options.to || '');
    parseIstDate(from);
    parseIstDate(to, true);
  } else if (range !== 'today') {
    throw createSafeError('range must be today, 7d, 30d, or custom.', 'INVALID_JIRA_DATE_RANGE');
  }

  const fromDate = parseIstDate(from);
  const toDate = parseIstDate(to, true);
  const days = Math.floor((parseIstDate(to).getTime() - fromDate.getTime()) / 86400000) + 1;
  if (fromDate > toDate || days > MAX_DAILY_RANGE_DAYS) {
    throw createSafeError(`The Jira daily range must be between 1 and ${MAX_DAILY_RANGE_DAYS} days.`, 'INVALID_JIRA_DATE_RANGE');
  }
  return { days, from, fromDate, range, to, toDate };
}

function startOfIstWeek(nowValue = new Date()) {
  const today = parseIstDate(istDateKey(nowValue));
  const shifted = new Date(today.getTime() + IST_OFFSET_MS);
  const day = shifted.getUTCDay();
  return addUtcDays(today, -((day + 6) % 7));
}

function startOfIstMonth(nowValue = new Date()) {
  const key = istDateKey(nowValue);
  return parseIstDate(`${key.slice(0, 8)}01`);
}

function fieldText(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim() || null;
  }
  if (Array.isArray(value)) {
    const text = value.map(fieldText).filter(Boolean).join(', ');
    return text || null;
  }
  if (typeof value === 'object') {
    return fieldText(value.value || value.name || value.displayName || value.text || value.content);
  }
  return null;
}

function normalizePerson(person) {
  if (!person) return null;
  if (typeof person === 'string') {
    return { accountId: null, displayName: person, email: null };
  }
  const displayName = person.displayName || person.emailAddress || person.name || null;
  const email = person.emailAddress || null;
  if (!displayName && !email) return null;
  return {
    accountId: person.accountId || null,
    displayName,
    email,
  };
}

function deriveResolverFromChangelog(changelog = []) {
  const histories = [...changelog].sort((left, right) => (
    new Date(right.created || 0).getTime() - new Date(left.created || 0).getTime()
  ));

  const resolutionHistory = histories.find((history) => (
    (history.items || []).some((item) => (
      String(item.field || '').toLowerCase() === 'resolution'
      && item.toString
      && !/^unresolved$|^open$/i.test(item.toString)
    ))
  ));

  return resolutionHistory ? normalizePerson(resolutionHistory.author) : null;
}

function normalizeIssueLink(link) {
  const linkedIssue = link.outwardIssue || link.inwardIssue;
  if (!linkedIssue?.key) return null;
  const direction = link.outwardIssue ? 'outward' : 'inward';
  return {
    direction,
    issueType: linkedIssue.fields?.issuetype?.name || null,
    key: linkedIssue.key,
    relationship: direction === 'outward' ? link.type?.outward || link.type?.name : link.type?.inward || link.type?.name,
    status: linkedIssue.fields?.status?.name || null,
    summary: linkedIssue.fields?.summary || null,
    type: link.type?.name || null,
  };
}

function isConfirmedIncidentLink(link) {
  return /^\[system\] incident$/i.test(link.issueType || '')
    || /^incident$/i.test(link.issueType || '')
    || /problem\s*\/\s*incident/i.test(link.type || '');
}

function getDirectAlertReferences(values = []) {
  const references = new Map();
  const pattern = /\bAlert\s*#\s*(\d+)\b/gi;

  values.filter(Boolean).forEach((value) => {
    const text = typeof value === 'string' ? value : adfToText(value);
    let match = pattern.exec(text);
    while (match) {
      references.set(match[1], {
        alertNumber: match[1],
        label: `Alert #${match[1]}`,
        matchType: 'direct_reference',
      });
      match = pattern.exec(text);
    }
    pattern.lastIndex = 0;
  });

  return [...references.values()];
}

function normalizedHistory(history) {
  return {
    actor: normalizePerson(history.author),
    createdAt: history.created || null,
    id: history.id || null,
    items: (history.items || []).map((item) => ({
      field: item.field || null,
      from: item.fromString || null,
      to: item.toString || null,
    })),
  };
}

function normalizeComment(comment) {
  return {
    author: normalizePerson(comment.author),
    body: adfToText(comment.body),
    createdAt: comment.created || null,
    id: comment.id || null,
    updatedAt: comment.updated || null,
  };
}

function findHowResolved(fields, comments = [], changelog = []) {
  const directValue = fieldText(fields.customfield_11693);
  if (directValue) return directValue;

  const historicalValue = [...changelog]
    .sort((left, right) => new Date(right.created || 0) - new Date(left.created || 0))
    .flatMap((history) => history.items || [])
    .find((item) => (
      /how.*resolved|resolution.*action|action.*taken/i.test(String(item.field || ''))
      && fieldText(item.toString)
    ));
  if (historicalValue) return fieldText(historicalValue.toString);

  const actionPattern = /\b(rolled?\s*back|rollback|restarted?|restored?|fixed|updated?\s+(?:the\s+)?config|configured?|recovered?|cleared?\s+(?:the\s+)?queue|deployed?|reverted?|reconnected?|fail(?:ed)?\s*over|patched?)\b/i;
  const evidence = [...comments]
    .sort((left, right) => new Date(right.created || 0) - new Date(left.created || 0))
    .map((comment) => adfToText(comment.body))
    .find((text) => actionPattern.test(text));

  if (!evidence) return 'Not documented';
  const matchingLine = evidence.split(/\n+|(?<=[.!?])\s+/).find((line) => actionPattern.test(line)) || evidence;
  return matchingLine.trim().slice(0, 320) || 'Not documented';
}

function normalizeIssue(issue, options = {}) {
  const fields = issue.fields || {};
  const rawChangelog = options.changelog || issue.changelog?.histories || [];
  const comments = options.comments || [];
  const links = (fields.issuelinks || []).map(normalizeIssueLink).filter(Boolean);
  const isResolved = Boolean(fields.resolutiondate || fields.resolution);
  const directResolvedBy = isResolved ? normalizePerson(fields.customfield_15764) : null;
  const resolvedBy = isResolved ? directResolvedBy || deriveResolverFromChangelog(rawChangelog) : null;
  const description = adfToText(fields.description) || null;
  const commentText = comments.map((comment) => adfToText(comment.body));
  const relatedAlerts = getDirectAlertReferences([fields.description, fields.summary, ...commentText]);
  const relatedIncidents = [...new Map(
    links.filter(isConfirmedIncidentLink).map((link) => [link.key, link]),
  ).values()];

  return {
    assignee: normalizePerson(fields.assignee),
    components: (fields.components || []).map((component) => ({
      id: component.id || null,
      name: component.name || null,
    })),
    createdAt: fields.created || null,
    description,
    id: issue.id || null,
    issueLinks: links,
    issueType: fields.issuetype?.name || null,
    key: issue.key,
    labels: fields.labels || [],
    priority: fields.priority?.name || null,
    project: ACC_PROJECT_KEY,
    relatedAlerts,
    relatedIncidents,
    reporter: normalizePerson(fields.reporter),
    resolution: fields.resolution?.name || fieldText(fields.resolution),
    resolvedAt: fields.resolutiondate || null,
    resolvedBy,
    resolvedBySource: directResolvedBy ? 'jira_field' : resolvedBy ? 'changelog' : null,
    status: fields.status?.name || null,
    summary: fields.summary || '',
    ticketCategory: /^\[system\]\s*/i.test(fields.issuetype?.name || '')
      ? fields.issuetype.name.replace(/^\[system\]\s*/i, '')
      : fields.issuetype?.name || null,
    updatedAt: fields.updated || null,
    ...(options.includeDetail ? {
      activity: rawChangelog
        .filter((history) => (history.items || []).some((item) => (
          /status|resolution|assignee|priority/i.test(String(item.field || ''))
        )))
        .map(normalizedHistory),
      changelog: rawChangelog.map(normalizedHistory),
      comments: comments.map(normalizeComment),
      howResolved: findHowResolved(fields, comments, rawChangelog),
    } : {}),
  };
}

function createAccJiraReadService({ client = jiraReadClient, now = () => Date.now() } = {}) {
  const countCache = new Map();
  const countInFlight = new Map();
  const pageTokenCache = new Map();

  async function search(jql, { fields = LIST_FIELDS, maxResults = 100, nextPageToken, expand } = {}) {
    const response = await client.request(SEARCH_PATH, {
      query: {
        expand,
        fields: fields.join(','),
        jql,
        maxResults,
        nextPageToken,
      },
      timeoutMs: 30000,
    });
    return response.body || {};
  }

  async function countJql(jql, options = {}) {
    const useCache = options.useCache !== false;
    const cached = countCache.get(jql);
    if (useCache && cached && now() - cached.cachedAt < COUNT_CACHE_TTL_MS) return cached.total;
    if (countInFlight.has(jql)) return countInFlight.get(jql);

    const request = (async () => {
      let nextPageToken;
      let total = 0;
      let pageCount = 0;

      do {
        const result = await search(jql, {
          fields: ['key'],
          maxResults: COUNT_PAGE_SIZE,
          nextPageToken,
        });
        total += (result.issues || []).length;
        nextPageToken = result.isLast ? null : result.nextPageToken;
        pageCount += 1;
        if (pageCount > 250) {
          throw createSafeError('Jira count exceeded the safe pagination boundary.', 'JIRA_COUNT_BOUNDARY', 502);
        }
      } while (nextPageToken);

      if (useCache) countCache.set(jql, { cachedAt: now(), total });
      return total;
    })();

    countInFlight.set(jql, request);
    try {
      return await request;
    } finally {
      countInFlight.delete(jql);
    }
  }

  async function fetchAll(jql, fields = LIST_FIELDS) {
    const issues = [];
    let nextPageToken;
    let pageCount = 0;

    do {
      const result = await search(jql, { fields, maxResults: 100, nextPageToken, expand: 'changelog' });
      issues.push(...(result.issues || []));
      nextPageToken = result.isLast ? null : result.nextPageToken;
      pageCount += 1;
      if (pageCount > 25) {
        throw createSafeError('Problem retrieval exceeded the controlled pagination boundary.', 'JIRA_PROBLEM_BOUNDARY', 502);
      }
    } while (nextPageToken);

    return issues;
  }

  async function fetchAllExactIncidents(
    jql,
    fields = ['key', 'created', 'updated', 'issuetype'],
  ) {
    const issues = [];
    let nextPageToken;
    let pageCount = 0;

    do {
      const result = await search(jql, {
        fields,
        maxResults: 1000,
        nextPageToken,
      });
      issues.push(...(result.issues || []));
      nextPageToken = result.isLast ? null : result.nextPageToken;
      pageCount += 1;
      if (pageCount > 400) {
        throw createSafeError('Jira Incident metric retrieval exceeded the safe pagination boundary.', 'JIRA_INCIDENT_METRIC_BOUNDARY', 502);
      }
    } while (nextPageToken);

    return { issues, pageCount };
  }

  async function listAllExactIncidentsForSync() {
    const jql = `${EXACT_INCIDENT_JQL} ORDER BY created ASC`;
    const result = await fetchAllExactIncidents(jql, LIST_FIELDS);
    const runtime = typeof client.getRuntimeConfigAsync === 'function'
      ? await client.getRuntimeConfigAsync()
      : null;
    const siteUrl = String(runtime?.siteUrl || '').replace(/\/+$/, '');
    const issues = result.issues.filter((issue) => (
      issue.fields?.issuetype?.name === '[System] Incident'
    ));

    return {
      items: issues.map((issue) => ({
        ...normalizeIssue(issue),
        rawPayload: issue,
        sourceUrl: siteUrl && issue.key ? `${siteUrl}/browse/${issue.key}` : null,
      })),
      pageCount: result.pageCount,
      readOnly: true,
      source: 'Jira',
      sourceStatus: 'AVAILABLE',
      totalCount: issues.length,
      updatedAt: new Date(now()).toISOString(),
    };
  }

  function pageCacheKey(jql, pageSize) {
    return `${pageSize}:${jql}`;
  }

  function getPageTokenState(jql, pageSize) {
    const key = pageCacheKey(jql, pageSize);
    const existing = pageTokenCache.get(key);
    if (existing && now() - existing.cachedAt < PAGE_TOKEN_CACHE_TTL_MS) return existing;
    const created = { cachedAt: now(), tokens: new Map([[1, null]]) };
    pageTokenCache.set(key, created);
    return created;
  }

  async function fetchIncidentPage(jql, page, pageSize) {
    const state = getPageTokenState(jql, pageSize);
    let currentPage = 1;
    let token = null;

    for (const [candidatePage, candidateToken] of state.tokens) {
      if (candidatePage <= page && candidatePage >= currentPage) {
        currentPage = candidatePage;
        token = candidateToken;
      }
    }

    let result;
    while (currentPage <= page) {
      result = await search(jql, {
        expand: 'changelog',
        fields: LIST_FIELDS,
        maxResults: pageSize,
        nextPageToken: token,
      });

      if (currentPage === page) break;
      if (result.isLast || !result.nextPageToken) return { issues: [], isLast: true, nextPageToken: null };
      currentPage += 1;
      token = result.nextPageToken;
      state.tokens.set(currentPage, token);
    }

    if (result?.nextPageToken) state.tokens.set(page + 1, result.nextPageToken);
    state.cachedAt = now();
    return result || { issues: [], isLast: true };
  }

  async function getDatasetCounts() {
    const [problems, incidents] = await Promise.all([
      countJql(PROBLEM_JQL),
      countJql(INCIDENT_JQL),
    ]);
    return { incidents, problems };
  }

  async function listProblems(options = {}) {
    const page = asPositiveInteger(options.page, 1);
    const pageSize = asPositiveInteger(options.pageSize, 25);
    if (!ALLOWED_PAGE_SIZES.has(pageSize)) {
      throw createSafeError('pageSize must be one of 25, 50, or 100.', 'INVALID_ACC_PROBLEM_PAGE_SIZE');
    }
    const jql = `${PROBLEM_JQL} ORDER BY updated DESC`;
    const [result, counts] = await Promise.all([
      fetchIncidentPage(jql, page, pageSize),
      getDatasetCounts(),
    ]);
    const items = (result.issues || []).map((issue) => normalizeIssue(issue));
    const totalCount = counts.problems;
    return {
      counts,
      currentPage: page,
      filteredCount: totalCount,
      hasNext: !result.isLast && Boolean(result.nextPageToken),
      hasPrevious: page > 1,
      items,
      page,
      pageSize,
      readOnly: true,
      source: 'Jira',
      sourceStatus: 'AVAILABLE',
      total: totalCount,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      updatedAt: new Date(now()).toISOString(),
    };
  }

  async function listIncidents(options = {}) {
    const page = asPositiveInteger(options.page, 1);
    const pageSize = asPositiveInteger(options.pageSize, 25);
    if (!ALLOWED_PAGE_SIZES.has(pageSize)) {
      throw createSafeError('pageSize must be one of 25, 50, or 100.', 'INVALID_ACC_INCIDENT_PAGE_SIZE');
    }

    const jql = buildIncidentJql(options);
    const [result, total, counts] = await Promise.all([
      fetchIncidentPage(jql, page, pageSize),
      countJql(jql),
      getDatasetCounts(),
    ]);
    const items = (result.issues || []).map((issue) => normalizeIssue(issue));

    return {
      counts,
      hasNext: !result.isLast && Boolean(result.nextPageToken),
      hasPrevious: page > 1,
      items,
      page,
      pageSize,
      readOnly: true,
      total,
    };
  }

  async function listExactIncidents(options = {}) {
    const page = asPositiveInteger(options.page, 1);
    const pageSize = asPositiveInteger(options.pageSize, 25);
    if (!ALLOWED_PAGE_SIZES.has(pageSize)) {
      throw createSafeError('pageSize must be one of 25, 50, or 100.', 'INVALID_ACC_INCIDENT_PAGE_SIZE');
    }

    const jql = buildExactIncidentJql(options);
    const [result, total] = await Promise.all([
      fetchIncidentPage(jql, page, pageSize),
      countJql(jql, { useCache: false }),
    ]);
    const items = (result.issues || []).map((issue) => normalizeIssue(issue));
    const updatedAt = new Date(now()).toISOString();
    return {
      counts: { incidents: total },
      filteredCount: total,
      hasNext: !result.isLast && Boolean(result.nextPageToken),
      hasPrevious: page > 1,
      items,
      page,
      currentPage: page,
      pageSize,
      readOnly: true,
      source: 'Jira',
      sourceStatus: 'AVAILABLE',
      total,
      totalCount: total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      updatedAt,
    };
  }

  async function getIncidentSummary(options = {}) {
    const queriedAt = new Date(now());
    const selectedRange = resolveDailyRange(options, queriedAt);
    const todayStart = parseIstDate(istDateKey(queriedAt));
    const weekStart = startOfIstWeek(queriedAt);
    const monthStart = startOfIstMonth(queriedAt);
    const earliestNeeded = new Date(Math.min(
      selectedRange.fromDate.getTime(), weekStart.getTime(), monthStart.getTime(), todayStart.getTime(),
    ));
    // Jira date-only JQL is interpreted in the Jira account timezone. Querying
    // from one extra calendar day and applying the exact Asia/Kolkata boundary
    // locally prevents boundary records from being omitted.
    const broadCreatedFrom = istDateKey(addUtcDays(earliestNeeded, -1));
    const recentJql = `${EXACT_INCIDENT_JQL} AND created >= "${broadCreatedFrom}" ORDER BY created ASC`;
    const [incidentsCreatedToDate, recentResult] = await Promise.all([
      countJql(`${EXACT_INCIDENT_JQL} ORDER BY created ASC`, { useCache: false }),
      fetchAllExactIncidents(recentJql),
    ]);
    const recent = recentResult.issues
      .filter((issue) => issue.fields?.issuetype?.name === '[System] Incident')
      .map((issue) => ({
        createdAt: issue.fields?.created || null,
        date: istDateKey(issue.fields?.created),
        key: issue.key,
        updatedAt: issue.fields?.updated || null,
      }))
      .filter((issue) => issue.date);
    const inWindow = (issue, start, end = queriedAt) => {
      const timestamp = new Date(issue.createdAt || '').getTime();
      return Number.isFinite(timestamp) && timestamp >= start.getTime() && timestamp <= end.getTime();
    };
    const incidentsCreatedToday = recent.filter((issue) => inWindow(issue, todayStart, queriedAt)).length;
    const incidentsCreatedThisWeek = recent.filter((issue) => inWindow(issue, weekStart, queriedAt)).length;
    const incidentsCreatedThisMonth = recent.filter((issue) => inWindow(issue, monthStart, queriedAt)).length;
    const dailyByDate = new Map();
    recent.forEach((issue) => {
      if (inWindow(issue, selectedRange.fromDate, selectedRange.toDate)) {
        dailyByDate.set(issue.date, (dailyByDate.get(issue.date) || 0) + 1);
      }
    });
    const dailyCreatedCounts = [];
    for (let index = 0; index < selectedRange.days; index += 1) {
      const date = istDateKey(addUtcDays(selectedRange.fromDate, index));
      dailyCreatedCounts.push({ date, count: dailyByDate.get(date) || 0 });
    }
    const latestIssueUpdatedAt = recent
      .map((issue) => new Date(issue.updatedAt || issue.createdAt || '').getTime())
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0];
    const updatedAt = queriedAt.toISOString();

    return {
      createdToday: incidentsCreatedToday,
      createdToDate: incidentsCreatedToDate,
      incidentsCreatedToday,
      incidentsCreatedToDate,
      incidentsCreatedThisWeek,
      incidentsCreatedThisMonth,
      dailyCounts: dailyCreatedCounts,
      dailyCreatedCounts,
      filteredCount: dailyCreatedCounts.reduce((total, item) => total + item.count, 0),
      issueType: '[System] Incident',
      jiraLatestIssueUpdatedAt: Number.isFinite(latestIssueUpdatedAt) ? new Date(latestIssueUpdatedAt).toISOString() : null,
      pagesChecked: recentResult.pageCount,
      project: ACC_PROJECT_KEY,
      range: { from: selectedRange.from, name: selectedRange.range, to: selectedRange.to },
      source: 'Jira',
      sourceStatus: 'AVAILABLE',
      timezone: 'Asia/Kolkata',
      updatedAt,
    };
  }

  async function listEvidenceCandidates(options = {}) {
    const requestedLimit = Math.max(2, Math.min(25, asPositiveInteger(options.limit, 25)));
    const perCategoryLimit = Math.ceil(requestedLimit / 2);
    const from = options.from && !Number.isNaN(new Date(options.from).getTime()) ? new Date(options.from).toISOString().slice(0, 10) : null;
    const to = options.to && !Number.isNaN(new Date(options.to).getTime()) ? new Date(options.to).toISOString().slice(0, 10) : null;
    const activityWindow = from && to
      ? ` AND ((created >= "${from}" AND created <= "${to}") OR (updated >= "${from}" AND updated <= "${to}") OR (resolved >= "${from}" AND resolved <= "${to}"))`
      : '';
    const [incidents, problems] = await Promise.all([
      search(`${INCIDENT_JQL}${activityWindow} ORDER BY updated DESC`, { fields: LIST_FIELDS, maxResults: perCategoryLimit, expand: 'changelog' }),
      search(`${PROBLEM_JQL}${activityWindow} ORDER BY updated DESC`, { fields: LIST_FIELDS, maxResults: perCategoryLimit, expand: 'changelog' }),
    ]);
    const items = [...(incidents.issues || []), ...(problems.issues || [])]
      .map((issue) => normalizeIssue(issue))
      .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0))
      .slice(0, requestedLimit);
    return {
      bounded: true,
      items,
      limit: requestedLimit,
      readOnly: true,
      relationshipPolicy: 'exact references confirm; entity plus time remains a candidate',
      typesInspected: ['Incidents', 'Problems'],
    };
  }

  function validateIssueKey(key) {
    const normalized = String(key || '').trim().toUpperCase();
    if (!/^ACC-\d+$/.test(normalized)) {
      throw createSafeError('A valid ACC issue key is required.', 'INVALID_ACC_ISSUE_KEY');
    }
    return normalized;
  }

  async function findIssue(key) {
    const issueKey = validateIssueKey(key);
    const result = await search(`project = ACC AND key = "${issueKey}"`, {
      fields: DETAIL_FIELDS,
      maxResults: 1,
    });
    const issue = result.issues?.[0];
    if (!issue) throw createSafeError(`ACC issue ${issueKey} was not found.`, 'ACC_ISSUE_NOT_FOUND', 404);
    return issue;
  }

  async function fetchComments(key) {
    const issueKey = validateIssueKey(key);
    const comments = [];
    let startAt = 0;
    let total = 0;

    do {
      const response = await client.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        query: { maxResults: 100, orderBy: 'created', startAt },
        timeoutMs: 30000,
      });
      const body = response.body || {};
      comments.push(...(body.comments || []));
      total = Number(body.total || comments.length);
      startAt += Number(body.maxResults || 100);
    } while (startAt < total);

    return comments;
  }

  async function fetchChangelog(key) {
    const issueKey = validateIssueKey(key);
    const histories = [];
    let startAt = 0;
    let total = 0;

    do {
      const response = await client.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`, {
        query: { maxResults: 100, startAt },
        timeoutMs: 30000,
      });
      const body = response.body || {};
      histories.push(...(body.values || []));
      total = Number(body.total || histories.length);
      startAt += Number(body.maxResults || 100);
    } while (startAt < total);

    return histories;
  }

  async function getIssueDetail(key) {
    const issueKey = validateIssueKey(key);
    const [issue, comments, changelog] = await Promise.all([
      findIssue(issueKey),
      fetchComments(issueKey),
      fetchChangelog(issueKey),
    ]);
    return {
      ...normalizeIssue(issue, { changelog, comments, includeDetail: true }),
      alertCorrelation: getDirectAlertReferences([
        issue.fields?.description,
        issue.fields?.summary,
        ...comments.map((comment) => comment.body),
      ]).length > 0 ? 'direct' : 'none',
      readOnly: true,
    };
  }

  async function getIssueComments(key) {
    const comments = await fetchComments(key);
    return {
      items: comments.map(normalizeComment),
      readOnly: true,
      total: comments.length,
    };
  }

  async function getIssueChangelog(key) {
    const histories = await fetchChangelog(key);
    return {
      items: histories.map(normalizedHistory),
      readOnly: true,
      total: histories.length,
    };
  }

  return {
    getIncidentSummary,
    getDatasetCounts,
    getIssueChangelog,
    getIssueComments,
    getIssueDetail,
    listEvidenceCandidates,
    listAllExactIncidentsForSync,
    listExactIncidents,
    listIncidents,
    listProblems,
  };
}

const service = createAccJiraReadService();

module.exports = {
  EXACT_INCIDENT_JQL,
  INCIDENT_JQL,
  PROBLEM_JQL,
  buildIncidentJql,
  buildExactIncidentJql,
  createAccJiraReadService,
  deriveResolverFromChangelog,
  findHowResolved,
  getDirectAlertReferences,
  normalizeIssue,
  resolveDailyRange,
  ...service,
};

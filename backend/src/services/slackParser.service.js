function cleanText(value) {
  return decodeHtmlEntities(value)
    .replace(/[*_`~]/g, '')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function normalizeUrlCandidate(value) {
  const decoded = decodeHtmlEntities(value)
    .replace(/^["'(<]+/, '')
    .replace(/[>"')\]]+$/, '')
    .replace(/\|[^/]*$/, '')
    .replace(/[.,;]+$/, '');
  const entitySplit = decoded.split(/(?:&quot;|&#34;|&gt;|<|>|\\|"|'|\s)/i)[0];

  return entitySplit
    .replace(/[>"')\]]+$/, '')
    .replace(/\|[^/]*$/, '')
    .replace(/[.,;]+$/, '');
}

const extractionWarningCounts = new Map();

function logExtractionWarning(reason, details = {}) {
  const count = extractionWarningCounts.get(reason) || 0;

  extractionWarningCounts.set(reason, count + 1);

  if (count < 25) {
    console.warn(reason, details);
  }
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeToolName(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized || normalized === 'unknown' || normalized === 'unknown-monitoring-tool') {
    return 'unknown';
  }

  if (normalized.includes('thousand') && normalized.includes('eyes')) return 'ThousandEyes';
  if (normalized.includes('thousandeyes')) return 'ThousandEyes';
  if (normalized.includes('splunk') && normalized.includes('appdynamics')) return 'Splunk AppDynamics';
  if (normalized.includes('appdynamics') || normalized.includes('app dynamics') || normalized.includes('appd')) return 'AppDynamics';
  if (normalized.includes('grafana')) return 'Grafana';
  if (normalized.includes('nagios')) return 'Nagios';
  if (normalized.includes('splunk')) return 'Splunk';
  if (normalized.includes('payment') && normalized.includes('gateway')) return 'Payment Gateway';
  if (normalized.includes('apex')) return 'Apex Dashboard';
  if (normalized.includes('abc hub') || normalized.includes('abchub')) return 'ABC Hub';
  if (normalized.includes('prometheus')) return 'Prometheus';
  if (normalized.includes('datadog')) return 'Datadog';
  if (normalized.includes('new relic') || normalized.includes('newrelic')) return 'New Relic';

  return value;
}

function collectTextFragments(value, fragments = []) {
  if (!value) {
    return fragments;
  }

  if (typeof value === 'string') {
    fragments.push(value);
    return fragments;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectTextFragments(item, fragments));
    return fragments;
  }

  if (typeof value === 'object') {
    [
      'text',
      'title',
      'fallback',
      'pretext',
      'footer',
      'value',
      'alt_text',
    ].forEach((key) => {
      if (value[key]) {
        collectTextFragments(value[key], fragments);
      }
    });

    if (value.fields) {
      collectTextFragments(value.fields, fragments);
    }

    if (value.elements) {
      collectTextFragments(value.elements, fragments);
    }

    if (value.blocks) {
      collectTextFragments(value.blocks, fragments);
    }
  }

  return fragments;
}

function getFullMessageText(event) {
  return uniqueValues([
    event.text,
    ...collectTextFragments(event.attachments || []),
    ...collectTextFragments(event.blocks || []),
  ])
    .map(cleanText)
    .filter(Boolean)
    .join('\n');
}

function getRawMessageText(event) {
  return uniqueValues([
    event.text,
    ...collectTextFragments(event.attachments || []),
    ...collectTextFragments(event.blocks || []),
  ])
    .filter(Boolean)
    .join('\n');
}

function collectUrlValues(value, urls = []) {
  if (!value) {
    return urls;
  }

  if (typeof value === 'string') {
    const decoded = decodeHtmlEntities(value);

    urls.push(...[...decoded.matchAll(/<((?:https?:\/\/)[^|>]+)(?:\|[^>]+)?>/gi)].map((match) => match[1]));
    urls.push(...[...decoded.matchAll(/\bhref=["']((?:https?:\/\/)[^"']+)["']/gi)].map((match) => match[1]));
    urls.push(...(decoded.match(/https?:\/\/[^\s)>,|"']+/gi) || []));
    return urls;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectUrlValues(item, urls));
    return urls;
  }

  if (typeof value === 'object') {
    [
      'url',
      'href',
      'action_id',
      'value',
      'text',
      'title',
      'fallback',
      'pretext',
      'footer',
      'alt_text',
    ].forEach((key) => {
      if (value[key]) {
        collectUrlValues(value[key], urls);
      }
    });

    if (value.fields) collectUrlValues(value.fields, urls);
    if (value.elements) collectUrlValues(value.elements, urls);
    if (value.blocks) collectUrlValues(value.blocks, urls);
    if (value.accessory) collectUrlValues(value.accessory, urls);
  }

  return urls;
}

function extractUrlsFromSlackPayload(payload = {}) {
  const event = payload.event || payload.message || payload;
  const prioritySources = [
    event.blocks,
    event.attachments,
    event.text,
    payload.blocks,
    payload.attachments,
    payload.text,
    payload.message,
  ];
  const urls = prioritySources.flatMap((source) => collectUrlValues(source, []));

  return uniqueValues(urls.map(normalizeUrlCandidate));
}

function getUrlCandidates(text, event = {}) {
  return extractUrlsFromSlackPayload({
    text,
    blocks: event.blocks,
    attachments: event.attachments,
  });
}

function extractJiraKey(text) {
  return decodeHtmlEntities(text).match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] || null;
}

function getJiraKeys(text) {
  return uniqueValues(decodeHtmlEntities(text).match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || []);
}

function getAlertIds(text) {
  return uniqueValues([
    ...(String(text || '').match(/#\d{3,}/g) || []),
    ...(String(text || '').match(/\b(?:ALRT|GRAFANA|NAGIOS|APPD|TE|SPLUNK)-[A-Z0-9-]+\b/gi) || []),
  ]).slice(0, 20);
}

function parseSeverity(text) {
  const normalized = text.toLowerCase();

  if (/\bcritical\b|\bcrit\b|\bsev[ -]?1\b/.test(normalized)) return 'critical';
  if (/\bhigh\b|\bsev[ -]?2\b/.test(normalized)) return 'high';
  if (/\bmedium\b|\bmed\b|\bsev[ -]?3\b/.test(normalized)) return 'medium';
  if (/\bwarning\b|\bwarn\b/.test(normalized)) return 'warning';
  if (/\blow\b|\bsev[ -]?4\b/.test(normalized)) return 'low';

  return 'medium';
}

function parseEnvironment(text) {
  const normalized = text.toLowerCase();

  if (/\bprod\b|\bproduction\b/.test(normalized)) return 'production';
  if (/\bstage\b|\bstaging\b/.test(normalized)) return 'staging';
  if (/\bdev\b|\bdevelopment\b/.test(normalized)) return 'development';

  return 'unknown';
}

function parseService(text) {
  const match = text.match(/\b(?:service|application|app|entity|host)\s*[:=]\s*([a-zA-Z0-9._/-]+)/i);
  return match?.[1] || 'unknown-service';
}

function parseSourceTool(text) {
  const normalized = text.toLowerCase();

  if (/\bgrafana\b/.test(normalized)) return 'Grafana';
  if (/\bthousand\s*eyes\b|\bthousandeyes\b/.test(normalized)) return 'ThousandEyes';
  if (/\bsplunk\s+appdynamics\b/.test(normalized)) return 'Splunk AppDynamics';
  if (/\bappdynamics\b|\bapp\s*dynamics\b|\bappd\b/.test(normalized)) return 'AppDynamics';
  if (/\bnagios\b/.test(normalized)) return 'Nagios';
  if (/\bsplunk\b/.test(normalized)) return 'Splunk';
  if (/\bpayment\s+gateway\b/.test(normalized)) return 'Payment Gateway';
  if (/\bapex\b/.test(normalized)) return 'Apex Dashboard';
  if (/\babc\s*hub\b|\babchub\b/.test(normalized)) return 'ABC Hub';
  if (/\bprometheus\b/.test(normalized)) return 'Prometheus';
  if (/\bdatadog\b/.test(normalized)) return 'Datadog';
  if (/\bnew\s*relic\b|\bnewrelic\b/.test(normalized)) return 'New Relic';

  return 'unknown-monitoring-tool';
}

function isJiraUrl(url) {
  return /\/browse\/[A-Z][A-Z0-9]+-\d+|\/jira\/.*[A-Z][A-Z0-9]+-\d+|atlassian\.net\/.*[A-Z][A-Z0-9]+-\d+/i.test(String(url || ''));
}

function isSlackUrl(url) {
  return /slack\.com\/archives|slack\.com\/app_redirect|slack-edge\.com/i.test(String(url || ''));
}

function detectMonitoringTool(payload = {}, urls = [], text = '') {
  const searchable = [
    text,
    getFullMessageText(payload.event || payload.message || payload),
    ...urls,
  ].filter(Boolean).join(' ');
  const tool = normalizeToolName(parseSourceTool(searchable));

  return tool === 'unknown-monitoring-tool' ? 'unknown' : tool;
}

function getPreferredMonitoringUrl(urls = [], fallback = null) {
  const monitoringUrls = urls.filter((url) => !isJiraUrl(url) && !isSlackUrl(url));
  const preferred = monitoringUrls.find((url) => (
    /grafana|thousandeyes|appd|appdynamics|nagios|splunk|apex|payment|monitor|alert|event|controller|health/i.test(url)
  ));

  return preferred || monitoringUrls[0] || fallback || null;
}

function parseDeepEventLink(text, event) {
  const urls = getUrlCandidates(text, event);
  return getPreferredMonitoringUrl(urls);
}

function buildSlackPermalink(event, rawPayload) {
  const workspaceUrl = rawPayload?.workspaceUrl || rawPayload?.slackWorkspaceUrl;

  if (!workspaceUrl || !event.channel || !event.ts) {
    return null;
  }

  return `${String(workspaceUrl).replace(/\/+$/, '')}/archives/${event.channel}/p${String(event.ts).replace('.', '')}`;
}

function slackTimestampToIso(timestamp) {
  if (!timestamp) {
    return null;
  }

  const seconds = Number(String(timestamp).split('.')[0]);

  if (!Number.isFinite(seconds)) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function normalizeSlackPersonName(value) {
  const cleaned = cleanText(value)
    .replace(/^mailto:/i, '')
    .replace(/^@+/, '')
    .replace(/\s+in\s+https?:\/\/.*$/i, '')
    .replace(/\s+in\s+[a-z0-9.-]+$/i, '')
    .replace(/\s+at\s+https?:\/\/.*$/i, '')
    .replace(/[<>]/g, '')
    .trim();

  if (!cleaned || /^(none|n\/a|not assigned|unassigned|unknown)$/i.test(cleaned)) {
    return null;
  }

  return cleaned;
}

function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{4,}$/i.test(String(value || '').trim());
}

function buildResponderKey(responder = {}) {
  return String(
    responder.slackUserId
    || responder.slack_user_id
    || responder.id
    || responder.displayName
    || responder.name
    || ''
  ).trim().toLowerCase();
}

function extractSlackMentions(text = '') {
  const decoded = decodeHtmlEntities(text);
  const mentions = [];

  for (const match of decoded.matchAll(/<@([A-Z0-9]+)(?:\|([^>]+))?>/gi)) {
    const slackUserId = match[1];
    const displayName = normalizeSlackPersonName(match[2]) || null;

    mentions.push({
      id: slackUserId,
      slackUserId,
      name: displayName || slackUserId,
      displayName: displayName || null,
      source: 'slack_mention',
    });
  }

  const cleaned = cleanText(decoded);

  for (const match of cleaned.matchAll(/(^|\s)@([a-zA-Z0-9._-]{2,80})/g)) {
    const name = normalizeSlackPersonName(match[2]);

    if (!name || /^(channel|here|everyone)$/i.test(name)) {
      continue;
    }

    mentions.push({
      id: name,
      slackUserId: isSlackUserId(name) ? name : null,
      name,
      displayName: isSlackUserId(name) ? null : name,
      source: 'slack_text_mention',
    });
  }

  const seen = new Set();

  return mentions.filter((mention) => {
    const key = buildResponderKey(mention);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function parseLabeledValue(lines, labels = []) {
  const labelPattern = labels.join('|');
  const stopPattern = /^(status|description|tags?|priority|severity|alert|type|source|integration|controller url|eventid|event id|rule name|rule id|added by|show more|show less)$/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inlineMatch = line.match(new RegExp(`^(?:${labelPattern})\\s*[:=-]\\s*(.+)$`, 'i'));

    if (inlineMatch?.[1]) {
      return inlineMatch[1];
    }

    if (new RegExp(`^(?:${labelPattern})$`, 'i').test(line)) {
      for (let valueIndex = index + 1; valueIndex < lines.length; valueIndex += 1) {
        const candidate = lines[valueIndex];

        if (!candidate) {
          continue;
        }

        if (stopPattern.test(candidate)) {
          break;
        }

        return candidate;
      }
    }
  }

  return null;
}

function parseSlackAssignee(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const value = parseLabeledValue(lines, [
    'assignee',
    'assigned to',
    'owner',
    'responder',
    'responders',
  ]);

  return normalizeSlackPersonName(value);
}

function parseSlackAcknowledgement(text, event = {}) {
  const rawLines = String(text || '')
    .split(/\r?\n/)
    .filter(Boolean);
  const cleanedText = cleanText(text || '');
  const lines = cleanedText
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const statusLine = parseLabeledValue(lines, ['status']);
  const statusFromNextLine = statusLine
    ? String(statusLine).toLowerCase()
    : null;
  const inlineStatus = cleanedText.match(/\bstatus\s*[:=-]\s*(acknowledged|unacknowledged|not acknowledged|open|triggered|firing|resolved|closed)\b/i)?.[1];
  const actionLine = lines.find((line) => /\backnowledged the alert\b/i.test(line));
  const rawActionLine = rawLines.find((line) => /\backnowledged the alert\b/i.test(cleanText(line)));
  const actorMention = rawActionLine?.match(/<@([A-Z0-9]+)(?:\|([^>]+))?>/i);
  const actionActor = actionLine
    ? actionLine.split(/\backnowledged the alert\b/i)[0]
    : null;
  const acknowledgedBySlackUserId = actorMention?.[1] || (
    isSlackUserId(normalizeSlackPersonName(actionActor)) ? normalizeSlackPersonName(actionActor) : null
  );
  const acknowledgedByDisplayName = normalizeSlackPersonName(actorMention?.[2])
    || normalizeSlackPersonName(actionActor);
  const acknowledged = (
    statusFromNextLine === 'acknowledged'
    || String(inlineStatus || '').toLowerCase() === 'acknowledged'
    || Boolean(actionLine)
  );
  const unacknowledged = (
    statusFromNextLine === 'unacknowledged'
    || statusFromNextLine === 'not acknowledged'
    || /^(unacknowledged|not acknowledged)$/i.test(inlineStatus || '')
  );
  const acknowledgedAt = acknowledged
    ? slackTimestampToIso(event.edited?.ts || event.updated?.ts || event.ts)
    : null;

  return {
    status: acknowledged ? 'acknowledged' : unacknowledged ? 'unacknowledged' : null,
    acknowledged,
    acknowledged_by: acknowledgedByDisplayName,
    acknowledged_by_slack_user_id: acknowledgedBySlackUserId,
    acknowledged_at: acknowledgedAt,
    source: 'slack_message',
  };
}

function splitResponderNames(value) {
  return String(value || '')
    .split(/[,;]|\band\b/i)
    .map((item) => normalizeSlackPersonName(item))
    .filter(Boolean);
}

function parseSlackResponders(rawText, cleanedText, slackAssignee, slackAcknowledgement = {}) {
  const mentions = extractSlackMentions(rawText || cleanedText || '');
  const responders = [];

  function addResponder(responder, role) {
    if (!responder) {
      return;
    }

    const normalized = typeof responder === 'string'
      ? {
          id: responder,
          slackUserId: isSlackUserId(responder) ? responder : null,
          name: responder,
          displayName: isSlackUserId(responder) ? null : responder,
        }
      : responder;
    const key = buildResponderKey(normalized);

    if (!key) {
      return;
    }

    const existingIndex = responders.findIndex((item) => buildResponderKey(item) === key);
    const nextResponder = {
      ...normalized,
      role: normalized.role || role || 'responder',
      source: normalized.source || 'slack_message',
    };

    if (existingIndex >= 0) {
      responders[existingIndex] = {
        ...responders[existingIndex],
        ...nextResponder,
        role: responders[existingIndex].role === nextResponder.role
          ? responders[existingIndex].role
          : uniqueValues([responders[existingIndex].role, nextResponder.role]).join(', '),
      };
      return;
    }

    responders.push(nextResponder);
  }

  mentions.forEach((mention) => addResponder(mention, 'mentioned'));

  splitResponderNames(slackAssignee).forEach((name) => addResponder(name, 'assignee'));

  if (slackAcknowledgement?.acknowledged_by || slackAcknowledgement?.acknowledged_by_slack_user_id) {
    const mention = mentions.find((item) => (
      item.slackUserId
      && item.slackUserId === slackAcknowledgement.acknowledged_by_slack_user_id
    ));

    addResponder({
      id: slackAcknowledgement.acknowledged_by_slack_user_id || slackAcknowledgement.acknowledged_by,
      slackUserId: slackAcknowledgement.acknowledged_by_slack_user_id || (
        isSlackUserId(slackAcknowledgement.acknowledged_by) ? slackAcknowledgement.acknowledged_by : null
      ),
      name: mention?.name || slackAcknowledgement.acknowledged_by,
      displayName: mention?.displayName || (
        isSlackUserId(slackAcknowledgement.acknowledged_by) ? null : slackAcknowledgement.acknowledged_by
      ),
      acknowledgedAt: slackAcknowledgement.acknowledged_at || null,
      source: 'slack_acknowledgement',
    }, 'acknowledger');
  }

  return responders;
}

function parseStatus(text) {
  const normalized = text.toLowerCase();

  if (/\bresolved\b/.test(normalized)) return 'resolved';
  if (/\brecovered\b|\brecovery\b/.test(normalized)) return 'recovered';
  if (/\bfiring\b/.test(normalized)) return 'firing';
  if (/\btriggered\b|\btrigger\b/.test(normalized)) return 'triggered';

  return 'triggered';
}

function parseAlertName(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const titleLine = lines.find((line) => /alert\s*[:=]/i.test(line));
  const titleMatch = titleLine?.match(/alert\s*[:=]\s*(.+)$/i);

  return cleanText(titleMatch?.[1] || lines[0] || 'Slack alert');
}

function buildAlertEnrichment(payload = {}) {
  const event = payload.event || payload.message || payload;
  const fullText = getFullMessageText(event);
  const rawText = getRawMessageText(event);
  const alertMessage = cleanText(fullText || event.text || payload.text || '');
  const urls = extractUrlsFromSlackPayload(payload);
  const jiraKey = extractJiraKey([alertMessage, ...urls].join(' '));
  const jiraUrl = urls.find((url) => (
    isJiraUrl(url) && (!jiraKey || String(url).toUpperCase().includes(jiraKey))
  )) || null;
  const monitoringTool = detectMonitoringTool(payload, urls, alertMessage);
  const slackPermalink = event.permalink || buildSlackPermalink(event, payload);
  const monitoringEventUrl = getPreferredMonitoringUrl(urls, slackPermalink);
  const slackAcknowledgement = parseSlackAcknowledgement(rawText || fullText || event.text || payload.text || '', event);
  const slackAssignee = parseSlackAssignee(fullText || event.text || payload.text || '');
  const slackResponders = parseSlackResponders(rawText, alertMessage, slackAssignee, slackAcknowledgement);

  if (monitoringTool === 'unknown') {
    logExtractionWarning('Slack parser could not detect monitoring tool', {
      slackChannelId: event.channel || payload.channel || null,
      slackMessageTs: event.ts || null,
      urls: urls.slice(0, 5),
    });
  }

  if (!monitoringEventUrl && urls.length > 0) {
    logExtractionWarning('Slack parser could not identify monitoring event URL', {
      slackChannelId: event.channel || payload.channel || null,
      slackMessageTs: event.ts || null,
      urls: urls.slice(0, 5),
    });
  }

  return {
    alert_id: null,
    source_tool: monitoringTool,
    alert_message: alertMessage,
    monitoring_tool: monitoringTool,
    monitoring_event_url: monitoringEventUrl,
    jira_key: jiraKey,
    jira_url: jiraUrl,
    jira_summary: null,
    jira_status: null,
    slack_permalink: slackPermalink,
    slack_assignee: slackAssignee,
    slack_responders: slackResponders,
    slack_acknowledgement: slackAcknowledgement,
    raw_payload: payload,
    urls,
  };
}

function parseSlackAlertMessage(event, rawPayload) {
  const fullText = getFullMessageText(event);
  const rawText = getRawMessageText(event);
  const text = cleanText(fullText || event.text);
  const enrichment = buildAlertEnrichment({
    ...rawPayload,
    event,
    text: event.text,
    blocks: event.blocks,
    attachments: event.attachments,
  });
  const urls = enrichment.urls?.length ? enrichment.urls : getUrlCandidates(fullText, event);
  const jiraKeys = getJiraKeys(fullText);
  const relatedAlerts = getAlertIds(fullText);
  const deepEventLink = enrichment.monitoring_event_url || parseDeepEventLink(fullText, event);
  const slackPermalink = event.permalink || buildSlackPermalink(event, rawPayload);
  const slackAcknowledgement = enrichment.slack_acknowledgement || parseSlackAcknowledgement(rawText || fullText || event.text || '', event);
  const slackAssignee = enrichment.slack_assignee || parseSlackAssignee(fullText || event.text || '');
  const slackResponders = enrichment.slack_responders?.length
    ? enrichment.slack_responders
    : parseSlackResponders(rawText, text, slackAssignee, slackAcknowledgement);
  const sourceTool = enrichment.monitoring_tool === 'unknown'
    ? parseSourceTool(text)
    : enrichment.monitoring_tool;

  return {
    alertName: parseAlertName(fullText || event.text || ''),
    severity: parseSeverity(text),
    service: parseService(text),
    environment: parseEnvironment(text),
    status: parseStatus(text),
    source: normalizeToolName(sourceTool),
    deliveryChannel: 'slack',
    slackChannelId: event.channel,
    slackMessageTs: event.ts,
    slackThreadTs: event.thread_ts || null,
    slackPermalink,
    slackAssignee,
    slackResponders,
    slackAcknowledgement,
    jiraKeys,
    jiraIssueKey: enrichment.jira_key || jiraKeys[0] || null,
    jiraUrl: enrichment.jira_url,
    relatedAlerts,
    eventLink: slackPermalink,
    deepEventLink,
    urls,
    enrichment,
    messageText: text,
    receivedAt: event.ts ? new Date(Number(String(event.ts).split('.')[0]) * 1000).toISOString() : null,
    user: event.user || null,
    botId: event.bot_id || null,
    rawPayload,
  };
}

module.exports = {
  buildAlertEnrichment,
  detectMonitoringTool,
  extractJiraKey,
  extractUrlsFromSlackPayload,
  parseSlackAcknowledgement,
  parseSlackAlertMessage,
  parseSlackAssignee,
  parseSlackResponders,
};

const crypto = require('crypto');

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function cleanSlackText(value) {
  return decodeEntities(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:b|strong|i|em|p|div|span)[^>]*>/gi, '')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/gi, (_, id, label) => `@${label || id}`)
    .replace(/<([^>]+)>/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function cleanStructuredValue(value) {
  return cleanSlackText(value)
    .replace(/\s+:[a-z0-9_+.-]+:\s*$/i, '')
    .trim();
}

function cleanLiteralValue(value) {
  return decodeEntities(value).trim();
}

function collectTextFragments(value, fragments = []) {
  if (!value) return fragments;
  if (typeof value === 'string') {
    fragments.push(value);
    return fragments;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextFragments(item, fragments));
    return fragments;
  }
  if (typeof value !== 'object') return fragments;

  ['text', 'title', 'fallback', 'pretext', 'footer', 'value', 'alt_text'].forEach((key) => {
    if (value[key]) collectTextFragments(value[key], fragments);
  });
  ['fields', 'elements', 'blocks', 'accessory'].forEach((key) => {
    if (value[key]) collectTextFragments(value[key], fragments);
  });
  return fragments;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCompleteMessageText(message = {}) {
  return unique([
    message.text,
    ...collectTextFragments(message.attachments || []),
    ...collectTextFragments(message.blocks || []),
  ])
    .map((fragment) => String(fragment).trim())
    .filter(Boolean)
    .join('\n');
}

function extractAlertNumber(value) {
  const text = typeof value === 'string' ? value : getCompleteMessageText(value);
  return text.match(/\bAlert\s*(?:number|no\.?\s*)?#\s*(\d{3,})\b/i)?.[1] || null;
}

function isOperationalAlertMessage(message = {}) {
  return Boolean(extractAlertNumber(message));
}

function getStructuredField(message = {}, labels = []) {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const attachmentFields = (message.attachments || []).flatMap((attachment) => attachment.fields || []);
  const matchedField = attachmentFields.find((field) => {
    const title = cleanSlackText(field.title || '').replace(/:$/, '').toLowerCase();
    return normalizedLabels.includes(title);
  });
  if (matchedField?.value) return cleanStructuredValue(matchedField.value);

  const rawText = getCompleteMessageText(message).replace(/[\u200e\u200f]/g, ' ');
  const knownSections = 'Status|Responders?|Owner|Assignee|Assigned to|Tags?|Description|Priority|Service|Application|App|Team|Environment|Env|Tier|Host|State|Type|Violation Count|Rule Name|Rule ID|Event ID|Event Time|Additional Info|Date/Time|Notification Type';
  for (const label of labels) {
    const boldSection = rawText.match(new RegExp(
      `\\*${escapeRegExp(label)}\\*\\s*:?[ \\t]*([\\s\\S]*?)(?=\\s+(?:(?::[a-z0-9_+.-]+:)[ \\t]*)?\\*(?:${knownSections})\\*|$)`,
      'i',
    ));
    if (boldSection?.[1]) return cleanStructuredValue(boldSection[1]);
  }

  const completeText = cleanSlackText(rawText);
  for (const label of labels) {
    const match = completeText.match(new RegExp(`(?:^|\\n)${label}\\s*[:=-]\\s*([^\\n]+)`, 'i'));
    if (match?.[1]) return cleanStructuredValue(match[1]);

    const inlineMatch = completeText.match(new RegExp(
      `\\b${escapeRegExp(label)}\\s*[:=-]\\s*([\\s\\S]*?)(?=\\s+(?:${knownSections}|Event Message|Runbook)\\s*[:=-]|$)`,
      'i',
    ));
    if (inlineMatch?.[1]) return cleanStructuredValue(inlineMatch[1]);
  }
  return null;
}

function extractSourceSystem(text) {
  const value = cleanSlackText(text);
  if (/\[\s*(?:grafana)(?:\s*\||\s*\])/i.test(value) || /\bgrafana\b/i.test(value)) return 'Grafana';
  if (/\[\s*(?:appd|appdynamics)(?:\s*\||\s*\])/i.test(value) || /\bapp\s*dynamics\b|\bappd\b/i.test(value)) return 'AppDynamics';
  if (/\[\s*nagios(?:\s*\||\s*\])/i.test(value) || /\bnagios\b/i.test(value)) return 'Nagios';
  if (/\bthousand\s*eyes\b|\bthousandeyes\b/i.test(value)) return 'ThousandEyes';
  if (/\bjira service management\b|\bjsm\b|\batlassian operations\b/i.test(value)) return 'Jira/JSM';
  if (/\bslack\b/i.test(value)) return 'Slack';
  return 'Unknown';
}

function extractTitle(text, alertNumber) {
  const cleaned = cleanSlackText(text);
  const inline = cleaned.match(new RegExp(`\\bAlert\\s*(?:number|no\\.?\\s*)?#\\s*${alertNumber}\\s*:?\\s*([^\\n]+)`, 'i'))?.[1];
  const rawTitle = inline || (() => {
    const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const alertLineIndex = lines.findIndex((line) => new RegExp(`\\bAlert\\s*#\\s*${alertNumber}\\b`, 'i').test(line));
    return lines[alertLineIndex + 1] || lines[alertLineIndex] || null;
  })();

  if (!rawTitle) return null;

  return cleanSlackText(rawTitle)
    .replace(/\s+System added a note[\s\S]*$/i, '')
    .replace(/^\s*\[(?:Grafana(?:\s*\|[^\]]+)?|AppD(?:ynamics)?|Nagios|ThousandEyes)\]\s*:?\s*/i, '')
    .replace(/\s*\[(?:critical|high|medium|warning|warn|low|info)\]\s*$/i, '')
    .replace(/\s+is\s+(?:critical|high|medium|warning|warn|low)\.?\s*$/i, '')
    .replace(/\s+AppD(?:ynamics)?\s*-\s*/i, ' — ')
    .replace(/^\s*:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSeverity(text) {
  const value = cleanSlackText(text);
  if (/\bcritical\b|\bsev[ -]?1\b/i.test(value)) return 'Critical';
  if (/\bhigh\b|\bsev[ -]?2\b/i.test(value)) return 'High';
  if (/\bmedium\b|\bsev[ -]?3\b|\bwarning\b|\bwarn\b/i.test(value)) return 'Medium';
  if (/\blow\b|\bsev[ -]?4\b|\binfo(?:rmational)?\b/i.test(value)) return 'Low';
  return null;
}

function extractPriority(message, text) {
  const field = getStructuredField(message, ['priority']);
  const match = String(field || text || '').match(/\bP([1-5])\b/i);
  return match ? `P${match[1]}` : null;
}

function extractStatus(message, text) {
  const field = getStructuredField(message, ['status']);
  const value = cleanSlackText(field || text || '');
  if (/\bunacknowledged\b|\bnot acknowledged\b/i.test(value)) return 'Unacknowledged';
  if (/\backnowledged\b/i.test(value)) return 'Acknowledged';
  if (/\bclosed\b/i.test(value)) return 'Closed';
  if (/\bresolved\b|\brecovered\b/i.test(value)) return 'Resolved';
  if (/\bfiring\b/i.test(value)) return 'Firing';
  if (/\btriggered\b/i.test(value)) return 'Triggered';
  if (/\bopen\b/i.test(field || '')) return 'Open';
  const statusPageState = value.match(/Statuspage incident status\s*\[[^\]]+\]\s*has changed as\s*\[([^\]]+)\]/i)?.[1];
  if (statusPageState) {
    return statusPageState.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return null;
}

function extractTags(message = {}) {
  const rawText = getCompleteMessageText(message).replace(/[\u200e\u200f]/g, ' ');
  const rawTagSection = rawText.match(
    /\*Tags?\*\s*:?[ \t]*([\s\S]*?)(?=[ \t]+(?:(?::[a-z0-9_+.-]+:)[ \t]*)?\*(?:Status|Responders?|Description|Priority|Service|Application|Team|Environment|Tier)\*|$)/i,
  )?.[1];
  const quotedTags = rawTagSection
    ? [...rawTagSection.matchAll(/`([^`]+)`/g)].map((match) => cleanLiteralValue(match[1]))
    : [];
  if (quotedTags.length) return unique(quotedTags).slice(0, 30);

  const value = getStructuredField(message, ['tag', 'tags']);
  if (!value) return [];
  return unique(value
    .replace(/\s+P[1-5]\s*$/i, '')
    .split(/[,;\n]|\s{2,}/)
    .map((tag) => cleanSlackText(tag))
    .filter(Boolean))
    .slice(0, 30);
}

function extractTagValue(message = {}, key) {
  const rawText = getCompleteMessageText(message);
  const match = rawText.match(new RegExp('`' + escapeRegExp(key) + ':([^`]+)`', 'i'));
  return match?.[1] ? cleanLiteralValue(match[1]) : null;
}

function toTagMap(tags = []) {
  return tags.reduce((map, tag) => {
    const separator = String(tag).indexOf(':');
    if (separator <= 0) return map;
    const key = tag.slice(0, separator).trim().toLowerCase();
    const value = tag.slice(separator + 1).trim();
    if (key && value && !map[key]) map[key] = value;
    return map;
  }, {});
}

function extractLabeledUrl(message = {}, label) {
  const rawText = decodeEntities(getCompleteMessageText(message));
  const match = rawText.match(new RegExp(`${escapeRegExp(label)}\\s*:\\s*<?(https?:\\/\\/[^|>\\s]+)(?:\\|[^>]+)?>?`, 'i'));
  return match?.[1] || null;
}

function cleanDescription(value) {
  return cleanSlackText(value)
    .replace(/[\u200e\u200f]/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDescription(message, sourceSystem) {
  const rawText = decodeEntities(getCompleteMessageText(message));
  const statusPageChange = rawText.match(/Statuspage incident message\s*\[([\s\S]*?)\]\s*has changed as\s*\[([\s\S]*?)\]/i);
  if (statusPageChange) return cleanDescription(statusPageChange[2] || statusPageChange[1]);

  const structured = getStructuredField(message, ['description']);
  if (!structured) return null;

  let description = cleanDescription(structured)
    .replace(/^Tier\s*:\s*\S+\s+Event Message\s*:\s*/i, '')
    .replace(/\s+Runbook\s*:[\s\S]*$/i, '')
    .replace(/\s+Service\s*:\s*\S+(?:\s+Team\s*:\s*\S+)?(?:\s+Environment\s*:\s*\S+)?\s*$/i, '')
    .trim();

  if (sourceSystem === 'Nagios') {
    const additionalInfo = description.match(/Additional Info\s*:\s*([\s\S]*?)(?=\s+Date\/Time\s*:|$)/i)?.[1];
    if (additionalInfo) description = cleanDescription(additionalInfo);
  }

  if (sourceSystem === 'AppDynamics') {
    description = description
      .replace(/\s+Severity\s*:\s*\S+(?:\s+Event Time\s*:[\s\S]*)?$/i, '')
      .trim();
  }

  return description || null;
}

function extractSourceDetails(message, sourceSystem, tags, description, links, runbook) {
  const tagMap = toTagMap(tags);
  const sourceDetails = {
    dashboard: extractLabeledUrl(message, 'dashboard'),
    eventId: extractTagValue(message, 'event_id') || getStructuredField(message, ['event id']),
    eventTime: getStructuredField(message, ['event time', 'date/time']),
    host: extractTagValue(message, 'host') || getStructuredField(message, ['host']),
    notificationType: getStructuredField(message, ['notification type']),
    ruleId: extractTagValue(message, 'rule_id') || getStructuredField(message, ['rule id']),
    ruleName: extractTagValue(message, 'rule_name') || getStructuredField(message, ['rule name']),
    state: extractTagValue(message, 'state') || getStructuredField(message, ['state']),
    type: extractTagValue(message, 'type') || getStructuredField(message, ['type']),
    violationCount: extractTagValue(message, 'violation_count') || getStructuredField(message, ['violation count']),
  };

  if (sourceSystem === 'AppDynamics') sourceDetails.eventMessage = description;
  if (sourceSystem === 'Grafana') sourceDetails.folder = tagMap.grafana_folder || null;
  sourceDetails.sourceUrl = links.find((link) => (
    link !== runbook
    && /j\.opsg\.in|appdynamics|grafana|nagios|thousandeyes/i.test(link)
  )) || null;

  return Object.fromEntries(Object.entries(sourceDetails).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function extractService(message, title, sourceSystem) {
  const labeled = extractTagValue(message, 'service') || getStructuredField(message, ['service', 'entity', 'host']);
  if (labeled) return labeled;
  if (sourceSystem === 'AppDynamics') {
    const cleanedTitle = cleanSlackText(title);
    return cleanedTitle.match(/^([a-zA-Z0-9._/-]+)\s+—\s+/)?.[1]
      || cleanedTitle.match(/^\[?AppD(?:ynamics)?\]?\s+([a-zA-Z0-9._/-]+)\s+AppD\b/i)?.[1]
      || null;
  }
  return null;
}

function parseTimestamp(timestamp) {
  const seconds = Number.parseFloat(timestamp);
  return Number.isFinite(seconds) ? new Date(Math.floor(seconds * 1000)).toISOString() : null;
}

function extractLinks(message = {}) {
  const links = new Set();
  const rawText = getCompleteMessageText(message);
  for (const match of rawText.matchAll(/<(https?:\/\/[^>|]+)(?:\|[^>]+)?>/gi)) links.add(match[1]);
  for (const match of rawText.replace(/<https?:\/\/[^>]+>/gi, '').matchAll(/https?:\/\/[^\s<>]+/gi)) {
    links.add(match[0].replace(/[),.;]+$/, ''));
  }
  (message.files || []).forEach((file) => {
    if (file.permalink) links.add(file.permalink);
  });
  return [...links];
}

function buildSlackPermalink(workspaceUrl, channelId, timestamp) {
  if (!workspaceUrl || !channelId || !timestamp) return null;
  return `${String(workspaceUrl).replace(/\/+$/, '')}/archives/${channelId}/p${String(timestamp).replace('.', '')}`;
}

function normalizeSlackRecord(message, context = {}) {
  const channelId = context.channel?.id || context.channelId || message.channel || null;
  const channelName = context.channel?.name || context.channelName || null;
  const messageTs = message.ts || null;
  const completeText = getCompleteMessageText(message);
  const authorName = message.bot_profile?.name || message.username || message.user || null;
  const permalink = message.permalink || buildSlackPermalink(context.workspaceUrl, channelId, messageTs);
  const replyCount = Number(message.reply_count || 0);

  return {
    slackChannelId: channelId,
    slackChannelName: channelName,
    messageTs,
    threadTs: message.thread_ts || (replyCount > 0 ? messageTs : null),
    parentMessageTs: message.thread_ts && message.thread_ts !== messageTs ? message.thread_ts : null,
    messageType: message.thread_ts && message.thread_ts !== messageTs ? 'reply' : replyCount > 0 ? 'parent' : 'message',
    authorId: message.user || message.bot_id || null,
    authorName,
    text: message.text || '',
    completeText,
    messageAt: parseTimestamp(messageTs),
    replyCount,
    reactions: Array.isArray(message.reactions) ? message.reactions : [],
    links: extractLinks(message),
    permalink,
    rawPayload: message,
  };
}

function normalizeSlackAlert(message, context = {}) {
  const rawRecord = normalizeSlackRecord(message, context);
  const alertNumber = extractAlertNumber(rawRecord.completeText);
  if (!alertNumber) return null;

  const title = extractTitle(rawRecord.completeText, alertNumber);
  const sourceSystem = extractSourceSystem(`${title || ''}\n${rawRecord.completeText}`);
  const tags = extractTags(message);
  const responder = getStructuredField(message, ['responders', 'responder', 'owner', 'assignee', 'assigned to']);
  const tier = getStructuredField(message, ['tier']);
  const environment = extractTagValue(message, 'environment') || getStructuredField(message, ['environment', 'env']);
  const application = extractTagValue(message, 'application') || getStructuredField(message, ['application', 'app']);
  const team = extractTagValue(message, 'team') || getStructuredField(message, ['team']);
  const runbook = extractLabeledUrl(message, 'runbook');
  const description = extractDescription(message, sourceSystem);
  const service = extractService(message, title, sourceSystem);
  const sourceDetails = extractSourceDetails(message, sourceSystem, tags, description, rawRecord.links, runbook);
  const sourceMessageTs = rawRecord.messageTs;
  const stableHash = crypto.createHash('sha1').update(`${rawRecord.slackChannelId}:${alertNumber}`).digest('hex').slice(0, 10);

  return {
    alertId: `SLACK-ALERT-${alertNumber}-${stableHash}`,
    sourceMessageTs,
    slackChannelId: rawRecord.slackChannelId,
    slackChannelName: rawRecord.slackChannelName,
    alertNumber,
    title,
    sourceSystem,
    severity: extractSeverity(`${title || ''}\n${rawRecord.completeText}`),
    priority: extractPriority(message, rawRecord.completeText),
    service,
    application,
    environment,
    tier,
    team,
    responder,
    status: extractStatus(message, rawRecord.completeText),
    tags,
    description,
    runbook,
    sourceDetails,
    firstSeen: rawRecord.messageAt,
    lastSeen: rawRecord.messageAt,
    occurrenceCount: 1,
    source: 'slack',
    slackPermalink: rawRecord.permalink,
    threadTs: rawRecord.threadTs,
    replyCount: rawRecord.replyCount,
    authorId: rawRecord.authorId,
    authorName: rawRecord.authorName,
    links: rawRecord.links,
    rawMessage: rawRecord.completeText,
    rawPayload: message,
  };
}

module.exports = {
  buildSlackPermalink,
  cleanSlackText,
  extractAlertNumber,
  extractSourceSystem,
  getCompleteMessageText,
  isOperationalAlertMessage,
  normalizeSlackAlert,
  normalizeSlackRecord,
};

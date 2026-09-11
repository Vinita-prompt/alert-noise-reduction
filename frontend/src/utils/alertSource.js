const deliveryLabels = new Map([
  ['slack', 'Slack'],
  ['jira', 'Jira'],
  ['jira issue', 'Jira'],
  ['jira service management', 'Jira Service Management'],
  ['jsm operations', 'JSM Operations'],
  ['jira operations', 'JSM Operations'],
  ['operations alerts', 'JSM Operations'],
]);

const monitoringLabels = new Map([
  ['grafana', 'Grafana'],
  ['thousandeyes', 'ThousandEyes'],
  ['thousand eyes', 'ThousandEyes'],
  ['appdynamics', 'Splunk AppDynamics'],
  ['splunk appdynamics', 'Splunk AppDynamics'],
  ['app dynamics', 'Splunk AppDynamics'],
  ['nagios', 'Nagios'],
  ['splunk', 'Splunk'],
  ['payment gateway', 'Payment Gateway'],
  ['apex dashboard', 'Apex Dashboard'],
  ['apex', 'Apex Dashboard'],
  ['abc hub', 'ABC Hub'],
  ['abchub', 'ABC Hub'],
  ['prometheus', 'Prometheus'],
  ['datadog', 'Datadog'],
  ['new relic', 'New Relic'],
]);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function prettyLabel(value) {
  return String(value || '')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isDeliverySource(value) {
  return deliveryLabels.has(normalize(value));
}

function normalizeMonitoringLabel(value) {
  const normalized = normalize(value);

  if (!normalized || isDeliverySource(normalized)) {
    return null;
  }

  return monitoringLabels.get(normalized) || prettyLabel(value);
}

function inferMonitoringTool(alert = {}) {
  const safeAlert = alert || {};
  const details = safeAlert.extractedDetails || {};
  const text = [
    safeAlert.title,
    safeAlert.service,
    safeAlert.description,
    safeAlert.signal,
    safeAlert.monitoringTool,
    safeAlert.monitoringEventUrl,
    safeAlert.rawPayload?.text,
    details.slack_enrichment?.monitoring_tool,
    details.slack_enrichment?.monitoring_event_url,
    details.alert?.source_tool,
    details.alert?.monitoring_tool,
    details.alert?.monitoring_event_url,
    details.alert?.source,
    details.normalized_alert?.source_tool,
    details.normalized_alert?.source_name,
    details.normalized_alert?.monitoring_tool,
    details.normalized_alert?.monitoring_event_url,
    details.structured_alert?.source,
    details.structured_alert?.integration,
    details.structured_alert?.details?.source,
    details.structured_alert?.details?.integration,
  ].filter(Boolean).join(' ').toLowerCase();

  for (const [key, label] of monitoringLabels.entries()) {
    if (text.includes(key)) {
      return label;
    }
  }

  return null;
}

export function getMonitoringSource(alert = {}) {
  const safeAlert = alert || {};
  const details = safeAlert.extractedDetails || {};
  const candidates = [
    safeAlert.monitoringTool,
    details.slack_enrichment?.monitoring_tool,
    details.normalized_alert?.monitoring_tool,
    details.alert?.monitoring_tool,
    details.alert?.source_tool,
    details.normalized_alert?.source_tool,
    safeAlert.monitoringSystemName,
    safeAlert.sourceName,
    safeAlert.source,
    details.structured_alert?.source,
    details.structured_alert?.details?.source,
  ];

  for (const candidate of candidates) {
    const label = normalizeMonitoringLabel(candidate);

    if (label) {
      return label;
    }
  }

  return inferMonitoringTool(safeAlert) || 'Monitoring Tool';
}

export function getDeliveryChannel(alert = {}) {
  const safeAlert = alert || {};
  const source = normalize(safeAlert.source);
  const sourceName = normalize(safeAlert.sourceName);
  const sourceType = normalize(safeAlert.sourceType);

  if (safeAlert.slackChannelId || source === 'slack' || sourceName === 'slack') {
    return 'Slack';
  }

  if (sourceType === 'jira_operations_alert' || source.includes('operations') || sourceName.includes('operations')) {
    return 'JSM Operations';
  }

  if (safeAlert.jiraIssueKey || source === 'jira' || sourceName === 'jira') {
    return 'Jira';
  }

  return 'Direct API/Webhook';
}

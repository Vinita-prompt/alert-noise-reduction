const crypto = require('crypto');

function hashIdentity(value) {
  return crypto
    .createHash('sha1')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function normalizeIdentityToken(value) {
  return String(value || '')
    .trim()
    .replace(/^#/, '')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getOpsAlertNumber(parsedAlert = {}) {
  const candidates = [
    ...(parsedAlert.relatedAlerts || []),
    parsedAlert.alertName,
    parsedAlert.messageText,
  ];

  for (const candidate of candidates) {
    const match = String(candidate || '').match(/#(\d{3,})\b/);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function getOpsAlertLinkId(url) {
  const value = String(url || '');
  const directMatch = value.match(/\/jira\/ops\/alerts\/([^/?#]+)/i);
  const shortMatch = value.match(/\/a\/abcfinancial\/([^/?#]+)/i);

  return directMatch?.[1] || shortMatch?.[1] || null;
}

function buildStableSlackIdentity({ parsedAlert = {}, sourceUrl = null, jiraIssueKey = null, fallbackId = null } = {}) {
  const opsAlertNumber = getOpsAlertNumber(parsedAlert);
  const urls = [
    sourceUrl,
    parsedAlert.deepEventLink,
    parsedAlert.eventLink,
    ...(parsedAlert.urls || []),
  ].filter(Boolean);
  const opsAlertLinkId = urls.map(getOpsAlertLinkId).find(Boolean);
  const monitoringUrl = urls.find((url) => !/slack\.com|atlassian\.net/i.test(String(url)));
  const fallbackSlackToken = `${parsedAlert.slackChannelId || 'unknown'}:${parsedAlert.slackThreadTs || parsedAlert.slackMessageTs || Date.now()}`;

  if (opsAlertNumber) {
    return {
      id: `SLACK-OPS-${normalizeIdentityToken(opsAlertNumber)}`,
      sourceAlertId: `ops-alert:${opsAlertNumber}`,
      type: 'ops_alert_number',
      value: opsAlertNumber,
      canMatchByJira: false,
    };
  }

  if (opsAlertLinkId) {
    return {
      id: `SLACK-OPSURL-${hashIdentity(opsAlertLinkId)}`,
      sourceAlertId: `ops-alert-link:${opsAlertLinkId}`,
      type: 'ops_alert_link',
      value: opsAlertLinkId,
      canMatchByJira: false,
    };
  }

  if (parsedAlert.slackThreadTs) {
    return {
      id: `SLACK-THREAD-${hashIdentity(`${parsedAlert.slackChannelId}:${parsedAlert.slackThreadTs}`)}`,
      sourceAlertId: `slack-thread:${parsedAlert.slackChannelId}:${parsedAlert.slackThreadTs}`,
      type: 'slack_thread',
      value: `${parsedAlert.slackChannelId}:${parsedAlert.slackThreadTs}`,
      canMatchByJira: false,
    };
  }

  if (monitoringUrl) {
    return {
      id: `SLACK-MON-${hashIdentity(monitoringUrl)}`,
      sourceAlertId: `monitoring-url:${hashIdentity(monitoringUrl)}`,
      type: 'monitoring_url',
      value: monitoringUrl,
      canMatchByJira: false,
    };
  }

  if (jiraIssueKey) {
    return {
      id: `SLACK-JIRA-${normalizeIdentityToken(jiraIssueKey)}`,
      sourceAlertId: `jira-incident:${jiraIssueKey}`,
      type: 'jira_incident',
      value: jiraIssueKey,
      canMatchByJira: true,
    };
  }

  return {
    id: fallbackId || `SLACK-${hashIdentity(fallbackSlackToken)}`,
    sourceAlertId: `slack-message:${fallbackSlackToken}`,
    type: 'slack_message',
    value: fallbackSlackToken,
    canMatchByJira: false,
  };
}

module.exports = {
  buildStableSlackIdentity,
  getOpsAlertLinkId,
  getOpsAlertNumber,
  hashIdentity,
  normalizeIdentityToken,
};

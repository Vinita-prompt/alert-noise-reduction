function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(cleanText).filter(Boolean))];
}

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE_PATTERN = new RegExp(`(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?,?\\s*${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}(?:,?\\s+starting at\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM)(?:\\s+[A-Za-z]+(?:\\s+Time)?)?)?`, 'i');

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return cleanText(match[0]);
  }
  return null;
}

/**
 * Normalize explicit maintenance communication already linked to a JSM
 * Operations notification. No fuzzy matching is used: identity comes from the
 * exact Operations alert number and its stored JSM/Slack message identities.
 */
function buildMaintenanceNotificationEvidence({ alert = {}, messages = [] } = {}) {
  const notificationId = cleanText(alert.operationsAlertId || alert.occurrenceId);
  const alertNumber = cleanText(alert.alertNumber);
  if (!notificationId || !alertNumber) return null;

  const normalizedMessages = (messages || []).map((message) => ({
    id: cleanText(message.messageTs),
    at: message.messageAt || null,
    author: cleanText(message.author?.name),
    text: cleanText(message.message),
  })).filter((message) => message.id && message.text);
  const title = cleanText(alert.alertName);
  const description = cleanText(alert.message);
  const combined = cleanText([title, description, ...normalizedMessages.map((message) => message.text)].join(' '));

  const plannedMaintenance = /\b(?:scheduled|planned) (?:service |database |network |infrastructure )?maintenance\b|\bwill (?:be )?perform(?:ing)? (?:a )?(?:scheduled )?(?:service |database |network |infrastructure )?maintenance\b|\bmaintenance window\b/i.test(combined);
  const datedMaintenance = DATE_PATTERN.test(combined);
  const cancelled = /\b(?:this |the )?maintenance (?:has been |was |is )?cancel(?:led|ed)\b/i.test(combined);
  const noImpact = /\bno operational impact\b|\bdo not anticipate any service impact\b|\bno (?:customer|service|operational) impact\b/i.test(combined);
  const serviceContinuity = /\b(?:views?|services?) will continue to (?:function|operate|work)|\btraffic will be automatically rerouted\b|\btraffic continue(?:s)? to route\b|\bcatch(?:-| )?up (?:is )?expected\b|\bwill be updated at the end of the maintenance window\b/i.test(combined);
  const limitedExpectedImpact = /\bmay experience (?:an )?impact for a brief amount of time\b|\bbrief (?:service )?impact\b/i.test(combined);

  const explicitInformational = plannedMaintenance && (datedMaintenance || cancelled || noImpact || serviceContinuity || limitedExpectedImpact);
  const explicitNonActionable = explicitInformational && (cancelled || noImpact || serviceContinuity);
  if (!explicitInformational || !explicitNonActionable) return null;

  const maintenanceStart = firstMatch(combined, [DATE_PATTERN]);
  const maintenanceEnd = firstMatch(combined, [
    /\b(?:expect (?:this )?maintenance to last )?no more than \d+\s+(?:minute|minutes|hour|hours)\b/i,
    /\b(?:maintenance )?window (?:ends?|ending)\s+[^.]+/i,
  ]);
  const impactStatement = firstMatch(combined, [
    /\bThis maintenance has been cancelled\./i,
    /\bWe do not anticipate any service impact[^.]*\./i,
    /\bDuring this maintenance, Views will continue to function[^.]*\./i,
    /\btraffic will be automatically rerouted[^.]*\./i,
    /\bUsers may experience an impact for a brief amount of time[^.]*\./i,
  ]);
  const status = cancelled ? 'CANCELLED' : /\bstatus\s*\[SCHEDULED\].*\[COMPLETED\]/i.test(combined)
    ? 'COMPLETED' : 'SCHEDULED';
  const impact = cancelled ? 'CANCELLED'
    : noImpact ? 'NO_OPERATIONAL_IMPACT'
      : serviceContinuity ? 'SERVICE_REMAINS_AVAILABLE'
        : limitedExpectedImpact ? 'LIMITED_EXPECTED_IMPACT' : null;
  const maintenanceMessages = normalizedMessages.filter((message) => (
    /\bmaintenance\b|\bno operational impact\b|\btraffic (?:will be )?(?:automatically )?rerout|\bviews? will continue\b|\bcancel(?:led|ed)\b/i.test(message.text)
  ));
  const detailedMessage = [...maintenanceMessages].sort((left, right) => right.text.length - left.text.length)[0]?.text || null;

  return {
    schemaVersion: 'maintenance-notification-evidence-v1',
    deterministic: true,
    identityValid: true,
    matchMethod: 'EXACT_JSM_ALERT_NUMBER_AND_STORED_NOTIFICATION',
    notificationId,
    alertNumber,
    jsmMessageIdentity: notificationId,
    slackMessageIdentities: unique(maintenanceMessages.map((message) => message.id)),
    episodeId: null,
    title: title || null,
    description: description && description !== title ? description : detailedMessage,
    jsmTimestamp: alert.createdAt || null,
    slackTimestamp: maintenanceMessages[0]?.at || null,
    maintenanceStart,
    maintenanceEnd,
    maintenanceStatus: status,
    explicitImpact: impact,
    impactStatement,
    sourceOwner: maintenanceMessages[0]?.author || null,
    sourceProvenance: unique(['JSM Operations', maintenanceMessages.length ? 'Slack' : null]),
    informational: true,
    nonActionable: true,
    evidenceReason: cancelled
      ? 'Exact JSM/Slack maintenance notification states that the scheduled maintenance was cancelled.'
      : noImpact
        ? 'Exact JSM/Slack maintenance notification explicitly states that no operational impact is expected.'
        : 'Exact JSM/Slack maintenance notification states that service remains available during the planned window.',
  };
}

module.exports = { buildMaintenanceNotificationEvidence };

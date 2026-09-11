const COMMAND_CENTER_TEAM = 'Command Center';

const isCommandCenterAlert = (alert) => (
  String(alert?.responderTeam ?? alert?.responder ?? alert?.team ?? '')
    .trim()
    .toLowerCase() === 'command center'
);

function safeAlias(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(alias || ''))) {
    throw new Error('Invalid SQL alias for Command Center eligibility.');
  }
  return alias;
}

function slackResponderTeamSql(alias = 'slack_normalized_alerts') {
  const table = safeAlias(alias);
  return `LOWER(BTRIM(COALESCE(${table}.responder, ${table}.team, ''))) = 'command center'`;
}

function correlatedSlackFieldSql(alertAlias, field) {
  const alert = safeAlias(alertAlias);
  const column = safeAlias(field);
  return `(SELECT slack.${column}
    FROM slack_normalized_alerts slack
    WHERE slack.alert_number = ${alert}.atlassian_ops_tiny_id
    ORDER BY slack.last_seen DESC NULLS LAST
    LIMIT 1)`;
}

function localAlertEligibilityFieldsSql(alias = 'alert') {
  const alert = safeAlias(alias);
  return {
    responderTeam: `COALESCE(
      ${alert}.extracted_details->'normalized_alert'->>'responderTeam',
      ${alert}.extracted_details->'normalized_alert'->>'responder_team',
      ${alert}.raw_payload->>'responderTeam',
      ${alert}.raw_payload->>'responder_team'
    )`,
    responder: `COALESCE(
      ${alert}.extracted_details->'normalized_alert'->>'responder',
      ${alert}.raw_payload->>'responder'
    )`,
    team: `COALESCE(
      ${alert}.extracted_details->'normalized_alert'->>'team',
      ${alert}.extracted_details->'normalized_alert'->>'assigned_team',
      ${alert}.raw_payload->>'team'
    )`,
  };
}

function alertEligibilityFieldsSql(alias = 'alert') {
  const alert = safeAlias(alias);
  const local = localAlertEligibilityFieldsSql(alert);
  return {
    responderTeam: local.responderTeam,
    responder: `COALESCE(${local.responder}, ${correlatedSlackFieldSql(alert, 'responder')})`,
    team: `COALESCE(${local.team}, ${correlatedSlackFieldSql(alert, 'team')})`,
  };
}

function commandCenterAlertSql(alias = 'alert') {
  const alert = safeAlias(alias);
  const fields = localAlertEligibilityFieldsSql(alert);
  return `(LOWER(BTRIM(COALESCE(
    ${fields.responderTeam},
    ${fields.responder},
    ${fields.team},
    ''
  ))) = 'command center'
  OR (
    ${fields.responderTeam} IS NULL
    AND ${fields.responder} IS NULL
    AND ${fields.team} IS NULL
    AND ${alert}.atlassian_ops_tiny_id IN (
      SELECT slack.alert_number FROM slack_normalized_alerts slack
      WHERE ${slackResponderTeamSql('slack')}
    )
  ))`;
}

function commandCenterAlertProjectionSql(alias = 'alert') {
  const fields = alertEligibilityFieldsSql(alias);
  return `${fields.responderTeam} AS visibility_responder_team,
    ${fields.responder} AS visibility_responder,
    ${fields.team} AS visibility_team`;
}

function asCommandCenterAlert(alert) {
  if (!isCommandCenterAlert(alert)) return alert;
  return {
    ...alert,
    responderTeam: COMMAND_CENTER_TEAM,
    responder: COMMAND_CENTER_TEAM,
    team: COMMAND_CENTER_TEAM,
  };
}

module.exports = {
  COMMAND_CENTER_TEAM,
  alertEligibilityFieldsSql,
  asCommandCenterAlert,
  commandCenterAlertProjectionSql,
  commandCenterAlertSql,
  isCommandCenterAlert,
  localAlertEligibilityFieldsSql,
  slackResponderTeamSql,
};

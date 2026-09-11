const db = require('../config/db');
const integrationService = require('./integration.service');
const jiraService = require('./jira.service');
const appDynamicsService = require('./appDynamics.service');
const accJiraReadService = require('./atlassian/accJiraRead.service');

const SERVICE_KEYS = [
  'backend',
  'database',
  'slack',
  'jira',
  'grafana',
  'appDynamics',
  'nagios',
];

const DEFAULT_INTEGRATION_HEALTH = {
  slack: 'not_configured',
  grafana: 'not_configured',
  appDynamics: 'not_configured',
  jira: 'not_configured',
  nagios: 'not_configured',
};

function envStatus(requiredNames) {
  const configured = requiredNames.map((name) => Boolean(process.env[name]?.trim()));

  if (!configured.some(Boolean)) {
    return 'not_configured';
  }

  return configured.every(Boolean) ? 'connected' : 'disconnected';
}

function normalizeIntegrationStatus(status) {
  if (['connected', 'disconnected', 'checking', 'not_configured'].includes(status)) {
    return status;
  }

  return 'disconnected';
}

async function checkDatabase() {
  try {
    await db.query('SELECT 1');
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

async function checkMonitoringIntegrations(databaseStatus) {
  if (databaseStatus !== 'connected') {
      return {
        slack: 'disconnected',
        grafana: 'disconnected',
        appDynamics: 'disconnected',
        jira: 'disconnected',
        nagios: 'disconnected',
    };
  }

  try {
    const [statusesResult, jiraStatusResult, appDynamicsResult, liveJiraResult] = await Promise.allSettled([
      integrationService.getIntegrationHealthStatuses(),
      jiraService.getStatus(),
      appDynamicsService.getSafeConfigPreview(),
      accJiraReadService.getIncidentSummary({ range: 'today' }),
    ]);
    const statuses = statusesResult.status === 'fulfilled' ? statusesResult.value : {};
    const jiraStatus = jiraStatusResult.status === 'fulfilled' ? jiraStatusResult.value : null;
    const appDynamics = appDynamicsResult.status === 'fulfilled' ? appDynamicsResult.value : null;
    const liveJiraAvailable = liveJiraResult.status === 'fulfilled'
      && String(liveJiraResult.value?.sourceStatus || '').toUpperCase() === 'AVAILABLE';
    const storedSlackStatus = normalizeIntegrationStatus(statuses.slack);
    const slackEnvValues = [
      process.env.SLACK_BOT_USER_OAUTH_TOKEN || process.env.SLACK_BOT_TOKEN,
      process.env.SLACK_SIGNING_SECRET,
      process.env.SLACK_CHANNEL_ID || process.env.SLACK_ALERT_CHANNEL_ID,
    ].map((value) => Boolean(value?.trim()));
    const slackEnvStatus = slackEnvValues.every(Boolean)
      ? 'connected'
      : slackEnvValues.some(Boolean)
        ? 'disconnected'
        : 'not_configured';

    return {
      slack: storedSlackStatus !== 'not_configured' ? storedSlackStatus : slackEnvStatus,
      grafana: normalizeIntegrationStatus(statuses.grafana),
      appDynamics: appDynamics?.configured
        ? normalizeIntegrationStatus(
          appDynamics.authenticated || appDynamics.controllerReachable === true || appDynamics.lastSuccessfulRead
            ? 'connected'
            : 'disconnected',
        )
        : normalizeIntegrationStatus(statuses['splunk-appdynamics']),
      jira: liveJiraAvailable
        ? 'connected'
        : jiraStatus?.configured
          ? normalizeIntegrationStatus(jiraStatus.reachable ? 'connected' : 'disconnected')
        : normalizeIntegrationStatus(statuses.jira),
      nagios: normalizeIntegrationStatus(statuses['nagios-dc01']) === 'connected'
        && normalizeIntegrationStatus(statuses['nagios-dc02']) === 'connected'
        ? 'connected'
        : [statuses['nagios-dc01'], statuses['nagios-dc02']].some((value) => value && value !== 'not_configured')
          ? 'disconnected' : 'not_configured',
    };
  } catch (error) {
    if (error.code === '42P01') {
      return DEFAULT_INTEGRATION_HEALTH;
    }

    return {
      slack: 'disconnected',
      grafana: 'disconnected',
      appDynamics: 'disconnected',
      jira: 'disconnected',
      nagios: 'disconnected',
    };
  }
}

function getOverallStatus(services) {
  if (services.backend === 'disconnected' || services.database === 'disconnected') {
    return 'Critical';
  }

  if (Object.values(services).includes('disconnected')) {
    return 'Warning';
  }

  return 'Healthy';
}

async function getSystemHealth() {
  const databaseStatus = await checkDatabase();
  const monitoringIntegrations = await checkMonitoringIntegrations(databaseStatus);
  const services = {
    backend: 'connected',
    database: databaseStatus,
    ...monitoringIntegrations,
  };
  const lastChecked = new Date().toISOString();
  const connectedServices = SERVICE_KEYS.filter((key) => services[key] === 'connected').length;

  return {
    overallStatus: getOverallStatus(services),
    lastChecked,
    services,
    connectedServices,
    totalServices: SERVICE_KEYS.length,
    status: 'ok',
    database: databaseStatus,
    checkedAt: lastChecked,
  };
}

module.exports = {
  getSystemHealth,
};

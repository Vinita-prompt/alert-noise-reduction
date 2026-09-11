const abcHubService = require('../services/abcHub.service');
const atlassianOpsService = require('../services/atlassian/opsIngestion.service');
const appDynamicsService = require('../services/appDynamics.service');
const grafanaDashboardService = require('../services/grafanaDashboard.service');
const integrationService = require('../services/integration.service');
const jiraService = require('../services/jira.service');
const liveAlertStreamService = require('../services/liveAlertStream.service');
const monitoringIngestionService = require('../services/monitoringIngestion.service');
const nagiosService = require('../services/nagios.service');
const oracleApexService = require('../services/oracleApex.service');
const paymentGatewayService = require('../services/paymentGateway.service');
const slackService = require('../services/slack.service');
const thousandEyesService = require('../services/thousandEyes.service');

const DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH = '/transactions-module/transactions/';

const INTEGRATION_DEFINITIONS = [
  {
    name: 'atlassian',
    label: 'Atlassian',
    requiredFields: ['baseUrl', 'accountIdentifier', 'email', 'opsReadToken'],
    credentialFields: [
      'email',
      'jiraReadToken',
      'opsReadToken',
      'opsWriteToken',
      'jiraWriteToken',
      'jsmReadToken',
      'jsmWriteToken',
    ],
    settingsDefaults: {
      opsPollingEnabled: 'true',
      opsPollIntervalSeconds: 30,
      opsInitialSyncDays: 30,
      operationsWriteEnabled: 'false',
      jiraWriteEnabled: 'false',
      jsmWriteEnabled: 'false',
      liveImportMode: true,
    },
  },
  {
    name: 'abc-hub',
    label: 'ABC Hub',
    requiredFields: ['baseUrl'],
    credentialFields: ['token'],
    settingsDefaults: {
      daemonMonitorPath: '/abcHub/api/v1/daemon-monitors/broken-jobs',
      dataTrakUserMonitoringPath: '/abcHub/api/v1/datatrak-user-monitoring',
      authMethod: 'Bearer token',
      liveImportMode: false,
    },
  },
  {
    name: 'payment-gateway',
    label: 'Payment Gateway',
    requiredFields: ['baseUrl', 'accountIdentifier', 'token'],
    credentialFields: ['token'],
    settingsDefaults: {
      transactionsPath: DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH,
      defaultSyncRange: '24h',
      liveImportMode: true,
    },
  },
  {
    name: 'jira',
    label: 'Jira',
    requiredFields: ['baseUrl', 'accountIdentifier', 'email', 'apiToken'],
    credentialFields: ['email', 'apiToken'],
    settingsDefaults: {
      authMode: 'API token',
      cloudId: '',
      liveImportMode: true,
    },
  },
  {
    name: 'slack',
    label: 'Slack',
    requiredFields: ['accountIdentifier', 'botToken', 'signingSecret'],
    credentialFields: ['botToken', 'signingSecret'],
    settingsDefaults: {
      liveImportMode: true,
    },
  },
  {
    name: 'splunk-appdynamics',
    aliases: ['appdynamics'],
    label: 'AppDynamics',
    requiredFields: ['baseUrl', 'accountIdentifier'],
    credentialFields: ['username', 'password', 'clientId', 'clientSecret'],
    settingsDefaults: {
      authMode: 'username_password',
      applicationsPath: '/controller/rest/applications',
      healthRulesPath: '/controller/alerting/rest/v1/applications/:applicationId/health-rules',
      eventsPath: '/controller/rest/applications/:applicationId/events',
      businessTransactionsPath: '/controller/rest/applications/:applicationName/business-transactions',
      tiersPath: '/controller/rest/applications/:applicationName/tiers',
      nodesPath: '/controller/rest/applications/:applicationName/nodes',
      snapshotsPath: '/controller/rest/applications/:applicationName/request-snapshots',
      metricDataPath: '/controller/rest/applications/:applicationName/metric-data',
      metricPaths: 'Overall Application Performance|Calls per Minute\nOverall Application Performance|Average Response Time (ms)\nOverall Application Performance|Errors per Minute\nOverall Application Performance|Error %\nOverall Application Performance|Exceptions per Minute',
      syncApplicationLimit: 100,
      eventDurationMinutes: 60,
      metricDurationMinutes: 60,
      snapshotDurationMinutes: 60,
      automaticSyncIntervalSeconds: 60,
      liveImportMode: true,
    },
  },
  {
    name: 'nagios-dc01',
    aliases: ['nagios-d01'],
    label: 'Nagios DC01',
    requiredFields: ['baseUrl', 'apiKey'],
    credentialFields: ['apiKey', 'token', 'username', 'password'],
    settingsDefaults: {
      liveImportMode: true,
      syncIntervalSeconds: 60,
    },
  },
  {
    name: 'nagios-dc02',
    aliases: ['nagios-d02'],
    label: 'Nagios DC02',
    requiredFields: ['baseUrl', 'apiKey'],
    credentialFields: ['apiKey', 'token', 'username', 'password'],
    settingsDefaults: {
      liveImportMode: true,
      syncIntervalSeconds: 60,
    },
  },
  {
    name: 'grafana',
    label: 'Grafana',
    requiredFields: ['baseUrl', 'token'],
    credentialFields: ['token'],
    settingsDefaults: {
      liveImportMode: true,
    },
  },
  {
    name: 'thousandeyes',
    label: 'ThousandEyes',
    requiredFields: ['baseUrl', 'accountIdentifier', 'token'],
    credentialFields: ['token'],
    settingsDefaults: {
      liveImportMode: true,
    },
  },
  {
    name: 'oracle-apex',
    aliases: ['apex-dashboard'],
    label: 'Oracle APEX',
    requiredFields: ['baseUrl', 'ajaxPath', 'flowId', 'regionId'],
    credentialFields: ['ajaxIdentifier'],
    settingsDefaults: {
      ajaxPath: '/ords/wwv_flow.ajax',
      flowId: '102',
      pageId: '',
      regionId: '1654121344282841',
      requestName: '',
      dashboardPath: '',
      maxRows: 100,
      liveImportMode: true,
    },
  },
];

const DEFINITION_BY_NAME = new Map();
INTEGRATION_DEFINITIONS.forEach((definition) => {
  DEFINITION_BY_NAME.set(definition.name, definition);
  (definition.aliases || []).forEach((alias) => DEFINITION_BY_NAME.set(alias, definition));
});

function getDefinition(name) {
  const key = String(name || '').trim().toLowerCase();
  const definition = DEFINITION_BY_NAME.get(key);

  if (!definition) {
    const error = new Error(`Unsupported integration: ${name}`);
    error.status = 400;
    throw error;
  }

  return definition;
}

function normalizeEndpointPath(pathValue, fallback) {
  const text = String(pathValue || fallback || '').trim();
  const withoutQuery = text.split('?')[0] || fallback || '';

  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

function splitPaymentGatewayUrl(value, pathValue) {
  const baseUrl = String(value || '').trim();
  const transactionsPath = normalizeEndpointPath(pathValue, DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH);

  if (!baseUrl) {
    return {
      baseUrl,
      transactionsPath: transactionsPath || DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH,
    };
  }

  try {
    const url = new URL(baseUrl);

    if (url.pathname.includes('/transactions-module/transactions')) {
      return {
        baseUrl: url.origin,
        transactionsPath: normalizeEndpointPath(url.pathname, DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH),
      };
    }
  } catch {
    return {
      baseUrl,
      transactionsPath: transactionsPath || DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH,
    };
  }

  return {
    baseUrl,
    transactionsPath: transactionsPath || DEFAULT_PAYMENT_GATEWAY_TRANSACTIONS_PATH,
  };
}

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function settingValue(integration, field) {
  return integration?.settings?.[field];
}

function hasCredential(integration, field) {
  return Boolean(integration?.maskedCredentials?.[field]);
}

function publicValueForField(integration, field) {
  if (!integration) return '';

  if (field === 'accountIdentifier') return integration.accountIdentifier || '';
  if (field === 'baseUrl') return integration.baseUrl || '';
  if (hasCredential(integration, field)) return '********';

  return settingValue(integration, field) || '';
}

function getMissingRequiredFields(definition, integration) {
  if (!integration) {
    return definition.requiredFields || [];
  }

  return (definition.requiredFields || []).filter((field) => {
    if (field === 'baseUrl') return !integration.baseUrl;
    if (field === 'accountIdentifier') return !integration.accountIdentifier;
    if ((definition.credentialFields || []).includes(field)) return !hasCredential(integration, field);

    return isMissing(settingValue(integration, field));
  });
}

function mapConnectionState(definition, integration, settings = {}) {
  if (!integration) {
    return {
      connectionStatus: 'Authentication required',
      mode: 'blocked_by_auth',
    };
  }

  const liveImportMode = settings.liveImportMode;

  if (!integration.isEnabled) {
    return {
      connectionStatus: 'Disabled',
      mode: 'disabled',
    };
  }

  if (liveImportMode === false || liveImportMode === 'false') {
    return {
      connectionStatus: 'Mock mode enabled',
      mode: 'mock',
    };
  }

  if (getMissingRequiredFields(definition, integration).length > 0) {
    return {
      connectionStatus: 'Authentication required',
      mode: 'blocked_by_auth',
    };
  }

  if (integration.status === 'connected') {
    return {
      connectionStatus: 'Connected',
      mode: 'live',
    };
  }

  if (integration.status === 'error') {
    return {
      connectionStatus: 'Connection failed',
      mode: 'connection_failed',
    };
  }

  return {
    connectionStatus: 'Authentication required',
    mode: 'blocked_by_auth',
  };
}

function mapIntegration(definition, integration) {
  const settings = {
    ...definition.settingsDefaults,
    ...(integration?.settings || {}),
  };

  if (definition.name === 'payment-gateway' && integration?.baseUrl) {
    const splitUrl = splitPaymentGatewayUrl(integration.baseUrl, settings.transactionsPath);
    integration = {
      ...integration,
      baseUrl: splitUrl.baseUrl,
    };
    settings.transactionsPath = splitUrl.transactionsPath;
  }

  const connection = mapConnectionState(definition, integration, settings);

  return {
    name: definition.name,
    label: definition.label,
    baseUrl: integration?.baseUrl || '',
    accountIdentifier: integration?.accountIdentifier || '',
    isEnabled: integration?.isEnabled ?? false,
    liveImportMode: settings.liveImportMode ?? false,
    status: integration?.status || 'not_configured',
    connectionStatus: connection.connectionStatus,
    mode: connection.mode,
    hasCredentials: Object.fromEntries(
      (definition.credentialFields || []).map((field) => [field, hasCredential(integration, field)]),
    ),
    values: {
      baseUrl: integration?.baseUrl || '',
      accountIdentifier: integration?.accountIdentifier || '',
      ...settings,
      ...Object.fromEntries(
        (definition.credentialFields || []).map((field) => [
          field,
          hasCredential(integration, field) ? '********' : '',
        ]),
      ),
    },
    missingFields: getMissingRequiredFields(definition, integration),
    lastTestedAt: integration?.lastTestedAt || null,
    updatedAt: integration?.updatedAt || null,
  };
}

async function listSettingsIntegrations() {
  const stored = await integrationService.getIntegrations();
  const storedByName = Object.fromEntries(stored.map((integration) => [integration.toolName, integration]));
  const integrations = INTEGRATION_DEFINITIONS.map((definition) => mapIntegration(definition, storedByName[definition.name]));

  return {
    integrations,
    paymentGateway: integrations.find((integration) => integration.name === 'payment-gateway'),
  };
}

function normalizeInput(definition, input = {}) {
  const body = { ...input };

  if (definition.name === 'payment-gateway') {
    const splitUrl = splitPaymentGatewayUrl(body.baseUrl, body.transactionsPath);
    body.baseUrl = splitUrl.baseUrl;
    body.transactionsPath = splitUrl.transactionsPath;
    body.token = body.bearerToken || body.token;
  }

  const payload = {
    baseUrl: body.baseUrl || '',
    accountIdentifier: body.accountIdentifier || body.tenantId || body.projectKey || body.channelId || '',
    isEnabled: body.isEnabled ?? body.enabled ?? true,
  };

  [...(definition.credentialFields || []), ...Object.keys(definition.settingsDefaults || {})].forEach((field) => {
    if (body[field] !== undefined && body[field] !== '********') {
      payload[field] = body[field];
    }
  });

  return payload;
}

function validateInput(definition, input, currentIntegration) {
  const merged = {
    baseUrl: input.baseUrl,
    accountIdentifier: input.accountIdentifier || input.tenantId || input.projectKey || input.channelId,
    ...input,
  };

  if (definition.name === 'payment-gateway') {
    const splitUrl = splitPaymentGatewayUrl(input.baseUrl, input.transactionsPath);
    merged.baseUrl = splitUrl.baseUrl;
    merged.transactionsPath = splitUrl.transactionsPath;
    merged.token = input.bearerToken || input.token;
  }

  (definition.requiredFields || []).forEach((field) => {
    const storedCredentialExists = (definition.credentialFields || []).includes(field)
      && hasCredential(currentIntegration, field)
      && (merged[field] === undefined || merged[field] === '' || merged[field] === '********');
    const value = field === 'accountIdentifier'
      ? merged.accountIdentifier
      : field === 'baseUrl'
        ? merged.baseUrl
        : merged[field];

    if (isMissing(value) && !storedCredentialExists) {
      const error = new Error(`${definition.label} requires ${field}.`);
      error.status = 400;
      throw error;
    }
  });

  if (merged.baseUrl) {
    try {
      new URL(merged.baseUrl);
    } catch {
      const error = new Error(`${definition.label} Base URL must be a valid URL.`);
      error.status = 400;
      throw error;
    }
  }

  if (merged.transactionsPath && !String(merged.transactionsPath).startsWith('/')) {
    const error = new Error(`${definition.label} endpoint path must start with /.`);
    error.status = 400;
    throw error;
  }
}

async function getIntegrations(request, response, next) {
  try {
    response.json({ data: await listSettingsIntegrations() });
  } catch (error) {
    next(error);
  }
}

async function updateIntegration(request, response, next) {
  try {
    const definition = getDefinition(request.params.name);
    const current = (await integrationService.getIntegrations()).find((integration) => integration.toolName === definition.name);

    validateInput(definition, request.body || {}, current);
    await integrationService.updateIntegration(definition.name, normalizeInput(definition, request.body || {}));

    response.json({
      data: {
        ...(await listSettingsIntegrations()),
        message: `${definition.label} settings saved.`,
      },
    });
  } catch (error) {
    next(error);
  }
}

function isRealTestImplemented(name) {
  return ['payment-gateway', 'slack', 'jira', 'grafana', 'thousandeyes'].includes(name);
}

function nagiosInstanceForDefinition(name) {
  if (name === 'nagios-dc01') return 'd01';
  if (name === 'nagios-dc02') return 'd02';
  return null;
}

async function testIntegration(request, response, next) {
  try {
    const definition = getDefinition(request.params.name);
    let result;

    if (definition.name === 'payment-gateway') {
      result = await paymentGatewayService.testPaymentGatewayConnection();
    } else if (definition.name === 'atlassian') {
      result = await atlassianOpsService.testConnection();
    } else if (definition.name === 'splunk-appdynamics') {
      result = await appDynamicsService.testConnection();
    } else if (definition.name === 'oracle-apex') {
      result = await oracleApexService.testConnectionReadiness();
    } else if (nagiosInstanceForDefinition(definition.name)) {
      result = await nagiosService.testInstanceConnection(nagiosInstanceForDefinition(definition.name));
    } else if (isRealTestImplemented(definition.name)) {
      result = await integrationService.testIntegration(definition.name);
    } else {
      const current = (await integrationService.getIntegrations()).find((integration) => integration.toolName === definition.name);
      const missing = getMissingRequiredFields(definition, current);

      result = {
        ok: false,
        mode: missing.length ? 'blocked_by_auth' : 'connection_failed',
        status: missing.length ? 'authentication_required' : 'connection_failed',
        message: missing.length
          ? `${definition.label} is missing required fields: ${missing.join(', ')}.`
          : `${definition.label} live connection test is not implemented yet. No mock or sample data was used.`,
      };
    }

    if (definition.name === 'atlassian' || nagiosInstanceForDefinition(definition.name)) {
      await integrationService.updateIntegrationStatus(definition.name, result.ok ? 'connected' : 'error');
    }

    response.json({
      data: {
        ...result,
        ...(await listSettingsIntegrations()),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function syncIntegration(request, response, next) {
  try {
    const definition = getDefinition(request.params.name);
    let result;

    if (definition.name === 'payment-gateway') {
      result = await paymentGatewayService.syncPaymentGatewayFromSettings({
        from: request.body?.from,
        to: request.body?.to,
      });
    } else if (definition.name === 'atlassian') {
      result = await atlassianOpsService.syncOpsAlerts({ syncType: 'manual' });
      await integrationService.updateIntegrationStatus(definition.name, 'connected');
    } else if (definition.name === 'slack') {
      result = await slackService.syncNewSlackNotifications({ limit: 100, maxPages: 10 });
    } else if (definition.name === 'jira') {
      result = await jiraService.importJiraIncidents({ incremental: true });
    } else if (definition.name === 'grafana') {
      result = await grafanaDashboardService.syncDashboards();
    } else if (definition.name === 'thousandeyes') {
      result = await thousandEyesService.syncThousandEyesData({ includeMetrics: false });
    } else if (definition.name === 'splunk-appdynamics') {
      result = await appDynamicsService.syncAppDynamicsData();
    } else if (definition.name === 'oracle-apex') {
      result = await oracleApexService.syncFromSettings();
    } else if (nagiosInstanceForDefinition(definition.name)) {
      result = await nagiosService.pollInstance(nagiosInstanceForDefinition(definition.name));
    } else if (definition.name === 'abc-hub') {
      result = await abcHubService.syncAbcHubData();

      if (result.source === 'mock_fallback' || result.warning) {
        const error = new Error(result.warning || result.message || 'ABC Hub live sync failed. No mock fallback is accepted from Settings.');
        error.status = 502;
        throw error;
      }
    } else {
      result = await monitoringIngestionService.ingestTool(definition.name);
    }

    if (definition.name === 'jira') {
      liveAlertStreamService.broadcast('jira-sync', {
        syncRunId: result?.runId || result?.syncRunId || null,
        updatedAt: new Date().toISOString(),
      });
    }

    response.json({
      data: {
        ...result,
        ...(await listSettingsIntegrations()),
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getIntegrations,
  syncIntegration,
  testIntegration,
  updateIntegration,
};

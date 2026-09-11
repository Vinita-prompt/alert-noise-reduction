const crypto = require('crypto');
const db = require('../config/db');

const SUPPORTED_TOOLS = {
  atlassian: {
    label: 'Atlassian',
    credentialFields: [
      'email',
      'jiraReadToken',
      'opsReadToken',
      'opsWriteToken',
      'jiraWriteToken',
      'jsmReadToken',
      'jsmWriteToken',
    ],
    configFields: [
      'opsPollingEnabled',
      'opsPollIntervalSeconds',
      'opsInitialSyncDays',
      'operationsWriteEnabled',
      'jiraWriteEnabled',
      'jsmWriteEnabled',
      'liveImportMode',
    ],
    requiredFields: ['baseUrl', 'accountIdentifier', 'email', 'opsReadToken'],
  },
  slack: {
    label: 'Slack',
    credentialFields: ['botToken', 'signingSecret'],
    configFields: ['liveImportMode'],
    requiredFields: ['accountIdentifier', 'botToken', 'signingSecret'],
  },
  thousandeyes: {
    label: 'ThousandEyes',
    credentialFields: ['token'],
    configFields: ['liveImportMode'],
    requiredFields: ['baseUrl', 'accountIdentifier', 'token'],
  },
  grafana: {
    label: 'Grafana',
    credentialFields: ['token'],
    configFields: ['liveImportMode'],
    requiredFields: ['baseUrl', 'token'],
  },
  nagios: {
    label: 'Nagios',
    credentialFields: ['token'],
    configFields: ['liveImportMode'],
    requiredFields: [],
  },
  'nagios-dc01': {
    label: 'Nagios DC01',
    credentialFields: ['token', 'apiKey', 'username', 'password'],
    configFields: ['liveImportMode', 'syncIntervalSeconds'],
    requiredFields: ['baseUrl', 'apiKey'],
  },
  'nagios-dc02': {
    label: 'Nagios DC02',
    credentialFields: ['token', 'apiKey', 'username', 'password'],
    configFields: ['liveImportMode', 'syncIntervalSeconds'],
    requiredFields: ['baseUrl', 'apiKey'],
  },
  'payment-gateway': {
    label: 'Payment Gateway',
    credentialFields: ['token'],
    configFields: ['transactionsPath', 'defaultSyncRange', 'liveImportMode'],
    requiredFields: ['baseUrl', 'accountIdentifier'],
  },
  'apex-dashboard': {
    label: 'Apex Dashboard',
    credentialFields: ['token', 'apiKey', 'username', 'password'],
    configFields: ['liveImportMode'],
    requiredFields: ['baseUrl'],
  },
  'oracle-apex': {
    label: 'Oracle APEX',
    credentialFields: ['ajaxIdentifier'],
    configFields: ['ajaxPath', 'flowId', 'pageId', 'regionId', 'requestName', 'dashboardPath', 'maxRows', 'liveImportMode'],
    requiredFields: ['baseUrl', 'ajaxPath', 'flowId', 'regionId'],
  },
  'abc-hub': {
    label: 'ABC Hub',
    credentialFields: ['token', 'apiKey', 'username', 'password'],
    configFields: ['daemonMonitorPath', 'dataTrakUserMonitoringPath', 'authMethod', 'liveImportMode'],
    requiredFields: ['baseUrl'],
  },
  jira: {
    label: 'Jira',
    credentialFields: ['email', 'apiToken', 'issueType'],
    configFields: ['authMode', 'cloudId', 'liveImportMode'],
    requiredFields: ['baseUrl', 'accountIdentifier', 'email', 'apiToken'],
  },
  'jsm-operations': {
    label: 'JSM Operations Alerts',
    credentialFields: [],
    requiredFields: [],
  },
  'splunk-appdynamics': {
    label: 'AppDynamics',
    credentialFields: ['username', 'password', 'clientId', 'clientSecret'],
    configFields: [
      'authMode',
      'applicationsPath',
      'healthRulesPath',
      'eventsPath',
      'businessTransactionsPath',
      'tiersPath',
      'nodesPath',
      'snapshotsPath',
      'metricDataPath',
      'metricPaths',
      'syncApplicationLimit',
      'eventDurationMinutes',
      'metricDurationMinutes',
      'snapshotDurationMinutes',
      'automaticSyncIntervalSeconds',
      'liveImportMode',
    ],
    requiredFields: ['baseUrl', 'accountIdentifier'],
  },
};

const TEST_TIMEOUT_MS = 5000;

function assertSupportedTool(toolName) {
  if (!SUPPORTED_TOOLS[toolName]) {
    const error = new Error(`Unsupported integration tool: ${toolName}`);
    error.status = 400;
    throw error;
  }
}

function getEncryptionKey() {
  const secret = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SLACK_SIGNING_SECRET;

  if (!secret) {
    const error = new Error('INTEGRATION_ENCRYPTION_KEY is not configured.');
    error.status = 500;
    throw error;
  }

  return crypto.createHash('sha256').update(secret).digest();
}

function encryptCredentials(credentials) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);

  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decryptCredentials(encryptedCredentials) {
  if (!encryptedCredentials) {
    return {};
  }

  const payload = JSON.parse(encryptedCredentials);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

function normalizeBaseUrl(baseUrl) {
  const normalized = baseUrl?.trim()?.replace(/\/+$/, '');

  if (!normalized) {
    return null;
  }

  return normalized;
}

function buildGrafanaApiUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return null;
  }

  return new URL(path, `${normalizedBaseUrl}/`).toString();
}

function buildJiraApiUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return null;
  }

  return new URL(path, `${normalizedBaseUrl}/`).toString();
}

function buildJsmOperationsApiUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)?.replace(/\/v2$/i, '');

  if (!normalizedBaseUrl) {
    return null;
  }

  return new URL(path, `${normalizedBaseUrl}/`).toString();
}

function buildBasicAuthHeader(email, apiToken) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

function buildThousandEyesApiUrls(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return [];
  }

  try {
    const url = new URL(normalizedBaseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    const hasVersionPath = /\/v\d+$/i.test(path);
    const candidates = hasVersionPath
      ? [new URL('account-groups', `${normalizedBaseUrl}/`).toString()]
      : [
          new URL('v7/account-groups', `${normalizedBaseUrl}/`).toString(),
          new URL('account-groups', `${normalizedBaseUrl}/`).toString(),
        ];

    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function getGrafanaNetworkErrorMessage(error, baseUrl) {
  const code = error.cause?.code || error.code;
  const detail = error.cause?.message || error.message;

  if (error.name === 'AbortError') {
    return 'Grafana connection timed out. Check VPN/network access and confirm the Grafana URL is reachable.';
  }

  if (code === 'ENOTFOUND') {
    return `Grafana host could not be found. Check the URL hostname: ${baseUrl}`;
  }

  if (code === 'ECONNREFUSED') {
    return `Grafana refused the connection. Check the URL and whether Grafana is reachable: ${baseUrl}`;
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'Grafana connection timed out. Check VPN/network access and firewall rules.';
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return 'Grafana SSL certificate could not be verified. This can happen with corporate proxies or internal certificates.';
  }

  if (detail?.includes('Invalid URL')) {
    return 'Grafana URL is invalid. Use the base URL only, for example https://your-org.grafana.net';
  }

  return `Unable to reach Grafana from the backend. Browser access can still work if VPN or proxy rules do not apply to Node.js. ${code ? `Error: ${code}.` : `Detail: ${detail}`}`;
}

function getVendorNetworkErrorMessage(vendorName, error, baseUrl) {
  const code = error.cause?.code || error.code;
  const detail = error.cause?.message || error.message;

  if (error.name === 'AbortError') {
    return `${vendorName} connection timed out. Check VPN/network access and confirm the API URL is reachable.`;
  }

  if (code === 'ENOTFOUND') {
    return `${vendorName} host could not be found. Check the API URL hostname: ${baseUrl}`;
  }

  if (code === 'ECONNREFUSED') {
    return `${vendorName} refused the connection. Check whether the API URL is reachable: ${baseUrl}`;
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `${vendorName} connection timed out. Check VPN/network access and firewall rules.`;
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return `${vendorName} SSL certificate could not be verified. This can happen with corporate proxies or internal certificates.`;
  }

  if (detail?.includes('Invalid URL')) {
    return `${vendorName} API URL is invalid. Use the API base URL only.`;
  }

  return `Unable to reach ${vendorName} from the backend. Browser access can still work if VPN or proxy rules do not apply to Node.js. ${code ? `Error: ${code}.` : `Detail: ${detail}`}`;
}

function isCertificateVerificationError(error) {
  const code = error.cause?.code || error.code;

  return (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  );
}

async function checkGrafanaReachability(baseUrl) {
  const healthUrl = buildGrafanaApiUrl(baseUrl, '/api/health');

  if (!healthUrl) {
    return {
      reachable: false,
      message: 'Grafana URL is missing. Add the Grafana base URL and save again.',
    };
  }

  try {
    const response = await fetchWithTimeout(healthUrl, {
      headers: {
        Accept: 'application/json',
      },
    });

    return {
      reachable: true,
      status: response.status,
    };
  } catch (error) {
    return {
      reachable: false,
      message: getGrafanaNetworkErrorMessage(error, baseUrl),
    };
  }
}

async function testThousandEyesConnection(row, credentials) {
  const baseUrl = normalizeBaseUrl(row.base_url);
  const accountGroupId = row.account_identifier;
  const token = credentials.token;
  const urls = buildThousandEyesApiUrls(baseUrl);

  if (urls.length === 0) {
    return {
      ok: false,
      message: 'ThousandEyes API URL is invalid. Use a base URL like https://api.thousandeyes.com/v7',
    };
  }

  let lastMessage = 'ThousandEyes connection failed. Check the API URL and token.';

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await readResponseText(response);

      if (response.ok) {
        if (accountGroupId && body && !body.includes(String(accountGroupId))) {
          return {
            ok: false,
            message: 'ThousandEyes token works, but the Account Group ID was not found. Check the Account Group ID.',
          };
        }

        return {
          ok: true,
          message: 'ThousandEyes connection successful.',
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          message: 'ThousandEyes rejected the token. Check the bearer/API token permissions.',
        };
      }

      if (response.status !== 404) {
        lastMessage = `ThousandEyes API returned HTTP ${response.status}. Check the API URL, Account Group ID, and token permissions.`;
      }
    } catch (error) {
      return {
        ok: false,
        message: getVendorNetworkErrorMessage('ThousandEyes', error, baseUrl),
      };
    }
  }

  return {
    ok: false,
    message: `${lastMessage} Recommended API Base URL: https://api.thousandeyes.com/v7`,
  };
}

async function testGrafanaConnection(row, credentials) {
  const baseUrl = normalizeBaseUrl(row.base_url);
  const token = credentials.token;
  let apiUrl = null;

  try {
    const reachability = await checkGrafanaReachability(baseUrl);

    if (!reachability.reachable) {
      return {
        ok: false,
        message: reachability.message,
      };
    }

    apiUrl = buildGrafanaApiUrl(baseUrl, '/api/org');

    if (!apiUrl) {
      return {
        ok: false,
        message: 'Grafana URL is missing. Add the Grafana base URL and save again.',
      };
    }

    const response = await fetchWithTimeout(apiUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) {
      return {
        ok: true,
        message: 'Grafana connection successful.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: 'Grafana URL is reachable, but the token was rejected. Use a Grafana service account token with API access.',
      };
    }

    return {
      ok: false,
      message: `Grafana URL is reachable, but /api/org returned HTTP ${response.status}. Check token permissions.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: getGrafanaNetworkErrorMessage(error, baseUrl),
    };
  }
}

async function testSlackConnection(row, credentials) {
  const botToken = credentials.botToken;
  const channelId = row.account_identifier;

  if (!botToken) {
    return {
      ok: false,
      message: 'Slack Bot Token is missing. Save a bot token, then test again.',
    };
  }

  if (!channelId) {
    return {
      ok: false,
      message: 'Slack Alert Channel ID is missing. Add a channel ID like C0123456789.',
    };
  }

  try {
    const response = await fetchWithTimeout('https://slack.com/api/auth.test', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));

    if (response.ok && payload.ok) {
      return {
        ok: true,
        message: `Slack connection successful. Bot ${payload.user || 'token'} is reachable and channel ${channelId} is saved.`,
      };
    }

    return {
      ok: false,
      message: `Slack rejected the bot token${payload.error ? `: ${payload.error}` : ''}. Check the token and Slack app scopes.`,
    };
  } catch (error) {
    if (isCertificateVerificationError(error)) {
      return {
        ok: false,
        certificateBlocked: true,
        message:
          'Slack settings are saved, but the live Slack API test is blocked because Node.js cannot verify the corporate SSL certificate. The token was not rejected. Ask IT for the corporate root certificate and run the backend with NODE_EXTRA_CA_CERTS, or use a local-only TLS bypass only for a demo.',
      };
    }

    return {
      ok: false,
      message: getVendorNetworkErrorMessage('Slack', error, 'https://slack.com/api/auth.test'),
    };
  }
}

async function testJiraConnection(row, credentials) {
  const baseUrl = normalizeBaseUrl(row.base_url);
  const projectKey = row.account_identifier?.trim();
  const email = credentials.email;
  const apiToken = credentials.apiToken;
  const apiUrl = projectKey
    ? buildJiraApiUrl(baseUrl, `/rest/api/3/project/${encodeURIComponent(projectKey)}`)
    : null;

  if (!apiUrl) {
    return {
      ok: false,
      message: 'Jira URL or project key is missing. Add the Jira site URL and project key, then save again.',
    };
  }

  try {
    const response = await fetchWithTimeout(apiUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: buildBasicAuthHeader(email, apiToken),
      },
    });

    if (response.ok) {
      return {
        ok: true,
        message: `Jira connection successful. Project ${projectKey} is reachable.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: 'Jira rejected the email/API token or the account does not have project access.',
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        message: `Jira is reachable, but project ${projectKey} was not found. Check the project key.`,
      };
    }

    return {
      ok: false,
      message: `Jira is reachable, but the project check returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: getVendorNetworkErrorMessage('Jira', error, baseUrl),
    };
  }
}

async function getJiraConfigForJsmOperations() {
  const envBaseUrl = normalizeBaseUrl(process.env.JIRA_BASE_URL);
  const envEmail = process.env.JIRA_EMAIL?.trim();
  const envApiToken = process.env.JIRA_API_TOKEN?.trim();
  const envProjectKey = process.env.JIRA_PROJECT_KEY?.trim() || 'ACC';

  if (envBaseUrl || envEmail || envApiToken) {
    return {
      baseUrl: envBaseUrl,
      projectKey: envProjectKey,
      credentials: {
        email: envEmail,
        apiToken: envApiToken,
      },
      missing: [
        ['JIRA_BASE_URL', envBaseUrl],
        ['JIRA_EMAIL', envEmail],
        ['JIRA_API_TOKEN', envApiToken],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name),
    };
  }

  const jiraConfig = await getIntegrationRuntimeConfig('jira');

  return {
    baseUrl: normalizeBaseUrl(jiraConfig.baseUrl),
    projectKey: jiraConfig.accountIdentifier,
    credentials: {
      email: jiraConfig.credentials.email,
      apiToken: jiraConfig.credentials.apiToken,
    },
    missing: [],
  };
}

function getSlackConfigFromEnv(env = process.env) {
  // Keep the signed Events API and history-polling paths on one canonical
  // configuration. The preferred names take precedence; the legacy aliases
  // remain supported for existing installations.
  const botToken = (env.SLACK_BOT_USER_OAUTH_TOKEN || env.SLACK_BOT_TOKEN || '').trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  const alertChannelId = (env.SLACK_CHANNEL_ID || env.SLACK_ALERT_CHANNEL_ID || '').trim();

  if (!botToken && !signingSecret && !alertChannelId) {
    return null;
  }

  const missing = [
    ['SLACK_BOT_USER_OAUTH_TOKEN', botToken],
    ['SLACK_SIGNING_SECRET', signingSecret],
    ['SLACK_CHANNEL_ID', alertChannelId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    const error = new Error(`Slack environment configuration is missing: ${missing.join(', ')}`);
    error.status = 400;
    throw error;
  }

  return {
    botToken,
    signingSecret,
    alertChannelId,
    source: 'env',
  };
}

async function getSlackRuntimeConfig() {
  const envConfig = getSlackConfigFromEnv();

  if (envConfig) {
    return envConfig;
  }

  const integrationConfig = await getIntegrationRuntimeConfig('slack');

  return {
    botToken: integrationConfig.credentials.botToken,
    signingSecret: integrationConfig.credentials.signingSecret,
    alertChannelId: integrationConfig.accountIdentifier,
    workspaceUrl: integrationConfig.baseUrl,
    source: 'integration',
  };
}

function mapVirtualJsmOperationsIntegration(testResult) {
  return {
    id: null,
    toolName: 'jsm-operations',
    label: SUPPORTED_TOOLS['jsm-operations'].label,
    baseUrl: testResult.baseUrl || null,
    accountIdentifier: testResult.projectKey || null,
    isEnabled: true,
    status: testResult.ok ? 'connected' : 'error',
    hasCredentials: false,
    maskedCredentials: {},
    lastTestedAt: new Date().toISOString(),
    createdAt: null,
    updatedAt: null,
  };
}

async function testJsmOperationsConnection() {
  const config = await getJiraConfigForJsmOperations();

  if (config.missing.length > 0) {
    return {
      ok: false,
      message: `JSM Operations uses the existing Jira auth. Missing: ${config.missing.join(', ')}.`,
      baseUrl: config.baseUrl,
      projectKey: config.projectKey,
    };
  }

  const infoUrl = buildJiraApiUrl(config.baseUrl, '/rest/servicedeskapi/info');

  if (!infoUrl) {
    return {
      ok: false,
      message: 'Jira site URL is missing. Add JIRA_BASE_URL or configure Jira in Settings.',
      baseUrl: config.baseUrl,
      projectKey: config.projectKey,
    };
  }

  try {
    const response = await fetchWithTimeout(infoUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: buildBasicAuthHeader(config.credentials.email, config.credentials.apiToken),
      },
    });

    if (response.ok) {
      return {
        ok: true,
        message: 'Jira Service Management connection successful. Operations alert import will use this same Jira API token.',
        baseUrl: config.baseUrl,
        projectKey: config.projectKey,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: 'Jira Service Management rejected the existing Jira email/API token or the account lacks JSM access.',
        baseUrl: config.baseUrl,
        projectKey: config.projectKey,
      };
    }

    return {
      ok: false,
      message: `Jira Service Management is reachable, but the JSM info check returned HTTP ${response.status}.`,
      baseUrl: config.baseUrl,
      projectKey: config.projectKey,
    };
  } catch (error) {
    return {
      ok: false,
      message: getVendorNetworkErrorMessage('Jira Service Management', error, config.baseUrl),
      baseUrl: config.baseUrl,
      projectKey: config.projectKey,
    };
  }
}

function normalizeInput(toolName, input = {}, existing = null) {
  assertSupportedTool(toolName);

  const spec = SUPPORTED_TOOLS[toolName];
  const credentials = existing?.encrypted_credentials
    ? decryptCredentials(existing.encrypted_credentials)
    : {};

  [...(spec.credentialFields || []), ...(spec.configFields || [])].forEach((field) => {
    if (input[field] !== undefined && input[field] !== '') {
      credentials[field] = input[field];
    }
  });

  return {
    toolName,
    baseUrl: input.baseUrl?.trim() || null,
    accountIdentifier: input.accountIdentifier?.trim() || null,
    isEnabled: Boolean(input.isEnabled),
    encryptedCredentials:
      Object.keys(credentials).length > 0
        ? encryptCredentials(credentials)
        : existing?.encrypted_credentials || null,
  };
}

function mapIntegrationRow(row) {
  const spec = SUPPORTED_TOOLS[row.tool_name] || {};
  let credentials = {};
  const hasEncryptedCredentials = Boolean(row.encrypted_credentials);
  let hasCredentials = hasEncryptedCredentials;
  let status = row.status;

  try {
    const config = validateStoredConfig(row.tool_name, row);
    credentials = config.credentials || {};
    hasCredentials = (spec.credentialFields || []).some((field) => Boolean(credentials[field]));

    if (config.missing.length > 0) {
      status = 'not_connected';
    }
  } catch {
    status = 'error';
  }

  return {
    id: row.id,
    toolName: row.tool_name,
    label: spec.label || row.tool_name,
    baseUrl: row.base_url,
    accountIdentifier: row.account_identifier,
    isEnabled: row.is_enabled,
    status,
    hasCredentials,
    maskedCredentials: hasCredentials
      ? Object.fromEntries((spec.credentialFields || []).map((field) => [field, '********']))
      : {},
    settings: {
      ...(spec.configFields || []).reduce((settings, field) => {
        if (credentials[field] !== undefined) {
          settings[field] = credentials[field];
        }

        return settings;
      }, {}),
      ...(row.tool_name === 'payment-gateway'
        ? {
          transactionsPath: credentials.transactionsPath || '/transactions-module/transactions/',
          defaultSyncRange: credentials.defaultSyncRange || '24h',
          liveImportMode: credentials.liveImportMode !== false && credentials.liveImportMode !== 'false',
        }
        : {}),
      ...(row.tool_name === 'oracle-apex'
        ? {
          ajaxPath: credentials.ajaxPath || '/ords/wwv_flow.ajax',
          flowId: credentials.flowId || '102',
          pageId: credentials.pageId || '',
          regionId: credentials.regionId || '1654121344282841',
          requestName: credentials.requestName || '',
          dashboardPath: credentials.dashboardPath || '',
          maxRows: credentials.maxRows || 100,
          liveImportMode: credentials.liveImportMode !== false && credentials.liveImportMode !== 'false',
        }
        : {}),
    },
    lastTestedAt: row.last_tested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getIntegrations() {
  const result = await db.query(`
    SELECT
      id,
      tool_name,
      base_url,
      account_identifier,
      encrypted_credentials,
      is_enabled,
      status,
      last_tested_at,
      created_at,
      updated_at
    FROM integrations
    ORDER BY tool_name ASC
  `);

  return result.rows.map(mapIntegrationRow);
}

async function getStoredIntegrationHealthStatus(toolName, row) {
  assertSupportedTool(toolName);

  if (!row) {
    return 'not_configured';
  }

  let config;

  try {
    config = validateStoredConfig(toolName, row);

    if (config.missing.length > 0) {
      return 'not_configured';
    }
  } catch {
    return 'disconnected';
  }

  if (toolName === 'grafana') {
    const testResult = await testGrafanaConnection(row, config.credentials);
    return testResult.ok ? 'connected' : 'disconnected';
  }

  if (toolName === 'slack') {
    const testResult = await testSlackConnection(row, config.credentials);
    return testResult.ok ? 'connected' : 'disconnected';
  }

  if (toolName === 'thousandeyes') {
    const testResult = await testThousandEyesConnection(row, config.credentials);
    return testResult.ok ? 'connected' : 'disconnected';
  }

  if (toolName === 'jira') {
    const testResult = await testJiraConnection(row, config.credentials);
    return testResult.ok ? 'connected' : 'disconnected';
  }

  if (toolName === 'jsm-operations') {
    const testResult = await testJsmOperationsConnection();
    return testResult.ok ? 'connected' : 'disconnected';
  }

  return row.status === 'connected' ? 'connected' : 'disconnected';
}

async function getIntegrationHealthStatuses() {
  // ThousandEyes is retained for historical compatibility only. It is no
  // longer an active source and must not be contacted by periodic health.
  const activeToolNames = Object.keys(SUPPORTED_TOOLS).filter((toolName) => toolName !== 'thousandeyes');
  const result = await db.query(
    `
      SELECT
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status
      FROM integrations
      WHERE tool_name = ANY($1)
    `,
    [activeToolNames],
  );

  const rowsByTool = Object.fromEntries(result.rows.map((row) => [row.tool_name, row]));

  const statusEntries = await Promise.all(
    activeToolNames.map(async (toolName) => [
      toolName,
      await getStoredIntegrationHealthStatus(toolName, rowsByTool[toolName]),
    ]),
  );

  return Object.fromEntries(statusEntries);
}

async function getIntegrationByTool(toolName) {
  assertSupportedTool(toolName);

  const result = await db.query(
    `
      SELECT
        id,
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status,
        last_tested_at,
        created_at,
        updated_at
      FROM integrations
      WHERE tool_name = $1
    `,
    [toolName],
  );

  return result.rows[0] || null;
}

async function getIntegrationRuntimeConfig(toolName) {
  const row = await getIntegrationByTool(toolName);

  if (!row) {
    const error = new Error(`Integration ${toolName} is not configured.`);
    error.status = 404;
    throw error;
  }

  const { credentials, missing } = validateStoredConfig(toolName, row);

  if (missing.length > 0) {
    const error = new Error(`Integration ${toolName} is missing required fields: ${missing.join(', ')}`);
    error.status = 400;
    throw error;
  }

  return {
    toolName,
    baseUrl: row.base_url,
    accountIdentifier: row.account_identifier,
    credentials,
    isEnabled: row.is_enabled,
    status: row.status,
  };
}

async function createIntegration(toolName, input) {
  const normalized = normalizeInput(toolName, input);

  const result = await db.query(
    `
      INSERT INTO integrations (
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'not_connected')
      RETURNING
        id,
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status,
        last_tested_at,
        created_at,
        updated_at
    `,
    [
      normalized.toolName,
      normalized.baseUrl,
      normalized.accountIdentifier,
      normalized.encryptedCredentials,
      normalized.isEnabled,
    ],
  );

  return mapIntegrationRow(result.rows[0]);
}

async function updateIntegration(toolName, input) {
  const existing = await getIntegrationByTool(toolName);

  if (!existing) {
    return createIntegration(toolName, input);
  }

  const normalized = normalizeInput(toolName, input, existing);
  const result = await db.query(
    `
      UPDATE integrations
      SET
        base_url = $2,
        account_identifier = $3,
        encrypted_credentials = $4,
        is_enabled = $5,
        status = 'not_connected',
        updated_at = NOW()
      WHERE tool_name = $1
      RETURNING
        id,
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status,
        last_tested_at,
        created_at,
        updated_at
    `,
    [
      normalized.toolName,
      normalized.baseUrl,
      normalized.accountIdentifier,
      normalized.encryptedCredentials,
      normalized.isEnabled,
    ],
  );

  return mapIntegrationRow(result.rows[0]);
}

async function deleteIntegration(toolName) {
  assertSupportedTool(toolName);

  const result = await db.query(
    'DELETE FROM integrations WHERE tool_name = $1 RETURNING tool_name',
    [toolName],
  );

  return Boolean(result.rows[0]);
}

async function updateIntegrationStatus(toolName, status) {
  assertSupportedTool(toolName);

  const result = await db.query(
    `
      UPDATE integrations
      SET status = $2, last_tested_at = NOW(), updated_at = NOW()
      WHERE tool_name = $1
      RETURNING
        id,
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status,
        last_tested_at,
        created_at,
        updated_at
    `,
    [toolName, status],
  );

  return result.rows[0] ? mapIntegrationRow(result.rows[0]) : null;
}

function validateStoredConfig(toolName, row) {
  const credentials = decryptCredentials(row.encrypted_credentials);
  const spec = SUPPORTED_TOOLS[toolName];
  const values = {
    baseUrl: row.base_url,
    accountIdentifier: row.account_identifier,
    ...credentials,
  };
  const missing = spec.requiredFields.filter((field) => !values[field]);

  return {
    missing,
    credentials,
  };
}

async function testIntegration(toolName) {
  const row = await getIntegrationByTool(toolName);

  if (!row) {
    if (toolName === 'jsm-operations') {
      const testResult = await testJsmOperationsConnection();

      return {
        integration: mapVirtualJsmOperationsIntegration(testResult),
        ok: testResult.ok,
        message: testResult.message,
      };
    }

    const error = new Error(`Integration ${toolName} is not configured.`);
    error.status = 404;
    throw error;
  }

  const { missing, credentials } = validateStoredConfig(toolName, row);
  let testResult = {
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? 'Configuration is complete. Live vendor API checks can be enabled when ingestion is implemented.'
        : `Missing required fields: ${missing.join(', ')}`,
  };

  if (missing.length === 0 && toolName === 'grafana') {
    testResult = await testGrafanaConnection(row, credentials);
  }

  if (missing.length === 0 && toolName === 'slack') {
    testResult = await testSlackConnection(row, credentials);
  }

  if (missing.length === 0 && toolName === 'thousandeyes') {
    testResult = await testThousandEyesConnection(row, credentials);
  }

  if (missing.length === 0 && toolName === 'jira') {
    testResult = await testJiraConnection(row, credentials);
  }

  if (missing.length === 0 && toolName === 'jsm-operations') {
    testResult = await testJsmOperationsConnection();
  }

  const nextStatus = testResult.ok ? 'connected' : testResult.certificateBlocked ? 'not_connected' : 'error';
  const result = await db.query(
    `
      UPDATE integrations
      SET status = $2, last_tested_at = NOW(), updated_at = NOW()
      WHERE tool_name = $1
      RETURNING
        id,
        tool_name,
        base_url,
        account_identifier,
        encrypted_credentials,
        is_enabled,
        status,
        last_tested_at,
        created_at,
        updated_at
    `,
    [toolName, nextStatus],
  );

  return {
    integration: mapIntegrationRow(result.rows[0]),
    ok: testResult.ok,
    certificateBlocked: Boolean(testResult.certificateBlocked),
    message: testResult.message,
  };
}

module.exports = {
  buildBasicAuthHeader,
  buildJiraApiUrl,
  createIntegration,
  deleteIntegration,
  getIntegrationHealthStatuses,
  getIntegrationRuntimeConfig,
  getIntegrations,
  getSlackConfigFromEnv,
  getSlackRuntimeConfig,
  testIntegration,
  updateIntegration,
  updateIntegrationStatus,
};

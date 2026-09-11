import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bell,
  Building2,
  CheckCircle2,
  ClipboardPaste,
  CreditCard,
  DatabaseZap,
  DownloadCloud,
  Gauge,
  KanbanSquare,
  Loader2,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import Badge from '../components/common/Badge.jsx';
import Button from '../components/common/Button.jsx';
import Card from '../components/common/Card.jsx';
import PageState from '../components/common/PageState.jsx';
import {
  connectAppDynamics,
  disconnectAppDynamics,
  getAtlassianStatus,
  getSettingsIntegrations,
  syncAtlassianOps,
  testAtlassianConnection,
  syncSettingsIntegration,
  testSettingsIntegration,
  updateSettingsIntegration,
} from '../services/api.js';

const settingsNavItems = [
  { id: 'integrations', label: 'Integrations', icon: DatabaseZap },
  { id: 'security', label: 'Security', icon: ShieldCheck },
];

const integrationCatalog = [
  {
    name: 'atlassian',
    label: 'Atlassian',
    icon: KanbanSquare,
    description: 'Configure scoped Atlassian access for Jira, JSM Operations alerts, JSM requests, enrichment, and controlled write actions.',
    fields: [
      { name: 'baseUrl', label: 'Atlassian site URL', type: 'url', required: true, helper: 'Your Atlassian site, for example https://abcfinancial.atlassian.net.' },
      { name: 'accountIdentifier', label: 'Cloud ID', type: 'text', required: true, helper: 'Cloud ID used by the Atlassian API gateway.' },
      { name: 'email', label: 'Atlassian email', type: 'email', required: true, credential: true, helper: 'Email paired with the scoped Atlassian tokens. Stored encrypted in the backend.' },
      { name: 'opsReadToken', label: 'Operations Read Token', type: 'password', required: true, secret: true, helper: 'Reads JSM Operations alerts, details, notes, responders, and alert lifecycle data.' },
      { name: 'jiraReadToken', label: 'Jira Read Token', type: 'password', secret: true, helper: 'Reads Jira issue details, comments, changelog, fields, and metadata when available.' },
      { name: 'jsmReadToken', label: 'JSM Read Token', type: 'password', secret: true, helper: 'Reads service desks, queues, service requests, SLAs, and request metadata.' },
      { name: 'jiraWriteToken', label: 'Jira Write Token', type: 'password', secret: true, helper: 'Optional. Used only when Jira writes are enabled for issue updates or comments.' },
      { name: 'jsmWriteToken', label: 'JSM Write Token', type: 'password', secret: true, helper: 'Optional. Used only when JSM writes are enabled for request updates.' },
      { name: 'opsPollingEnabled', label: 'Operations polling', type: 'select', helper: 'Whether the backend should poll JSM Operations automatically after restart.', options: [['true', 'Enabled'], ['false', 'Disabled']] },
      { name: 'opsPollIntervalSeconds', label: 'Polling interval seconds', type: 'number', helper: 'Default is 30 seconds. Minimum backend-safe interval is 5 seconds.' },
      { name: 'opsInitialSyncDays', label: 'Initial sync days', type: 'number', helper: 'How many days of alert history to pull on the first JSM Operations sync.' },
      { name: 'operationsWriteEnabled', label: 'Operations writes', type: 'select', helper: 'Keep disabled unless you are ready to send real Operations alert actions.', options: [['false', 'Disabled'], ['true', 'Enabled']] },
      { name: 'jiraWriteEnabled', label: 'Jira writes', type: 'select', helper: 'Keep disabled unless you are ready to create or update Jira issues from this app.', options: [['false', 'Disabled'], ['true', 'Enabled']] },
      { name: 'jsmWriteEnabled', label: 'JSM request writes', type: 'select', helper: 'Keep disabled unless you are ready to update service requests from this app.', options: [['false', 'Disabled'], ['true', 'Enabled']] },
    ],
  },
  {
    name: 'abc-hub',
    label: 'ABC Hub',
    icon: Building2,
    description: 'Connect ABC Hub monitoring modules including Daemon Monitor and DataTrak User Monitoring.',
    fields: [
      { name: 'baseUrl', label: 'Base URL', type: 'url', required: true, helper: 'Root ABC Hub URL used for live module API calls.' },
      { name: 'daemonMonitorPath', label: 'Daemon Monitor endpoint path', type: 'text', helper: 'Path for broken or hung daemon jobs.', placeholder: '/abcHub/api/v1/daemon-monitors/broken-jobs' },
      { name: 'dataTrakUserMonitoringPath', label: 'DataTrak User Monitoring endpoint path', type: 'text', helper: 'Path for DataTrak user monitoring records.', placeholder: '/abcHub/api/v1/datatrak-user-monitoring' },
      { name: 'authMethod', label: 'Supported auth method', type: 'text', helper: 'Placeholder for the approved ABC Hub auth flow.', placeholder: 'Bearer token / SSO / service account' },
      { name: 'token', label: 'Auth token', type: 'password', secret: true, helper: 'Optional until ABC Hub server-side authentication is approved.' },
    ],
  },
  {
    name: 'payment-gateway',
    label: 'Payment Gateway',
    icon: CreditCard,
    description: 'Connect the Payment Gateway Transactions REST API for operational payment monitoring.',
    fields: [
      { name: 'baseUrl', label: 'Base URL', type: 'url', required: true, helper: 'Root Payment Gateway API URL. If a full transaction URL is pasted, the backend separates it safely.' },
      { name: 'accountIdentifier', label: 'Tenant ID', type: 'text', required: true, helper: 'Tenant, merchant, or database context required by the gateway API.' },
      { name: 'transactionsPath', label: 'Transactions API path', type: 'text', helper: 'Path after the Base URL for transaction pages.', placeholder: '/transactions-module/transactions/' },
      { name: 'token', label: 'Bearer Token', type: 'password', required: true, secret: true, helper: 'Live sync token. Paste either the raw token or Bearer token; it is stored encrypted.' },
      { name: 'defaultSyncRange', label: 'Default sync range', type: 'select', helper: 'Date window used by Sync Now.', options: [
        ['15m', 'Last 15 minutes'],
        ['1h', 'Last 1 hour'],
        ['6h', 'Last 6 hours'],
        ['24h', 'Last 24 hours'],
        ['7d', 'Last 7 days'],
      ] },
    ],
  },
  {
    name: 'jira',
    label: 'Jira',
    icon: KanbanSquare,
    description: 'Connect Jira for incident enrichment, incident sync, and future incident creation/linking.',
    fields: [
      { name: 'baseUrl', label: 'Jira site URL', type: 'url', required: true, helper: 'Atlassian site URL, for example https://company.atlassian.net.' },
      { name: 'accountIdentifier', label: 'Project key', type: 'text', required: true, helper: 'Project key used for incident tickets, such as ACC.' },
      { name: 'email', label: 'Jira account email', type: 'email', required: true, credential: true, helper: 'Email paired with the Jira API token.' },
      { name: 'apiToken', label: 'API token', type: 'password', required: true, secret: true, helper: 'Stored encrypted. Used until OAuth is approved.' },
      { name: 'cloudId', label: 'Cloud ID optional', type: 'text', helper: 'Needed later for Atlassian platform API routes.' },
      { name: 'authMode', label: 'Auth mode', type: 'select', helper: 'Current supported local mode is API token.', options: [['API token', 'API token'], ['OAuth', 'OAuth placeholder']] },
    ],
  },
  {
    name: 'slack',
    label: 'Slack',
    icon: Bell,
    description: 'Receive Slack alert notifications and mirror them into the website alert queue.',
    fields: [
      { name: 'baseUrl', label: 'Workspace URL', type: 'url', helper: 'Optional Slack workspace URL for reference.' },
      { name: 'accountIdentifier', label: 'Alert channel ID', type: 'text', required: true, helper: 'Slack channel ID that contains alert notifications.' },
      { name: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true, helper: 'Slack bot token with the needed channel history and user scopes.' },
      { name: 'signingSecret', label: 'Signing secret', type: 'password', required: true, secret: true, helper: 'Used to verify Slack event callbacks.' },
    ],
  },
  {
    name: 'splunk-appdynamics',
    label: 'AppDynamics',
    icon: Activity,
    description: 'Connect AppDynamics securely for applications, health rules, events, dashboards, transactions, and future alert evaluation.',
    fields: [
      { name: 'baseUrl', label: 'Controller URL', type: 'url', required: true, helper: 'AppDynamics controller base URL.' },
      { name: 'accountIdentifier', label: 'Account name', type: 'text', required: true, helper: 'AppDynamics account or tenant name.' },
      { name: 'authMode', label: 'Auth mode', type: 'select', helper: 'Use username/password for 1Password-injected user credentials, or API client when a service account is approved.', options: [['username_password', 'Username / password'], ['api_client', 'API client']] },
      { name: 'username', label: 'Username', type: 'password', credential: true, helper: 'Optional here if injected through 1Password environment variables. Stored encrypted if saved.' },
      { name: 'password', label: 'Password', type: 'password', secret: true, helper: 'Optional here if injected through 1Password environment variables. Never returned to the UI.' },
      { name: 'clientId', label: 'Client ID', type: 'password', secret: true, helper: 'Use only for API-client authentication. Stored encrypted.' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', secret: true, helper: 'Use only for API-client authentication. Stored encrypted and never returned.' },
      { name: 'applicationsPath', label: 'Applications API path', type: 'text', helper: 'Default AppDynamics applications endpoint.', placeholder: '/controller/rest/applications' },
      { name: 'healthRulesPath', label: 'Health rules API path', type: 'text', helper: 'Use :applicationId as the placeholder.', placeholder: '/controller/alerting/rest/v1/applications/:applicationId/health-rules' },
      { name: 'eventsPath', label: 'Events API path', type: 'text', helper: 'Use :applicationId as the placeholder.', placeholder: '/controller/rest/applications/:applicationId/events' },
      { name: 'businessTransactionsPath', label: 'Business transactions path', type: 'text', helper: 'Use :applicationName or :applicationId as the placeholder.', placeholder: '/controller/rest/applications/:applicationName/business-transactions' },
      { name: 'tiersPath', label: 'Tiers API path', type: 'text', helper: 'Use :applicationName or :applicationId as the placeholder.', placeholder: '/controller/rest/applications/:applicationName/tiers' },
      { name: 'nodesPath', label: 'Nodes API path', type: 'text', helper: 'Use :applicationName or :applicationId as the placeholder.', placeholder: '/controller/rest/applications/:applicationName/nodes' },
      { name: 'snapshotsPath', label: 'Snapshots API path', type: 'text', helper: 'Request snapshots endpoint for the selected application.', placeholder: '/controller/rest/applications/:applicationName/request-snapshots' },
      { name: 'metricDataPath', label: 'Metric data API path', type: 'text', helper: 'Metric data endpoint used for AppDynamics chart history.', placeholder: '/controller/rest/applications/:applicationName/metric-data' },
      { name: 'metricPaths', label: 'Metric paths', type: 'text', helper: 'Comma or newline separated metric paths to cache for charts.' },
      { name: 'syncApplicationLimit', label: 'Application sync limit', type: 'number', helper: 'Caps localhost sync volume while testing.' },
      { name: 'eventDurationMinutes', label: 'Event lookback minutes', type: 'number', helper: 'How much recent event history to fetch per application during sync.' },
      { name: 'metricDurationMinutes', label: 'Metric lookback minutes', type: 'number', helper: 'How much metric history to fetch per sync.' },
      { name: 'snapshotDurationMinutes', label: 'Snapshot lookback minutes', type: 'number', helper: 'How far back request snapshots should be collected.' },
      { name: 'automaticSyncIntervalSeconds', label: 'Automatic sync interval seconds', type: 'number', helper: 'Target refresh interval for AppDynamics background sync.' },
    ],
  },
  {
    name: 'nagios-dc01',
    label: 'Nagios DC01',
    icon: Server,
    description: 'Configure Nagios DC01 access for host, service, problem, and event monitoring.',
    fields: [
      { name: 'baseUrl', label: 'Nagios XI Base URL', type: 'url', required: true, helper: 'DC01 Nagios XI base URL used for live polling.' },
      { name: 'apiKey', label: 'API key', type: 'password', required: true, secret: true, helper: 'DC01 Nagios API key. Stored encrypted in the backend.' },
      { name: 'syncIntervalSeconds', label: 'Sync interval seconds', type: 'number', helper: 'How often the backend should poll DC01 when automatic polling is enabled.' },
      { name: 'username', label: 'Username optional', type: 'text', credential: true, helper: 'Optional only if DC01 requires basic authentication later.' },
      { name: 'password', label: 'Password optional', type: 'password', secret: true, helper: 'Optional only if DC01 requires basic authentication later.' },
    ],
  },
  {
    name: 'nagios-dc02',
    label: 'Nagios DC02',
    icon: Server,
    description: 'Configure Nagios DC02 access for host, service, problem, and event monitoring.',
    fields: [
      { name: 'baseUrl', label: 'Nagios XI Base URL', type: 'url', required: true, helper: 'DC02 Nagios XI base URL used for live polling.' },
      { name: 'apiKey', label: 'API key', type: 'password', required: true, secret: true, helper: 'DC02 Nagios API key. Stored encrypted in the backend.' },
      { name: 'syncIntervalSeconds', label: 'Sync interval seconds', type: 'number', helper: 'How often the backend should poll DC02 when automatic polling is enabled.' },
      { name: 'username', label: 'Username optional', type: 'text', credential: true, helper: 'Optional only if DC02 requires basic authentication later.' },
      { name: 'password', label: 'Password optional', type: 'password', secret: true, helper: 'Optional only if DC02 requires basic authentication later.' },
    ],
  },
  {
    name: 'grafana',
    label: 'Grafana',
    icon: Gauge,
    description: 'Connect Grafana dashboards, folders, panels, and alert metadata.',
    fields: [
      { name: 'baseUrl', label: 'Grafana URL', type: 'url', required: true, helper: 'Grafana base URL used for dashboard API calls.' },
      { name: 'token', label: 'Service account token / API key', type: 'password', required: true, secret: true, helper: 'Token used to read dashboards and alert metadata.' },
      { name: 'accountIdentifier', label: 'Folder or rule filter optional', type: 'text', helper: 'Optional filter for future targeted sync.' },
    ],
  },
  {
    name: 'oracle-apex',
    label: 'Oracle APEX',
    icon: DatabaseZap,
    description: 'Read-only PF & ETL Dashboard connector using Oracle APEX AJAX JSON responses.',
    fields: [
      { name: 'baseUrl', label: 'APEX Base URL', type: 'url', required: true, helper: 'Root Oracle APEX URL. Browser import uses your signed-in APEX session.' },
      { name: 'ajaxPath', label: 'AJAX endpoint path', type: 'text', required: true, helper: 'APEX AJAX endpoint path.', placeholder: '/ords/wwv_flow.ajax' },
      { name: 'flowId', label: 'Flow ID', type: 'text', required: true, helper: 'APEX application flow ID. Current PF & ETL dashboard uses 102.' },
      { name: 'pageId', label: 'Page ID optional', type: 'text', helper: 'APEX page / flow step ID from the same Network request, if present.' },
      { name: 'regionId', label: 'Region ID', type: 'text', required: true, helper: 'APEX report region ID used by fetchData.' },
      { name: 'requestName', label: 'Request name optional', type: 'text', helper: 'Optional p_request value from the APEX AJAX request, if that request sends one.' },
      { name: 'ajaxIdentifier', label: 'AJAX Identifier', type: 'password', secret: true, helper: 'Region ajaxIdentifier from the APEX network request. Stored encrypted if saved.' },
      { name: 'dashboardPath', label: 'Dashboard path optional', type: 'text', helper: 'Optional path used for the Open in APEX link.' },
      { name: 'maxRows', label: 'Rows per page', type: 'number', helper: 'Pagination page size for browser-assisted imports.' },
    ],
  },
];

function defaultValues(tool) {
  return Object.fromEntries(tool.fields.map((field) => [
    field.name,
    field.type === 'select' ? field.options?.[0]?.[0] || '' : '',
  ]));
}

function formFromIntegration(tool, integration) {
  return {
    ...defaultValues(tool),
    ...(integration?.values || {}),
    isEnabled: integration?.isEnabled ?? false,
    liveImportMode: integration?.liveImportMode ?? false,
  };
}

function statusTone(status) {
  if (status === 'Connected') return 'active';
  if (status === 'Authentication required' || status === 'Mock mode enabled') return 'draft';
  return 'paused';
}

function resultTone(type) {
  if (type === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (type === 'loading') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (type === 'info') return 'border-blue-200 bg-blue-50 text-blue-800';
  return 'border-rose-200 bg-rose-50 text-rose-800';
}

function validateToolForm(tool, form, integration) {
  for (const field of tool.fields) {
    const value = form[field.name];
    const storedSecret = (field.secret || field.credential) && integration?.hasCredentials?.[field.name];

    if (field.required && !value && !storedSecret) {
      return `${tool.label} requires ${field.label}.`;
    }

    if (field.required && value === '********' && !storedSecret) {
      return `${tool.label} requires ${field.label}.`;
    }

    if (field.type === 'url' && value && value !== '********') {
      try {
        new URL(value);
      } catch {
        return `${field.label} must be a valid URL.`;
      }
    }

    if (field.name.toLowerCase().includes('path') && value && !String(value).startsWith('/')) {
      return `${field.label} must start with /.`;
    }
  }

  return null;
}

function buildPayload(tool, form) {
  const payload = {
    isEnabled: Boolean(form.isEnabled),
    liveImportMode: Boolean(form.liveImportMode),
  };

  tool.fields.forEach((field) => {
    const value = form[field.name];

    if (value !== undefined && value !== '********') {
      payload[field.name] = value;
    }
  });

  if (payload.tenantId) {
    payload.accountIdentifier = payload.tenantId;
  }

  return payload;
}

function summarizeSyncResult(tool, result) {
  if (result.message) return result.message;

  const fetched = result.fetched ?? result.totalFetched ?? result.recordsStored ?? 0;
  const inserted = result.inserted ?? 0;
  const updated = result.updated ?? 0;

  return `${tool.label} sync complete: ${fetched} fetched, ${inserted} new, ${updated} updated.`;
}

function SettingsResult({ result }) {
  if (!result) return null;

  return (
    <div className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${resultTone(result.type)}`}>
      {result.type === 'success' ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      ) : result.type === 'loading' ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span>{result.message}</span>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return 'Not available';
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

const atlassianConnectionLabels = [
  ['jiraRead', 'Jira Read', 'Issues, fields, comments, changelog'],
  ['operationsRead', 'Operations Read', 'JSM Operations alerts, notes, responders'],
  ['operationsWrite', 'Operations Write', 'Acknowledge, assign, snooze, close'],
  ['jiraWrite', 'Jira Write', 'Create/update Jira issues and comments'],
  ['jsmRead', 'JSM Read', 'Service desks, queues, requests, SLAs'],
  ['jsmWrite', 'JSM Write', 'Request comments, participants, transitions'],
];

function getAtlassianConnectionTone(connection) {
  if (connection?.connected) return 'active';
  if (connection?.configured) return connection?.enabled === false ? 'draft' : 'paused';
  return 'draft';
}

function getAtlassianConnectionText(connection) {
  if (connection?.connected) return 'Connected';
  if (!connection?.configured) return 'Missing config';
  if (connection?.enabled === false) return 'Write disabled';
  if (connection?.connectionTested) return 'Failed';
  return 'Configured';
}

function AtlassianOperationsCard({
  actionState,
  onRefresh,
  onSync,
  onTest,
  result,
  status,
}) {
  const isTesting = actionState === 'test';
  const isSyncing = actionState === 'sync';
  const connected = Boolean(status?.connected);
  const configured = Boolean(status?.configured);
  const connections = status?.connections || {
    jiraRead: status?.jiraRead,
    operationsRead: status?.operationsRead,
    operationsWrite: status?.operationsWrite,
    jiraWrite: status?.jiraWrite,
    jsmRead: status?.jsmRead,
    jsmWrite: status?.jsmWrite,
  };

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-cyan-50 text-cyan-700">
            <KanbanSquare className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h4 className="font-semibold text-slate-950">Atlassian JSM Operations</h4>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Scoped Atlassian integration using backend-only tokens. Read and write lanes are tested and shown separately so no token is reused for the wrong API.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={configured ? 'active' : 'draft'}>{configured ? 'Configured' : 'Missing config'}</Badge>
          <Badge tone={connected ? 'active' : 'paused'}>{connected ? 'Connected' : 'Not verified'}</Badge>
          <Badge tone={status?.readOnly ? 'draft' : 'active'}>{status?.readOnly ? 'Read-only' : 'Writes enabled'}</Badge>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {atlassianConnectionLabels.map(([key, label, helper]) => {
          const connection = connections?.[key] || {};

          return (
            <div key={key} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-950">{label}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p>
                </div>
                <Badge tone={getAtlassianConnectionTone(connection)}>
                  {getAtlassianConnectionText(connection)}
                </Badge>
              </div>
              {connection.error ? (
                <p className="mt-2 text-xs leading-5 text-rose-700">
                  {typeof connection.error === 'string' ? connection.error : connection.error.message}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <dl className="mt-5 grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-4 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Polling</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {status?.pollingEnabled ? `Active every ${status.pollIntervalSeconds}s` : 'Inactive'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last attempted sync</dt>
          <dd className="mt-1 font-semibold text-slate-900">{formatDateTime(status?.lastAttemptAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last successful sync</dt>
          <dd className="mt-1 font-semibold text-slate-900">{formatDateTime(status?.lastSuccessfulSyncAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts fetched</dt>
          <dd className="mt-1 font-semibold text-slate-900">{status?.alertsFetched ?? 0}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts imported</dt>
          <dd className="mt-1 font-semibold text-slate-900">{status?.alertsImported ?? 0}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts updated</dt>
          <dd className="mt-1 font-semibold text-slate-900">{status?.alertsUpdated ?? 0}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts failed</dt>
          <dd className="mt-1 font-semibold text-slate-900">{status?.alertsFailed ?? 0}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last result</dt>
          <dd className="mt-1 font-semibold text-slate-900">{status?.lastResult || 'Not run yet'}</dd>
        </div>
      </dl>

      {status?.missingConfig?.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Missing Atlassian settings: {status.missingConfig.join(', ')}
        </div>
      ) : null}

      {status?.lastErrorMessage ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {status.lastErrorCode ? `${status.lastErrorCode}: ` : ''}{status.lastErrorMessage}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Button disabled={Boolean(actionState)} type="button" onClick={onRefresh}>
          Refresh status
        </Button>
        <Button disabled={Boolean(actionState) || !configured} type="button" onClick={onTest}>
          {isTesting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Testing
            </>
          ) : 'Test Connection'}
        </Button>
        <Button disabled={Boolean(actionState) || !configured} type="button" variant="primary" onClick={onSync}>
          {isSyncing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Syncing
            </>
          ) : (
            <>
              <DownloadCloud className="h-4 w-4" aria-hidden="true" />
              Sync Now
            </>
          )}
        </Button>
      </div>

      <SettingsResult result={result} />
    </Card>
  );
}

function IntegrationField({ field, value, onChange, hasStoredSecret }) {
  const inputClass = 'mt-1 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100';

  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {field.label}{field.required ? ' *' : ''}
      </span>
      {field.type === 'select' ? (
        <select className={inputClass} value={value || ''} onChange={(event) => onChange(field.name, event.target.value)}>
          {(field.options || []).map(([optionValue, label]) => (
            <option key={optionValue} value={optionValue}>{label}</option>
          ))}
        </select>
      ) : (
        <input
          className={inputClass}
          placeholder={hasStoredSecret ? '********' : field.placeholder || ''}
          type={field.type || 'text'}
          value={value || ''}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      )}
      {field.helper ? <p className="mt-1 text-xs leading-5 text-slate-500">{field.helper}</p> : null}
    </label>
  );
}

const atlassianEnvFieldMap = {
  ATLASSIAN_SITE_URL: 'baseUrl',
  ATLASSIAN_CLOUD_ID: 'accountIdentifier',
  ATLASSIAN_EMAIL: 'email',
  ATLASSIAN_JIRA_READ_TOKEN: 'jiraReadToken',
  ATLASSIAN_OPS_READ_TOKEN: 'opsReadToken',
  ATLASSIAN_JIRA_WRITE_TOKEN: 'jiraWriteToken',
  ATLASSIAN_JSM_READ_TOKEN: 'jsmReadToken',
  ATLASSIAN_JSM_WRITE_TOKEN: 'jsmWriteToken',
  ATLASSIAN_OPS_POLLING_ENABLED: 'opsPollingEnabled',
  ATLASSIAN_OPS_POLL_INTERVAL_SECONDS: 'opsPollIntervalSeconds',
  ATLASSIAN_OPS_INITIAL_SYNC_DAYS: 'opsInitialSyncDays',
  ATLASSIAN_OPS_WRITE_ENABLED: 'operationsWriteEnabled',
  ATLASSIAN_JIRA_WRITE_ENABLED: 'jiraWriteEnabled',
  ATLASSIAN_JSM_WRITE_ENABLED: 'jsmWriteEnabled',
};

function parseAtlassianEnvBlock(value) {
  return String(value || '')
    .split('\n')
    .reduce((fields, line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
        return fields;
      }

      const [rawKey, ...rawValueParts] = trimmed.split('=');
      const key = rawKey.trim();
      const fieldName = atlassianEnvFieldMap[key];

      if (!fieldName) {
        return fields;
      }

      const parsedValue = rawValueParts.join('=').trim().replace(/^['"]|['"]$/g, '');

      if (parsedValue) {
        fields[fieldName] = parsedValue;
      }

      return fields;
    }, {});
}

function IntegrationCard({
  tool,
  integration,
  form,
  onChange,
  onSave,
  onTest,
  onSync,
  onConnect,
  onDisconnect,
  actionState,
  testResult,
  syncResult,
  bulkPasteValue,
  onBulkPasteChange,
  onApplyBulkPaste,
}) {
  const Icon = tool.icon;
  const status = integration?.connectionStatus || 'Authentication required';
  const isSaving = actionState === 'save';
  const isTesting = actionState === 'test';
  const isSyncing = actionState === 'sync';
  const isConnecting = actionState === 'connect';
  const isDisconnecting = actionState === 'disconnect';
  const isAppDynamics = tool.name === 'splunk-appdynamics';

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-slate-100 text-slate-700">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h4 className="font-semibold text-slate-950">{tool.label}</h4>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{tool.description}</p>
          </div>
        </div>
        <Badge tone={statusTone(isSyncing ? 'Sync in progress' : status)}>
          {isSyncing ? 'Sync in progress' : status}
        </Badge>
      </div>

      {tool.name === 'atlassian' ? (
        <div className="mt-5 rounded-lg border border-cyan-100 bg-cyan-50/60 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h5 className="text-sm font-semibold text-slate-950">Paste Atlassian token block</h5>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Paste lines like ATLASSIAN_OPS_READ_TOKEN=... here. The values stay in this browser form until you click Save or Test Connection.
              </p>
            </div>
            <Button type="button" onClick={onApplyBulkPaste}>
              <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
              Fill fields
            </Button>
          </div>
          <textarea
            className="mt-3 min-h-40 w-full rounded-md border border-cyan-200 bg-white px-3 py-2 font-mono text-xs outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            placeholder={`ATLASSIAN_SITE_URL=https://abcfinancial.atlassian.net
ATLASSIAN_CLOUD_ID=
ATLASSIAN_EMAIL=
ATLASSIAN_JIRA_READ_TOKEN=
ATLASSIAN_OPS_READ_TOKEN=
ATLASSIAN_JIRA_WRITE_TOKEN=
ATLASSIAN_JSM_READ_TOKEN=
ATLASSIAN_JSM_WRITE_TOKEN=`}
            value={bulkPasteValue || ''}
            onChange={(event) => onBulkPasteChange(event.target.value)}
          />
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {tool.fields.map((field) => (
          <IntegrationField
            key={field.name}
            field={field}
            hasStoredSecret={Boolean(integration?.hasCredentials?.[field.name])}
            value={form?.[field.name] || ''}
            onChange={onChange}
          />
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <label className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 p-3">
          <span>
            <span className="block text-sm font-semibold text-slate-700">Enabled</span>
            <span className="mt-1 block text-xs text-slate-500">Allow the backend to use this integration.</span>
          </span>
          <input
            checked={Boolean(form?.isEnabled)}
            className="h-5 w-5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
            type="checkbox"
            onChange={(event) => onChange('isEnabled', event.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 p-3">
          <span>
            <span className="block text-sm font-semibold text-slate-700">Live import mode</span>
            <span className="mt-1 block text-xs text-slate-500">Use real source APIs. Turn off only for intentionally manual/mock workflows.</span>
          </span>
          <input
            checked={Boolean(form?.liveImportMode)}
            className="h-5 w-5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
            type="checkbox"
            onChange={(event) => onChange('liveImportMode', event.target.checked)}
          />
        </label>
      </div>

      <dl className="mt-5 grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-4 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connection status</dt>
          <dd className="mt-1 font-semibold text-slate-900">{isSyncing ? 'Sync in progress' : status}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Credentials</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {Object.values(integration?.hasCredentials || {}).some(Boolean) ? 'Stored as ********' : 'Not stored'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last tested</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {integration?.lastTestedAt ? new Date(integration.lastTestedAt).toLocaleString() : 'Not tested yet'}
          </dd>
        </div>
      </dl>

      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Button disabled={Boolean(actionState)} type="button" variant="primary" onClick={onSave}>
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving
            </>
          ) : 'Save'}
        </Button>
        <Button disabled={Boolean(actionState)} type="button" onClick={onTest}>
          {isTesting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Testing
            </>
          ) : 'Test Connection'}
        </Button>
        <Button disabled={Boolean(actionState) || !form?.isEnabled || !form?.liveImportMode} type="button" onClick={onSync}>
          {isSyncing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Syncing
            </>
          ) : (
            <>
              <DownloadCloud className="h-4 w-4" aria-hidden="true" />
              Sync Now
            </>
          )}
        </Button>
      </div>

      {isAppDynamics ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button disabled={Boolean(actionState)} type="button" variant="primary" onClick={onConnect}>
            {isConnecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Connecting
              </>
            ) : 'Connect AppDynamics'}
          </Button>
          <Button disabled={Boolean(actionState)} type="button" onClick={onDisconnect}>
            {isDisconnecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Disconnecting
              </>
            ) : 'Disconnect AppDynamics'}
          </Button>
        </div>
      ) : null}

      <SettingsResult result={testResult} />
      <SettingsResult result={syncResult} />
    </Card>
  );
}

export default function Settings() {
  const [activeSection, setActiveSection] = useState('integrations');
  const [integrations, setIntegrations] = useState([]);
  const [forms, setForms] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [actionStates, setActionStates] = useState({});
  const [testResults, setTestResults] = useState({});
  const [syncResults, setSyncResults] = useState({});
  const [atlassianStatus, setAtlassianStatus] = useState(null);
  const [atlassianAction, setAtlassianAction] = useState(null);
  const [atlassianResult, setAtlassianResult] = useState(null);
  const [bulkPasteValues, setBulkPasteValues] = useState({});

  const integrationByName = useMemo(
    () => Object.fromEntries(integrations.map((integration) => [integration.name, integration])),
    [integrations],
  );

  function applyIntegrationData(data) {
    const nextIntegrations = data.integrations || [];

    setIntegrations(nextIntegrations);
    setForms(Object.fromEntries(
      integrationCatalog.map((tool) => [
        tool.name,
        formFromIntegration(tool, nextIntegrations.find((integration) => integration.name === tool.name)),
      ]),
    ));
  }

  useEffect(() => {
    let mounted = true;

    async function loadSettings() {
      try {
        const [data, atlassianData] = await Promise.all([
          getSettingsIntegrations(),
          getAtlassianStatus().catch((requestError) => ({
            configured: false,
            connected: false,
            lastErrorCode: 'status_unavailable',
            lastErrorMessage: requestError.message,
            missingConfig: [],
          })),
        ]);

        if (!mounted) return;

        applyIntegrationData(data);
        setAtlassianStatus(atlassianData);
        setError(null);
      } catch (requestError) {
        if (!mounted) return;
        setError(requestError.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadSettings();

    return () => {
      mounted = false;
    };
  }, []);

  function showToast(type, message) {
    setToast({ type, message });
  }

  function updateForm(toolName, fieldName, value) {
    setForms((current) => ({
      ...current,
      [toolName]: {
        ...(current[toolName] || {}),
        [fieldName]: value,
      },
    }));
  }

  function updateBulkPaste(toolName, value) {
    setBulkPasteValues((current) => ({
      ...current,
      [toolName]: value,
    }));
  }

  function applyAtlassianEnvPaste() {
    const parsed = parseAtlassianEnvBlock(bulkPasteValues.atlassian || '');
    const keys = Object.keys(parsed);

    if (keys.length === 0) {
      showToast('error', 'Paste Atlassian lines like ATLASSIAN_OPS_READ_TOKEN=... before filling fields.');
      return;
    }

    setForms((current) => ({
      ...current,
      atlassian: {
        ...(current.atlassian || {}),
        ...parsed,
      },
    }));
    showToast('success', `${keys.length} Atlassian setting${keys.length === 1 ? '' : 's'} filled. Click Save to store them.`);
  }

  async function runAction(tool, action, callback) {
    setActionStates((current) => ({ ...current, [tool.name]: action }));

    try {
      const data = await callback();

      applyIntegrationData(data);
      return data;
    } finally {
      setActionStates((current) => ({ ...current, [tool.name]: null }));
    }
  }

  async function refreshAtlassianSnapshot() {
    if (!integrationCatalog.some((tool) => tool.name === 'atlassian')) {
      return;
    }

    const status = await getAtlassianStatus().catch(() => null);

    if (status) {
      setAtlassianStatus(status);
    }
  }

  async function handleSave(tool) {
    const form = forms[tool.name] || {};
    const validationError = validateToolForm(tool, form, integrationByName[tool.name]);

    if (validationError) {
      showToast('error', validationError);
      return;
    }

    try {
      const data = await runAction(tool, 'save', () => updateSettingsIntegration(tool.name, buildPayload(tool, form)));

      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: 'info', message: data.message || `${tool.label} settings saved. Run Test Connection to verify.` },
      }));
      if (tool.name === 'atlassian') {
        await refreshAtlassianSnapshot();
      }
      showToast('success', data.message || `${tool.label} settings saved.`);
    } catch (requestError) {
      showToast('error', requestError.message);
    }
  }

  async function handleTest(tool) {
    const form = forms[tool.name] || {};
    const validationError = validateToolForm(tool, form, integrationByName[tool.name]);

    if (validationError) {
      showToast('error', validationError);
      return;
    }

    setTestResults((current) => ({
      ...current,
      [tool.name]: { type: 'loading', message: `Testing ${tool.label} connection...` },
    }));

    try {
      await runAction(tool, 'save', () => updateSettingsIntegration(tool.name, buildPayload(tool, form)));
      const data = await runAction(tool, 'test', () => testSettingsIntegration(tool.name));
      const ok = Boolean(data.ok);
      const message = data.message || `${tool.label} test finished.`;

      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: ok ? 'success' : data.mode === 'mock' ? 'info' : 'error', message },
      }));
      if (tool.name === 'atlassian') {
        await refreshAtlassianSnapshot();
      }
      showToast(ok || data.mode === 'mock' ? 'success' : 'error', message);
    } catch (requestError) {
      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: 'error', message: requestError.message },
      }));
      showToast('error', requestError.message);
    }
  }

  async function handleSync(tool) {
    const form = forms[tool.name] || {};
    const validationError = validateToolForm(tool, form, integrationByName[tool.name]);

    if (validationError) {
      showToast('error', validationError);
      return;
    }

    setSyncResults((current) => ({
      ...current,
      [tool.name]: { type: 'loading', message: `${tool.label} sync in progress...` },
    }));

    try {
      await runAction(tool, 'save', () => updateSettingsIntegration(tool.name, buildPayload(tool, form)));
      const data = await runAction(tool, 'sync', () => syncSettingsIntegration(tool.name));
      const message = summarizeSyncResult(tool, data);

      setSyncResults((current) => ({
        ...current,
        [tool.name]: { type: 'success', message },
      }));
      if (tool.name === 'atlassian') {
        await refreshAtlassianSnapshot();
      }
      showToast('success', message);
    } catch (requestError) {
      setSyncResults((current) => ({
        ...current,
        [tool.name]: { type: 'error', message: requestError.message },
      }));
      showToast('error', requestError.message);
    }
  }

  async function handleConnectAppDynamics(tool) {
    const form = forms[tool.name] || {};
    const validationError = validateToolForm(tool, form, integrationByName[tool.name]);

    if (validationError) {
      showToast('error', validationError);
      return;
    }

    setTestResults((current) => ({
      ...current,
      [tool.name]: { type: 'loading', message: 'Connecting AppDynamics...' },
    }));

    try {
      await runAction(tool, 'save', () => updateSettingsIntegration(tool.name, buildPayload(tool, form)));
      const data = await runAction(tool, 'connect', () => connectAppDynamics());
      const ok = Boolean(data.ok);
      const message = data.message || 'AppDynamics connection check finished.';

      await getSettingsIntegrations().then(applyIntegrationData);
      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: ok ? 'success' : 'error', message },
      }));
      showToast(ok ? 'success' : 'error', message);
    } catch (requestError) {
      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: 'error', message: requestError.message },
      }));
      showToast('error', requestError.message);
    }
  }

  async function handleDisconnectAppDynamics(tool) {
    setTestResults((current) => ({
      ...current,
      [tool.name]: { type: 'loading', message: 'Disconnecting AppDynamics...' },
    }));

    try {
      const data = await runAction(tool, 'disconnect', () => disconnectAppDynamics());
      await getSettingsIntegrations().then(applyIntegrationData);
      const message = data.message || 'AppDynamics disconnected.';

      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: 'info', message },
      }));
      showToast('success', message);
    } catch (requestError) {
      setTestResults((current) => ({
        ...current,
        [tool.name]: { type: 'error', message: requestError.message },
      }));
      showToast('error', requestError.message);
    }
  }

  async function refreshAtlassianStatus() {
    setAtlassianAction('refresh');

    try {
      const data = await getAtlassianStatus();
      setAtlassianStatus(data);
      setAtlassianResult({ type: 'info', message: 'Atlassian Operations status refreshed.' });
    } catch (requestError) {
      setAtlassianResult({ type: 'error', message: requestError.message });
    } finally {
      setAtlassianAction(null);
    }
  }

  async function handleAtlassianTest() {
    setAtlassianAction('test');
    setAtlassianResult({ type: 'loading', message: 'Testing Atlassian read lanes and checking write-lane configuration...' });

    try {
      const data = await testAtlassianConnection();
      const message = data.ok
        ? 'Atlassian read access verified.'
        : 'Atlassian test completed with warnings. Check the lane status cards.';
      const refreshedStatus = await getAtlassianStatus();
      const testedConnections = Object.fromEntries(
        atlassianConnectionLabels.map(([key]) => [key, data[key]]).filter(([, value]) => value),
      );

      setAtlassianResult({ type: data.ok ? 'success' : 'error', message });
      setAtlassianStatus({
        ...refreshedStatus,
        connections: {
          ...(refreshedStatus.connections || {}),
          ...testedConnections,
        },
      });
      showToast(data.ok ? 'success' : 'error', message);
    } catch (requestError) {
      setAtlassianResult({ type: 'error', message: requestError.message });
      setAtlassianStatus(await getAtlassianStatus().catch(() => atlassianStatus));
      showToast('error', requestError.message);
    } finally {
      setAtlassianAction(null);
    }
  }

  async function handleAtlassianSync() {
    setAtlassianAction('sync');
    setAtlassianResult({ type: 'loading', message: 'Syncing JSM Operations alerts...' });

    try {
      const data = await syncAtlassianOps();
      const message = `JSM Operations sync complete: ${data.fetched} fetched, ${data.inserted} inserted, ${data.updated} updated, ${data.failed} failed.`;

      setAtlassianResult({ type: 'success', message });
      setAtlassianStatus(await getAtlassianStatus());
      showToast('success', message);
    } catch (requestError) {
      setAtlassianResult({ type: 'error', message: requestError.message });
      setAtlassianStatus(await getAtlassianStatus().catch(() => atlassianStatus));
      showToast('error', requestError.message);
    } finally {
      setAtlassianAction(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Settings</p>
        <nav className="mt-4 space-y-1">
          {settingsNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;

            return (
              <button
                key={item.id}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-semibold transition ${
                  isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
                type="button"
                onClick={() => setActiveSection(item.id)}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="space-y-6">
        {toast ? (
          <div
            className={`flex items-start justify-between gap-4 rounded-lg border p-4 text-sm shadow-sm ${
              toast.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {toast.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4" aria-hidden="true" />
              )}
              {toast.message}
            </div>
            <button className="font-semibold" type="button" onClick={() => setToast(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {activeSection === 'integrations' ? (
          <section className="space-y-4">
            <div>
              <h3 className="text-xl font-semibold text-slate-950">Integration Settings</h3>
              <p className="mt-1 text-sm text-slate-500">
                Configure source systems for live data import. Auth failures are shown directly; Settings does not hide failed live calls behind mock data.
              </p>
            </div>

            {loading ? (
              <PageState title="Loading integrations" message="Fetching saved integration settings." variant="loading" />
            ) : null}

            {error ? (
              <PageState title="Unable to load integrations" message={error} variant="error" />
            ) : null}

            {!loading && !error ? (
              <>
                <AtlassianOperationsCard
                  actionState={atlassianAction}
                  result={atlassianResult}
                  status={atlassianStatus}
                  onRefresh={refreshAtlassianStatus}
                  onSync={handleAtlassianSync}
                  onTest={handleAtlassianTest}
                />
                <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
                  {integrationCatalog.map((tool) => (
                    <IntegrationCard
                      key={tool.name}
                      tool={tool}
                      integration={integrationByName[tool.name]}
                      form={forms[tool.name] || defaultValues(tool)}
                      actionState={actionStates[tool.name]}
                      testResult={testResults[tool.name]}
                      syncResult={syncResults[tool.name]}
                      bulkPasteValue={bulkPasteValues[tool.name]}
                      onChange={(fieldName, value) => updateForm(tool.name, fieldName, value)}
                      onBulkPasteChange={(value) => updateBulkPaste(tool.name, value)}
                      onApplyBulkPaste={applyAtlassianEnvPaste}
                      onSave={() => handleSave(tool)}
                      onTest={() => handleTest(tool)}
                      onSync={() => handleSync(tool)}
                      onConnect={() => handleConnectAppDynamics(tool)}
                      onDisconnect={() => handleDisconnectAppDynamics(tool)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {activeSection === 'security' ? (
          <section className="space-y-4">
            <div>
              <h3 className="text-xl font-semibold text-slate-950">Security</h3>
              <p className="mt-1 text-sm text-slate-500">Credential storage and masking rules for connected integrations.</p>
            </div>

            <Card className="p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-950">Credential handling</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Secrets are sent only to the backend API, stored encrypted, and returned to the UI only as masked values.
                    Update a token by entering a new value; leaving the field as masked keeps the stored credential.
                  </p>
                </div>
              </div>
            </Card>
          </section>
        ) : null}
      </div>
    </div>
  );
}

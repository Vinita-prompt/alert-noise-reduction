import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CheckCircle2,
  Clock3,
  Cog,
  DatabaseZap,
  ExternalLink,
  FileText,
  Globe2,
  Loader2,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Button from '../components/common/Button.jsx';
import Card from '../components/common/Card.jsx';
import PageState from '../components/common/PageState.jsx';
import {
  getMonitoringDetails,
  getMonitoringEntities,
  getMonitoringTools,
  getGrafanaPanelRenderUrl,
  getNagiosHealth,
  importAbcHubDaemonMonitor,
  importOracleApexPayload,
  importPaymentGatewayTransactions,
  pollNagiosInstance,
  syncGrafanaDashboards,
} from '../services/api.js';

const instances = [
  { key: 'd01', label: 'Nagios D01' },
  { key: 'd02', label: 'Nagios D02' },
];

const statusLabels = {
  ok: 'OK',
  up: 'Up',
  warning: 'Warning',
  critical: 'Critical',
  down: 'Down',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
  running: 'Running',
  waiting: 'Waiting',
  delayed: 'Delayed',
  queued: 'Queued',
};

const statusStyles = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  up: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  critical: 'border-red-200 bg-red-50 text-red-700',
  down: 'border-red-200 bg-red-50 text-red-700',
  unreachable: 'border-orange-200 bg-orange-50 text-orange-700',
  unknown: 'border-orange-200 bg-orange-50 text-orange-700',
  pending: 'border-slate-200 bg-slate-100 text-slate-600',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  running: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  waiting: 'border-slate-200 bg-slate-100 text-slate-600',
  delayed: 'border-orange-200 bg-orange-50 text-orange-700',
  queued: 'border-blue-200 bg-blue-50 text-blue-700',
};

const statusDotStyles = {
  ok: 'bg-emerald-500',
  up: 'bg-emerald-500',
  warning: 'bg-yellow-400',
  critical: 'bg-red-500',
  down: 'bg-red-500',
  unreachable: 'bg-orange-500',
  unknown: 'bg-orange-500',
  pending: 'bg-slate-400',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  running: 'bg-yellow-400',
  waiting: 'bg-slate-400',
  delayed: 'bg-orange-500',
  queued: 'bg-blue-500',
};

const serviceSummaryOrder = ['ok', 'warning', 'critical', 'unknown', 'pending'];
const hostSummaryOrder = ['up', 'down', 'unreachable', 'pending'];
const problemStatuses = ['critical', 'down', 'unreachable', 'warning', 'unknown'];
const refreshIntervalMs = 30000;
const chartPalette = {
  navy: '#0f172a',
  cyan: '#0891b2',
  teal: '#0f766e',
  red: '#e11d48',
  amber: '#d97706',
  slate: '#64748b',
};
const timeRangeOptions = [
  { value: '5m', label: 'Last 5 minutes', from: 'now-5m', to: 'now' },
  { value: '15m', label: 'Last 15 minutes', from: 'now-15m', to: 'now' },
  { value: '30m', label: 'Last 30 minutes', from: 'now-30m', to: 'now' },
  { value: '1h', label: 'Last 1 hour', from: 'now-1h', to: 'now' },
  { value: '3h', label: 'Last 3 hours', from: 'now-3h', to: 'now' },
  { value: '6h', label: 'Last 6 hours', from: 'now-6h', to: 'now' },
  { value: '12h', label: 'Last 12 hours', from: 'now-12h', to: 'now' },
  { value: '24h', label: 'Last 24 hours', from: 'now-24h', to: 'now' },
  { value: '7d', label: 'Last 7 days', from: 'now-7d', to: 'now' },
  { value: '30d', label: 'Last 30 days', from: 'now-30d', to: 'now' },
  { value: 'custom', label: 'Custom range', from: '', to: '' },
];

function resolveTimeRange(value) {
  return timeRangeOptions.find((option) => option.value === value) || timeRangeOptions[1];
}

function buildSelectedTimeRange(value, customFrom, customTo) {
  if (value !== 'custom') {
    return resolveTimeRange(value);
  }

  const from = customFrom || 'now-1h';
  const to = customTo || 'now';
  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (
    Number.isFinite(fromDate.getTime())
    && Number.isFinite(toDate.getTime())
    && fromDate > toDate
  ) {
    return {
      value: 'custom',
      label: 'Custom range',
      from: to,
      to: from,
    };
  }

  return {
    value: 'custom',
    label: 'Custom range',
    from,
    to,
  };
}

function toDateTimeLocalValue(value) {
  if (!value || String(value).startsWith('now')) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const offsetMs = date.getTimezoneOffset() * 60 * 1000;

  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatDateTime(value) {
  if (!value) {
    return 'Not available';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatSeconds(value) {
  if (!Number.isFinite(Number(value))) {
    return 'Not available';
  }

  const seconds = Math.max(0, Number(value));

  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hr`;

  return `${(seconds / 86400).toFixed(1)} days`;
}

function formatScore(value) {
  if (!Number.isFinite(Number(value))) {
    return 'Not available';
  }

  return `${Math.round(Number(value) * 100)}%`;
}

function getLatestTimestamp(records = []) {
  const timestamp = records
    .map((record) => new Date(record.lastCheck || record.updatedAt || record.lastEndDate || record.lastStartDate || record.nextRunDate).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  return timestamp ? new Date(timestamp).toISOString() : null;
}

function getAbcHubDaemonMonitorUrl(detail) {
  const sourceUrl = detail?.deepLink || detail?.entities?.find((record) => record.deepLink)?.deepLink;

  if (!sourceUrl) {
    throw new Error('ABC Hub URL is not configured for this Monitoring view.');
  }

  return new URL('/abcHub/api/v1/daemon-monitors/broken-jobs', sourceUrl).toString();
}

function getDaemonJobsFromPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function parseAbcHubDaemonJson(text) {
  if (!text.trim()) {
    throw new Error('Paste the ABC Hub Daemon Monitor JSON before importing.');
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON. Copy the full ABC Hub JSON response and try again.');
  }

  const jobs = getDaemonJobsFromPayload(payload);

  if (!jobs.length) {
    throw new Error('The pasted JSON does not contain daemon jobs in response.data.');
  }

  return payload;
}

async function fetchAbcHubDaemonMonitorJson(detail) {
  const url = getAbcHubDaemonMonitorUrl(detail);
  let response;

  try {
    response = await fetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch {
    throw new Error('Unable to fetch ABC Hub JSON from this browser session. ABC Hub may be blocking cross-origin browser access, or you may need to sign in to ABC Hub first.');
  }

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new Error('ABC Hub rejected the browser session. Open ABC Hub in another tab, sign in, then try the import again.');
  }

  if (!response.ok) {
    throw new Error(`ABC Hub returned HTTP ${response.status} while fetching Daemon Monitor JSON.`);
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('ABC Hub returned non-JSON content. This usually means the browser received an SSO/login page instead of Daemon Monitor data.');
  }

  const jobs = getDaemonJobsFromPayload(payload);

  if (!jobs.length) {
    throw new Error('ABC Hub returned empty Daemon Monitor data.');
  }

  return payload;
}

function getPaymentGatewayDefaultImportUrl(detail) {
  const sourceUrl = detail?.deepLink || detail?.entities?.find((record) => record.deepLink)?.deepLink || window.location.origin;

  return new URL(
    '/transactions-module/transactions/?page=0&size=50&sort=createdDate%2Cdesc&search=&tokenType=BANK_ACCOUNT&createdDate=2026-07-17&createdDate=2026-07-17',
    sourceUrl,
  ).toString();
}

function getPaymentTransactionsFromPayload(payload) {
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.data?.content)) return payload.data.content;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload)) return payload;

  return [];
}

function validatePaymentGatewayJson(payload) {
  const transactions = getPaymentTransactionsFromPayload(payload);

  if (!transactions.length) {
    throw new Error('Payment Gateway JSON is empty or does not contain transaction records.');
  }

  return payload;
}

function parsePaymentGatewayJson(text) {
  if (!text.trim()) {
    throw new Error('Paste the Payment Gateway transactions JSON before importing.');
  }

  try {
    return validatePaymentGatewayJson(JSON.parse(text));
  } catch (error) {
    if (/transaction records|empty/i.test(error.message)) {
      throw error;
    }

    throw new Error('Invalid JSON. Copy the full Payment Gateway transactions response and try again.');
  }
}

function getOracleApexRowsFromPayload(payload) {
  const arrays = [];

  function visit(node) {
    if (Array.isArray(node)) {
      arrays.push(node);
      node.slice(0, 3).forEach(visit);
      return;
    }

    if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  }

  visit(payload);

  return arrays
    .filter((items) => items.some((item) => item && typeof item === 'object'))
    .sort((left, right) => right.length - left.length)[0] || [];
}

function parseOracleApexJson(text) {
  if (!text.trim()) {
    throw new Error('Paste the Oracle APEX AJAX JSON response before importing.');
  }

  let payload;
  let normalizedText = text.trim();

  if (!normalizedText.startsWith('{') && /^"[^"]+"\s*:/.test(normalizedText)) {
    normalizedText = `{${normalizedText}`;
  }

  if (normalizedText.startsWith('{') && !normalizedText.endsWith('}')) {
    normalizedText = `${normalizedText}}`;
  }

  try {
    payload = JSON.parse(normalizedText);
  } catch {
    throw new Error('Invalid JSON. Copy the full Oracle APEX AJAX response and try again. If it starts with "regions", include the opening { before it.');
  }

  if (!getOracleApexRowsFromPayload(payload).length) {
    throw new Error('The pasted Oracle APEX JSON does not contain report rows.');
  }

  return payload;
}

function buildOracleApexRequestBody(config, firstRow, maxRows, ajaxIdentifier, sessionId = '') {
  const body = new URLSearchParams();
  const pJson = {
    regions: [
      {
        id: config.regionId,
        ajaxIdentifier,
        fetchData: {
          version: 1,
          firstRow,
          maxRows,
        },
      },
    ],
  };

  body.set('p_flow_id', config.flowId || '102');
  if (config.pageId) {
    body.set('p_flow_step_id', config.pageId);
  }
  if (sessionId) {
    body.set('p_instance', sessionId);
  }
  if (config.requestName) {
    body.set('p_request', config.requestName);
  }
  body.set('p_json', JSON.stringify(pJson));

  return body;
}

function getOracleApexSessionFromUrl(value) {
  try {
    const url = new URL(value);

    return url.searchParams.get('session') || url.searchParams.get('p_instance') || '';
  } catch {
    return '';
  }
}

async function fetchOracleApexAjaxPages(config, ajaxIdentifier, sessionId = '') {
  if (!config?.baseUrl || String(config.baseUrl).includes('apex.example.com')) {
    throw new Error('Oracle APEX Base URL is not configured in Settings.');
  }

  if (!ajaxIdentifier) {
    throw new Error('Enter the Oracle APEX ajaxIdentifier from the dashboard network request.');
  }

  const maxRows = Number(config.maxRows || 100);
  const endpoint = new URL(config.ajaxPath || '/ords/wwv_flow.ajax', config.baseUrl).toString();
  const resolvedSessionId = sessionId || getOracleApexSessionFromUrl(config.baseUrl);
  const payloads = [];
  let firstRow = 1;
  let pageNumber = 1;

  while (pageNumber <= 200) {
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: buildOracleApexRequestBody(config, firstRow, maxRows, ajaxIdentifier, resolvedSessionId),
      });
    } catch {
      throw new Error('Unable to fetch Oracle APEX JSON from this browser session. APEX may be blocking cross-origin access, or you may need to sign in first.');
    }

    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new Error('Oracle APEX rejected this browser session. Open APEX in another tab, sign in, then try again.');
    }

    if (!response.ok) {
      throw new Error(`Oracle APEX returned HTTP ${response.status}.`);
    }

    if (/^\s*</.test(text)) {
      throw new Error('Oracle APEX returned an HTML page instead of JSON. Your session may be expired or SSO redirected the request.');
    }

    let payload;

    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Oracle APEX returned malformed JSON.');
    }

    const payloadText = JSON.stringify(payload || {}).toLowerCase();
    if (
      /invalid.{0,120}(ajax|plugin|region|identifier)/.test(payloadText) ||
      /ajaxidentifier.{0,120}(invalid|rejected|not found|does not match)/.test(payloadText) ||
      /region.{0,120}not found|session.{0,40}state.{0,40}protection/.test(payloadText)
    ) {
      throw new Error('Oracle APEX rejected this generated AJAX request. Use the Pasted APEX AJAX JSON import instead: copy the actual wwv_flow.ajax Response JSON from DevTools and paste it below.');
    }

    const rows = getOracleApexRowsFromPayload(payload);
    payloads.push({ payload, pageNumber, firstRow, maxRows, count: rows.length });

    if (rows.length < maxRows || rows.length === 0) {
      break;
    }

    firstRow += maxRows;
    pageNumber += 1;
  }

  return payloads;
}

async function fetchPaymentGatewayTransactionsJson(importUrl) {
  let response;

  try {
    response = await fetch(importUrl, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch {
    throw new Error('Unable to fetch Payment Gateway JSON from this browser session. The gateway may be blocking cross-origin access, or you may need to sign in first.');
  }

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new Error('Payment Gateway rejected this browser session. Open Payment Gateway in another tab, sign in, then try the import again.');
  }

  if (!response.ok) {
    throw new Error(`Payment Gateway returned HTTP ${response.status} while fetching transactions JSON.`);
  }

  try {
    return validatePaymentGatewayJson(JSON.parse(text));
  } catch (error) {
    if (/transaction records|empty/i.test(error.message)) {
      throw error;
    }

    throw new Error('Payment Gateway returned non-JSON content. This usually means the browser received a sign-in page instead of transactions data.');
  }
}

function formatDuration(value) {
  if (!Number.isFinite(Number(value))) {
    return 'Not available';
  }

  const duration = Number(value);

  return duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} sec`;
}

function statusLabel(status) {
  return statusLabels[status] || String(status || 'Unknown');
}

function StatusPill({ status }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyles[status] || statusStyles.pending}`}>
      <span className={`h-2 w-2 rounded-full ${statusDotStyles[status] || statusDotStyles.pending}`} />
      {statusLabel(status)}
    </span>
  );
}

function DaemonStatePill({ state }) {
  const normalized = String(state || 'Unknown').toLowerCase();
  const styles = {
    healthy: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    idle: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    running: 'border-yellow-200 bg-yellow-50 text-yellow-700',
    delayed: 'border-orange-200 bg-orange-50 text-orange-700',
    'missed schedule': 'border-red-200 bg-red-50 text-red-700',
    disabled: 'border-slate-200 bg-slate-100 text-slate-600',
    unknown: 'border-slate-200 bg-slate-100 text-slate-600',
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[normalized] || styles.unknown}`}>
      {state || 'Unknown'}
    </span>
  );
}

function SummaryTile({ label, status, value, total }) {
  const percent = total > 0 ? Math.round((Number(value || 0) / total) * 100) : 0;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-600">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{value || 0}</p>
          <p className="mt-1 text-xs text-slate-500">{percent}% of total</p>
        </div>
        <span className={`mt-1 h-3 w-3 rounded-full ${statusDotStyles[status] || statusDotStyles.pending}`} />
      </div>
    </Card>
  );
}

function EmptyTable({ message }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
      {message}
    </div>
  );
}

function tableMatchesSearch(row, search) {
  const value = search.trim().toLowerCase();

  if (!value) {
    return true;
  }

  return [
    row.hostName,
    row.serviceDescription,
    row.displayName,
    row.pluginOutput,
    row.status,
  ].some((field) => String(field || '').toLowerCase().includes(value));
}

function filterByStatus(row, statusFilter) {
  return statusFilter === 'all' || row.status === statusFilter;
}

function NagiosTable({ title, rows, columns, emptyMessage }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 px-5 py-4">
        <h3 className="font-semibold text-slate-950">{title}</h3>
      </div>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((row) => (
                <tr key={row.problemKey || row.entityId || row.id || `${row.hostName}:${row.serviceDescription || row.eventHash || 'host'}`} className="hover:bg-slate-50">
                  {columns.map((column) => (
                    <td key={column.key} className="max-w-md px-4 py-3 align-top text-slate-700">
                      {column.render ? column.render(row) : row[column.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-5">
          <EmptyTable message={emptyMessage} />
        </div>
      )}
    </Card>
  );
}

function flattenGrafanaPanels(panels = []) {
  const result = [];

  panels.forEach((panel) => {
    if (!panel || typeof panel !== 'object') {
      return;
    }

    if (panel.type !== 'row') {
      result.push(panel);
    }

    if (Array.isArray(panel.panels)) {
      result.push(...flattenGrafanaPanels(panel.panels));
    }
  });

  return result;
}

function getPanelDatasource(panel) {
  const datasource = panel.datasource || panel.targets?.find((target) => target.datasource)?.datasource;

  if (!datasource) {
    return 'Default datasource';
  }

  if (typeof datasource === 'string') {
    return datasource;
  }

  return datasource.name || datasource.uid || datasource.type || 'Datasource';
}

function getPanelQuerySummary(panel) {
  const target = panel.targets?.[0];

  if (!target) {
    return 'No query metadata stored';
  }

  return target.queryType || target.expr || target.metric || target.refId || target.measurement || 'Query metadata stored';
}

function DashboardCard({ dashboard, onSelect }) {
  return (
    <Card className="flex h-full flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-slate-950">{dashboard.title}</p>
          <p className="mt-1 truncate text-xs font-medium uppercase tracking-wide text-slate-500">
            {dashboard.folderTitle || 'General'}
          </p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-orange-50 text-orange-700">
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-md bg-slate-50 p-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Panels</p>
          <p className="mt-1 font-semibold text-slate-900">{dashboard.panelCount || 0}</p>
        </div>
        <div className="rounded-md bg-slate-50 p-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sources</p>
          <p className="mt-1 font-semibold text-slate-900">{dashboard.datasourceNames?.length || 0}</p>
        </div>
      </div>

      {dashboard.tags?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {dashboard.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {dashboard.datasourceNames?.length ? (
        <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">
          {dashboard.datasourceNames.slice(0, 4).join(', ')}
        </p>
      ) : (
        <p className="mt-3 text-xs leading-5 text-slate-500">No panel datasource metadata stored yet.</p>
      )}

      <div className="mt-auto pt-4">
        <Button size="sm" onClick={() => onSelect(dashboard)}>
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
          View in app
        </Button>
      </div>
    </Card>
  );
}

function GrafanaPanelCard({ dashboard, panel, timeRange }) {
  const [renderFailed, setRenderFailed] = useState(false);
  const grid = panel.gridPos || {};
  const height = Math.max(220, Math.min(520, Number(grid.h || 8) * 36));
  const width = Math.max(700, Math.min(1400, Number(grid.w || 12) * 70));
  const selectedRange = timeRange || resolveTimeRange('6h');
  const imageUrl = getGrafanaPanelRenderUrl(dashboard.uid, panel.id, {
    from: selectedRange.from,
    to: selectedRange.to,
    width,
    height,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-slate-950">{panel.title || `Panel ${panel.id}`}</h4>
          <p className="mt-1 truncate text-xs text-slate-500">
            {panel.type || 'panel'} · {getPanelDatasource(panel)}
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
          #{panel.id}
        </span>
      </div>
      <div className="bg-slate-50 p-3">
        {panel.id && !renderFailed ? (
          <img
            alt={panel.title || `Grafana panel ${panel.id}`}
            className="h-auto min-h-48 w-full rounded-md border border-slate-200 bg-white object-contain"
            loading="lazy"
            onError={() => setRenderFailed(true)}
            src={imageUrl}
          />
        ) : (
          <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-slate-200 bg-white text-sm text-slate-500">
            {panel.id ? 'Panel preview is unavailable from Grafana render API, but metadata is preserved below.' : 'Panel render unavailable because this panel has no Grafana panel ID.'}
          </div>
        )}
      </div>
      <div className="border-t border-slate-200 px-4 py-3">
        <p className="line-clamp-2 text-xs leading-5 text-slate-500">{getPanelQuerySummary(panel)}</p>
      </div>
    </Card>
  );
}

function GrafanaDashboardViewer({ dashboard, onBack, timeRange }) {
  const panels = dashboard.normalizedPanels?.length
    ? dashboard.normalizedPanels.map((panel) => ({
      id: panel.panelId,
      title: panel.panelTitle || panel.title,
      type: panel.type,
      order: panel.order,
      datasource: panel.datasource,
      targets: panel.targets || [],
      gridPos: panel.gridPos || {},
      rawPayload: panel.rawPayload || {},
      querySummary: panel.querySummary,
      deepLink: panel.deepLink,
    }))
    : flattenGrafanaPanels(dashboard.dashboard?.panels || []);
  const selectedRange = timeRange || resolveTimeRange('6h');
  const alertRules = dashboard.alertRules || [];
  const alertStates = dashboard.alertStates || [];
  const aiFeatures = dashboard.aiFeatures || [];
  const variables = dashboard.variables || [];
  const annotations = dashboard.annotations || [];
  const metricSummaries = dashboard.metricSummaries || [];
  const correlations = dashboard.correlationFeatures || [];
  const stateHistory = dashboard.alertStateHistory || [];

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:bg-slate-50"
            type="button"
            onClick={onBack}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">Back to Grafana dashboards</span>
          </button>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">Grafana Dashboard</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">{dashboard.title}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {dashboard.folderTitle || dashboard.dashboardSubname || 'General'} · {panels.length} panels · {alertRules.length} alert rules · {selectedRange.label}.
            </p>
          </div>
        </div>
        {dashboard.dashboardUrl ? (
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            href={dashboard.dashboardUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open original
          </a>
        ) : null}
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="font-semibold text-slate-950">Panel structure</h3>
            <p className="mt-1 text-sm text-slate-500">Panel names, order, type, and datasource preserved from Grafana.</p>
          </div>
          <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
            {panels.length} panels
          </span>
        </div>
        {panels.length ? (
          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {panels.map((panel, index) => (
              <div key={`panel-list:${dashboard.uid}:${panel.id}:${index}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 text-sm font-semibold text-slate-950">{panel.title || `Panel ${panel.id || index + 1}`}</p>
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-500">#{index + 1}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{panel.type || 'panel'} · {getPanelDatasource(panel)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">No panels are stored for this dashboard.</p>
        )}
      </Card>

      {panels.length ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {panels.map((panel) => (
            <GrafanaPanelCard key={`${dashboard.uid}:${panel.id}:${panel.title}`} dashboard={dashboard} panel={panel} timeRange={selectedRange} />
          ))}
        </div>
      ) : (
        <EmptyTable message="This Grafana dashboard has no renderable panels stored yet. Sync dashboards again to refresh the dashboard JSON." />
      )}

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-500" aria-hidden="true" />
          <h3 className="font-semibold text-slate-950">Dashboard metadata</h3>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">UID</p>
            <p className="mt-1 break-all font-medium text-slate-900">{dashboard.uid}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Updated / refreshed</p>
            <p className="mt-1 font-medium text-slate-900">{formatDateTime(dashboard.lastUpdatedAt || dashboard.updatedAt)}</p>
            <p className="mt-1 text-xs text-slate-500">Refreshed {formatDateTime(dashboard.lastRefreshedAt || dashboard.lastSyncedAt)}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Refresh interval</p>
            <p className="mt-1 font-medium text-slate-900">{dashboard.refreshInterval || 'Not set'}</p>
            <p className="mt-1 text-xs text-slate-500">UID {dashboard.uid}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-3 md:col-span-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Datasources</p>
            <p className="mt-1 font-medium text-slate-900">{dashboard.datasourceNames?.join(', ') || 'Not available'}</p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Metric summaries</h3>
              <p className="mt-1 text-sm text-slate-500">Historical values collected from panel queries when Grafana datasource permissions allow it.</p>
            </div>
            <span className="rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-700">{metricSummaries.length}</span>
          </div>
          {metricSummaries.length ? (
            <div className="mt-4 divide-y divide-slate-100">
              {metricSummaries.slice(0, 8).map((metric) => (
                <div key={`${metric.panelId}:${metric.seriesName}:${metric.metricName}`} className="grid grid-cols-1 gap-2 py-3 text-sm md:grid-cols-4">
                  <div className="md:col-span-2">
                    <p className="font-semibold text-slate-950">{metric.seriesName}</p>
                    <p className="mt-1 text-xs text-slate-500">Panel {metric.panelId} · {metric.metricName}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current</p>
                    <p className="font-semibold text-slate-950">{formatMetricValue(metric.currentValue)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg / P95</p>
                    <p className="font-semibold text-slate-950">{formatMetricValue(metric.average)} / {formatMetricValue(metric.p95)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No metric values are stored yet. Sync Grafana with datasource query access to populate historical metrics.</p>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Variables and annotations</h3>
              <p className="mt-1 text-sm text-slate-500">Dashboard templating variables and Grafana annotations preserved for context.</p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{variables.length + annotations.length}</span>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Variables</p>
              {variables.length ? (
                <div className="mt-2 space-y-2">
                  {variables.slice(0, 8).map((variable) => (
                    <div key={variable.name} className="text-sm">
                      <p className="font-semibold text-slate-950">{variable.name}</p>
                      <p className="text-xs text-slate-500">{variable.type || 'variable'} · {variable.datasourceUid || 'default datasource'}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No variables stored.</p>
              )}
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Annotations</p>
              {annotations.length ? (
                <div className="mt-2 space-y-2">
                  {annotations.slice(0, 8).map((annotation) => (
                    <div key={annotation.id} className="text-sm">
                      <p className="line-clamp-2 font-semibold text-slate-950">{annotation.text || 'Annotation'}</p>
                      <p className="text-xs text-slate-500">{formatDateTime(annotation.timestamp)} · {annotation.createdBy || 'Grafana'}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No annotations stored for this dashboard.</p>
              )}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Alert rules</h3>
              <p className="mt-1 text-sm text-slate-500">Rules linked to this dashboard when Grafana permissions expose them.</p>
            </div>
            <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">{alertRules.length}</span>
          </div>
          {alertRules.length ? (
            <div className="mt-4 divide-y divide-slate-100">
              {alertRules.slice(0, 8).map((rule) => (
                <div key={rule.uid} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-950">{rule.title}</p>
                    <StatusPill status={rule.state || 'pending'} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {rule.severity || 'low'} · {rule.condition || 'No condition metadata'} · {rule.uid}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No alert rules are stored for this dashboard yet.</p>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">AI-ready monitoring features</h3>
              <p className="mt-1 text-sm text-slate-500">Prepared feature rows for later noise vs incident evaluation. No AI model is running yet.</p>
            </div>
            <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700">{aiFeatures.length}</span>
          </div>
          {aiFeatures.length ? (
            <div className="mt-4 grid grid-cols-1 gap-2">
              {aiFeatures.slice(0, 8).map((feature) => (
                <div key={`${feature.sourceModule}:${feature.entityId}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-950">{feature.entityName}</p>
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600">{feature.aiLabel || 'unknown'}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                    {feature.metricName || 'metric pending'} · {feature.alertRuleState || 'no alert state'} · {feature.aiReason}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">AI-ready features will appear after a Grafana sync stores panel or alert-rule metadata.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Correlation features</h3>
              <p className="mt-1 text-sm text-slate-500">Cross-panel relationships prepared for future root-cause and noise analysis.</p>
            </div>
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">{correlations.length}</span>
          </div>
          {correlations.length ? (
            <div className="mt-4 divide-y divide-slate-100">
              {correlations.slice(0, 8).map((correlation) => (
                <div key={correlation.id} className="py-3 text-sm">
                  <p className="font-semibold text-slate-950">{correlation.entityA.split(':panel:').pop()} ↔ {correlation.entityB.split(':panel:').pop()}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    dependency {formatMetricValue(correlation.dependencyScore)} · confidence {formatMetricValue(correlation.correlationConfidence)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Correlation rows will appear after metric/panel relationships are computed during sync.</p>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Alert state timeline</h3>
              <p className="mt-1 text-sm text-slate-500">Historical state transitions are appended, not overwritten.</p>
            </div>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">{stateHistory.length}</span>
          </div>
          {stateHistory.length ? (
            <div className="mt-4 divide-y divide-slate-100">
              {stateHistory.slice(0, 8).map((event) => (
                <div key={event.id} className="flex flex-col gap-2 py-3 text-sm md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-semibold text-slate-950">{event.ruleTitle || 'Grafana rule'}</p>
                    <p className="mt-1 text-xs text-slate-500">{event.previousState || 'new'} → {event.state}</p>
                  </div>
                  <span className="text-xs font-medium text-slate-500">{formatDateTime(event.transitionedAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No state transitions have been observed for this dashboard yet.</p>
          )}
        </Card>
      </div>

      {alertStates.length ? (
        <Card className="p-4">
          <h3 className="font-semibold text-slate-950">Current alert states</h3>
          <div className="mt-4 divide-y divide-slate-100">
            {alertStates.slice(0, 10).map((alert) => (
              <div key={alert.fingerprint} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-medium text-slate-950">{alert.ruleTitle || alert.labels?.alertname || 'Grafana alert'}</p>
                  <p className="mt-1 text-xs text-slate-500">{alert.fingerprint}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill status={alert.state || 'pending'} />
                  <span className="text-xs font-medium text-slate-500">{formatDateTime(alert.startsAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

function GrafanaDashboardsSection({
  dashboards,
  folders,
  search,
  folder,
  onSearchChange,
  onFolderChange,
  onSync,
  syncing,
  error,
  selectedDashboard,
  onSelectDashboard,
  onBackToDashboards,
}) {
  if (selectedDashboard) {
    return <GrafanaDashboardViewer dashboard={selectedDashboard} onBack={onBackToDashboards} />;
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-orange-500 text-white">
            <DatabaseZap className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">Grafana</p>
            <h2 className="text-xl font-semibold text-slate-950">Dashboard Inventory</h2>
            <p className="mt-1 text-sm text-slate-500">
              Dashboards are pulled from Grafana separately from active alerts, so this works even when no alerts are firing.
            </p>
          </div>
        </div>
        <Button onClick={onSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          Sync dashboards
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Dashboards stored</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{dashboards.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Folders</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{folders.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Panels mapped</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {dashboards.reduce((sum, dashboard) => sum + Number(dashboard.panelCount || 0), 0)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Datasources seen</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {new Set(dashboards.flatMap((dashboard) => dashboard.datasourceNames || [])).size}
          </p>
        </Card>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center">
        <label className="relative block flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            className="h-10 w-full rounded-md border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search Grafana dashboards or folders"
          />
        </label>
        <select
          className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
          value={folder}
          onChange={(event) => onFolderChange(event.target.value)}
        >
          <option value="all">All folders</option>
          {folders.map((item) => (
            <option key={item.title} value={item.title}>
              {item.title} ({item.count})
            </option>
          ))}
        </select>
      </div>

      {dashboards.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {dashboards.map((dashboard) => (
            <DashboardCard key={dashboard.uid} dashboard={dashboard} onSelect={onSelectDashboard} />
          ))}
        </div>
      ) : (
        <EmptyTable message="No Grafana dashboards are stored yet. Click Sync dashboards to pull dashboard inventory from Grafana." />
      )}
    </section>
  );
}

function HealthStrip({ snapshot }) {
  const status = snapshot.status || {};
  const connectionStatus = status.connectionStatus || (snapshot.instance?.configured ? 'checking' : 'not_configured');
  const configured = snapshot.instance?.configured;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connection</p>
        <div className="mt-2">
          <StatusPill status={connectionStatus === 'connected' ? 'ok' : connectionStatus === 'not_configured' ? 'pending' : 'critical'} />
        </div>
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last sync</p>
        <p className="mt-2 text-sm font-semibold text-slate-900">{formatDateTime(status.lastSuccessfulSync)}</p>
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Response time</p>
        <p className="mt-2 text-sm font-semibold text-slate-900">{formatDuration(status.responseTimeMs)}</p>
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Configuration</p>
        <p className="mt-2 text-sm font-semibold text-slate-900">{configured ? 'Configured' : 'Missing API details'}</p>
      </div>
    </div>
  );
}

function InstancePanel({ instanceKey, snapshot, search, statusFilter, onPoll, polling }) {
  const serviceSummary = snapshot.serviceSummary || {};
  const hostSummary = snapshot.hostSummary || {};
  const services = (snapshot.services || []).filter((row) => tableMatchesSearch(row, search) && filterByStatus(row, statusFilter));
  const hosts = (snapshot.hosts || []).filter((row) => tableMatchesSearch(row, search) && filterByStatus(row, statusFilter));
  const problems = (snapshot.problems || []).filter((row) => tableMatchesSearch(row, search) && filterByStatus(row, statusFilter));
  const downtime = (snapshot.downtime || []).filter((row) => tableMatchesSearch(row, search) || String(row.comment || '').toLowerCase().includes(search.trim().toLowerCase()));
  const aiFeatures = (snapshot.aiFeatures || []).filter((row) => tableMatchesSearch({ hostName: row.entityName, serviceDescription: row.entityType, pluginOutput: row.aiReason, status: row.currentState }, search));
  const syncLogs = snapshot.syncLogs || [];
  const serviceTotal = Number(serviceSummary.total || 0);
  const hostTotal = Number(hostSummary.total || 0);

  const problemColumns = [
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'hostName', label: 'Host' },
    { key: 'serviceDescription', label: 'Service', render: (row) => row.serviceDescription || 'Host problem' },
    { key: 'pluginOutput', label: 'Status information' },
    { key: 'acknowledged', label: 'Ack', render: (row) => (row.acknowledged ? 'Yes' : 'No') },
    { key: 'inDowntime', label: 'Downtime', render: (row) => (row.inDowntime ? 'Yes' : 'No') },
    { key: 'durationSeconds', label: 'Duration', render: (row) => formatSeconds(row.durationSeconds) },
    { key: 'lastCheck', label: 'Last check', render: (row) => formatDateTime(row.lastCheck) },
  ];
  const serviceColumns = [
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'hostName', label: 'Host' },
    { key: 'serviceDescription', label: 'Service' },
    { key: 'pluginOutput', label: 'Status information' },
    { key: 'acknowledged', label: 'Ack', render: (row) => (row.acknowledged ? 'Yes' : 'No') },
    { key: 'inDowntime', label: 'Downtime', render: (row) => (row.inDowntime ? 'Yes' : 'No') },
    { key: 'attemptCount', label: 'Attempt', render: (row) => row.attemptCount ?? 'Not available' },
    { key: 'durationSeconds', label: 'Duration', render: (row) => formatSeconds(row.durationSeconds) },
    { key: 'lastCheck', label: 'Last check', render: (row) => formatDateTime(row.lastCheck) },
  ];
  const hostColumns = [
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'hostName', label: 'Host' },
    { key: 'address', label: 'Address', render: (row) => row.address || 'Not available' },
    { key: 'pluginOutput', label: 'Status information' },
    { key: 'acknowledged', label: 'Ack', render: (row) => (row.acknowledged ? 'Yes' : 'No') },
    { key: 'inDowntime', label: 'Downtime', render: (row) => (row.inDowntime ? 'Yes' : 'No') },
    { key: 'attemptCount', label: 'Attempt', render: (row) => row.attemptCount ?? 'Not available' },
    { key: 'durationSeconds', label: 'Duration', render: (row) => formatSeconds(row.durationSeconds) },
    { key: 'lastCheck', label: 'Last check', render: (row) => formatDateTime(row.lastCheck) },
  ];
  const eventColumns = [
    { key: 'eventTime', label: 'Time', render: (row) => formatDateTime(row.eventTime) },
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'eventType', label: 'Type' },
    { key: 'hostName', label: 'Host' },
    { key: 'serviceDescription', label: 'Service', render: (row) => row.serviceDescription || 'Host' },
    { key: 'oldState', label: 'Old', render: (row) => row.oldState ?? 'Not available' },
    { key: 'newState', label: 'New', render: (row) => row.newState ?? 'Not available' },
    { key: 'output', label: 'Event output' },
  ];
  const downtimeColumns = [
    { key: 'active', label: 'Active', render: (row) => (row.active ? 'Yes' : 'No') },
    { key: 'entityType', label: 'Type' },
    { key: 'hostName', label: 'Host' },
    { key: 'serviceName', label: 'Service', render: (row) => row.serviceName || 'Host' },
    { key: 'startTime', label: 'Start', render: (row) => formatDateTime(row.startTime) },
    { key: 'endTime', label: 'End', render: (row) => formatDateTime(row.endTime) },
    { key: 'comment', label: 'Comment', render: (row) => row.comment || 'Not available' },
  ];
  const aiFeatureColumns = [
    { key: 'currentState', label: 'State', render: (row) => <StatusPill status={row.currentState} /> },
    { key: 'entityName', label: 'Entity' },
    { key: 'entityType', label: 'Type' },
    { key: 'stateChangeCount', label: 'Changes' },
    { key: 'recurrenceCount', label: 'Recurrence' },
    { key: 'flappingScore', label: 'Flapping', render: (row) => formatScore(row.flappingScore) },
    { key: 'stabilityScore', label: 'Stability', render: (row) => formatScore(row.stabilityScore) },
    { key: 'incidentLikelihood', label: 'Incident likelihood', render: (row) => formatScore(row.incidentLikelihood) },
    { key: 'noiseLikelihood', label: 'Noise likelihood', render: (row) => formatScore(row.noiseLikelihood) },
  ];
  const syncLogColumns = [
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status === 'success' ? 'ok' : row.status === 'failed' ? 'critical' : 'pending'} /> },
    { key: 'startedAt', label: 'Started', render: (row) => formatDateTime(row.startedAt) },
    { key: 'durationMs', label: 'Duration', render: (row) => formatDuration(row.durationMs) },
    { key: 'counts', label: 'Counts', render: (row) => `${row.counts?.hosts || 0} hosts, ${row.counts?.services || 0} services, ${row.counts?.aiFeatures || 0} features` },
    { key: 'warnings', label: 'Warnings', render: (row) => (row.warnings || []).slice(0, 2).join(' | ') || 'None' },
  ];

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-slate-900 text-white">
            <Server className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Nagios XI</p>
            <h2 className="text-xl font-semibold text-slate-950">{snapshot.instance?.label || instances.find((item) => item.key === instanceKey)?.label}</h2>
            {snapshot.status?.lastError ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-rose-700">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {snapshot.status.lastError}
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">Host, service, active problem, and event status reconstructed from Nagios XI REST data.</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {snapshot.instance?.nagiosUrl ? (
            <a
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              href={snapshot.instance.nagiosUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open in Nagios
            </a>
          ) : null}
          <Button onClick={() => onPoll(instanceKey)} disabled={polling}>
            {polling ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            Refresh from API
          </Button>
        </div>
      </div>

      <HealthStrip snapshot={snapshot} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            <h3 className="font-semibold text-slate-950">Service Status Summary</h3>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {serviceSummaryOrder.map((status) => (
              <SummaryTile key={status} label={statusLabel(status)} status={status} value={serviceSummary[status]} total={serviceTotal} />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-3 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-slate-700" aria-hidden="true" />
            <h3 className="font-semibold text-slate-950">Host Status Summary</h3>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {hostSummaryOrder.map((status) => (
              <SummaryTile key={status} label={statusLabel(status)} status={status} value={hostSummary[status]} total={hostTotal} />
            ))}
          </div>
        </div>
      </div>

      <NagiosTable title="Active Problems" rows={problems} columns={problemColumns} emptyMessage="No active problems match the current filters." />
      <NagiosTable title="Acknowledged / Downtime Records" rows={downtime.slice(0, 150)} columns={downtimeColumns} emptyMessage="No downtime records are stored for this instance." />
      <NagiosTable title="AI-Ready Feature Rows" rows={aiFeatures.slice(0, 150)} columns={aiFeatureColumns} emptyMessage="AI-ready Nagios features will appear after the next poll." />
      <NagiosTable title="Service Status Table" rows={services.slice(0, 250)} columns={serviceColumns} emptyMessage="No services match the current filters." />
      <NagiosTable title="Host Status Table" rows={hosts.slice(0, 250)} columns={hostColumns} emptyMessage="No hosts match the current filters." />
      <NagiosTable title="Recent Event History" rows={(snapshot.events || []).slice(0, 100)} columns={eventColumns} emptyMessage="No event history has been stored yet." />
      <NagiosTable title="Nagios Sync Log" rows={syncLogs.slice(0, 20)} columns={syncLogColumns} emptyMessage="No Nagios sync log has been stored yet." />
    </section>
  );
}

function formatMetricValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Not available';
  }

  if (typeof value === 'number') {
    return value.toLocaleString();
  }

  const text = String(value);
  const looksLikeDate = /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/.test(text);

  return looksLikeDate ? formatDateTime(value) : text;
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') {
    return 'Not available';
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? `${numeric.toFixed(numeric % 1 === 0 ? 0 : 1)}%` : String(value);
}

function formatMetricWithUnit(value, unit) {
  if (value === null || value === undefined || value === '') {
    return 'Not available';
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ''}`;
}

function getEntityCustomProperties(entity) {
  return entity.customProperties || entity.metadata?.customProperties || {};
}

function getAlertCountFilterValue(entity) {
  const custom = getEntityCustomProperties(entity);

  return Number(custom.activeAlerts ?? custom.alertCount ?? 0);
}

function entityMatchesSeverity(entity, severityFilter) {
  if (severityFilter === 'all') {
    return true;
  }

  return String(entity.severity || entity.metadata?.latestSeverity || '').toLowerCase() === severityFilter;
}

function entityMatchesAlertCount(entity, alertCountFilter) {
  const custom = getEntityCustomProperties(entity);
  const activeAlerts = Number(custom.activeAlerts || 0);
  const alertCount = Number(custom.alertCount || 0);

  if (alertCountFilter === 'active') {
    return activeAlerts > 0;
  }

  if (alertCountFilter === 'has-alerts') {
    return alertCount > 0;
  }

  if (alertCountFilter === 'no-alerts') {
    return alertCount === 0;
  }

  return true;
}

function thousandEyesEntityMatchesSearch(entity, search) {
  const custom = getEntityCustomProperties(entity);
  const value = search.trim().toLowerCase();

  if (!value) {
    return true;
  }

  return [
    entity.label,
    entity.id,
    custom.testName,
    custom.applicationName,
    custom.target,
    custom.endpoint,
    custom.testType,
  ].some((field) => String(field || '').toLowerCase().includes(value));
}

function MonitoringSelector({
  tools,
  entities,
  selectedTool,
  selectedEntity,
  selectedRange,
  customFrom,
  customTo,
  entityStatus,
  onToolChange,
  onEntityChange,
  onRangeChange,
  onCustomRangeChange,
}) {
  const selectedToolLabel = tools.find((tool) => tool.key === selectedTool)?.label || 'Monitoring tool';
  const entityLabel = selectedTool === 'abc-hub' ? 'Module' : selectedTool === 'oracle-apex' ? 'Dashboard' : 'Application / Dashboard';
  const entityPlaceholder = selectedTool === 'abc-hub' ? 'Select module' : selectedTool === 'oracle-apex' ? 'Select APEX dashboard' : 'Select application or entity';

  return (
    <Card className="p-5">
      <div className={`grid grid-cols-1 gap-4 ${selectedRange === 'custom' ? 'lg:grid-cols-5' : 'lg:grid-cols-3'}`}>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700">Monitoring Tool</span>
          <select
            className="mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={selectedTool}
            onChange={(event) => onToolChange(event.target.value)}
          >
            {tools.map((tool) => (
              <option key={tool.key} value={tool.key}>
                {tool.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-700">{entityLabel}</span>
          <select
            className="mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:bg-slate-50 disabled:text-slate-400"
            value={selectedEntity}
            onChange={(event) => onEntityChange(event.target.value)}
            disabled={entityStatus === 'loading' || entities.length === 0}
          >
            <option value="">
              {entityStatus === 'loading' ? `Loading ${selectedToolLabel} options...` : entityPlaceholder}
            </option>
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.label} ({entity.recordCount || entity.panelCount || 0})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-700">Time Range</span>
          <select
            className="mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={selectedRange}
            onChange={(event) => onRangeChange(event.target.value)}
          >
            {timeRangeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {selectedRange === 'custom' ? (
          <>
            <label className="block">
              <span className="text-sm font-semibold text-slate-700">From</span>
              <input
                className="mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                type="datetime-local"
                value={toDateTimeLocalValue(customFrom)}
                onChange={(event) => onCustomRangeChange({ from: fromDateTimeLocalValue(event.target.value) })}
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-slate-700">To</span>
              <input
                className="mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                type="datetime-local"
                value={toDateTimeLocalValue(customTo)}
                onChange={(event) => onCustomRangeChange({ to: fromDateTimeLocalValue(event.target.value) })}
              />
            </label>
          </>
        ) : null}
      </div>

      {entityStatus === 'error' ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Unable to load applications for {selectedToolLabel}.
        </div>
      ) : null}

      {entityStatus === 'success' && entities.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          No applications or entities are available for {selectedToolLabel} yet. Sync that integration first, then refresh this page.
        </div>
      ) : null}
    </Card>
  );
}

function entityMatchesSearch(entity, search) {
  const value = search.trim().toLowerCase();

  if (!value) {
    return true;
  }

  return [
    entity.label,
    entity.id,
    entity.dashboardName,
    entity.dashboardUid,
    entity.dashboardSubname,
    entity.metadata?.folderTitle,
    ...(entity.tags || []),
    ...(entity.panelTitles || []),
  ].some((field) => String(field || '').toLowerCase().includes(value));
}

function buildNagiosTotals(entities) {
  const totalRecords = entities.reduce((sum, entity) => sum + Number(entity.recordCount || 0), 0);
  const problemRecords = entities.reduce((sum, entity) => {
    const counts = entity.statusCounts || {};

    return sum + problemStatuses.reduce((statusSum, status) => statusSum + Number(counts[status] || 0), 0);
  }, 0);
  const acknowledgedEntities = entities.filter((entity) => entity.acknowledged).length;
  const lastUpdatedAt = entities
    .map((entity) => entity.lastUpdatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    acknowledgedEntities,
    lastUpdatedAt,
    problemRecords,
    totalEntities: entities.length,
    totalRecords,
  };
}

function NagiosTotalStrip({ entities, selectedTool }) {
  if (!selectedTool.startsWith('nagios-') || !entities.length) {
    return null;
  }

  const totals = buildNagiosTotals(entities);
  const instanceName = selectedTool === 'nagios-d01' ? 'Nagios D01' : 'Nagios D02';

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{instanceName}</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Nagios totals</h2>
          <p className="mt-1 text-sm text-slate-500">Full instance total across all loaded hosts/entities.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Entities</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{totals.totalEntities}</p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total Records</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{totals.totalRecords}</p>
          </div>
          <div className="rounded-md bg-rose-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">Problems</p>
            <p className="mt-1 text-xl font-semibold text-rose-700">{totals.problemRecords}</p>
          </div>
          <div className="rounded-md bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Ack Entities</p>
            <p className="mt-1 text-xl font-semibold text-emerald-700">{totals.acknowledgedEntities}</p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last Updated</p>
            <p className="mt-1 text-sm font-semibold text-slate-950">{formatDateTime(totals.lastUpdatedAt)}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function getNagiosInstanceKey(selectedTool) {
  return selectedTool === 'nagios-d02' ? 'd02' : 'd01';
}

function NagiosHealthBadge({ value }) {
  const normalized = String(value || 'unknown').toLowerCase();
  const styles = {
    healthy: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    connected: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    polling: 'border-yellow-200 bg-yellow-50 text-yellow-700',
    failed: 'border-red-200 bg-red-50 text-red-700',
    disconnected: 'border-red-200 bg-red-50 text-red-700',
    not_configured: 'border-slate-200 bg-slate-100 text-slate-600',
    unknown: 'border-slate-200 bg-slate-100 text-slate-600',
  };
  const label = normalized.replace(/_/g, ' ');

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${styles[normalized] || styles.unknown}`}>
      {label}
    </span>
  );
}

function NagiosFreshnessBadge({ status, seconds }) {
  const normalized = String(status || 'red').toLowerCase();
  const styles = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-700',
    red: 'border-red-200 bg-red-50 text-red-700',
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[normalized] || styles.red}`}>
      {normalized === 'green' ? 'Fresh' : normalized === 'yellow' ? 'Aging' : 'Stale'} · {seconds === null || seconds === undefined ? 'No successful poll' : formatSeconds(seconds)}
    </span>
  );
}

function NagiosMetricCard({ label, value, helper }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
      {helper ? <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p> : null}
    </div>
  );
}

function NagiosHealthDashboard({ healthItem, loading, error, polling, pollMessage, onPoll }) {
  if (loading) {
    return <PageState title="Loading Nagios health" message="Checking connector status and poll history." variant="loading" />;
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {error}
      </div>
    );
  }

  if (!healthItem) {
    return null;
  }

  const { health = {}, statistics = {}, pollHistory = [], instance = {} } = healthItem;
  const latestPoll = pollHistory[0];
  const todayKey = new Date().toDateString();
  const todayPolls = pollHistory.filter((row) => new Date(row.startedAt).toDateString() === todayKey);
  const pollColumns = [
    { key: 'result', label: 'Result', render: (row) => <NagiosHealthBadge value={row.result === 'success' ? 'healthy' : row.result} /> },
    { key: 'startedAt', label: 'Start time', render: (row) => formatDateTime(row.startedAt) },
    { key: 'durationMs', label: 'Duration', render: (row) => formatDuration(row.durationMs) },
    { key: 'httpStatus', label: 'HTTP', render: (row) => row.httpStatus || 'Not available' },
    { key: 'retryCount', label: 'Retries', render: (row) => row.retryCount || 0 },
    { key: 'recordsRetrieved', label: 'Retrieved', render: (row) => formatCount(row.recordsRetrieved) },
    { key: 'recordsInserted', label: 'Inserted', render: (row) => formatCount(row.recordsInserted) },
    { key: 'recordsUpdated', label: 'Updated', render: (row) => formatCount(row.recordsUpdated) },
    { key: 'recordsSkipped', label: 'Skipped', render: (row) => formatCount(row.recordsSkipped) },
    { key: 'failureReason', label: 'Failure reason', render: (row) => row.failureReason || 'None' },
  ];

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">Nagios Health</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">{instance.label || health.label || 'Nagios connector'}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <NagiosHealthBadge value={health.status} />
              <NagiosHealthBadge value={health.connectionHealth} />
              <NagiosFreshnessBadge status={health.dataFreshnessStatus} seconds={health.dataFreshnessSeconds} />
            </div>
            {health.failureReason ? (
              <p className="mt-3 flex items-start gap-2 text-sm leading-6 text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {health.failureStage ? `${health.failureStage}: ` : ''}{health.failureReason}
              </p>
            ) : (
              <p className="mt-3 text-sm leading-6 text-slate-500">
                Poll health is tracked with stage-level diagnostics, retries, response timing, and freshness.
              </p>
            )}
            {pollMessage ? (
              <p className={`mt-3 text-sm ${/failed|unable|error/i.test(pollMessage) ? 'text-rose-700' : 'text-emerald-700'}`}>
                {pollMessage}
              </p>
            ) : null}
          </div>
          {onPoll ? (
            <Button onClick={onPoll} disabled={polling}>
              {polling ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Poll now
            </Button>
          ) : null}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <NagiosMetricCard label="Last Successful Poll" value={formatDateTime(health.lastSuccessfulPoll)} helper={`Next: ${formatDateTime(health.nextScheduledPoll)}`} />
          <NagiosMetricCard label="Last Failed Poll" value={formatDateTime(health.lastFailedPoll)} helper={health.failureType || 'No recent failure'} />
          <NagiosMetricCard label="Response Time" value={formatDuration(health.responseTimeMs)} helper={`HTTP ${health.httpStatus || 'not available'}`} />
          <NagiosMetricCard label="Latest Poll" value={latestPoll?.result || 'No poll yet'} helper={`${formatCount(latestPoll?.recordsRetrieved)} retrieved, ${latestPoll?.retryCount || 0} retries`} />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <NagiosMetricCard label="Today's Polls" value={formatCount(todayPolls.length)} />
          <NagiosMetricCard label="Successful" value={formatCount(statistics.successfulPolls)} />
          <NagiosMetricCard label="Failed" value={formatCount(statistics.failedPolls)} />
          <NagiosMetricCard label="Avg Response" value={formatDuration(statistics.averageResponseTimeMs)} />
          <NagiosMetricCard label="Avg Duration" value={formatDuration(statistics.averagePollDurationMs)} />
          <NagiosMetricCard label="Skipped Unchanged" value={formatCount(statistics.recordsSkipped)} />
        </div>
      </div>

      <NagiosTable title="Nagios Poll History" rows={pollHistory.slice(0, 20)} columns={pollColumns} emptyMessage="No Nagios poll history has been stored yet." />
    </section>
  );
}

function ThousandEyesTestCard({ entity, selected, onSelect }) {
  const custom = getEntityCustomProperties(entity);
  const alertCount = Number(custom.alertCount || 0);
  const activeAlerts = Number(custom.activeAlerts || 0);
  const target = custom.target || custom.endpoint || 'Target not available';
  const lastUpdated = custom.lastUpdatedAt || custom.lastRunAt || entity.lastUpdatedAt;

  return (
    <Card className={`flex h-full flex-col p-4 transition ${selected ? 'ring-2 ring-cyan-300' : 'hover:-translate-y-0.5 hover:shadow-md'}`}>
      <button className="block flex-1 text-left" type="button" onClick={onSelect}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="line-clamp-2 text-base font-semibold text-slate-950">{custom.testName || entity.label}</h3>
              {selected ? (
                <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-xs font-semibold text-white">Selected</span>
              ) : null}
            </div>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {custom.testType || entity.entityType || 'Test'} · {custom.testId || entity.id}
            </p>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-cyan-50 text-cyan-700">
            <Globe2 className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>

        <p className="mt-3 line-clamp-2 break-all text-sm text-slate-600">{target}</p>

        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts</p>
            <p className="mt-1 font-semibold text-slate-950">
              {alertCount}
              {activeAlerts ? <span className="ml-1 text-rose-600">({activeAlerts} active)</span> : null}
            </p>
          </div>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Availability</p>
            <p className="mt-1 font-semibold text-slate-950">{formatPercent(custom.availability)}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Errors</p>
            <p className="mt-1 font-semibold text-slate-950">{formatMetricWithUnit(custom.errorCount, '')}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Updated</p>
            <p className="mt-1 text-xs font-semibold text-slate-950">{formatDateTime(lastUpdated)}</p>
          </div>
        </div>
      </button>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <StatusPill status={entity.status || 'pending'} />
        {entity.deepLink ? (
          <a
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            href={entity.deepLink}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open in ThousandEyes
          </a>
        ) : null}
      </div>
    </Card>
  );
}

function ThousandEyesTestBrowser({
  entities,
  selectedEntity,
  collapsed,
  search,
  onSearchChange,
  onSelectEntity,
  onToggleCollapsed,
}) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [alertCountFilter, setAlertCountFilter] = useState('all');
  const visibleEntities = entities.filter((entity) => (
    thousandEyesEntityMatchesSearch(entity, search) &&
    (statusFilter === 'all' || entity.status === statusFilter) &&
    entityMatchesSeverity(entity, severityFilter) &&
    entityMatchesAlertCount(entity, alertCountFilter)
  ));
  const selectedItem = entities.find((entity) => entity.id === selectedEntity);
  const activeAlerts = entities.reduce((sum, entity) => sum + Number(getEntityCustomProperties(entity).activeAlerts || 0), 0);
  const totalAlerts = entities.reduce((sum, entity) => sum + Number(getEntityCustomProperties(entity).alertCount || 0), 0);
  const averageAvailabilityValues = entities
    .map((entity) => Number(getEntityCustomProperties(entity).availability))
    .filter(Number.isFinite);
  const averageAvailability = averageAvailabilityValues.length
    ? averageAvailabilityValues.reduce((sum, value) => sum + value, 0) / averageAvailabilityValues.length
    : null;

  return (
    <Card className="overflow-hidden">
      <div className={`flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between ${collapsed ? '' : 'border-b border-slate-200'}`}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">ThousandEyes test browser</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Synthetic and network tests</h2>
          {collapsed ? (
            <p className="mt-1 text-sm text-slate-500">
              Browser minimized{selectedItem ? ` · selected: ${selectedItem.label}` : ''}.
            </p>
          ) : (
            <p className="mt-1 text-sm text-slate-500">
              Browse every stored ThousandEyes test with alert count, availability, errors, timestamps, and source links.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="grid grid-cols-4 gap-2 text-sm">
            <div className="rounded-md bg-slate-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tests</p>
              <p className="mt-1 font-semibold text-slate-950">{entities.length}</p>
            </div>
            <div className="rounded-md bg-rose-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">Active</p>
              <p className="mt-1 font-semibold text-rose-700">{activeAlerts}</p>
            </div>
            <div className="rounded-md bg-slate-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts</p>
              <p className="mt-1 font-semibold text-slate-950">{totalAlerts}</p>
            </div>
            <div className="rounded-md bg-emerald-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Avg Avail.</p>
              <p className="mt-1 font-semibold text-emerald-700">{formatPercent(averageAvailability)}</p>
            </div>
          </div>
          <Button variant="secondary" onClick={onToggleCollapsed}>
            {collapsed ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronUp className="h-4 w-4" aria-hidden="true" />}
            {collapsed ? 'Show browser' : 'Hide browser'}
          </Button>
        </div>
      </div>

      {collapsed ? null : (
        <>
          <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 lg:grid-cols-4">
            <label className="relative block lg:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                className="h-10 w-full rounded-md border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search test, application, or target"
              />
            </label>
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="ok">OK</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
              <option value="unknown">Unknown</option>
              <option value="pending">Pending</option>
            </select>
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
            >
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={alertCountFilter}
              onChange={(event) => setAlertCountFilter(event.target.value)}
            >
              <option value="all">All alert counts</option>
              <option value="active">Active alerts only</option>
              <option value="has-alerts">Has alert history</option>
              <option value="no-alerts">No alerts</option>
            </select>
          </div>

          <div className="p-5">
            {visibleEntities.length ? (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                {visibleEntities.map((entity) => (
                  <ThousandEyesTestCard
                    key={entity.id}
                    entity={entity}
                    selected={entity.id === selectedEntity}
                    onSelect={() => onSelectEntity(entity.id)}
                  />
                ))}
              </div>
            ) : (
              <EmptyTable message="No ThousandEyes tests match the current filters." />
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function MonitoringEntityBrowser({
  entities,
  selectedTool,
  selectedEntity,
  collapsed,
  search,
  syncStatus,
  syncMessage,
  onSearchChange,
  onSelectEntity,
  onToggleCollapsed,
  onSyncGrafana,
}) {
  if (selectedTool === 'thousandeyes') {
    return (
      <ThousandEyesTestBrowser
        entities={entities}
        selectedEntity={selectedEntity}
        collapsed={collapsed}
        search={search}
        onSearchChange={onSearchChange}
        onSelectEntity={onSelectEntity}
        onToggleCollapsed={onToggleCollapsed}
      />
    );
  }

  const isGrafana = selectedTool === 'grafana';
  const isAbcHub = selectedTool === 'abc-hub';
  const isOracleApex = selectedTool === 'oracle-apex';
  const visibleEntities = entities.filter((entity) => entityMatchesSearch(entity, search));
  const totalRecords = entities.reduce((sum, entity) => sum + Number(entity.panelCount || entity.recordCount || 0), 0);
  const totalProblems = entities.reduce((sum, entity) => {
    const counts = entity.statusCounts || {};

    return sum + problemStatuses.reduce((statusSum, status) => statusSum + Number(counts[status] || 0), 0);
  }, 0);
  const folders = new Set(entities.map((entity) => entity.dashboardSubname || entity.metadata?.folderTitle).filter(Boolean));
  const selectedItem = entities.find((entity) => entity.id === selectedEntity);
  const visibleGroups = isGrafana
    ? Object.entries(visibleEntities.reduce((groups, entity) => {
      const folderName = entity.dashboardSubname || entity.metadata?.folderTitle || 'General';
      groups[folderName] = [...(groups[folderName] || []), entity];
      return groups;
    }, {})).sort(([left], [right]) => left.localeCompare(right))
    : [['Entities', visibleEntities]];

  if (!entities.length) {
    return null;
  }

  return (
    <Card className="overflow-hidden">
      <div className={`flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between ${collapsed ? '' : 'border-b border-slate-200'}`}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">
            {isGrafana || isOracleApex ? 'Dashboard browser' : isAbcHub ? 'Module browser' : 'Entity browser'}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">
            {isGrafana ? 'Available Grafana dashboards' : isOracleApex ? 'Available Oracle APEX dashboards' : isAbcHub ? 'ABC Hub monitoring modules' : 'Available applications and entities'}
          </h2>
          {collapsed ? (
            <p className="mt-1 text-sm text-slate-500">
              Browser minimized{selectedItem ? ` · selected: ${selectedItem.label}` : ''}.
            </p>
          ) : (
            <p className="mt-1 text-sm text-slate-500">
              {isGrafana
                ? 'Browse synced folders, dashboard names, panel metadata, timestamps, and source links.'
                : isOracleApex
                  ? 'Select the PF & ETL Dashboard to import and inspect read-only APEX report rows.'
                  : isAbcHub
                    ? 'Select Daemon Monitor or Report Monitoring to load ABC Hub operational status and history.'
                    : 'Select an entity to load normalized monitoring records and recent events.'}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-md bg-slate-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{isGrafana || isOracleApex ? 'Dashboards' : isAbcHub ? 'Modules' : 'Entities'}</p>
              <p className="mt-1 font-semibold text-slate-950">{entities.length}</p>
            </div>
            <div className="rounded-md bg-slate-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{isGrafana ? 'Folders' : 'Problems'}</p>
              <p className="mt-1 font-semibold text-slate-950">{isGrafana ? folders.size : totalProblems}</p>
            </div>
            <div className="rounded-md bg-slate-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{isGrafana ? 'Panels' : 'Total Records'}</p>
              <p className="mt-1 font-semibold text-slate-950">{totalRecords}</p>
            </div>
          </div>
          {isGrafana ? (
            <Button variant="secondary" onClick={onSyncGrafana} disabled={syncStatus === 'loading'}>
              {syncStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Sync Grafana
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onToggleCollapsed}>
            {collapsed ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronUp className="h-4 w-4" aria-hidden="true" />}
            {collapsed ? 'Show browser' : 'Hide browser'}
          </Button>
        </div>
      </div>

      {collapsed ? null : (
        <>
      {isGrafana && syncMessage ? (
        <div className={`mx-4 mt-4 rounded-md border p-3 text-sm ${
          syncStatus === 'error'
            ? 'border-rose-200 bg-rose-50 text-rose-800'
            : 'border-emerald-200 bg-emerald-50 text-emerald-800'
        }`}>
          {syncMessage}
        </div>
      ) : null}

      <div className="border-b border-slate-200 p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            className="h-10 w-full rounded-md border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={isGrafana ? 'Search dashboard, folder, tag, UID, or panel name' : 'Search application or entity'}
          />
        </label>
      </div>

      {visibleEntities.length ? (
        <div className="divide-y divide-slate-100">
          {visibleGroups.map(([groupName, groupEntities]) => (
            <div key={groupName} className="divide-y divide-slate-100">
              {isGrafana ? (
                <div className="bg-slate-50 px-5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">{groupName}</p>
                    <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-500">{groupEntities.length} dashboards</span>
                  </div>
                </div>
              ) : null}
              {groupEntities.map((entity) => {
                const isSelected = entity.id === selectedEntity;
                const subname = entity.dashboardSubname || entity.metadata?.folderTitle || entity.entityType || 'General';

                return (
                  <button
                    key={entity.id}
                    className={`block w-full px-5 py-4 text-left transition hover:bg-slate-50 ${
                      isSelected ? 'bg-cyan-50/70 ring-1 ring-inset ring-cyan-200' : 'bg-white'
                    }`}
                    type="button"
                    onClick={() => onSelectEntity(entity.id)}
                  >
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-words text-sm font-semibold text-slate-950">{entity.dashboardName || entity.label}</h3>
                          {isSelected ? (
                            <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-xs font-semibold text-white">Selected</span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                            {isAbcHub ? 'ABC Hub' : isOracleApex ? 'Oracle APEX' : subname} {entity.dashboardUid || entity.id ? `· ${entity.dashboardUid || entity.id}` : ''}
                        </p>
                        {entity.panelTitles?.length ? (
                          <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">
                            Panels: {entity.panelTitles.slice(0, 6).join(', ')}
                          </p>
                        ) : (
                          <p className="mt-2 text-xs leading-5 text-slate-500">
                            {isGrafana ? 'No panel names are stored for this dashboard yet.' : entity.metadata?.description || `${entity.recordCount || 0} normalized records stored.`}
                          </p>
                        )}
                        {entity.tags?.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {entity.tags.slice(0, 6).map((tag) => (
                              <span key={`${entity.id}:${tag}`} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <div className="grid shrink-0 grid-cols-2 gap-2 text-xs sm:grid-cols-4 xl:min-w-[520px]">
                        <div className="rounded-md bg-white/80 px-3 py-2 ring-1 ring-slate-200">
                          <p className="font-semibold uppercase tracking-wide text-slate-500">{isGrafana ? 'Panels' : 'Records'}</p>
                          <p className="mt-1 text-sm font-semibold text-slate-950">{entity.panelCount || entity.recordCount || 0}</p>
                        </div>
                        <div className="rounded-md bg-white/80 px-3 py-2 ring-1 ring-slate-200">
                          <p className="font-semibold uppercase tracking-wide text-slate-500">Updated</p>
                          <p className="mt-1 text-sm font-semibold text-slate-950">{formatDateTime(entity.lastUpdatedAt)}</p>
                        </div>
                        <div className="rounded-md bg-white/80 px-3 py-2 ring-1 ring-slate-200">
                          <p className="font-semibold uppercase tracking-wide text-slate-500">Refreshed</p>
                          <p className="mt-1 text-sm font-semibold text-slate-950">{formatDateTime(entity.lastRefreshedAt || entity.lastUpdatedAt)}</p>
                        </div>
                        <div className="rounded-md bg-white/80 px-3 py-2 ring-1 ring-slate-200">
                          <p className="font-semibold uppercase tracking-wide text-slate-500">Status</p>
                          <div className="mt-1">
                            <StatusPill status={entity.status || 'pending'} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="p-5">
          <EmptyTable message="No dashboards or entities match the current search." />
        </div>
      )}
        </>
      )}
    </Card>
  );
}

function MonitoringSummary({ detail }) {
  const summary = detail.summary || {};
  const statusCounts = summary.statusCounts || {};
  const keyMetrics = detail.keyMetrics || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">
            {detail.tool?.label || 'Monitoring'} · {detail.application?.entityType || 'entity'}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-slate-950">{detail.application?.label}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Showing normalized monitoring data for the selected tool and entity only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={summary.status || 'pending'} />
          {detail.deepLink ? (
            <a
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              href={detail.deepLink}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open source
            </a>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Records</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{summary.total || 0}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Problem records</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{summary.problems || 0}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Acknowledged</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{summary.acknowledged || 0}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Last check</p>
          <p className="mt-2 text-sm font-semibold text-slate-950">{formatDateTime(summary.lastCheck || detail.lastUpdatedAt)}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="font-semibold text-slate-950">Status summary</h3>
          {Object.keys(statusCounts).length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(statusCounts).map(([status, value]) => (
                <span key={status} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  <span className={`h-2.5 w-2.5 rounded-full ${statusDotStyles[status] || statusDotStyles.pending}`} />
                  <span className="font-semibold">{statusLabel(status)}</span>
                  <span className="text-slate-500">{value}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No status values are available yet.</p>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold text-slate-950">Key metrics</h3>
          {keyMetrics.length ? (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {keyMetrics.map((metric) => (
                <div key={metric.label} className="rounded-md bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{metric.label}</p>
                  <p className="mt-1 break-words text-sm font-semibold text-slate-950">{formatMetricValue(metric.value)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No key metrics are available yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function MonitoringRecordTable({ records }) {
  const columns = [
    { key: 'entityType', label: 'Type' },
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'summary', label: 'Summary' },
    { key: 'details', label: 'Details', render: (row) => row.details || 'Not available' },
    { key: 'acknowledged', label: 'Ack', render: (row) => (row.acknowledged ? 'Yes' : 'No') },
    { key: 'lastCheck', label: 'Last check', render: (row) => formatDateTime(row.lastCheck) },
    {
      key: 'deepLink',
      label: 'Source',
      render: (row) => (row.deepLink ? (
        <a className="font-medium text-cyan-700 hover:text-cyan-900" href={row.deepLink} target="_blank" rel="noreferrer">
          Open
        </a>
      ) : 'Not available'),
    },
  ];

  return <NagiosTable title="Selected Entity Records" rows={records || []} columns={columns} emptyMessage="No monitoring records match this selection." />;
}

function AppDynamicsKpiCard({ label, value, helper, tone = 'slate' }) {
  const toneClasses = {
    slate: 'bg-slate-50 text-slate-700 border-slate-100',
    cyan: 'bg-cyan-50 text-cyan-700 border-cyan-100',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    red: 'bg-rose-50 text-rose-700 border-rose-100',
  };

  return (
    <Card className="p-4">
      <div className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${toneClasses[tone] || toneClasses.slate}`}>
        {label}
      </div>
      <p className="mt-3 text-2xl font-semibold text-slate-950">{formatMetricValue(value)}</p>
      {helper ? <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p> : null}
    </Card>
  );
}

function AppDynamicsDashboard({ detail }) {
  const dashboard = detail.dashboard || {};
  const overview = dashboard.overview || {};
  const score = detail.transactionScore || dashboard.transactionScore || {};
  const metricTimeline = (detail.metricTimeline || dashboard.metricTimeline || []).map((point) => ({
    ...point,
    label: formatChartTime(point.timestamp),
  }));
  const businessTransactions = detail.businessTransactions || dashboard.businessTransactions || [];
  const nodes = detail.nodes || dashboard.nodes || [];
  const servers = detail.servers || dashboard.servers || [];
  const events = detail.appDynamicsEvents || dashboard.events || [];
  const snapshots = detail.snapshots || dashboard.snapshots || [];
  const flowMap = detail.flowMap || dashboard.flowMap || [];
  const aiFeatures = detail.aiFeatures || dashboard.aiFeatures || [];
  const transactionRows = businessTransactions.slice(0, 100);
  const nodeRows = nodes.slice(0, 100);
  const eventRows = events.slice(0, 100);
  const snapshotRows = snapshots.slice(0, 100);
  const statusDistribution = Object.entries(events.reduce((counts, event) => {
    const key = event.status || event.severity || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {})).map(([name, value]) => ({ name, value }));
  const transactionColumns = [
    { key: 'health', label: 'Health', render: (row) => <StatusPill status={row.health || 'pending'} /> },
    { key: 'business_transaction_name', label: 'Business Transaction' },
    { key: 'tier_name', label: 'Tier', render: (row) => row.tier_name || 'Not available' },
    { key: 'response_time', label: 'Response Time', render: (row) => formatMetricWithUnit(row.response_time, 'ms') },
    { key: 'calls_per_minute', label: 'Calls/min', render: (row) => formatMetricValue(row.calls_per_minute) },
    { key: 'errors_per_minute', label: 'Errors/min', render: (row) => formatMetricValue(row.errors_per_minute) },
    { key: 'error_percent', label: 'Error %', render: (row) => formatPercent(row.error_percent) },
    { key: 'last_seen_at', label: 'Last Seen', render: (row) => formatDateTime(row.last_seen_at || row.updated_at) },
  ];
  const nodeColumns = [
    { key: 'health', label: 'Health', render: (row) => <StatusPill status={row.health || 'pending'} /> },
    { key: 'node_name', label: 'Node' },
    { key: 'tier_name', label: 'Tier', render: (row) => row.tier_name || 'Not available' },
    { key: 'server_name', label: 'Server', render: (row) => row.server_name || 'Not available' },
    { key: 'cpu', label: 'CPU', render: (row) => formatPercent(row.cpu) },
    { key: 'memory', label: 'Memory', render: (row) => formatPercent(row.memory) },
    { key: 'availability', label: 'Availability', render: (row) => formatPercent(row.availability) },
  ];
  const eventColumns = [
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status || row.severity || 'pending'} /> },
    { key: 'event_type', label: 'Type', render: (row) => row.event_type || 'event' },
    { key: 'summary', label: 'Summary' },
    { key: 'tier_name', label: 'Tier', render: (row) => row.tier_name || 'Not available' },
    { key: 'node_name', label: 'Node', render: (row) => row.node_name || 'Not available' },
    { key: 'event_time', label: 'Time', render: (row) => formatDateTime(row.event_time) },
  ];
  const snapshotColumns = [
    { key: 'business_transaction_name', label: 'Business Transaction', render: (row) => row.business_transaction_name || 'Not available' },
    { key: 'snapshot_type', label: 'Type', render: (row) => row.snapshot_type || 'request' },
    { key: 'execution_time_ms', label: 'Execution', render: (row) => formatMetricWithUnit(row.execution_time_ms, 'ms') },
    { key: 'sql_call_count', label: 'SQL Calls', render: (row) => formatMetricValue(row.sql_call_count) },
    { key: 'remote_call_count', label: 'Remote Calls', render: (row) => formatMetricValue(row.remote_call_count) },
    { key: 'exception_count', label: 'Exceptions', render: (row) => formatMetricValue(row.exception_count) },
    { key: 'started_at', label: 'Started', render: (row) => formatDateTime(row.started_at) },
  ];
  const aiColumns = [
    { key: 'ai_label', label: 'AI Label', render: (row) => row.ai_label || 'unknown' },
    { key: 'entity_name', label: 'Entity' },
    { key: 'source_module', label: 'Module' },
    { key: 'ai_confidence', label: 'Confidence', render: (row) => formatPercent(Number(row.ai_confidence || 0) * 100) },
    { key: 'ai_reason', label: 'Reason', render: (row) => row.ai_reason || 'Feature row prepared for future model.' },
  ];

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-cyan-600 text-white">
            <Activity className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">Splunk AppDynamics</p>
            <h2 className="text-xl font-semibold text-slate-950">{overview.applicationName || detail.application?.label}</h2>
            <p className="mt-1 text-sm text-slate-500">
              Application health, topology, business transactions, snapshots, and event context stored from the controller API.
            </p>
          </div>
        </div>
        {detail.deepLink ? (
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            href={detail.deepLink}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open in AppDynamics
          </a>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
        <AppDynamicsKpiCard label="Applications" value={overview.applicationName ? 1 : 0} helper={overview.status || 'cached'} tone="cyan" />
        <AppDynamicsKpiCard label="Business Transactions" value={businessTransactions.length} helper={`${formatMetricValue(score.callsPerMinute)} calls/min`} />
        <AppDynamicsKpiCard label="Nodes" value={nodes.length} helper={`${servers.length} servers`} />
        <AppDynamicsKpiCard label="Snapshots" value={snapshots.length} helper="Recent request snapshots" />
        <AppDynamicsKpiCard label="Events" value={events.length} helper="Recent controller events" tone={events.some((event) => event.status === 'critical') ? 'red' : 'amber'} />
        <AppDynamicsKpiCard label="Avg Response" value={formatMetricWithUnit(score.averageResponseTime, 'ms')} helper="From transaction rows" tone="green" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-4 xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Application performance trend</h3>
              <p className="mt-1 text-sm text-slate-500">Metric points cached from AppDynamics metric-data.</p>
            </div>
            <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700">{metricTimeline.length} points</span>
          </div>
          {metricTimeline.length ? (
            <div className="mt-4 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={metricTimeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="responseTime" name="Response time" stroke={chartPalette.cyan} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="callsPerMinute" name="Calls/min" stroke={chartPalette.navy} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="errorsPerMinute" name="Errors/min" stroke={chartPalette.red} strokeWidth={2} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyTable message="No AppDynamics metric series are stored yet. Sync AppDynamics after credentials are configured." />
          )}
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold text-slate-950">Event state mix</h3>
          {statusDistribution.length ? (
            <div className="mt-4 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusDistribution} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={4}>
                    {statusDistribution.map((entry) => (
                      <Cell key={entry.name} fill={entry.name === 'critical' ? chartPalette.red : entry.name === 'warning' ? chartPalette.amber : chartPalette.cyan} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyTable message="No AppDynamics event states are stored yet." />
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-950">Application flow map</h3>
            <p className="mt-1 text-sm text-slate-500">Stored tier and node relationships; richer service edges can be added when the controller exposes them.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{flowMap.length} entities</span>
        </div>
        {flowMap.length ? (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {flowMap.slice(0, 24).map((item) => (
              <div key={`${item.entity_type}:${item.entity_id}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-slate-950">{item.entity_name}</p>
                  <StatusPill status={item.health || 'pending'} />
                </div>
                <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{item.entity_type}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {item.source_entity_id ? `Source: ${item.source_entity_id}` : 'Root entity'}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyTable message="No AppDynamics topology rows are stored yet." />
        )}
      </Card>

      <NagiosTable title="Business Transactions" rows={transactionRows} columns={transactionColumns} emptyMessage="No AppDynamics business transactions are stored yet." />
      <NagiosTable title="Nodes and Application Agents" rows={nodeRows} columns={nodeColumns} emptyMessage="No AppDynamics nodes are stored yet." />
      <NagiosTable title="Recent Events" rows={eventRows} columns={eventColumns} emptyMessage="No AppDynamics events are stored yet." />
      <NagiosTable title="Request Snapshots" rows={snapshotRows} columns={snapshotColumns} emptyMessage="No AppDynamics snapshots are stored yet." />
      <NagiosTable title="AI-Ready AppDynamics Features" rows={aiFeatures.slice(0, 100)} columns={aiColumns} emptyMessage="AI-ready AppDynamics feature rows will appear after sync." />
    </section>
  );
}

function paymentRecordValue(record, key) {
  const custom = record.customProperties || {};

  return custom[key] ?? custom[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
}

function normalizedPaymentStatus(record) {
  return String(paymentRecordValue(record, 'status') || paymentRecordValue(record, 'paymentStatus') || 'UNKNOWN').toUpperCase();
}

function formatCurrency(value, currency = 'USD') {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return '$0.00';
  }

  return numeric.toLocaleString(undefined, {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 2,
  });
}

function buildPaymentAnalyticsFromRecords(records) {
  const total = records.length;
  const successCount = records.filter((record) => normalizedPaymentStatus(record) === 'SUCCESS').length;
  const failureCount = records.filter((record) => normalizedPaymentStatus(record) === 'FAILED').length;
  const pendingCount = records.filter((record) => normalizedPaymentStatus(record) === 'PENDING').length;
  const settledCount = records.filter((record) => Boolean(paymentRecordValue(record, 'settled'))).length;
  const amountTotal = records.reduce((sum, record) => sum + Number(paymentRecordValue(record, 'amount') || 0), 0);
  const successRate = total ? Number(((successCount / total) * 100).toFixed(1)) : 0;

  return {
    total,
    successCount,
    failureCount,
    pendingCount,
    settledCount,
    amountTotal,
    successRate,
  };
}

function getPaymentBucketSize(detail) {
  const from = new Date(detail.timeRange?.from);
  const to = new Date(detail.timeRange?.to);
  const minutes = Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())
    ? Math.max(1, Math.round((to.getTime() - from.getTime()) / 60000))
    : 60;

  if (minutes <= 30) return 5 * 60 * 1000;
  if (minutes <= 120) return 10 * 60 * 1000;
  if (minutes <= 360) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

function formatChartTime(value) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function buildPaymentTimeSeries(records, detail) {
  const bucketSize = getPaymentBucketSize(detail);
  const buckets = new Map();

  records.forEach((record) => {
    const timestamp = new Date(record.lastCheck || record.updatedAt).getTime();

    if (!Number.isFinite(timestamp)) {
      return;
    }

    const bucketStart = Math.floor(timestamp / bucketSize) * bucketSize;
    const bucket = buckets.get(bucketStart) || {
      timestamp: bucketStart,
      label: formatChartTime(bucketStart),
      total: 0,
      success: 0,
      failures: 0,
      pending: 0,
      amountTotal: 0,
    };
    const paymentStatus = normalizedPaymentStatus(record);
    const amount = Number(paymentRecordValue(record, 'amount'));

    bucket.total += 1;
    bucket.success += paymentStatus === 'SUCCESS' ? 1 : 0;
    bucket.failures += paymentStatus === 'FAILED' ? 1 : 0;
    bucket.pending += paymentStatus === 'PENDING' ? 1 : 0;
    bucket.amountTotal += Number.isFinite(amount) ? amount : 0;

    buckets.set(bucketStart, bucket);
  });

  return [...buckets.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((bucket) => ({
      ...bucket,
      successRate: bucket.total ? Number(((bucket.success / bucket.total) * 100).toFixed(1)) : 0,
      amountTotal: Number(bucket.amountTotal.toFixed(2)),
    }));
}

function buildPaymentStatusData(records) {
  const counts = records.reduce((items, record) => {
    const status = normalizedPaymentStatus(record);

    items[status] = (items[status] || 0) + 1;
    return items;
  }, {});

  return Object.entries(counts).map(([name, value]) => ({ name, value }));
}

function buildPaymentResponseCodeData(records) {
  const counts = records.reduce((items, record) => {
    const responseCode = paymentRecordValue(record, 'responseCode') || 'UNKNOWN';

    items[responseCode] = (items[responseCode] || 0) + 1;
    return items;
  }, {});

  return Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
}

function buildPaymentDistributionData(records, key, fallback = 'Unknown', limit = 10) {
  const counts = records.reduce((items, record) => {
    const value = paymentRecordValue(record, key) || fallback;

    items[value] = (items[value] || 0) + 1;
    return items;
  }, {});

  return Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function buildPaymentProcessorData(records) {
  const processors = records.reduce((items, record) => {
    const name = paymentRecordValue(record, 'processorName') || 'Unknown processor';
    const current = items[name] || {
      name,
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      amount: 0,
    };
    const status = normalizedPaymentStatus(record);

    current.total += 1;
    current.success += status === 'SUCCESS' ? 1 : 0;
    current.failed += status === 'FAILED' ? 1 : 0;
    current.pending += status === 'PENDING' ? 1 : 0;
    current.amount += Number(paymentRecordValue(record, 'amount') || 0);
    items[name] = current;

    return items;
  }, {});

  return Object.values(processors)
    .map((item) => ({
      ...item,
      successRate: item.total ? Number(((item.success / item.total) * 100).toFixed(1)) : 0,
      amount: Number(item.amount.toFixed(2)),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}

function paymentFilterOptions(records, key) {
  return [...new Set(records.map((record) => paymentRecordValue(record, key)).filter(Boolean))]
    .map(String)
    .sort((a, b) => a.localeCompare(b));
}

function paymentSearchText(record) {
  return [
    paymentRecordValue(record, 'uniqueTransactionNumber'),
    paymentRecordValue(record, 'referenceId'),
    paymentRecordValue(record, 'merchant'),
    paymentRecordValue(record, 'merchantNumber'),
    paymentRecordValue(record, 'merchantId'),
    paymentRecordValue(record, 'merchantReference'),
    paymentRecordValue(record, 'accountHolderName'),
    paymentRecordValue(record, 'processorName'),
    paymentRecordValue(record, 'transactionType'),
    paymentRecordValue(record, 'paymentAction'),
    paymentRecordValue(record, 'responseCode'),
    paymentRecordValue(record, 'status'),
    paymentRecordValue(record, 'source'),
    paymentRecordValue(record, 'descriptor'),
    paymentRecordValue(record, 'payerId'),
    paymentRecordValue(record, 'memberNumber'),
  ].filter(Boolean).join(' ').toLowerCase();
}

function sortPaymentRecords(records, sortKey, sortDirection) {
  const direction = sortDirection === 'asc' ? 1 : -1;

  return [...records].sort((a, b) => {
    const aValue = ['createdDate', 'creationDate', 'effectiveDate'].includes(sortKey)
      ? new Date(paymentRecordValue(a, 'createdDate') || a.lastCheck).getTime()
      : sortKey === 'amount'
        ? Number(paymentRecordValue(a, 'amount') || 0)
        : String(paymentRecordValue(a, sortKey) || '').toLowerCase();
    const bValue = ['createdDate', 'creationDate', 'effectiveDate'].includes(sortKey)
      ? new Date(paymentRecordValue(b, 'createdDate') || b.lastCheck).getTime()
      : sortKey === 'amount'
        ? Number(paymentRecordValue(b, 'amount') || 0)
        : String(paymentRecordValue(b, sortKey) || '').toLowerCase();

    if (aValue < bValue) return -1 * direction;
    if (aValue > bValue) return 1 * direction;
    return 0;
  });
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);

  return `"${text.replace(/"/g, '""')}"`;
}

function exportPaymentCsv(records) {
  const columns = [
    ['merchant', (row) => paymentRecordValue(row, 'merchant')],
    ['merchant_number', (row) => paymentRecordValue(row, 'merchantNumber') || paymentRecordValue(row, 'merchantId')],
    ['account_holder_name', (row) => paymentRecordValue(row, 'accountHolderName')],
    ['last_four', (row) => paymentRecordValue(row, 'lastFour') ? `****${paymentRecordValue(row, 'lastFour')}` : ''],
    ['unique_transaction_number', (row) => paymentRecordValue(row, 'uniqueTransactionNumber') || row.entityId],
    ['transaction_type', (row) => paymentRecordValue(row, 'transactionType')],
    ['source', (row) => paymentRecordValue(row, 'source')],
    ['sec_code', (row) => paymentRecordValue(row, 'secCode')],
    ['amount', (row) => paymentRecordValue(row, 'amount')],
    ['payment_action', (row) => paymentRecordValue(row, 'paymentAction')],
    ['response_code', (row) => paymentRecordValue(row, 'responseCode')],
    ['status', (row) => normalizedPaymentStatus(row)],
    ['creation_date', (row) => paymentRecordValue(row, 'creationDate')],
    ['creation_time_utc', (row) => paymentRecordValue(row, 'creationTimeUtc')],
    ['effective_date', (row) => paymentRecordValue(row, 'effectiveDate')],
    ['effective_time_utc', (row) => paymentRecordValue(row, 'effectiveTimeUtc')],
    ['payer_id', (row) => paymentRecordValue(row, 'payerId')],
    ['member_number', (row) => paymentRecordValue(row, 'memberNumber')],
  ];
  const csv = [
    columns.map(([label]) => csvEscape(label)).join(','),
    ...records.map((row) => columns.map(([, getter]) => csvEscape(getter(row))).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `payment-gateway-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function labelFromKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildApexColumns(columns, jobs) {
  if (columns?.length) {
    return columns
      .filter((column) => column.visible !== false)
      .map((column) => ({
        key: column.key,
        label: column.label || column.name || labelFromKey(column.key),
        type: column.type || 'unknown',
        displayOrder: column.displayOrder || 999,
      }))
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }

  const keys = new Set();
  jobs.slice(0, 20).forEach((job) => {
    Object.keys(job.rowValues || {}).forEach((key) => keys.add(key));
  });

  return [...keys].map((key, index) => ({
    key,
    label: labelFromKey(key),
    type: 'unknown',
    displayOrder: index + 1,
  }));
}

function apexRowValue(job, key) {
  return job.rowValues?.[key] ?? job.rawPayload?.row?.[key] ?? '';
}

function formatApexValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Not available';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function apexSearchText(job) {
  return [
    job.entityId,
    job.entityName,
    job.status,
    job.severity,
    job.summary,
    job.environment,
    ...Object.values(job.rowValues || {}),
  ].map(formatApexValue).join(' ').toLowerCase();
}

function sortApexJobs(jobs, sortKey, sortDirection) {
  const direction = sortDirection === 'asc' ? 1 : -1;

  return [...jobs].sort((left, right) => {
    const leftValue = sortKey.startsWith('column:')
      ? formatApexValue(apexRowValue(left, sortKey.replace('column:', ''))).toLowerCase()
      : sortKey === 'lastUpdated'
        ? new Date(left.lastUpdated || left.timestamp || 0).getTime()
        : formatApexValue(left[sortKey]).toLowerCase();
    const rightValue = sortKey.startsWith('column:')
      ? formatApexValue(apexRowValue(right, sortKey.replace('column:', ''))).toLowerCase()
      : sortKey === 'lastUpdated'
        ? new Date(right.lastUpdated || right.timestamp || 0).getTime()
        : formatApexValue(right[sortKey]).toLowerCase();

    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return 1 * direction;
    return 0;
  });
}

function exportApexCsv(jobs, dynamicColumns) {
  const columns = [
    ['entity_id', (row) => row.entityId],
    ['entity_name', (row) => row.entityName],
    ['status', (row) => row.status],
    ['severity', (row) => row.severity],
    ['last_updated', (row) => row.lastUpdated],
    ...dynamicColumns.map((column) => [column.key, (row) => apexRowValue(row, column.key)]),
  ];
  const csv = [
    columns.map(([label]) => csvEscape(label)).join(','),
    ...jobs.map((row) => columns.map(([, getter]) => csvEscape(getter(row))).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `oracle-apex-pf-etl-dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function ApexKpiCard({ label, value, helper, tone = 'slate' }) {
  const toneClasses = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    red: 'bg-rose-50 text-rose-700 border-rose-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    cyan: 'bg-cyan-50 text-cyan-700 border-cyan-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-100',
  };

  return (
    <Card className="p-4">
      <div className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${toneClasses[tone] || toneClasses.slate}`}>
        {label}
      </div>
      <p className="mt-3 text-2xl font-semibold text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{helper}</p>
    </Card>
  );
}

function apexFirstValue(job, keys, fallback = '') {
  for (const key of keys) {
    const value = apexRowValue(job, key);

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return fallback;
}

function getApexCardModel(job) {
  const name = apexFirstValue(job, ['job_name', 'column_1'], job.entityName);
  const groupName = apexFirstValue(job, ['workflow_group'], getApexSectionName({ name }));
  const statusFlag = String(apexFirstValue(job, ['status_flag', 'column_5'], job.status)).toLowerCase();
  const isWarning = statusFlag.includes('warning') || job.status === 'delayed' || job.severity === 'warning';
  const isFailed = job.status === 'failed' || job.severity === 'critical';
  const startTime = apexFirstValue(job, ['start_time', 'column_2']);
  const finishTime = apexFirstValue(job, ['finish_time', 'column_3']);
  const completedSteps = apexFirstValue(job, ['completed_steps', 'column_8']);

  return {
    id: job.entityId,
    name,
    groupName,
    status: job.status,
    severity: job.severity,
    startTime,
    finishTime,
    pastFinishTimes: apexFirstValue(job, ['past_finish_times', 'column_4']),
    statusFlag,
    jobStep: apexFirstValue(job, ['job_step', 'column_6']),
    completedSteps,
    completedStepCount: apexFirstValue(job, ['completed_step_count']),
    totalStepCount: apexFirstValue(job, ['total_step_count']),
    completionRate: apexFirstValue(job, ['completion_rate']),
    executionDurationSeconds: Number(apexFirstValue(job, ['execution_duration_seconds'])) || null,
    server: apexFirstValue(job, ['server'], job.customProperties?.server),
    environment: job.environment || apexFirstValue(job, ['environment'], 'production'),
    lastUpdated: job.lastUpdated || job.timestamp,
    statusIcon: apexFirstValue(job, ['status_icon', 'column_7']),
    detailLink: apexFirstValue(job, ['detail_link', 'column_9'], job.deepLink),
    isWarning,
    isFailed,
    rawJob: job,
  };
}

function getApexSectionName(card) {
  const name = String(card.name || '').toUpperCase();

  if (/PF_SNAPSHOT_ETL_GROUP\d+/.test(name)) {
    return 'PF SNAPSHOT GROUPS';
  }

  if (/DAYEND|BPD|ISERIES/.test(name)) {
    return 'ISERIES';
  }

  if (/SNAPSHOT/.test(name)) {
    return 'PF SNAPSHOT';
  }

  return 'ETL JOBS';
}

function groupApexCards(cards) {
  const preferredOrder = ['ISERIES', 'PF SNAPSHOT GROUPS', 'PF SNAPSHOT', 'ETL JOBS'];
  const groups = cards.reduce((result, card) => {
    const sectionName = card.groupName || getApexSectionName(card);

    result[sectionName] = [...(result[sectionName] || []), card];
    return result;
  }, {});

  ['PF SNAPSHOT GROUPS'].forEach((sectionName) => {
    if (!groups[sectionName]) {
      groups[sectionName] = [];
    }
  });

  return Object.entries(groups)
    .sort(([left], [right]) => {
      const leftIndex = preferredOrder.indexOf(left);
      const rightIndex = preferredOrder.indexOf(right);

      return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
    })
    .map(([title, sectionCards]) => [title, sectionCards.sort((left, right) => String(left.name).localeCompare(String(right.name)))]);
}

function resolveApexCardLink(value, fallbackBaseUrl) {
  if (!value) {
    return '';
  }

  const text = String(value);

  try {
    if (text.startsWith('#action')) {
      const queryText = text.includes('?') ? text.slice(text.indexOf('?') + 1) : '';
      const params = new URLSearchParams(queryText);
      const url = params.get('url');

      return url ? new URL(url, fallbackBaseUrl || window.location.origin).toString() : '';
    }

    return new URL(text, fallbackBaseUrl || window.location.origin).toString();
  } catch {
    return '';
  }
}

function ApexInsightPill({ label, value }) {
  return (
    <div className="rounded-md bg-white/70 px-3 py-2 ring-1 ring-slate-200">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-slate-950">{value}</p>
    </div>
  );
}

function ApexJobCard({ card, feature, baseUrl }) {
  const cardTone = card.isFailed
    ? 'border-red-200 bg-red-50'
    : card.isWarning
      ? 'border-orange-200 bg-orange-50'
      : card.status === 'running'
        ? 'border-yellow-200 bg-yellow-50'
        : card.status === 'queued'
          ? 'border-blue-200 bg-blue-50'
      : 'border-slate-200 bg-white';
  const iconTone = card.isFailed ? 'text-red-600' : 'text-green-600';
  const openLink = resolveApexCardLink(card.detailLink, baseUrl);
  const fields = [
    ['Group Name', card.groupName],
    ['Current Status', statusLabel(card.status)],
    ['Start Time', card.startTime],
    ['Finish Time', card.finishTime],
    ['Past Finish-Times', card.pastFinishTimes],
    ['Job Step', card.jobStep],
    ['Completed Steps', card.completedSteps],
    ['Execution Duration', formatSeconds(card.executionDurationSeconds)],
    ['Server', card.server],
    ['Environment', card.environment],
    ['Last Updated', formatDateTime(card.lastUpdated)],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');

  return (
    <Card className={`overflow-hidden border ${cardTone}`}>
      <div className="flex items-start justify-between gap-4 border-b border-black/5 px-5 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <CheckCircle2 className={`h-7 w-7 shrink-0 ${iconTone}`} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="break-words font-mono text-lg font-bold tracking-tight text-slate-950">{card.name}</h3>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{card.groupName}</p>
          </div>
        </div>
        <StatusPill status={card.status} />
      </div>
      <div className="space-y-2 px-5 py-5 text-base">
        {fields.map(([label, value]) => (
          <div key={`${card.id}:${label}`} className="grid grid-cols-[170px_1fr] gap-3">
            <span className="text-slate-950">{label}</span>
            <span className="break-words font-bold text-slate-950">{formatApexValue(value)}</span>
          </div>
        ))}
        {!fields.length ? (
          <p className="text-sm text-slate-500">No timing details were available in this APEX row.</p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-black/5 bg-white/45 px-5 py-4 md:grid-cols-4">
        <ApexInsightPill label="Avg runtime" value={formatSeconds(feature?.averageRuntimeSeconds)} />
        <ApexInsightPill label="AI health" value={formatScore(feature?.jobStabilityScore)} />
        <ApexInsightPill label="Delay risk" value={formatScore(feature?.riskScore)} />
        <ApexInsightPill label="Incident risk" value={formatScore(feature?.incidentProbability)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-black/5 px-5 py-3">
        {openLink ? (
          <a
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            href={openLink}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open in APEX
          </a>
        ) : null}
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-slate-700">Raw payload</summary>
          <pre className="mt-2 max-h-60 max-w-full overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-5 text-slate-100">
            {JSON.stringify(card.rawJob.rawPayload || card.rawJob.rowValues, null, 2)}
          </pre>
        </details>
      </div>
    </Card>
  );
}

function OracleApexNativeCardView({ jobs, aiFeatures, deepLink }) {
  const cards = jobs.map(getApexCardModel);
  const sections = groupApexCards(cards);
  const featuresByEntityId = Object.fromEntries((aiFeatures || []).map((feature) => [feature.entityId, feature]));

  if (!cards.length) {
    return (
      <Card className="bg-sky-50 p-5">
        <EmptyTable message="Import Oracle APEX JSON to render the PF & ETL dashboard card layout." />
      </Card>
    );
  }

  return (
    <section className="rounded-lg bg-sky-50 p-4 shadow-sm ring-1 ring-sky-100">
      <div className="space-y-10">
        {sections.map(([title, sectionCards]) => (
          <div key={title}>
            <div className="mb-4 flex items-center gap-3">
              {title === 'ISERIES' ? (
                <Cog className="h-5 w-5 text-slate-800" aria-hidden="true" />
              ) : (
                <FileText className="h-5 w-5 text-slate-800" aria-hidden="true" />
              )}
              <h2 className="text-2xl font-bold tracking-tight text-slate-950">{title}</h2>
            </div>
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
              {sectionCards.length ? (
                sectionCards.map((card) => (
                  <ApexJobCard key={card.id} card={card} feature={featuresByEntityId[card.id]} baseUrl={deepLink} />
                ))
              ) : (
                <div className="lg:col-span-2 2xl:col-span-3">
                  <EmptyTable message={`No ${title} workflow cards are stored yet. Import the APEX wwv_flow.ajax response that contains this dashboard section.`} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function OracleApexTable({
  jobs,
  dynamicColumns,
  page,
  pageSize,
  sortKey,
  sortDirection,
  onPageChange,
  onSortChange,
  onExport,
}) {
  const totalPages = Math.max(1, Math.ceil(jobs.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const visibleRows = jobs.slice(start, start + pageSize);

  function handleSort(nextKey) {
    if (sortKey === nextKey) {
      onSortChange(nextKey, sortDirection === 'asc' ? 'desc' : 'asc');
      return;
    }

    onSortChange(nextKey, nextKey === 'lastUpdated' ? 'desc' : 'asc');
  }

  function sortMarker(key) {
    return sortKey === key ? <span>{sortDirection === 'asc' ? '↑' : '↓'}</span> : null;
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="font-semibold text-slate-950">PF & ETL report rows</h3>
          <p className="mt-1 text-sm text-slate-500">
            Showing {visibleRows.length ? start + 1 : 0}-{Math.min(start + pageSize, jobs.length)} of {jobs.length} matching rows.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={onExport} disabled={jobs.length === 0}>
          <FileText className="h-4 w-4" aria-hidden="true" />
          Export CSV / Excel
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => handleSort('entityName')}>
                  Job {sortMarker('entityName')}
                </button>
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => handleSort('status')}>
                  Status {sortMarker('status')}
                </button>
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => handleSort('lastUpdated')}>
                  Last updated {sortMarker('lastUpdated')}
                </button>
              </th>
              {dynamicColumns.map((column) => (
                <th key={column.key} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => handleSort(`column:${column.key}`)}>
                    {column.label} {sortMarker(`column:${column.key}`)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {visibleRows.map((job) => (
              <tr key={job.entityId} className="hover:bg-slate-50">
                <td className="max-w-72 px-4 py-3 align-top">
                  <p className="font-semibold text-slate-950">{job.entityName}</p>
                  <p className="mt-1 break-all text-xs text-slate-500">{job.entityId}</p>
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top">
                  <StatusPill status={job.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top text-slate-700">
                  {formatDateTime(job.lastUpdated || job.timestamp)}
                </td>
                {dynamicColumns.map((column) => (
                  <td key={`${job.entityId}:${column.key}`} className="max-w-64 px-4 py-3 align-top text-slate-700">
                    <span className="line-clamp-3 break-words">{formatApexValue(apexRowValue(job, column.key))}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleRows.length === 0 ? (
        <div className="p-5">
          <EmptyTable message="No Oracle APEX rows match the selected filters." />
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-slate-200 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span className="text-slate-500">Page {safePage} of {totalPages}</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => onPageChange(Math.max(1, safePage - 1))} disabled={safePage <= 1}>
            Previous
          </Button>
          <Button type="button" variant="secondary" onClick={() => onPageChange(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}>
            Next
          </Button>
        </div>
      </div>
    </Card>
  );
}

function OracleApexDashboard({ detail, onImported }) {
  const jobs = detail.jobs || [];
  const columns = buildApexColumns(detail.columns || [], jobs);
  const syncHistory = detail.syncHistory || [];
  const aiFeatures = detail.aiFeatures || [];
  const summary = detail.summary || {};
  const importConfig = detail.importConfig || {};
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState('lastUpdated');
  const [sortDirection, setSortDirection] = useState('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState([]);
  const [ajaxIdentifier, setAjaxIdentifier] = useState('');
  const [apexSessionId, setApexSessionId] = useState('');
  const [manualJsonText, setManualJsonText] = useState('');
  const [importState, setImportState] = useState(null);
  const pageSize = 25;

  useEffect(() => {
    setVisibleColumnKeys((current) => {
      const availableKeys = columns.map((column) => column.key);
      const retained = current.filter((key) => availableKeys.includes(key));

      return retained.length ? retained : availableKeys.slice(0, 12);
    });
  }, [columns.map((column) => column.key).join('|')]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, statusFilter]);

  const dynamicColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
  const statuses = [...new Set(jobs.map((job) => job.status).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const filteredJobs = jobs.filter((job) => {
    const statusMatches = statusFilter === 'all' || job.status === statusFilter;
    const searchMatches = !search.trim() || apexSearchText(job).includes(search.trim().toLowerCase());

    return statusMatches && searchMatches;
  });
  const sortedJobs = sortApexJobs(filteredJobs, sortKey, sortDirection);

  function toggleColumn(columnKey) {
    setVisibleColumnKeys((current) => (
      current.includes(columnKey)
        ? current.filter((key) => key !== columnKey)
        : [...current, columnKey]
    ));
  }

  async function handleBrowserImport(event) {
    event?.preventDefault();
    event?.stopPropagation();
    setImportState({ status: 'loading', message: 'Fetching Oracle APEX AJAX pages with this browser session...' });

    try {
      const pages = await fetchOracleApexAjaxPages(importConfig, ajaxIdentifier, apexSessionId);
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let rows = 0;

      for (const page of pages) {
        const result = await importOracleApexPayload({
          payload: page.payload,
          pageNumber: page.pageNumber,
          firstRow: page.firstRow,
          maxRows: page.maxRows,
        });

        inserted += Number(result.inserted || 0);
        updated += Number(result.updated || 0);
        skipped += Number(result.skipped || 0);
        rows += Number(result.recordsRetrieved || page.count || 0);
      }

      setImportState({
        status: 'success',
        message: `Oracle APEX browser import complete: ${rows} rows across ${pages.length} page(s). ${inserted} inserted, ${updated} updated, ${skipped} unchanged.`,
      });
      onImported?.();
    } catch (error) {
      setImportState({ status: 'error', message: error.message || 'Unable to import Oracle APEX data.' });
    }
  }

  async function handleManualImport(event) {
    event?.preventDefault();
    event?.stopPropagation();
    setImportState({ status: 'loading', message: 'Importing pasted Oracle APEX AJAX JSON...' });

    try {
      const payload = parseOracleApexJson(manualJsonText);
      const result = await importOracleApexPayload({ payload });

      setImportState({
        status: 'success',
        message: result.message || `Oracle APEX import complete: ${result.recordsRetrieved || 0} rows stored.`,
      });
      onImported?.();
    } catch (error) {
      setImportState({ status: 'error', message: error.message || 'Unable to import pasted Oracle APEX JSON.' });
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-cyan-600 text-white">
            <DatabaseZap className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">Oracle APEX</p>
            <h2 className="text-xl font-semibold text-slate-950">PF & ETL Dashboard</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Read-only APEX AJAX data imported from the authenticated browser session or pasted JSON response. No APEX jobs are started, stopped, edited, or executed.
            </p>
          </div>
        </div>
        {detail.deepLink ? (
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            href={detail.deepLink}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open in APEX
          </a>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-7">
        <ApexKpiCard label="Total Jobs" value={summary.totalJobs || 0} helper="Rows stored from the APEX report." tone="cyan" />
        <ApexKpiCard label="Completed" value={summary.completed || 0} helper={`${summary.successRate || 0}% success rate.`} tone="green" />
        <ApexKpiCard label="Running" value={summary.running || 0} helper="Jobs currently active." tone="amber" />
        <ApexKpiCard label="Queued" value={summary.queued || 0} helper="Jobs waiting in queue." tone="cyan" />
        <ApexKpiCard label="Failed" value={summary.failed || 0} helper="Rows with failed/error state." tone="red" />
        <ApexKpiCard label="Delayed" value={summary.delayed || 0} helper="Rows that appear late or delayed." tone="amber" />
        <ApexKpiCard label="Avg Runtime" value={formatSeconds(summary.averageRuntimeSeconds)} helper="Derived from available duration fields." />
      </div>

      <Card className="p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h3 className="font-semibold text-slate-950">Import Oracle APEX JSON</h3>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Use the browser import when your browser session can call APEX directly. If cross-origin rules block it, paste the JSON response from the Network tab and import it here.
            </p>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p><span className="font-semibold text-slate-900">Flow:</span> {importConfig.flowId || '102'}</p>
            <p><span className="font-semibold text-slate-900">Page:</span> {importConfig.pageId || 'Optional'}</p>
            <p><span className="font-semibold text-slate-900">Region:</span> {importConfig.regionId || 'Not configured'}</p>
            <p><span className="font-semibold text-slate-900">Request:</span> {importConfig.requestName || 'Optional'}</p>
            <p><span className="font-semibold text-slate-900">Page size:</span> {importConfig.maxRows || 100}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="rounded-md border border-slate-200 p-4">
            <label className="block text-sm font-semibold text-slate-700">
              AJAX Identifier for browser import
              <input
                className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                type="password"
                value={ajaxIdentifier}
                onChange={(event) => setAjaxIdentifier(event.target.value)}
                placeholder={importConfig.ajaxIdentifierConfigured ? 'Saved in backend; enter here for browser fetch' : 'Paste ajaxIdentifier from APEX network request'}
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Copy the ajaxIdentifier from the same APEX `wwv_flow.ajax` request that loads the PF & ETL report region. If it comes from another region, APEX will reject it.
            </p>
            <label className="mt-4 block text-sm font-semibold text-slate-700">
              APEX Session ID optional, not stored
              <input
                className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                type="password"
                value={apexSessionId}
                onChange={(event) => setApexSessionId(event.target.value)}
                placeholder="Only if the APEX request includes p_instance"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Some APEX pages require `p_instance` and `p_flow_step_id`. Save Page ID in Settings if the Network request has `p_flow_step_id`; enter the current session ID here only for this import.
            </p>
            <Button className="mt-4" type="button" onClick={handleBrowserImport} disabled={importState?.status === 'loading'}>
              {importState?.status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Import from Browser Session
            </Button>
          </div>

          <div className="rounded-md border border-slate-200 p-4">
            <label className="block text-sm font-semibold text-slate-700">
              Pasted APEX AJAX JSON
              <textarea
                className="mt-2 min-h-32 w-full rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={manualJsonText}
                onChange={(event) => setManualJsonText(event.target.value)}
                placeholder='{"regions":[...]}'
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" onClick={handleManualImport} disabled={importState?.status === 'loading'}>
                {importState?.status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
                Import Pasted JSON
              </Button>
              <Button type="button" variant="secondary" onClick={() => setManualJsonText('')} disabled={!manualJsonText}>
                Clear
              </Button>
            </div>
          </div>
        </div>

        {importState ? (
          <div className={`mt-4 rounded-md border p-3 text-sm ${
            importState.status === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : importState.status === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-cyan-200 bg-cyan-50 text-cyan-800'
          }`}>
            {importState.message}
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_220px]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              className="h-10 w-full rounded-md border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search job, server, owner, status, or any dynamic column"
            />
          </label>
          <select
            className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>{statusLabel(status)}</option>
            ))}
          </select>
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">
            Visible columns ({dynamicColumns.length}/{columns.length})
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {columns.map((column) => (
              <label key={column.key} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={visibleColumnKeys.includes(column.key)}
                  onChange={() => toggleColumn(column.key)}
                />
                <span className="min-w-0 truncate">{column.label}</span>
              </label>
            ))}
          </div>
        </details>
      </Card>

      <OracleApexNativeCardView jobs={sortedJobs} aiFeatures={aiFeatures} deepLink={detail.deepLink} />

      <OracleApexTable
        jobs={sortedJobs}
        dynamicColumns={dynamicColumns}
        page={currentPage}
        pageSize={pageSize}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onPageChange={setCurrentPage}
        onSortChange={(nextKey, nextDirection) => {
          setSortKey(nextKey);
          setSortDirection(nextDirection);
        }}
        onExport={() => exportApexCsv(sortedJobs, dynamicColumns)}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="font-semibold text-slate-950">Sync history</h3>
            <p className="mt-1 text-sm text-slate-500">Imports append audit history and keep raw payloads for replay/debugging.</p>
          </div>
          {syncHistory.length ? (
            <div className="divide-y divide-slate-100">
              {syncHistory.slice(0, 8).map((sync) => (
                <div key={sync.id} className="grid grid-cols-1 gap-2 px-5 py-4 text-sm md:grid-cols-4">
                  <div>
                    <StatusPill status={sync.result === 'success' ? 'ok' : 'critical'} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rows</p>
                    <p className="font-semibold text-slate-950">{sync.recordsRetrieved}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Inserted / Updated</p>
                    <p className="font-semibold text-slate-950">{sync.recordsInserted} / {sync.recordsUpdated}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Finished</p>
                    <p className="font-semibold text-slate-950">{formatDateTime(sync.finishedAt || sync.startedAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-5">
              <EmptyTable message="No Oracle APEX import history yet." />
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="font-semibold text-slate-950">AI-ready features</h3>
            <p className="mt-1 text-sm text-slate-500">Feature rows are prepared for later prediction. No AI model is running yet.</p>
          </div>
          {aiFeatures.length ? (
            <div className="divide-y divide-slate-100">
              {aiFeatures.slice(0, 8).map((feature) => (
                <div key={feature.entityId} className="px-5 py-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-slate-950">{feature.entityName}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">{feature.aiLabel || 'unknown'}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                    <span>Risk {formatScore(feature.riskScore)}</span>
                    <span>Failure {formatScore(feature.failureRate)}</span>
                    <span>Stability {formatScore(feature.jobStabilityScore)}</span>
                    <span>Runs {feature.recurrenceCount || 0}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{feature.aiReason}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-5">
              <EmptyTable message="AI-ready rows will appear after Oracle APEX data is imported." />
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">Raw imported row payload preview</summary>
          <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            {JSON.stringify(jobs.slice(0, 20).map((job) => job.rawPayload), null, 2)}
          </pre>
        </details>
      </Card>
    </section>
  );
}

function PaymentKpiCard({ label, value, helper, tone = 'slate' }) {
  const toneClasses = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    red: 'bg-rose-50 text-rose-700 border-rose-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    cyan: 'bg-cyan-50 text-cyan-700 border-cyan-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-100',
  };

  return (
    <Card className="p-4">
      <div className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${toneClasses[tone] || toneClasses.slate}`}>
        {label}
      </div>
      <p className="mt-3 text-2xl font-semibold text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{helper}</p>
    </Card>
  );
}

function PaymentChartCard({ title, subtitle, children }) {
  return (
    <Card className="p-5">
      <div>
        <h3 className="font-semibold text-slate-950">{title}</h3>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      </div>
      <div className="mt-4 h-72">
        {children}
      </div>
    </Card>
  );
}

function PaymentFilterSelect({ label, value, onChange, options }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800 shadow-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100"
      >
        <option value="all">All</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function PaymentTransactionsTable({
  records,
  page,
  pageSize,
  sortKey,
  sortDirection,
  onPageChange,
  onSortChange,
  onExport,
}) {
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const visibleRows = records.slice(start, start + pageSize);
  const columns = [
    ['merchant', 'Merchant'],
    ['merchantNumber', 'Merchant #'],
    ['accountHolderName', 'Account Holder Name'],
    ['lastFour', 'Last Four'],
    ['uniqueTransactionNumber', 'Unique Transaction #'],
    ['transactionType', 'Transaction Type'],
    ['source', 'Source'],
    ['secCode', 'SEC Code'],
    ['amount', 'Amount'],
    ['paymentAction', 'Payment Action'],
    ['responseCode', 'Response Code'],
    ['status', 'Status'],
    ['creationDate', 'Creation Date'],
    ['creationTimeUtc', 'Creation Time (UTC)'],
    ['effectiveDate', 'Effective Date'],
    ['effectiveTimeUtc', 'Effective Time (UTC)'],
    ['payerId', 'Payer ID'],
    ['memberNumber', 'Member #'],
  ];

  function handleSort(nextKey) {
    if (sortKey === nextKey) {
      onSortChange(nextKey, sortDirection === 'asc' ? 'desc' : 'asc');
      return;
    }

    onSortChange(nextKey, ['createdDate', 'creationDate', 'effectiveDate'].includes(nextKey) ? 'desc' : 'asc');
  }

  function renderCell(row, key) {
    if (key === 'uniqueTransactionNumber') {
      return (
        <div>
          <p className="font-semibold text-slate-950">{paymentRecordValue(row, 'uniqueTransactionNumber') || row.entityId}</p>
        </div>
      );
    }

    if (key === 'merchantNumber') {
      return paymentRecordValue(row, 'merchantNumber') || paymentRecordValue(row, 'merchantId') || 'Not available';
    }

    if (key === 'accountHolderName') {
      return paymentRecordValue(row, 'accountHolderName') || 'Masked';
    }

    if (key === 'lastFour') {
      return paymentRecordValue(row, 'lastFour') ? `****${paymentRecordValue(row, 'lastFour')}` : 'Not available';
    }

    if (key === 'status') {
      return (
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-slate-900">{normalizedPaymentStatus(row)}</span>
          <StatusPill status={row.status} />
        </div>
      );
    }

    if (key === 'amount') {
      return (
        <div>
          <p className="font-semibold text-slate-900">{formatCurrency(paymentRecordValue(row, 'amount'), paymentRecordValue(row, 'currency'))}</p>
          <p className="text-xs text-slate-500">{paymentRecordValue(row, 'currency') || 'USD'}</p>
        </div>
      );
    }

    if (key === 'settled') {
      return paymentRecordValue(row, 'settled') ? 'Yes' : 'No';
    }

    if (key === 'createdDate') {
      return formatDateTime(paymentRecordValue(row, 'createdDate') || row.lastCheck);
    }

    if (key === 'responseCode') {
      return <span className="font-semibold text-slate-900">{paymentRecordValue(row, 'responseCode') || 'UNKNOWN'}</span>;
    }

    return paymentRecordValue(row, key) || 'Not available';
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="font-semibold text-slate-950">Recent Transactions</h3>
          <p className="mt-1 text-sm text-slate-500">
            Showing {visibleRows.length ? start + 1 : 0}-{Math.min(start + pageSize, records.length)} of {records.length} matching records.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={onExport} disabled={records.length === 0}>
          <FileText className="h-4 w-4" aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map(([key, label]) => (
                <th key={key} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => handleSort(key)}>
                    {label}
                    {sortKey === key ? <span>{sortDirection === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {visibleRows.map((row) => (
              <tr key={row.entityId} className="hover:bg-slate-50">
                {columns.map(([key]) => (
                  <td key={key} className="max-w-56 whitespace-nowrap px-4 py-3 align-top text-slate-700">
                    {renderCell(row, key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleRows.length === 0 ? (
        <div className="p-5">
          <EmptyTable message="No payment transactions match the selected filters." />
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-slate-200 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span className="text-slate-500">Page {safePage} of {totalPages}</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => onPageChange(Math.max(1, safePage - 1))} disabled={safePage <= 1}>
            Previous
          </Button>
          <Button type="button" variant="secondary" onClick={() => onPageChange(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}>
            Next
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PaymentGatewayDashboard({ detail, onImported }) {
  const allRecords = (detail.entities || []).filter((record) => record.entityType === 'payment_transaction');
  const observedTotalRecords = detail.paymentGateway?.observedTotalRecords
    || paymentRecordValue(allRecords[0] || {}, 'observedTotalRecords')
    || 389736727;
  const loadedForRange = detail.paymentGateway?.loadedForRange || allRecords.length;
  const dashboardQueryLimit = detail.paymentGateway?.dashboardQueryLimit || 10000;
  const isDashboardLimited = Boolean(detail.paymentGateway?.dashboardResultTruncated);
  const [statusFilter, setStatusFilter] = useState('all');
  const [responseCodeFilter, setResponseCodeFilter] = useState('all');
  const [transactionTypeFilter, setTransactionTypeFilter] = useState('all');
  const [paymentSearch, setPaymentSearch] = useState('');
  const [sortKey, setSortKey] = useState('creationDate');
  const [sortDirection, setSortDirection] = useState('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [paymentImportUrl, setPaymentImportUrl] = useState(() => getPaymentGatewayDefaultImportUrl(detail));
  const [paymentManualJsonText, setPaymentManualJsonText] = useState('');
  const [paymentImportState, setPaymentImportState] = useState(null);
  const records = allRecords.filter((record) => {
    const status = normalizedPaymentStatus(record);
    const responseCode = String(paymentRecordValue(record, 'responseCode') || 'UNKNOWN');
    const transactionType = String(paymentRecordValue(record, 'transactionType') || 'UNKNOWN');
    const searchMatch = !paymentSearch.trim() || paymentSearchText(record).includes(paymentSearch.trim().toLowerCase());

    return (statusFilter === 'all' || status === statusFilter)
      && (responseCodeFilter === 'all' || responseCode === responseCodeFilter)
      && (transactionTypeFilter === 'all' || transactionType === transactionTypeFilter)
      && searchMatch;
  });
  const sortedRecords = sortPaymentRecords(records, sortKey, sortDirection);
  const analytics = buildPaymentAnalyticsFromRecords(records);
  const trendData = buildPaymentTimeSeries(records, detail);
  const statusData = buildPaymentStatusData(records);
  const responseCodeData = buildPaymentResponseCodeData(records);
  const merchantData = buildPaymentDistributionData(records, 'merchant');
  const transactionTypeData = buildPaymentDistributionData(records, 'transactionType');
  const paymentActionData = buildPaymentDistributionData(records, 'paymentAction');
  const processorData = buildPaymentProcessorData(records);
  const pageSize = 25;
  const statusColors = {
    SUCCESS: chartPalette.teal,
    FAILED: chartPalette.red,
    PENDING: chartPalette.amber,
    UNKNOWN: chartPalette.slate,
  };
  const syncMessage = detail.paymentGateway?.sync?.warning || detail.paymentGateway?.sync?.message;

  useEffect(() => {
    setCurrentPage(1);
  }, [paymentSearch, statusFilter, responseCodeFilter, transactionTypeFilter, sortKey, sortDirection]);

  async function importPaymentGatewayPayload(payload, loadingMessage = 'Importing Payment Gateway transactions JSON...') {
    setPaymentImportState({
      type: 'loading',
      message: loadingMessage,
    });

    try {
      const result = await importPaymentGatewayTransactions(payload);

      setPaymentImportState({
        type: 'success',
        message: result.message || 'Payment Gateway JSON import succeeded.',
      });
      onImported?.();
    } catch (error) {
      setPaymentImportState({
        type: 'error',
        message: error.message || 'Payment Gateway JSON import failed.',
      });
    }
  }

  async function handleImportLivePaymentGatewayJson() {
    setPaymentImportState({
      type: 'loading',
      message: 'Fetching Payment Gateway transactions JSON from your browser session...',
    });

    try {
      const payload = await fetchPaymentGatewayTransactionsJson(paymentImportUrl);
      await importPaymentGatewayPayload(payload, 'Storing fetched Payment Gateway JSON in PostgreSQL...');
    } catch (error) {
      setPaymentImportState({
        type: 'error',
        message: error.message || 'Payment Gateway JSON import failed.',
      });
    }
  }

  async function handleImportPastedPaymentJson() {
    try {
      const payload = parsePaymentGatewayJson(paymentManualJsonText);
      await importPaymentGatewayPayload(payload, 'Importing pasted Payment Gateway JSON into PostgreSQL...');
      setPaymentManualJsonText('');
    } catch (error) {
      setPaymentImportState({
        type: 'error',
        message: error.message || 'Payment Gateway JSON import failed.',
      });
    }
  }

  async function handleImportPaymentJsonFile(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const payload = parsePaymentGatewayJson(text);
      setPaymentManualJsonText(text);
      await importPaymentGatewayPayload(payload, `Importing ${file.name} into PostgreSQL...`);
    } catch (error) {
      setPaymentImportState({
        type: 'error',
        message: error.message || 'Payment Gateway JSON file import failed.',
      });
    } finally {
      event.target.value = '';
    }
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="space-y-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">Payment Gateway</p>
              <h3 className="mt-1 text-2xl font-semibold text-slate-950">Transactions REST API</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                The source contains {Number(observedTotalRecords).toLocaleString()} records. This dashboard shows a safe, paged window for the selected time range; raw transaction payloads stay in PostgreSQL and are not displayed here.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full border border-cyan-100 bg-cyan-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-700">
              Auto refresh 30s
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source total</p>
              <p className="mt-2 break-words text-2xl font-semibold text-slate-950">{Number(observedTotalRecords).toLocaleString()}</p>
            </div>
            <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Loaded in browser</p>
              <p className="mt-2 break-words text-2xl font-semibold text-slate-950">{Number(loadedForRange).toLocaleString()}</p>
              {isDashboardLimited ? (
                <p className="mt-1 text-xs text-slate-500">Showing up to {Number(dashboardQueryLimit).toLocaleString()} records at once</p>
              ) : null}
            </div>
            <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">After filters</p>
              <p className="mt-2 break-words text-2xl font-semibold text-slate-950">{Number(records.length).toLocaleString()}</p>
            </div>
          </div>

          {syncMessage ? (
            <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600">
              {syncMessage}
            </div>
          ) : null}

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <label className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Payment Gateway transactions JSON URL
                <input
                  className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  value={paymentImportUrl}
                  onChange={(event) => setPaymentImportUrl(event.target.value)}
                  placeholder="/transactions-module/transactions/?page=0&size=50..."
                  spellCheck={false}
                />
              </label>
              <Button
                type="button"
                variant="primary"
                onClick={handleImportLivePaymentGatewayJson}
                disabled={paymentImportState?.type === 'loading'}
              >
                {paymentImportState?.type === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <DatabaseZap className="h-4 w-4" aria-hidden="true" />
                )}
                Import Live Payment Gateway JSON
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Uses your existing browser session. No cookies, tokens, or credentials are sent to the backend; only the JSON response is imported.
            </p>
            <div className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-slate-950">Paste the original Payment Gateway JSON</h4>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    Use this when the gateway blocks browser fetch. Open the transaction JSON page, copy the full response, paste it here, then import it into PostgreSQL.
                  </p>
                </div>
                <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  Upload JSON
                  <input
                    className="hidden"
                    type="file"
                    accept="application/json,.json"
                    onChange={handleImportPaymentJsonFile}
                  />
                </label>
              </div>
              <textarea
                className="mt-3 min-h-40 w-full resize-y rounded-md border border-slate-200 bg-white p-3 font-mono text-xs leading-5 text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={paymentManualJsonText}
                onChange={(event) => setPaymentManualJsonText(event.target.value)}
                placeholder='Paste the full transactions response here, for example: {"content":[{"id":"...","uniqueTransactionNumber":"...","merchantName":"..."}],"pageable":{"pageNumber":0},"last":false}'
                spellCheck={false}
              />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-500">
                  This imports the original JSON payload only. Banking details stay masked in the dashboard, and raw JSON is preserved in PostgreSQL.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleImportPastedPaymentJson}
                  disabled={paymentImportState?.type === 'loading'}
                >
                  {paymentImportState?.type === 'loading' ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <DatabaseZap className="h-4 w-4" aria-hidden="true" />
                  )}
                  Import pasted JSON
                </Button>
              </div>
            </div>
            {paymentImportState ? (
              <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                paymentImportState.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : paymentImportState.type === 'loading'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-rose-200 bg-rose-50 text-rose-800'
              }`}
              >
                {paymentImportState.type === 'success' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                ) : paymentImportState.type === 'loading' ? (
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>{paymentImportState.message}</span>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Search
              <span className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input
                  className="w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm font-medium normal-case tracking-normal text-slate-800 shadow-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100"
                  value={paymentSearch}
                  onChange={(event) => setPaymentSearch(event.target.value)}
                  placeholder="Transaction, merchant, processor"
                />
              </span>
            </label>
            <PaymentFilterSelect label="Status" value={statusFilter} onChange={setStatusFilter} options={paymentFilterOptions(allRecords, 'status')} />
            <PaymentFilterSelect label="Response code" value={responseCodeFilter} onChange={setResponseCodeFilter} options={paymentFilterOptions(allRecords, 'responseCode')} />
            <PaymentFilterSelect label="Transaction type" value={transactionTypeFilter} onChange={setTransactionTypeFilter} options={paymentFilterOptions(allRecords, 'transactionType')} />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <PaymentKpiCard label="Loaded in browser" value={Number(loadedForRange).toLocaleString()} helper="not the full source total" tone="slate" />
        <PaymentKpiCard label="Success rate" value={formatPercent(analytics.successRate)} helper={`${analytics.total} matching transactions`} tone="green" />
        <PaymentKpiCard label="Failures" value={analytics.failureCount || 0} helper="failed gateway operations" tone="red" />
        <PaymentKpiCard label="Pending" value={analytics.pendingCount || 0} helper="submitted or processing" tone="amber" />
        <PaymentKpiCard label="Settled" value={analytics.settledCount || 0} helper="settled transactions" tone="cyan" />
        <PaymentKpiCard label="Amount processed" value={formatCurrency(analytics.amountTotal)} helper="visible operational amount volume" tone="cyan" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <PaymentChartCard title="Success / Failure Trend" subtitle="Transaction status counts over the selected time window.">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
              <Tooltip />
              <Line type="monotone" dataKey="success" name="Success" stroke={chartPalette.teal} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="failures" name="Failures" stroke={chartPalette.red} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="pending" name="Pending" stroke={chartPalette.amber} strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Transaction Volume Trend" subtitle="Total transactions by time bucket.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trendData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="total" name="Transactions" fill={chartPalette.navy} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Amount Trend" subtitle="Total transaction amount by time bucket.">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trendData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <defs>
                <linearGradient id="paymentAmountGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartPalette.cyan} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={chartPalette.cyan} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
              <Tooltip />
              <Area type="monotone" dataKey="amountTotal" name="Amount" stroke={chartPalette.cyan} strokeWidth={2.5} fill="url(#paymentAmountGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Response Code Breakdown" subtitle="Most common gateway response codes in the current view.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={responseCodeData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={12} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" name="Transactions" fill={chartPalette.navy} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Status Distribution" subtitle="Operational mix of successful, failed, and timed-out transactions.">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={64} outerRadius={104} paddingAngle={3}>
                {statusData.map((entry) => (
                  <Cell key={entry.name} fill={statusColors[entry.name] || chartPalette.slate} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Merchant Distribution" subtitle="Transaction volume by merchant.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={merchantData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={12} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" name="Transactions" fill={chartPalette.teal} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Processor Performance" subtitle="Success rate by processor.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={processorData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={12} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} domain={[0, 100]} />
              <Tooltip />
              <Bar dataKey="successRate" name="Success rate %" fill={chartPalette.cyan} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Transaction Type Distribution" subtitle="Volume by transaction type.">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={transactionTypeData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={96} paddingAngle={3}>
                {transactionTypeData.map((entry, index) => (
                  <Cell key={entry.name} fill={[chartPalette.navy, chartPalette.cyan, chartPalette.teal, chartPalette.amber, chartPalette.red][index % 5]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </PaymentChartCard>

        <PaymentChartCard title="Payment Action Distribution" subtitle="Sale, refund, void, retry, and other operational actions.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={paymentActionData} margin={{ left: -18, right: 16, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={12} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" name="Transactions" fill={chartPalette.amber} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </PaymentChartCard>
      </div>

      <PaymentTransactionsTable
        records={sortedRecords}
        page={currentPage}
        pageSize={pageSize}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onPageChange={setCurrentPage}
        onSortChange={(nextKey, nextDirection) => {
          setSortKey(nextKey);
          setSortDirection(nextDirection);
        }}
        onExport={() => exportPaymentCsv(sortedRecords)}
      />

      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        Raw payment payloads are retained in PostgreSQL for traceability, but this dashboard only exposes monitoring-safe operational fields.
      </div>
    </div>
  );
}

function ActiveProblemsTable({ problems }) {
  const columns = [
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'hostName', label: 'Host' },
    { key: 'serviceDescription', label: 'Service', render: (row) => row.serviceDescription || 'Host' },
    { key: 'pluginOutput', label: 'Details' },
    { key: 'acknowledged', label: 'Ack', render: (row) => (row.acknowledged ? 'Yes' : 'No') },
    { key: 'lastCheck', label: 'Last check', render: (row) => formatDateTime(row.lastCheck) },
  ];

  return <NagiosTable title="Active Problems For Selection" rows={problems || []} columns={columns} emptyMessage="No active problems are attached to this selection." />;
}

function RecentEventsTable({ events }) {
  const columns = [
    { key: 'eventTime', label: 'Time', render: (row) => formatDateTime(row.eventTime) },
    { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'serviceDescription', label: 'Service', render: (row) => row.serviceDescription || 'Host' },
    { key: 'output', label: 'Event output' },
  ];

  return <NagiosTable title="Recent Events For Selection" rows={events || []} columns={columns} emptyMessage="No recent events are attached to this selection." />;
}

function NagiosDowntimeTable({ downtime }) {
  const columns = [
    { key: 'active', label: 'Active', render: (row) => (row.active ? 'Yes' : 'No') },
    { key: 'entityType', label: 'Type' },
    { key: 'serviceName', label: 'Service', render: (row) => row.serviceName || 'Host' },
    { key: 'startTime', label: 'Start', render: (row) => formatDateTime(row.startTime) },
    { key: 'endTime', label: 'End', render: (row) => formatDateTime(row.endTime) },
    { key: 'comment', label: 'Comment', render: (row) => row.comment || 'Not available' },
  ];

  return <NagiosTable title="Downtime For Selection" rows={downtime || []} columns={columns} emptyMessage="No downtime records are attached to this selection." />;
}

function NagiosAiFeatureTable({ features }) {
  const columns = [
    { key: 'currentState', label: 'State', render: (row) => <StatusPill status={row.currentState} /> },
    { key: 'entityName', label: 'Entity' },
    { key: 'entityType', label: 'Type' },
    { key: 'stateChangeCount', label: 'Changes' },
    { key: 'recurrenceCount', label: 'Recurrence' },
    { key: 'flappingScore', label: 'Flapping', render: (row) => formatScore(row.flappingScore) },
    { key: 'stabilityScore', label: 'Stability', render: (row) => formatScore(row.stabilityScore) },
    { key: 'incidentLikelihood', label: 'Incident likelihood', render: (row) => formatScore(row.incidentLikelihood) },
    { key: 'aiLabel', label: 'AI label' },
  ];

  return <NagiosTable title="AI Features For Selection" rows={features || []} columns={columns} emptyMessage="AI-ready feature rows will appear after the next Nagios poll." />;
}

function ThousandEyesDetailView({ detail }) {
  const records = detail.entities || [];
  const alerts = records.filter((record) => record.entityType === 'alert');
  const tests = records.filter((record) => record.entityType === 'test');
  const metrics = records.filter((record) => record.entityType === 'metric');
  const testRecord = tests[0] || records[0] || {};
  const custom = testRecord.customProperties || records[0]?.customProperties || {};
  const historicalMetrics = custom.historicalMetrics || [];
  const alertHistory = custom.alertHistory?.length ? custom.alertHistory : alerts.map((alert) => ({
    alertId: alert.entityId,
    summary: alert.summary,
    status: alert.status,
    severity: alert.severity,
    startedAt: alert.lastCheck,
    endedAt: alert.customProperties?.endedAt,
    deepLink: alert.deepLink,
  }));
  const timeline = [...records]
    .sort((a, b) => new Date(b.lastCheck || b.updatedAt || 0) - new Date(a.lastCheck || a.updatedAt || 0))
    .slice(0, 12);
  const rawPayload = testRecord.rawPayload || records[0]?.rawPayload || {};

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Alert count</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{custom.alertCount ?? alerts.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Active alerts</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{custom.activeAlerts ?? 0}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Availability</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{formatPercent(custom.availability)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Error count</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{formatMetricWithUnit(custom.errorCount, '')}</p>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-700" aria-hidden="true" />
          <h3 className="font-semibold text-slate-950">Current metrics</h3>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
          {[
            ['Response time', formatMetricWithUnit(custom.responseTime, 'ms')],
            ['Latency', formatMetricWithUnit(custom.latency, 'ms')],
            ['Packet loss', formatPercent(custom.packetLoss)],
            ['Last run', formatDateTime(custom.lastRunAt)],
            ['Monitoring timestamp', formatDateTime(custom.monitoringTimestamp)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-950">{value}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="font-semibold text-slate-950">ThousandEyes metadata</h3>
            <p className="mt-1 text-sm text-slate-500">Normalized alert/test context preserved from the source payload.</p>
          </div>
          {detail.deepLink ? (
            <a
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              href={detail.deepLink}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open ThousandEyes
            </a>
          ) : null}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            ['Test ID', custom.testId],
            ['Application', custom.applicationName || detail.application?.label],
            ['Test type', custom.testType],
            ['Target / endpoint', custom.target || custom.endpoint],
            ['Agent / location', custom.agent || custom.location],
            ['Trigger condition', custom.triggerCondition],
            ['Metric', custom.metric],
            ['Account group', custom.accountGroupId],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-950">{value || 'Not available'}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="font-semibold text-slate-950">Historical metrics</h3>
            <p className="mt-1 text-sm text-slate-500">Latest stored ThousandEyes result samples for this test.</p>
          </div>
          {historicalMetrics.length ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {['Time', 'Availability', 'Errors', 'Response', 'Latency', 'Packet loss'].map((label) => (
                      <th key={label} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {historicalMetrics.slice(0, 12).map((item) => (
                    <tr key={`${item.id}:${item.timestamp}`}>
                      <td className="px-4 py-3 text-slate-700">{formatDateTime(item.timestamp)}</td>
                      <td className="px-4 py-3 text-slate-700">{formatPercent(item.availability)}</td>
                      <td className="px-4 py-3 text-slate-700">{formatMetricWithUnit(item.errorCount, '')}</td>
                      <td className="px-4 py-3 text-slate-700">{formatMetricWithUnit(item.responseTime, 'ms')}</td>
                      <td className="px-4 py-3 text-slate-700">{formatMetricWithUnit(item.latency, 'ms')}</td>
                      <td className="px-4 py-3 text-slate-700">{formatPercent(item.packetLoss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-5">
              <EmptyTable message="No historical ThousandEyes metric samples are stored for this test yet." />
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="font-semibold text-slate-950">Alert history</h3>
            <p className="mt-1 text-sm text-slate-500">Triggered and cleared alert context linked to this test.</p>
          </div>
          {alertHistory.length ? (
            <div className="divide-y divide-slate-100">
              {alertHistory.slice(0, 10).map((alert) => (
                <div key={`${alert.alertId}:${alert.startedAt}`} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={alert.status} />
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">
                      {alert.severity || 'low'}
                    </span>
                  </div>
                  <p className="mt-2 font-semibold text-slate-950">{alert.summary || alert.alertId}</p>
                  <p className="mt-1 text-sm text-slate-500">
                    Triggered {formatDateTime(alert.startedAt)} · Cleared {formatDateTime(alert.endedAt)}
                  </p>
                  {alert.deepLink ? (
                    <a className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-cyan-700 hover:text-cyan-900" href={alert.deepLink} target="_blank" rel="noreferrer">
                      Open alert
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-5">
              <EmptyTable message="No ThousandEyes alert history is stored for this test yet." />
            </div>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="font-semibold text-slate-950">ThousandEyes timeline</h3>
          <p className="mt-1 text-sm text-slate-500">Recent alert, test, and metric records for this selected entity.</p>
        </div>
        {timeline.length ? (
          <div className="divide-y divide-slate-100">
            {timeline.map((record) => (
              <div key={`${record.entityType}:${record.entityId}`} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={record.status} />
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {record.entityType}
                    </span>
                  </div>
                  <p className="mt-2 font-semibold text-slate-950">{record.summary}</p>
                  <p className="mt-1 max-w-3xl text-sm text-slate-500">{record.details || 'No additional detail available.'}</p>
                </div>
                <div className="shrink-0 text-left text-sm text-slate-500 md:text-right">
                  <p className="font-medium text-slate-700">{formatDateTime(record.lastCheck || record.updatedAt)}</p>
                  {record.deepLink ? (
                    <a className="mt-1 inline-flex items-center gap-1 font-medium text-cyan-700 hover:text-cyan-900" href={record.deepLink} target="_blank" rel="noreferrer">
                      Open source
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-5">
            <EmptyTable message="No ThousandEyes timeline records are stored for this entity yet." />
          </div>
        )}
      </Card>

      <Card className="p-5">
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">Raw ThousandEyes payload</summary>
          <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            {JSON.stringify(rawPayload, null, 2)}
          </pre>
        </details>
      </Card>
    </div>
  );
}

function AbcHubDetailView({ detail, onImported }) {
  const [moduleSearch, setModuleSearch] = useState('');
  const [moduleStatusFilter, setModuleStatusFilter] = useState('all');
  const [moduleSeverityFilter, setModuleSeverityFilter] = useState('all');
  const [importState, setImportState] = useState(null);
  const [manualJsonText, setManualJsonText] = useState('');
  const records = detail.entities || [];
  const moduleKey = detail.application?.id;
  const isDataTrak = moduleKey === 'datatrak-user-monitoring';
  const isDaemonMonitor = moduleKey === 'daemon-monitor';
  const primaryType = isDataTrak ? 'datatrak_user' : 'daemon_job';
  const eventType = isDataTrak ? 'datatrak_user_event' : 'daemon_job_event';
  const title = isDataTrak ? 'DataTrak User Monitoring' : 'Daemon Monitor';
  const matchesFilters = (record) => {
    const value = moduleSearch.trim().toLowerCase();
    const custom = record.customProperties || {};
    const textMatch = !value || [
      record.summary,
      record.details,
      record.entityId,
      custom.daemonName,
      custom.daemonJobCompanyId,
      custom.businessUnit,
      custom.business_unit,
      custom.VPD,
      custom.server,
      custom.jobState,
      custom.job_state,
      custom.scheduleState,
      custom.schedule_state,
      custom.userName,
      custom.userId,
      custom.activity,
      custom.eventType,
    ].some((field) => String(field || '').toLowerCase().includes(value));

    return textMatch &&
      (moduleStatusFilter === 'all' || record.status === moduleStatusFilter) &&
      (moduleSeverityFilter === 'all' || record.severity === moduleSeverityFilter);
  };
  const primaryRecords = records.filter((record) => record.entityType === primaryType).filter(matchesFilters);
  const events = records.filter((record) => record.entityType === eventType).filter(matchesFilters);
  const allDaemonRecords = isDaemonMonitor ? records.filter((record) => record.entityType === primaryType) : [];
  const activeJobs = allDaemonRecords.filter((record) => record.active ?? record.customProperties?.active).length;
  const runningJobs = allDaemonRecords.filter((record) => record.currentlyRunning ?? record.running ?? record.customProperties?.currentlyRunning ?? record.customProperties?.running).length;
  const disabledJobs = allDaemonRecords.filter((record) => (record.active ?? record.customProperties?.active) === false).length;
  const missedScheduleJobs = allDaemonRecords.filter((record) => record.customProperties?.missedSchedule || record.customProperties?.scheduleState === 'Missed Schedule').length;
  const daemonDurations = allDaemonRecords
    .map((record) => Number(record.executionDurationSeconds ?? record.customProperties?.executionDurationSeconds))
    .filter((value) => Number.isFinite(value));
  const averageDaemonRuntime = daemonDurations.length
    ? daemonDurations.reduce((sum, value) => sum + value, 0) / daemonDurations.length
    : null;
  const daemonAiFeatures = isDaemonMonitor ? (detail.aiFeatures || []) : [];
  async function handleImportDaemonJson() {
    setImportState({
      type: 'loading',
      message: 'Fetching ABC Hub Daemon Monitor JSON from your browser session...',
    });

    try {
      const payload = await fetchAbcHubDaemonMonitorJson(detail);
      const result = await importAbcHubDaemonMonitor(payload);

      setImportState({
        type: 'success',
        message: result.message || 'ABC Hub Daemon Monitor JSON import succeeded.',
      });
      onImported?.();
    } catch (error) {
      setImportState({
        type: 'error',
        message: error.message,
      });
    }
  }

  async function importDaemonPayload(payload, loadingMessage = 'Importing ABC Hub Daemon Monitor JSON...') {
    setImportState({
      type: 'loading',
      message: loadingMessage,
    });

    try {
      const result = await importAbcHubDaemonMonitor(payload);

      setImportState({
        type: 'success',
        message: result.message || 'ABC Hub Daemon Monitor JSON import succeeded.',
      });
      setManualJsonText('');
      onImported?.();
    } catch (error) {
      setImportState({
        type: 'error',
        message: error.message || 'Backend validation failed while importing ABC Hub daemon jobs.',
      });
    }
  }

  async function handleImportPastedJson() {
    try {
      const payload = parseAbcHubDaemonJson(manualJsonText);

      await importDaemonPayload(payload, 'Importing pasted ABC Hub Daemon Monitor JSON...');
    } catch (error) {
      setImportState({
        type: 'error',
        message: error.message,
      });
    }
  }

  async function handleImportJsonFile(event) {
    const file = event.target.files?.[0];

    event.target.value = '';

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const payload = parseAbcHubDaemonJson(text);

      await importDaemonPayload(payload, `Importing ${file.name}...`);
    } catch (error) {
      setImportState({
        type: 'error',
        message: error.message,
      });
    }
  }

  const columns = isDataTrak
    ? [
        { key: 'userName', label: 'User Name / User ID', render: (row) => `${row.customProperties?.userName || row.summary} / ${row.customProperties?.userId || row.entityId}` },
        { key: 'status', label: 'Monitoring Status', render: (row) => <StatusPill status={row.status} /> },
        { key: 'severity', label: 'Severity' },
        { key: 'lastUpdatedAt', label: 'Last Updated', render: (row) => formatDateTime(row.customProperties?.lastUpdatedAt || row.updatedAt) },
        { key: 'activity', label: 'Activity / Events', render: (row) => row.customProperties?.activity || row.details || 'Not available' },
        {
          key: 'deepLink',
          label: 'Deep Link',
          render: (row) => (row.deepLink ? (
            <a className="font-medium text-cyan-700 hover:text-cyan-900" href={row.deepLink} target="_blank" rel="noreferrer">
              Open
            </a>
          ) : 'Not available'),
        },
      ]
    : [
        { key: 'vpd', label: 'VPD', render: (row) => row.businessUnit || row.customProperties?.businessUnit || row.customProperties?.VPD || 'Not available' },
        { key: 'daemonName', label: 'Name', render: (row) => row.entityName || row.customProperties?.daemonName || row.customProperties?.entityName || row.summary },
        { key: 'server', label: 'Server', render: (row) => row.server || row.customProperties?.server || 'Not available' },
        { key: 'active', label: 'Active', render: (row) => (row.active ?? row.customProperties?.active ? 'Yes' : 'No') },
        { key: 'running', label: 'Currently Running', render: (row) => (row.currentlyRunning ?? row.running ?? row.customProperties?.currentlyRunning ?? row.customProperties?.running ? 'Yes' : 'No') },
        { key: 'nextRunDate', label: 'Next Run', render: (row) => formatDateTime(row.nextRunDate || row.customProperties?.nextRunDate) },
        { key: 'lastStartDate', label: 'Last Start', render: (row) => formatDateTime(row.lastStartDate || row.customProperties?.lastStartDate) },
        { key: 'lastEndDate', label: 'Last End', render: (row) => formatDateTime(row.lastEndDate || row.customProperties?.lastEndDate) },
        { key: 'executionDuration', label: 'Execution Duration', render: (row) => formatSeconds(row.executionDurationSeconds ?? row.customProperties?.executionDurationSeconds) },
        { key: 'currentState', label: 'Current State', render: (row) => <DaemonStatePill state={row.customProperties?.scheduleState || row.jobState || row.customProperties?.jobState || row.status} /> },
        {
          key: 'deepLink',
          label: 'Deep Link',
          render: (row) => (row.deepLink ? (
            <a className="font-medium text-cyan-700 hover:text-cyan-900" href={row.deepLink} target="_blank" rel="noreferrer">
              Open
            </a>
          ) : 'Not available'),
        },
      ];
  const daemonAiColumns = [
    { key: 'entityName', label: 'Daemon Job' },
    { key: 'businessUnit', label: 'VPD', render: (row) => row.businessUnit || 'Not available' },
    { key: 'server', label: 'Server', render: (row) => row.server || 'Not available' },
    { key: 'executionDuration', label: 'Execution Duration', render: (row) => formatSeconds(row.executionDuration) },
    { key: 'missedScheduleCount', label: 'Missed Schedule' },
    { key: 'lateExecutionCount', label: 'Late Executions' },
    { key: 'stabilityScore', label: 'Stability', render: (row) => formatScore(row.stabilityScore) },
    { key: 'downtimeScore', label: 'Downtime', render: (row) => formatScore(row.downtimeScore) },
    { key: 'aiLabel', label: 'AI Label' },
  ];

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">ABC Hub</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">{title}</h3>
            <p className="mt-1 text-sm text-slate-500">
              Read-only ABC Hub monitoring data stored in PostgreSQL with raw payloads preserved for analytics and future AI evaluation.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {isDaemonMonitor ? (
              <Button
                type="button"
                variant="primary"
                onClick={handleImportDaemonJson}
                disabled={importState?.type === 'loading'}
              >
                {importState?.type === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                Fetch from ABC Hub session
              </Button>
            ) : null}
            {detail.deepLink ? (
              <a
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                href={detail.deepLink}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Open ABC Hub
              </a>
            ) : null}
          </div>
        </div>
      </Card>

      {isDaemonMonitor ? (
        <Card className="p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="font-semibold text-slate-950">Read-only Daemon Monitor import</h3>
              <p className="mt-1 text-sm text-slate-500">
                This view retrieves and displays daemon monitoring data only. Run and Actions operations are not exposed or invoked.
              </p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {records.some((record) => record.customProperties?.sourceMode === 'browser_import') ? 'Imported JSON' : 'No imported JSON yet'}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[
              ['Total Daemon Jobs', allDaemonRecords.length],
              ['Active jobs', activeJobs],
              ['Running jobs', runningJobs],
              ['Disabled jobs', disabledJobs],
              ['Jobs missed schedule', missedScheduleJobs],
              ['Average runtime', formatSeconds(averageDaemonRuntime)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-1 break-words text-lg font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-dashed border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h4 className="text-sm font-semibold text-slate-950">Paste or upload ABC Hub JSON</h4>
                <p className="mt-1 text-sm text-slate-500">
                  Use this when ABC Hub blocks cross-origin browser fetch. Paste the full Daemon Monitor JSON response or upload a saved JSON file.
                </p>
              </div>
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                <FileText className="h-4 w-4" aria-hidden="true" />
                Upload JSON
                <input
                  className="hidden"
                  type="file"
                  accept="application/json,.json"
                  onChange={handleImportJsonFile}
                />
              </label>
            </div>
            <textarea
              className="mt-3 min-h-36 w-full resize-y rounded-md border border-slate-200 bg-white p-3 font-mono text-xs leading-5 text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={manualJsonText}
              onChange={(event) => setManualJsonText(event.target.value)}
              placeholder='Paste JSON here, for example: {"data":[{"id":123,"name":"Example daemon job","active":true}]}'
              spellCheck={false}
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-500">
                Only the JSON payload is sent to this local backend. Cookies and browser session data are not stored.
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={handleImportPastedJson}
                disabled={importState?.type === 'loading'}
              >
                {importState?.type === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <DatabaseZap className="h-4 w-4" aria-hidden="true" />
                )}
                Import pasted JSON
              </Button>
            </div>
          </div>

          {importState ? (
            <div className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
              importState.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : importState.type === 'loading'
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
            >
              {importState.type === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              ) : importState.type === 'loading' ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>{importState.message}</span>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              className="h-10 w-full rounded-md border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={moduleSearch}
              onChange={(event) => setModuleSearch(event.target.value)}
              placeholder={isDataTrak ? 'Search user, user ID, or activity' : 'Search daemon or event'}
            />
          </label>
          <select
            className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={moduleStatusFilter}
            onChange={(event) => setModuleStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="ok">OK</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="unknown">Unknown</option>
          </select>
          <select
            className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            value={moduleSeverityFilter}
            onChange={(event) => setModuleSeverityFilter(event.target.value)}
          >
            <option value="all">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </Card>

      <NagiosTable
        title={isDataTrak ? 'DataTrak users' : 'Daemon status'}
        rows={primaryRecords}
        columns={columns}
        emptyMessage={`No ${title} records match this time range.`}
      />

      {isDaemonMonitor ? (
        <NagiosTable
          title="AI-Ready Daemon Feature Rows"
          rows={daemonAiFeatures}
          columns={daemonAiColumns}
          emptyMessage="AI-ready daemon features will appear after the next import or sync."
        />
      ) : null}

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="font-semibold text-slate-950">Recent events and timeline</h3>
          <p className="mt-1 text-sm text-slate-500">Module history filtered by the selected time range.</p>
        </div>
        {events.length ? (
          <div className="divide-y divide-slate-100">
            {events.map((event) => (
              <div key={event.entityId} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={event.status} />
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {event.customProperties?.eventType || 'event'}
                    </span>
                  </div>
                  <p className="mt-2 font-semibold text-slate-950">{event.summary}</p>
                  <p className="mt-1 max-w-3xl text-sm text-slate-500">{event.details || 'No additional detail available.'}</p>
                </div>
                <p className="shrink-0 text-sm font-medium text-slate-700">{formatDateTime(event.lastCheck || event.updatedAt)}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-5">
            <EmptyTable message={`No ${title} history is stored for this time range.`} />
          </div>
        )}
      </Card>

      <Card className="p-5">
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">
            {isDataTrak ? 'Raw DataTrak monitoring details' : 'Raw ABC Hub payloads'}
          </summary>
          <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            {JSON.stringify(primaryRecords.map((record) => record.rawPayload), null, 2)}
          </pre>
        </details>
      </Card>
    </div>
  );
}

function MonitoringDetailsPanel({ detail, onBackToEntities, onImported, timeRange }) {
  if (!detail) {
    return null;
  }

  const detailNagiosHealth = detail.tool?.key?.startsWith('nagios-')
    ? {
      health: detail.connectorHealth,
      statistics: detail.syncStatistics,
      pollHistory: detail.pollHistory || [],
      instance: {
        label: detail.tool?.label,
      },
    }
    : null;

  return (
    <div className="space-y-5">
      <MonitoringSummary detail={detail} />

      {detail.kind === 'grafana_dashboard' && detail.dashboard ? (
        <GrafanaDashboardViewer dashboard={detail.dashboard} onBack={onBackToEntities} timeRange={timeRange || detail.timeRange} />
      ) : detail.kind === 'oracle_apex_dashboard' ? (
        <OracleApexDashboard detail={detail} onImported={onImported} />
      ) : detail.kind === 'payment_gateway_dashboard' ? (
        <PaymentGatewayDashboard detail={detail} onImported={onImported} />
      ) : detail.kind === 'appdynamics_dashboard' ? (
        <AppDynamicsDashboard detail={detail} />
      ) : detail.tool?.key === 'thousandeyes' ? (
        <>
          <ThousandEyesDetailView detail={detail} />
          <MonitoringRecordTable records={detail.entities || []} />
        </>
      ) : detail.tool?.key === 'abc-hub' ? (
        <AbcHubDetailView detail={detail} onImported={onImported} />
      ) : (
        <>
          <MonitoringRecordTable records={detail.entities || []} />
          <ActiveProblemsTable problems={detail.activeProblems || []} />
          {detail.tool?.key?.startsWith('nagios-') ? (
            <>
              <NagiosHealthDashboard healthItem={detailNagiosHealth} loading={false} error={null} polling={false} pollMessage="" />
              <NagiosDowntimeTable downtime={detail.downtime || []} />
              <NagiosAiFeatureTable features={detail.aiFeatures || []} />
            </>
          ) : null}
          <RecentEventsTable events={detail.recentEvents || []} />
        </>
      )}
    </div>
  );
}

export default function Monitoring() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTool = searchParams.get('tool') || 'nagios-d01';
  const selectedEntity = searchParams.get('entity') || '';
  const selectedRange = searchParams.get('range') || '6h';
  const customFrom = searchParams.get('from') || '';
  const customTo = searchParams.get('to') || '';
  const selectedTimeRange = buildSelectedTimeRange(selectedRange, customFrom, customTo);
  const [tools, setTools] = useState([]);
  const [toolsStatus, setToolsStatus] = useState('loading');
  const [toolsError, setToolsError] = useState(null);
  const [entities, setEntities] = useState([]);
  const [entityStatus, setEntityStatus] = useState('idle');
  const [entityError, setEntityError] = useState(null);
  const [dashboardSearch, setDashboardSearch] = useState('');
  const [browserCollapsed, setBrowserCollapsed] = useState(Boolean(selectedEntity));
  const [detail, setDetail] = useState(null);
  const [detailStatus, setDetailStatus] = useState('idle');
  const [detailError, setDetailError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [manualRefreshKey, setManualRefreshKey] = useState(0);
  const [grafanaSyncStatus, setGrafanaSyncStatus] = useState('idle');
  const [grafanaSyncMessage, setGrafanaSyncMessage] = useState('');
  const [nagiosHealth, setNagiosHealth] = useState(null);
  const [nagiosHealthStatus, setNagiosHealthStatus] = useState('idle');
  const [nagiosHealthError, setNagiosHealthError] = useState(null);
  const [nagiosPolling, setNagiosPolling] = useState(false);
  const [nagiosPollMessage, setNagiosPollMessage] = useState('');

  function updateSelection(nextTool, nextEntity = '', nextRange = selectedRange, rangeOverrides = {}) {
    const params = new URLSearchParams();
    const nextFrom = rangeOverrides.from ?? customFrom;
    const nextTo = rangeOverrides.to ?? customTo;

    if (nextTool) {
      params.set('tool', nextTool);
    }

    if (nextEntity) {
      params.set('entity', nextEntity);
    }

    params.set('range', resolveTimeRange(nextRange).value);

    if (nextRange === 'custom') {
      if (nextFrom) {
        params.set('from', nextFrom);
      }

      if (nextTo) {
        params.set('to', nextTo);
      }
    }

    setSearchParams(params);
  }

  function updateTimeRange(nextRange) {
    updateSelection(selectedTool, selectedEntity, nextRange);
  }

  function updateCustomRange(rangeUpdate) {
    updateSelection(selectedTool, selectedEntity, 'custom', rangeUpdate);
  }

  async function handleGrafanaSync() {
    setGrafanaSyncStatus('loading');
    setGrafanaSyncMessage('Syncing Grafana folders, dashboards, panels, alert rules, and AI-ready features...');

    try {
      const result = await syncGrafanaDashboards({ limit: 2000 });
      setGrafanaSyncStatus('success');
      setGrafanaSyncMessage(result?.message || 'Grafana sync complete.');
      setManualRefreshKey((current) => current + 1);
    } catch (requestError) {
      setGrafanaSyncStatus('error');
      setGrafanaSyncMessage(requestError.message || 'Unable to sync Grafana.');
    }
  }

  async function handleNagiosPoll() {
    const instance = getNagiosInstanceKey(selectedTool);
    setNagiosPolling(true);
    setNagiosPollMessage(`Polling ${instance.toUpperCase()} from Nagios XI...`);

    try {
      const result = await pollNagiosInstance(instance);
      setNagiosPollMessage(result?.message || `${instance.toUpperCase()} poll complete.`);
      setManualRefreshKey((current) => current + 1);
    } catch (requestError) {
      setNagiosPollMessage(requestError.message || `Unable to poll ${instance.toUpperCase()}.`);
      setManualRefreshKey((current) => current + 1);
    } finally {
      setNagiosPolling(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function loadTools() {
      try {
        const data = await getMonitoringTools();

        if (!active) {
          return;
        }

        setTools(data || []);
        setToolsStatus('success');
        setToolsError(null);
      } catch (requestError) {
        if (!active) {
          return;
        }

        setToolsStatus('error');
        setToolsError(requestError.message);
      }
    }

    loadTools();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!searchParams.get('tool')) {
      updateSelection(selectedTool, selectedEntity, selectedRange);
    }
  }, [customFrom, customTo, searchParams, selectedEntity, selectedRange, selectedTool]);

  useEffect(() => {
    setDashboardSearch('');
    setGrafanaSyncMessage('');
    setGrafanaSyncStatus('idle');
  }, [selectedTool]);

  useEffect(() => {
    if (selectedEntity) {
      setBrowserCollapsed(true);
    } else {
      setBrowserCollapsed(false);
    }
  }, [selectedEntity]);

  useEffect(() => {
    let active = true;

    async function loadEntities() {
      setEntityStatus('loading');
      setEntityError(null);

      const hasCurrentDetail = detail?.tool?.key === selectedTool && detail?.application?.id === selectedEntity;
      if (!hasCurrentDetail) {
        setDetail(null);
      }

      try {
        const data = await getMonitoringEntities(selectedTool);

        if (!active) {
          return;
        }

        setEntities(data || []);
        setEntityStatus('success');

        if (selectedEntity && !(data || []).some((entity) => entity.id === selectedEntity)) {
          updateSelection(selectedTool, '');
        }
      } catch (requestError) {
        if (!active) {
          return;
        }

        setEntities([]);
        setEntityStatus('error');
        setEntityError(requestError.message);
      }
    }

    loadEntities();
    const intervalId = selectedTool === 'grafana' ? setInterval(loadEntities, refreshIntervalMs) : null;

    return () => {
      active = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [manualRefreshKey, selectedTool]);

  useEffect(() => {
    if (!selectedTool.startsWith('nagios-')) {
      setNagiosHealth(null);
      setNagiosHealthStatus('idle');
      setNagiosHealthError(null);
      setNagiosPollMessage('');
      return undefined;
    }

    let active = true;

    async function loadNagiosHealth() {
      setNagiosHealthStatus((current) => (current === 'idle' ? 'loading' : current));
      setNagiosHealthError(null);

      try {
        const data = await getNagiosHealth({ instance: getNagiosInstanceKey(selectedTool) });

        if (!active) {
          return;
        }

        setNagiosHealth(data?.instances?.[0] || null);
        setNagiosHealthStatus('success');
      } catch (requestError) {
        if (!active) {
          return;
        }

        setNagiosHealth(null);
        setNagiosHealthStatus('error');
        setNagiosHealthError(requestError.message);
      }
    }

    loadNagiosHealth();
    const intervalId = setInterval(loadNagiosHealth, refreshIntervalMs);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [manualRefreshKey, selectedTool]);

  useEffect(() => {
    let active = true;

    async function loadDetails() {
      if (!selectedTool || !selectedEntity) {
        setDetail(null);
        setDetailStatus('idle');
        return;
      }

      const hasCurrentDetail = detail?.tool?.key === selectedTool && detail?.application?.id === selectedEntity;

      setDetailStatus(hasCurrentDetail ? 'success' : 'loading');
      setDetailError(null);

      try {
        const data = await getMonitoringDetails(selectedTool, selectedEntity, {
          from: selectedTimeRange.from,
          to: selectedTimeRange.to,
        });

        if (!active) {
          return;
        }

        setDetail(data);
        setDetailStatus('success');
        setLastRefresh(new Date().toISOString());
      } catch (requestError) {
        if (!active) {
          return;
        }

        if (hasCurrentDetail) {
          setDetailStatus('success');
          setDetailError(requestError.message);
          return;
        }

        setDetail(null);
        setDetailStatus('error');
        setDetailError(requestError.message);
      }
    }

    loadDetails();
    const intervalId = setInterval(loadDetails, refreshIntervalMs);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [manualRefreshKey, selectedTool, selectedEntity, selectedTimeRange.from, selectedTimeRange.to]);

  if (toolsStatus === 'loading') {
    return <PageState title="Loading monitoring tools" message="Preparing the monitoring selector." variant="loading" />;
  }

  if (toolsStatus === 'error') {
    return <PageState title="Unable to load monitoring tools" message={toolsError} variant="error" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">Monitoring</p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-950">Monitoring Operations Console</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Select a monitoring tool, then choose an application or entity to inspect normalized status, metrics, events, and source links.
          </p>
        </div>
        <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
          <span className="font-semibold text-slate-900">Last refresh:</span> {formatDateTime(lastRefresh)}
        </div>
      </div>

      <MonitoringSelector
        tools={tools}
        entities={entities}
        selectedTool={selectedTool}
        selectedEntity={selectedEntity}
        selectedRange={selectedTimeRange.value}
        customFrom={selectedTimeRange.from}
        customTo={selectedTimeRange.to}
        entityStatus={entityStatus}
        onToolChange={(tool) => updateSelection(tool, '')}
        onEntityChange={(entity) => updateSelection(selectedTool, entity)}
        onRangeChange={updateTimeRange}
        onCustomRangeChange={updateCustomRange}
      />

      {entityError ? (
        <PageState title="Unable to load applications" message={entityError} variant="error" />
      ) : null}

      {entityStatus === 'success' ? (
        <NagiosTotalStrip entities={entities} selectedTool={selectedTool} />
      ) : null}

      {selectedTool.startsWith('nagios-') ? (
        <NagiosHealthDashboard
          healthItem={nagiosHealth}
          loading={nagiosHealthStatus === 'loading'}
          error={nagiosHealthError}
          polling={nagiosPolling}
          pollMessage={nagiosPollMessage}
          onPoll={handleNagiosPoll}
        />
      ) : null}

      {entityStatus === 'success' && entities.length > 0 ? (
        <MonitoringEntityBrowser
          entities={entities}
          selectedTool={selectedTool}
          selectedEntity={selectedEntity}
          collapsed={browserCollapsed}
          search={dashboardSearch}
          syncStatus={grafanaSyncStatus}
          syncMessage={grafanaSyncMessage}
          onSearchChange={setDashboardSearch}
          onSelectEntity={(entity) => updateSelection(selectedTool, entity)}
          onToggleCollapsed={() => setBrowserCollapsed((current) => !current)}
          onSyncGrafana={handleGrafanaSync}
        />
      ) : null}

      {!selectedEntity && entityStatus === 'success' && entities.length > 0 ? (
        <PageState
          title={selectedTool === 'abc-hub' ? 'Choose an ABC Hub module' : selectedTool === 'oracle-apex' ? 'Choose an Oracle APEX dashboard' : 'Choose an application or entity'}
          message={selectedTool === 'abc-hub'
            ? 'Select Daemon Monitor or DataTrak User Monitoring to load status summary, events, timeline, and source links.'
            : selectedTool === 'oracle-apex'
              ? 'Select PF & ETL Dashboard to import APEX AJAX JSON and inspect the normalized job rows.'
              : 'Select a value from the second dropdown to load status summary, entity records, metrics, events, and source links.'}
        />
      ) : null}

      {detailStatus === 'loading' ? (
        <PageState title="Loading monitoring details" message="Fetching the selected monitoring data." variant="loading" />
      ) : null}

      {detailStatus === 'error' ? (
        <PageState title="Unable to load monitoring details" message={detailError} variant="error" />
      ) : null}

      {detailStatus === 'success' ? (
        <MonitoringDetailsPanel
          detail={detail}
          timeRange={selectedTimeRange}
          onBackToEntities={() => updateSelection(selectedTool, '')}
          onImported={() => setManualRefreshKey((current) => current + 1)}
        />
      ) : null}

      <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
        <Clock3 className="h-4 w-4" aria-hidden="true" />
        Selected detail data refreshes every 30 seconds.
      </div>
    </div>
  );
}

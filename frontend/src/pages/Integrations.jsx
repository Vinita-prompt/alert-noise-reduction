import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  Gauge,
  Globe2,
  Loader2,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import Badge from '../components/common/Badge.jsx';
import Button from '../components/common/Button.jsx';
import Card from '../components/common/Card.jsx';
import PageState from '../components/common/PageState.jsx';
import useLiveDataRefresh from '../hooks/useLiveDataRefresh.js';
import {
  getMonitoringIntegrations,
  runMonitoringBackfill,
  runMonitoringSync,
} from '../services/api.js';

const sourceIcons = {
  'nagios-dc01': Server,
  'nagios-dc02': Server,
  thousandeyes: Globe2,
  'payment-gateway': ShieldCheck,
  'apex-dashboard': Gauge,
  appdynamics: Activity,
  grafana: DatabaseZap,
  'abc-hub': Building2,
};

const ACTIVE_MONITORING_SOURCE_IDS = new Set(['appdynamics', 'grafana', 'nagios-dc01', 'nagios-dc02']);

const statusTone = {
  connected: 'active',
  disconnected: 'critical',
  checking: 'draft',
  not_configured: 'paused',
  idle: 'paused',
  syncing: 'draft',
  backfilling: 'draft',
  failed: 'critical',
};

function formatStatus(value) {
  return String(value || 'not_configured').replaceAll('_', ' ');
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

function formatDuration(value) {
  if (!Number.isFinite(value)) {
    return 'Not available';
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(1)} sec`;
}

function IntegrationMetric({ label, value }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function IntegrationCard({ source, runningAction, onBackfill, onSync }) {
  const Icon = sourceIcons[source.id] || Network;
  const isBackfilling = runningAction === `${source.id}-backfill`;
  const isSyncing = runningAction === `${source.id}-sync`;
  const isBusy = isBackfilling || isSyncing;
  const isConfigured = source.configured;
  const connectionStatus = source.connectionStatus || 'not_configured';
  const syncStatus = source.syncStatus || 'idle';

  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-950">{source.label}</h3>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{source.category}</p>
          </div>
        </div>
        <Badge tone={statusTone[connectionStatus]}>{formatStatus(connectionStatus)}</Badge>
      </div>

      <p className="mt-4 min-h-12 text-sm leading-6 text-slate-600">{source.description}</p>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <IntegrationMetric label="API health" value={formatStatus(source.apiHealth)} />
        <IntegrationMetric label="Sync status" value={formatStatus(syncStatus)} />
        <IntegrationMetric label="Last sync" value={formatDateTime(source.lastSuccessfulSync)} />
        <IntegrationMetric label="Last alert" value={formatDateTime(source.lastAlertReceivedAt)} />
        <IntegrationMetric label="Total alerts" value={Number.isFinite(Number(source.totalAlertsImported)) ? Number(source.totalAlertsImported).toLocaleString() : 'Not available'} />
        <IntegrationMetric label="Response time" value={formatDuration(source.responseTimeMs)} />
      </div>

      <div className="mt-4 rounded-md border border-slate-200 bg-white p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold text-slate-700">Adapter</span>
          <span className="text-right text-slate-600">{source.adapterName}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-semibold text-slate-700">Auth</span>
          <span className="text-right text-slate-600">{source.authType}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-semibold text-slate-700">Configured</span>
          <span className="text-right text-slate-600">{isConfigured ? 'Yes' : 'No'}</span>
        </div>
      </div>

      {source.lastError ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{source.lastError}</span>
        </div>
      ) : null}

      <div className="mt-auto grid grid-cols-1 gap-2 pt-5 sm:grid-cols-2">
        <Button disabled={isBusy} onClick={() => onBackfill(source)}>
          {isBackfilling ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Backfilling
            </>
          ) : (
            <>
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              Historical Import
            </>
          )}
        </Button>
        <Button disabled={isBusy} onClick={() => onSync(source)}>
          {isSyncing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Syncing
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Incremental Sync
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}

export default function Integrations() {
  const [sources, setSources] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [runningAction, setRunningAction] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  const loadSources = useCallback(async () => {
    const data = await getMonitoringIntegrations();
    setSources((data.sources || []).filter((source) => ACTIVE_MONITORING_SOURCE_IDS.has(source.id)));
    setUpdatedAt(new Date());
    setStatus('success');
    setError(null);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      try {
        const data = await getMonitoringIntegrations();

        if (!isMounted) {
          return;
        }

        setSources((data.sources || []).filter((source) => ACTIVE_MONITORING_SOURCE_IDS.has(source.id)));
        setUpdatedAt(new Date());
        setStatus('success');
        setError(null);
      } catch (requestError) {
        if (!isMounted) {
          return;
        }

        setSources([]);
        setStatus('error');
        setError(requestError.message);
      }
    }

    load();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => loadSources().catch((requestError) => {
      setSources([]);
      setStatus('error');
      setError(requestError.message);
    }), 30_000);
    return () => clearInterval(timer);
  }, [loadSources]);
  const liveConnection = useLiveDataRefresh(() => loadSources().catch(() => {}));

  const summary = useMemo(() => {
    const total = sources.length;
    const connected = sources.filter((source) => source.connectionStatus === 'connected').length;
    const configured = sources.filter((source) => source.configured).length;
    const imported = sources.reduce((sum, source) => sum + Number(source.totalAlertsImported || 0), 0);

    return { total, connected, configured, imported };
  }, [sources]);

  async function runSourceAction(source, action) {
    const actionKey = `${source.id}-${action}`;
    const label = action === 'backfill' ? 'historical import' : 'incremental sync';

    setRunningAction(actionKey);
    setToast({
      type: 'loading',
      message: `${source.label} ${label} is running...`,
    });

    try {
      const result = action === 'backfill'
        ? await runMonitoringBackfill(source.id)
        : await runMonitoringSync(source.id);

      await loadSources();
      setToast({
        type: 'success',
        message:
          result.message || `${source.label} ${label} complete: ${result.fetched || 0} fetched, ${result.inserted || 0} inserted, ${result.updated || 0} updated, ${result.skipped || 0} skipped.`,
      });
    } catch (requestError) {
      await loadSources().catch(() => {});
      setToast({
        type: 'error',
        message: `${source.label} ${label} failed. ${requestError.message}`,
      });
    } finally {
      setRunningAction(null);
    }
  }

  if (status === 'loading') {
    return <PageState title="Loading integrations" message="Fetching monitoring adapter status." variant="loading" />;
  }

  if (status === 'error') {
    return <PageState title="Live integration data unavailable" message={error || 'The backend integration status endpoint is unavailable.'} variant="error" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">Monitoring Integrations</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">ABC Command Center sources</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Each source has its own adapter for authentication, historical backfill, incremental sync, raw payload storage,
            and normalized alert delivery into PostgreSQL.
          </p>
          <p className="mt-2 text-xs text-slate-500">Updated {formatDateTime(updatedAt)} · {liveConnection === 'LIVE' ? 'Event stream live' : '30-second polling'}</p>
        </div>
        <Button onClick={() => loadSources()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh Status
        </Button>
      </div>

      {toast ? (
        <div
          className={`flex items-start justify-between gap-4 rounded-lg border p-4 text-sm shadow-sm ${
            toast.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : toast.type === 'loading'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          <div className="flex items-center gap-2 font-semibold">
            {toast.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : toast.type === 'loading' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
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

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Connected sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{summary.connected} / {summary.total}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Configured sources</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{summary.configured} / {summary.total}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Stored source alerts</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{summary.imported}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-slate-500">Adapter mode</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">Backfill + Sync</p>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {sources.map((source) => (
          <IntegrationCard
            key={source.id}
            runningAction={runningAction}
            source={source}
            onBackfill={(selectedSource) => runSourceAction(selectedSource, 'backfill')}
            onSync={(selectedSource) => runSourceAction(selectedSource, 'sync')}
          />
        ))}
      </section>
    </div>
  );
}

import {
  Activity,
  ArrowLeft,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  Database,
  Network,
  OctagonX,
  Search,
  Server,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  DataStateText,
  DefinitionList,
  EmptyState,
  formatFreshness,
  formatRange,
  LiveReadOnlyBadge,
  MetricCard,
  MetricValue,
  normalizeRange,
  RefreshButton,
  SourceButton,
  TimeRangeControl,
} from '../components/appdynamics/AppDynamicsUi.jsx';
import { PageHeader, TableHead, TableShell } from '../components/operational/DemoUi.jsx';
import {
  getAppDynamicsWorkspaceApplication,
  getAppDynamicsWorkspaceApplications,
} from '../services/api.js';

const DEFAULT_RANGE = '15m';

function ErrorPanel({ message, onRetry }) {
  return (
    <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-5">
      <p className="text-sm font-semibold text-rose-800">AppDynamics data could not be loaded.</p>
      <p className="mt-1 text-xs leading-5 text-rose-700">{message}</p>
      <button className="mt-4 rounded-xl bg-rose-700 px-3.5 py-2 text-xs font-semibold text-white" onClick={onRetry} type="button">Try again</button>
    </div>
  );
}

const HEALTH_PRESENTATION = {
  critical: {
    Icon: OctagonX,
    iconClass: 'bg-rose-600 text-white shadow-sm shadow-rose-200',
    label: 'Critical',
  },
  healthy: {
    Icon: CircleCheck,
    iconClass: 'bg-emerald-100 text-emerald-700',
    label: 'Healthy',
  },
  unknown: {
    Icon: Activity,
    iconClass: 'bg-slate-100 text-slate-500',
    label: 'Health unavailable',
  },
  warning: {
    Icon: TriangleAlert,
    iconClass: 'bg-amber-100 text-amber-700',
    label: 'Warning',
  },
};

function compactOperationalNumber(value, maximumFractionDigits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const absolute = Math.abs(numeric);
  const unit = absolute >= 1_000_000_000
    ? { divisor: 1_000_000_000, suffix: 'b' }
    : absolute >= 1_000_000
      ? { divisor: 1_000_000, suffix: 'm' }
      : absolute >= 1_000
        ? { divisor: 1_000, suffix: 'k' }
        : null;

  if (!unit) {
    return numeric.toLocaleString(undefined, { maximumFractionDigits });
  }

  const scaled = numeric / unit.divisor;
  const digits = Math.min(maximumFractionDigits, Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2);
  return `${scaled.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit.suffix}`;
}

function formatApplicationMetric(value, type) {
  if (type === 'percentage') return `${Number(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  if (type === 'response') return `${compactOperationalNumber(value, 1)} ms`;
  if (type === 'count') return compactOperationalNumber(value, 2);
  return compactOperationalNumber(value, 2);
}

function displayApplicationMetric(application, key, type) {
  const requestStatus = application.performanceStatus;
  if (requestStatus === 'error' || requestStatus === 'unavailable') {
    return { rawValue: null, status: requestStatus, value: 'Unavailable' };
  }

  const metricStatus = application.metrics?.states?.[key]?.status || requestStatus;
  const rawValue = application.metrics?.[key];
  if (metricStatus === 'no_data' || rawValue === null || rawValue === undefined) {
    return { rawValue: 0, status: 'no_data', value: formatApplicationMetric(0, type) };
  }

  return { rawValue, status: 'data', value: formatApplicationMetric(rawValue, type) };
}

function ApplicationHealth({ health }) {
  const presentation = HEALTH_PRESENTATION[health?.state] || HEALTH_PRESENTATION.unknown;
  const { Icon } = presentation;
  const tooltip = health?.source === 'active_health_rule_violation' && ['critical', 'warning'].includes(health?.state)
    ? `${presentation.label} — active health-rule violation`
    : health?.state === 'unknown'
      ? 'Health unavailable from current AppDynamics API data'
      : presentation.label;

  return (
    <span
      aria-label={tooltip}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${presentation.iconClass}`}
      role="img"
      title={tooltip}
    >
      <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={2.5} />
    </span>
  );
}

function ApplicationMetric({ application, label, metricKeyName, type }) {
  const metric = displayApplicationMetric(application, metricKeyName, type);
  const isErrorMetric = ['errorPercent', 'errors', 'errorsPerMinute'].includes(metricKeyName);
  const healthState = application.health?.state;
  const emphasized = isErrorMetric && metric.rawValue > 0 && ['critical', 'warning'].includes(healthState);
  const valueTone = emphasized
    ? healthState === 'critical' ? 'text-rose-700' : 'text-amber-700'
    : metric.status === 'error' || metric.status === 'unavailable' ? 'text-slate-400' : 'text-slate-950';

  return (
    <div className="min-w-0" title={metric.status === 'no_data' ? 'No metric points returned; summary card displays zero.' : undefined}>
      <p className={`${metric.value === 'Unavailable' ? 'text-sm' : 'text-xl sm:text-2xl'} truncate font-semibold tabular-nums tracking-tight ${valueTone}`}>{metric.value}</p>
      <p className="mt-1 text-[10px] font-semibold leading-4 text-slate-500 sm:text-[11px]">{label}</p>
    </div>
  );
}

function ApplicationCard({ application, range }) {
  return (
    <Link
      aria-label={`Open ${application.name} application details`}
      className="group block min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-lg hover:shadow-slate-200/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
      to={`/appdynamics/${encodeURIComponent(application.id)}?range=${range}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <ApplicationHealth health={application.health} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate text-base font-semibold text-slate-950" title={application.name}>{application.name}</h2>
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-teal-600" aria-hidden="true" />
          </div>
          <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-400">Application ID {application.id}</p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5 border-t border-slate-100 pt-5 sm:grid-cols-3">
        <ApplicationMetric application={application} label="Response Time (ms)" metricKeyName="responseTime" type="response" />
        <ApplicationMetric application={application} label="Calls" metricKeyName="calls" type="count" />
        <ApplicationMetric application={application} label="Calls / min" metricKeyName="callsPerMinute" type="rate" />
        <ApplicationMetric application={application} label="Error %" metricKeyName="errorPercent" type="percentage" />
        <ApplicationMetric application={application} label="Errors" metricKeyName="errors" type="count" />
        <ApplicationMetric application={application} label="Errors / min" metricKeyName="errorsPerMinute" type="rate" />
      </div>
    </Link>
  );
}

function ApplicationsList({ range, setRange }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('search') || '';
  const page = Number(searchParams.get('page')) || 1;
  const sort = 'name';
  const direction = searchParams.get('direction') || 'asc';
  const [draftSearch, setDraftSearch] = useState(search);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError('');
    try {
      const response = await getAppDynamicsWorkspaceApplications({ direction, page, range, refresh, search, sort });
      if (requestSequence.current === sequence) setResult(response);
    } catch (requestError) {
      if (requestSequence.current === sequence) setError(requestError.message);
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [direction, page, range, search, sort]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { setDraftSearch(search); }, [search]);

  function updateParams(values) {
    const next = new URLSearchParams(searchParams);
    Object.entries(values).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) next.delete(key);
      else next.set(key, String(value));
    });
    setSearchParams(next);
  }

  function submitSearch(event) {
    event.preventDefault();
    updateParams({ page: 1, search: draftSearch.trim() });
  }

  const pagination = result?.pagination;

  return (
    <div>
      <PageHeader
        eyebrow="Live monitoring workspace"
        title="AppDynamics"
        description="Explore real application inventory and on-demand performance data from the connected AppDynamics controller. No background estate-wide polling or write operations are enabled."
        actions={<LiveReadOnlyBadge />}
      />

      <section className="mt-7 flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Connection</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-900">
              <span className={`h-2 w-2 rounded-full ${error ? 'bg-rose-500' : result?.connection?.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} />
              {error ? 'Unavailable' : result?.connection?.connected ? 'Connected' : 'Connecting'}
            </span>
            <span className="text-xs text-slate-400">·</span>
            <span className="text-xs font-semibold text-slate-600">{result?.connection?.applicationCount !== undefined ? `${result.connection.applicationCount.toLocaleString()} applications` : 'Loading applications'}</span>
            <span className="text-xs text-slate-400">·</span>
            <span className="text-xs text-slate-500">OAuth read-only</span>
          </div>
          {result?.lastUpdated ? <p className="mt-2 text-[11px] text-slate-400">Fetched {formatFreshness(result.lastUpdated)}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Summary range</span>
          <TimeRangeControl disabled={loading} onChange={setRange} value={range} />
          <RefreshButton loading={loading} onClick={() => load(true)} />
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <form className="relative w-full max-w-xl" onSubmit={submitSearch}>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              aria-label="Search AppDynamics applications"
              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-24 text-sm font-medium text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-100"
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Search all applications"
              value={draftSearch}
            />
            <button className="absolute right-1.5 top-1.5 h-8 rounded-lg bg-slate-950 px-3 text-[11px] font-semibold text-white" type="submit">Search</button>
          </form>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.11em] text-slate-400">Sort</span>
            <button
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600"
              onClick={() => updateParams({ direction: direction === 'asc' ? 'desc' : 'asc' })}
              type="button"
            >
              {direction === 'asc' ? 'Name A–Z' : 'Name Z–A'}
            </button>
          </div>
        </div>
      </section>

      {error ? <ErrorPanel message={error} onRetry={load} /> : null}

      <div className="mt-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-950">Applications</h2>
          <p className="mt-1 text-xs text-slate-500">{pagination ? `${pagination.total.toLocaleString()} matching · 25 per page` : 'Loading application inventory…'}</p>
        </div>
        {result?.sortScope === 'visible_page' ? <p className="hidden text-[11px] text-slate-400 sm:block">Metric sorting applies to the loaded page.</p> : null}
      </div>

      {!error && !loading && result?.applications?.length === 0 ? (
        <div className="mt-4"><EmptyState title="No applications matched" description="Adjust the search term and try again." /></div>
      ) : null}

      <section className={`mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3 ${loading ? 'opacity-55' : ''}`} aria-busy={loading} aria-label="AppDynamics applications">
        {(result?.applications || []).map((application) => <ApplicationCard application={application} key={application.id} range={range} />)}
        {loading && !result ? Array.from({ length: 8 }, (_, index) => (
          <div className="h-[250px] animate-pulse rounded-2xl border border-slate-200 bg-white" key={index} />
        )) : null}
      </section>

      {pagination?.pageCount > 1 ? (
        <nav className="mt-7 flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3" aria-label="Application pagination">
          <p className="text-xs font-semibold text-slate-500">Page {pagination.page} of {pagination.pageCount}</p>
          <div className="flex gap-2">
            <button aria-label="Previous application page" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-35" disabled={pagination.page <= 1 || loading} onClick={() => updateParams({ page: pagination.page - 1 })} type="button"><ChevronLeft className="h-4 w-4" /></button>
            <button aria-label="Next application page" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-35" disabled={pagination.page >= pagination.pageCount || loading} onClick={() => updateParams({ page: pagination.page + 1 })} type="button"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function MetricChart({ aggregationLabel, color, data, label, range, state, suffix = '' }) {
  const tickFormatter = (value) => {
    const date = new Date(value);
    if (['6mo', '1y'].includes(range)) return date.toLocaleDateString([], { month: 'short', year: '2-digit' });
    if (['7d', '30d', '90d'].includes(range)) return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
    if (range === '24h') return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div><h3 className="text-xs font-bold text-slate-800">{label}</h3>{aggregationLabel ? <p className="mt-1 text-[10px] text-slate-400">{aggregationLabel}</p> : null}</div>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      </div>
      {state?.status === 'data' && data?.length ? (
        <div className="mt-5 h-48">
          <ResponsiveContainer height="100%" width="100%">
            <LineChart data={data} margin={{ bottom: 0, left: -24, right: 6, top: 4 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
              <XAxis axisLine={false} dataKey="timestamp" minTickGap={36} tick={{ fill: '#94a3b8', fontSize: 9 }} tickFormatter={tickFormatter} tickLine={false} />
              <YAxis axisLine={false} tick={{ fill: '#94a3b8', fontSize: 9 }} tickLine={false} width={50} />
              <Tooltip contentStyle={{ border: '1px solid #e2e8f0', borderRadius: 12, boxShadow: '0 10px 30px rgba(15,23,42,.08)', fontSize: 11 }} formatter={(value) => [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`, label]} labelFormatter={(value) => new Date(value).toLocaleString()} />
              <Line dataKey="value" dot={false} isAnimationActive={false} stroke={color} strokeWidth={2} type="monotone" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
          <p className="text-xs font-semibold text-slate-600">
            {state?.status === 'no_data' ? 'No metric points returned in selected time range.' : <DataStateText range={range} status={state?.status || 'no_data'} />}
          </p>
          {state?.status === 'no_data' ? <p className="mt-1 text-[11px] text-slate-400">No points were returned for {formatRange(range)}.</p> : null}
        </div>
      )}
    </article>
  );
}

function ResourceStat({ emptyLabel, items, label, status }) {
  const hasData = status === 'data';
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <p className={`${hasData ? 'text-lg' : 'text-xs leading-4'} font-bold text-slate-900`}>
        {hasData ? items.length.toLocaleString() : <DataStateText noDataLabel={emptyLabel} status={status} />}
      </p>
      <p className="mt-1 text-[10px] font-semibold leading-4 text-slate-500">{label}</p>
    </div>
  );
}

function configurationSummary(label, items, status) {
  if (status === 'data') return `${items.length} ${label}`;
  if (status === 'unavailable') return `${label} not available`;
  if (status === 'error') return `${label} unable to load`;
  return `No ${label}`;
}

function OverviewTab({ onRangeChange, result }) {
  const metrics = result.application.metrics;
  const metricStates = metrics?.states || {};
  const appNodeId = `application:${result.application.id}`;
  const tierEdges = result.dependencySummary.edges.filter((edge) => edge.source === appNodeId);
  const hasNoMetricData = Object.values(metricStates).some((state) => state.status === 'no_data');
  const suggestedRange = { '15m': '1h', '30m': '1h', '1h': '24h', '4h': '24h' }[result.range] || null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
        <span className="font-bold text-slate-800">{result.rangeConfig?.label || `Last ${formatRange(result.range)}`}</span>
        <span className="text-slate-300">·</span>
        <span>{result.rangeConfig?.aggregationLabel}</span>
        <span className="text-slate-300">·</span>
        <span>{result.rangeConfig?.queryMode === 'BETWEEN_TIMES' ? 'Historical window' : 'Relative window'}</span>
      </div>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard hint={result.rangeConfig?.aggregationLabel} label="Calls / min" range={result.range} status={metricStates.callsPerMinute?.status} value={metrics?.callsPerMinute} />
        <MetricCard hint={result.rangeConfig?.aggregationLabel} label="Avg response time" range={result.range} status={metricStates.responseTime?.status} suffix=" ms" value={metrics?.responseTime} />
        <MetricCard hint={result.rangeConfig?.aggregationLabel} label="Errors / min" range={result.range} status={metricStates.errorsPerMinute?.status} value={metrics?.errorsPerMinute} />
        <MetricCard hint={result.rangeConfig?.aggregationLabel} label="Error rate" range={result.range} status={metricStates.errorPercent?.status} suffix="%" value={metrics?.errorPercent} />
      </section>

      {hasNoMetricData && suggestedRange ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">Some metrics have no points in {formatRange(result.range)}.</p>
          <button className="shrink-0 text-xs font-bold text-teal-700 hover:text-teal-900" onClick={() => onRangeChange(suggestedRange)} type="button">Try {formatRange(suggestedRange)}</button>
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-3">
        <MetricChart aggregationLabel={result.rangeConfig?.aggregationLabel} color="#0f766e" data={metrics?.series?.callsPerMinute} label="Calls per minute" range={result.range} state={metricStates.callsPerMinute} />
        <MetricChart aggregationLabel={result.rangeConfig?.aggregationLabel} color="#2563eb" data={metrics?.series?.responseTime} label="Average response time" range={result.range} state={metricStates.responseTime} suffix=" ms" />
        <MetricChart aggregationLabel={result.rangeConfig?.aggregationLabel} color="#e11d48" data={metrics?.series?.errorsPerMinute} label="Errors per minute" range={result.range} state={metricStates.errorsPerMinute} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_0.8fr]">
        <article className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Network className="h-4 w-4" /></span>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Dependency summary</h3>
              <p className="mt-0.5 text-[11px] text-slate-400">Application → tiers → registered backends</p>
            </div>
          </div>
          {tierEdges.length ? (
            <div className="mt-5 space-y-3">
              {tierEdges.map((edge) => {
                const tier = result.dependencySummary.nodes.find((node) => node.id === edge.target);
                const dependencies = result.dependencySummary.edges
                  .filter((candidate) => candidate.source === edge.target)
                  .map((candidate) => result.dependencySummary.nodes.find((node) => node.id === candidate.target))
                  .filter(Boolean);
                return (
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3" key={edge.target}>
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-800"><Server className="h-3.5 w-3.5 text-teal-600" />{tier?.label}</div>
                    {dependencies.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {dependencies.map((dependency) => <span className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600" key={dependency.id}>{dependency.label}</span>)}
                      </div>
                    ) : <p className="mt-1.5 text-[10px] text-slate-400">No registered downstream backend returned.</p>}
                  </div>
                );
              })}
            </div>
          ) : <div className="mt-5"><EmptyState title={result.resources?.tiers?.status === 'error' ? 'Unable to load data' : result.resources?.tiers?.status === 'unavailable' ? 'Not available through API' : 'No tier relationships returned'} description="The application model did not return dependency relationships for this application." /></div>}
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-bold text-slate-900">Inventory at a glance</h3>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <ResourceStat emptyLabel="No records" items={result.businessTransactions} label="Business transactions" status={result.resources?.businessTransactions?.status} />
            <ResourceStat emptyLabel="No records" items={result.tiers} label="Tiers" status={result.resources?.tiers?.status} />
            <ResourceStat emptyLabel="No nodes reported" items={result.nodes} label="Nodes" status={result.resources?.nodes?.status} />
            <ResourceStat emptyLabel="No recent events" items={result.events} label="Recent events" status={result.resources?.events?.status} />
            <ResourceStat emptyLabel="No database calls" items={result.databaseCalls} label="Database calls" status={result.resources?.databaseCalls?.status} />
            <ResourceStat emptyLabel="No remote services" items={result.remoteServices} label="Remote services" status={result.resources?.remoteServices?.status} />
          </div>
          {result.telemetryProfile?.tierTypes?.length || result.telemetryProfile?.agentTypes?.length ? (
            <p className="mt-4 text-[11px] leading-5 text-slate-500">Telemetry profile: {[...(result.telemetryProfile.tierTypes || []), ...(result.telemetryProfile.agentTypes || [])].join(' · ')}</p>
          ) : null}
          {!result.capabilities.serviceEndpoints ? (
            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-4 text-amber-800">Service Endpoint inventory is not exposed by the confirmed controller API, so it is not displayed.</p>
          ) : null}
        </article>
      </section>

      <details className="rounded-2xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-5 py-4 text-xs font-bold text-slate-700">Monitoring configuration · {configurationSummary('health rules', result.healthRules, result.resources?.healthRules?.status)} · {configurationSummary('policies', result.policies, result.resources?.policies?.status)}</summary>
        <div className="grid gap-5 border-t border-slate-100 p-5 lg:grid-cols-2">
          <ConfigList items={result.healthRules} label="Health rules" status={result.resources?.healthRules?.status} />
          <ConfigList items={result.policies} label="Policies" status={result.resources?.policies?.status} />
        </div>
      </details>
    </div>
  );
}

function ConfigList({ items, label, status }) {
  return (
    <div>
      <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</h4>
      {items.length ? <ul className="mt-3 max-h-60 space-y-2 overflow-y-auto pr-2">{items.map((item) => <li className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700" key={item.id}><span>{item.name}</span><span className={`h-2 w-2 shrink-0 rounded-full ${item.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} title={item.enabled ? 'Enabled' : 'Disabled'} /></li>)}</ul> : <p className="mt-3 text-xs text-slate-400"><DataStateText noDataLabel="No records" status={status} /></p>}
    </div>
  );
}

function BusinessTransactionsTab({ items, status }) {
  if (!items.length) {
    const title = status === 'error' ? 'Unable to load data' : status === 'unavailable' ? 'Not available through API' : 'No business transactions returned';
    return <EmptyState title={title} description="The controller did not return business transaction records for this application." />;
  }
  return (
    <TableShell minWidth="900px">
      <TableHead headings={['Business transaction', 'Tier', 'Entry point', 'Recent telemetry']} />
      <tbody className="divide-y divide-slate-100">
        {items.map((item) => (
          <tr className="align-top hover:bg-slate-50" key={item.id}>
            <td className="px-5 py-4 text-xs font-bold text-slate-800">{item.name}</td>
            <td className="px-5 py-4 text-xs text-slate-600">{item.tierName || 'Not reported'}</td>
            <td className="px-5 py-4 text-xs text-slate-600">{item.entryPointType || 'Not reported'}</td>
            <td className="px-5 py-4 text-xs text-slate-600">
              {item.metricStatus === 'data' ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {item.callsPerMinute !== null ? <span>Calls/min <strong className="text-slate-800"><MetricValue status="data" value={item.callsPerMinute} /></strong></span> : null}
                  {item.responseTime !== null ? <span>Response <strong className="text-slate-800"><MetricValue status="data" suffix=" ms" value={item.responseTime} /></strong></span> : null}
                  {item.errorsPerMinute !== null ? <span>Errors/min <strong className="text-slate-800"><MetricValue status="data" value={item.errorsPerMinute} /></strong></span> : null}
                </div>
              ) : <DataStateText noDataLabel="No recent metric data" status={item.metricStatus} />}
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function TiersNodesTab({ nodeStatus, nodes, tierStatus, tiers }) {
  const emptyNodeText = nodeStatus === 'error'
    ? 'Unable to load nodes'
    : nodeStatus === 'unavailable'
      ? 'Nodes not available through API'
      : 'No nodes reported by AppDynamics';
  if (!tiers.length && !nodes.length) {
    return <EmptyState title={tierStatus === 'error' || nodeStatus === 'error' ? 'Unable to load data' : tierStatus === 'unavailable' && nodeStatus === 'unavailable' ? 'Not available through API' : 'No tiers or nodes reported'} description="The application model returned no tier or node records for this application." />;
  }
  return (
    <div className="space-y-3">
      {tiers.map((tier) => {
        const tierNodes = nodes.filter((node) => node.tierId === tier.id || node.tierName === tier.name);
        return (
          <details className="rounded-2xl border border-slate-200 bg-white" key={tier.id} open={tiers.length === 1}>
            <summary className="cursor-pointer px-5 py-4">
              <span className="text-sm font-bold text-slate-900">{tier.name}</span>
              <span className="ml-3 text-[11px] font-semibold text-slate-400">{tierNodes.length ? `${tierNodes.length} nodes` : emptyNodeText}</span>
            </summary>
            <div className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-2 xl:grid-cols-3">
              {tierNodes.map((node) => (
                <article className="rounded-xl bg-slate-50 p-4" key={node.id}>
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-800"><Server className="h-3.5 w-3.5 text-teal-600" />{node.name}</div>
                  <div className="mt-3"><DefinitionList items={[
                    { label: 'Host', value: node.host },
                    { label: 'Agent type', value: node.agentType },
                    { label: 'Agent version', value: node.agentVersion },
                    { label: 'Operating system', value: node.operatingSystem },
                    { label: 'JVM', value: node.jvm },
                  ]} /></div>
                </article>
              ))}
              {!tierNodes.length ? <p className="text-xs text-slate-400">{emptyNodeText}</p> : null}
            </div>
          </details>
        );
      })}
      {nodes.filter((node) => !node.tierId && !node.tierName).map((node) => <article className="rounded-2xl border border-slate-200 bg-white p-5" key={node.id}><p className="text-sm font-bold text-slate-900">{node.name}</p><div className="mt-4"><DefinitionList items={[{ label: 'Host', value: node.host }, { label: 'Agent type', value: node.agentType }, { label: 'Agent version', value: node.agentVersion }]} /></div></article>)}
    </div>
  );
}

function BackendsTab({ items, kind, status }) {
  const Icon = kind === 'database' ? Database : Workflow;
  if (!items.length) {
    const resource = kind === 'database' ? 'database calls' : 'remote services';
    const title = status === 'error' ? 'Unable to load data' : status === 'unavailable' ? 'Not available through API' : `No ${resource} returned`;
    return <EmptyState title={title} description={status === 'no_data' ? `The registered backends API returned no ${resource} for this application.` : `AppDynamics could not provide ${resource} for this application.`} />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {items.map((item) => (
        <article className="rounded-2xl border border-slate-200 bg-white p-5" key={item.id}>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0">
              <h3 className="break-words text-sm font-bold text-slate-900">{item.name}</h3>
              <p className="mt-1 text-[11px] font-semibold text-slate-400">{[item.type, item.tierName].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          {Object.keys(item.properties || {}).length ? <div className="mt-4"><DefinitionList items={Object.entries(item.properties).slice(0, 12).map(([label, value]) => ({ label, value }))} /></div> : null}
        </article>
      ))}
    </div>
  );
}

function EventsTab({ items, loading, onPageChange, pagination, partial, status }) {
  if (!items.length) {
    const title = partial || status === 'error' ? 'Unable to load complete event data' : status === 'unavailable' ? 'Not available through API' : 'No recent events';
    return <EmptyState title={title} description={partial ? 'One AppDynamics event endpoint failed and the other returned no records.' : status === 'no_data' ? 'No event or violation records were returned in the selected time range.' : 'AppDynamics could not provide event data for this application.'} />;
  }
  const hasHealthRule = items.some((item) => item.healthRule);
  const hasEntity = items.some((item) => item.affectedEntity || item.tier || item.node || item.businessTransaction);
  const headings = ['Time', 'Type', 'Severity', 'Message'];
  if (hasHealthRule) headings.push('Health rule');
  if (hasEntity) headings.push('Affected entity');
  return (
    <div>
      {partial ? <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Some event categories could not be loaded for this range. The records below are the real results that AppDynamics did return.</p> : null}
      <TableShell minWidth="1000px">
        <TableHead headings={headings} />
        <tbody className="divide-y divide-slate-100">
          {items.map((item, index) => (
            <tr className="align-top hover:bg-slate-50" key={item.id || `${item.time}-${index}`}>
              <td className="whitespace-nowrap px-5 py-4 text-[11px] text-slate-500">{formatFreshness(item.time) || 'Not reported'}</td>
              <td className="px-5 py-4 text-xs font-semibold text-slate-700">{item.type || 'Event'}</td>
              <td className="px-5 py-4"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{item.severity || 'Not reported'}</span></td>
              <td className="max-w-xl px-5 py-4 text-xs leading-5 text-slate-700">{item.message || 'Not reported'}</td>
              {hasHealthRule ? <td className="px-5 py-4 text-xs text-slate-600">{item.healthRule || 'Not reported'}</td> : null}
              {hasEntity ? <td className="px-5 py-4 text-xs text-slate-600">{item.businessTransaction || item.node || item.tier || item.affectedEntity || 'Not reported'}</td> : null}
            </tr>
          ))}
        </tbody>
      </TableShell>
      {pagination?.pageCount > 1 ? (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs font-semibold text-slate-500">Newest first · page {pagination.page} of {pagination.pageCount}</p>
          <div className="flex gap-2">
            <button aria-label="Previous events page" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-35" disabled={loading || pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} type="button"><ChevronLeft className="h-4 w-4" /></button>
            <button aria-label="Next events page" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-35" disabled={loading || pagination.page >= pagination.pageCount} onClick={() => onPageChange(pagination.page + 1)} type="button"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ApplicationDetail({ applicationId, range, setRange }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('Overview');
  const [eventPage, setEventPage] = useState(1);
  const requestSequence = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError('');
    try {
      const response = await getAppDynamicsWorkspaceApplication(applicationId, { eventPage, eventPageSize: 100, range, refresh });
      if (requestSequence.current === sequence) setResult(response);
    } catch (requestError) {
      if (requestSequence.current === sequence) setError(requestError.message);
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [applicationId, eventPage, range]);

  useEffect(() => { load(false); }, [load]);

  const tabs = useMemo(() => {
    if (!result) return ['Overview'];
    return ['Overview', 'Business Transactions', 'Tiers & Nodes', 'Database Calls', 'Remote Services', 'Events'];
  }, [result]);

  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab('Overview');
  }, [activeTab, tabs]);

  function changeRange(value) {
    setEventPage(1);
    setRange(value);
  }

  return (
    <div>
      <Link className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 transition hover:text-slate-950" to={`/appdynamics?range=${range}`}><ArrowLeft className="h-3.5 w-3.5" />All applications</Link>

      <div className="mt-5 flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><p className="text-[10px] font-bold uppercase tracking-[0.13em] text-teal-700">AppDynamics application</p><LiveReadOnlyBadge /></div>
          <h1 className="mt-3 break-words text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">{result?.application?.name || (loading ? 'Loading application…' : 'Application')}</h1>
          {result?.application ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-500">
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">Application ID {result.application.id}</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Connected</span>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">Selected range: {formatRange(result.range)}</span>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">Fetched: {formatFreshness(result.lastUpdated)}</span>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangeControl disabled={loading} onChange={changeRange} value={range} />
          <RefreshButton loading={loading} onClick={() => load(true)} />
          <SourceButton href={result?.application?.sourceUrl} />
        </div>
      </div>

      {error ? <ErrorPanel message={error} onRetry={() => load(true)} /> : null}
      {loading && !result ? <div className="mt-8 h-80 animate-pulse rounded-2xl border border-slate-200 bg-white" /> : null}

      {result ? (
        <>
          <nav className="mt-8 overflow-x-auto border-b border-slate-200" aria-label="Application workspace tabs">
            <div className="flex min-w-max gap-1">
              {tabs.map((tab) => (
                <button className={`border-b-2 px-3.5 py-3 text-xs font-bold transition ${activeTab === tab ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-900'}`} key={tab} onClick={() => setActiveTab(tab)} type="button">{tab}</button>
              ))}
            </div>
          </nav>

          <section className={`mt-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
            {activeTab === 'Overview' ? <OverviewTab onRangeChange={changeRange} result={result} /> : null}
            {activeTab === 'Business Transactions' ? <BusinessTransactionsTab items={result.businessTransactions} status={result.resources?.businessTransactions?.status} /> : null}
            {activeTab === 'Tiers & Nodes' ? <TiersNodesTab nodeStatus={result.resources?.nodes?.status} nodes={result.nodes} tierStatus={result.resources?.tiers?.status} tiers={result.tiers} /> : null}
            {activeTab === 'Database Calls' ? <BackendsTab items={result.databaseCalls} kind="database" status={result.resources?.databaseCalls?.status} /> : null}
            {activeTab === 'Remote Services' ? <BackendsTab items={result.remoteServices} kind="remote" status={result.resources?.remoteServices?.status} /> : null}
            {activeTab === 'Events' ? <EventsTab items={result.events} loading={loading} onPageChange={setEventPage} pagination={result.eventPagination} partial={result.resources?.events?.partial} status={result.resources?.events?.status} /> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

export default function AppDynamicsWorkspace() {
  const { applicationId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawRange = searchParams.get('range') || DEFAULT_RANGE;
  const range = normalizeRange(rawRange);

  useEffect(() => {
    if (rawRange === range) return;
    const next = new URLSearchParams(searchParams);
    next.set('range', range);
    setSearchParams(next, { replace: true });
  }, [range, rawRange, searchParams, setSearchParams]);

  function setRange(value) {
    const next = new URLSearchParams(searchParams);
    next.set('range', String(value));
    if (applicationId) next.delete('page');
    else next.set('page', '1');
    setSearchParams(next);
  }

  return applicationId
    ? <ApplicationDetail applicationId={applicationId} range={range} setRange={setRange} />
    : <ApplicationsList range={range} setRange={setRange} />;
}

import {
  Activity,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Globe2,
  MapPin,
  Network,
  Search,
  Server,
  TestTube2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TableHead, TableShell } from '../components/operational/DemoUi.jsx';
import {
  BackLink,
  EmptyState,
  ErrorPanel,
  formatDateTime,
  formatDuration,
  formatMetric,
  Freshness,
  LiveBadge,
  RefreshButton,
  SourceLink,
  StatusBadge,
  SummaryCard,
  THOUSANDEYES_RANGES,
  TimeRange,
  WorkspaceHeader,
} from '../components/thousandeyes/ThousandEyesUi.jsx';
import {
  getThousandEyesAlert,
  getThousandEyesAlerts,
  getThousandEyesAgent,
  getThousandEyesDashboard,
  getThousandEyesEvent,
  getThousandEyesEvents,
  getThousandEyesTest,
} from '../services/api.js';

function updateParams(searchParams, setSearchParams, values) {
  const next = new URLSearchParams(searchParams);
  Object.entries(values).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '' || value === 'all') next.delete(key);
    else next.set(key, String(value));
  });
  setSearchParams(next);
}

function useRemoteData(loader, dependencies) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = sequence.current + 1;
    sequence.current = current;
    setLoading(true);
    setError('');
    try {
      const result = await loader();
      if (sequence.current === current) setData(result);
    } catch (requestError) {
      if (sequence.current === current) setError(requestError.message);
    } finally {
      if (sequence.current === current) setLoading(false);
    }
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, error, load, loading };
}

function SmallSparkline({ data, dataKey }) {
  const usable = data?.filter((point) => Number.isFinite(Number(point[dataKey]))) || [];
  if (usable.length < 2) return <span className="text-[11px] text-slate-400">No trend</span>;
  return (
    <div className="h-9 w-28" aria-label={`${dataKey} trend`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={usable} margin={{ bottom: 2, left: 2, right: 2, top: 2 }}>
          <Line dataKey={dataKey} dot={false} isAnimationActive={false} stroke="#0f766e" strokeWidth={2} type="monotone" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function chooseMetric(metrics = {}) {
  const options = [
    { key: 'responseTime', label: 'Response', suffix: ' ms' },
    { key: 'latency', label: 'Latency', suffix: ' ms' },
    { key: 'availability', label: 'Availability', suffix: '%' },
    { key: 'loss', label: 'Loss', suffix: '%' },
    { key: 'dnsTime', label: 'DNS', suffix: ' ms' },
  ];
  return options.find((option) => metrics[option.key] !== null && metrics[option.key] !== undefined && Number.isFinite(Number(metrics[option.key]))) || options[0];
}

function LoadingBlock({ label = 'Loading live ThousandEyes data…' }) {
  return (
    <div className="mt-6 flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-400">
      <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-teal-600" />
      {label}
    </div>
  );
}

function AgentMap({ agents }) {
  const clusters = agents?.clusters || [];
  if (!clusters.length) {
    return <EmptyState title="Agent locations unavailable" description="The connected account did not return usable coordinates for its agents." />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      <svg className="block h-auto w-full" role="img" aria-label="Real ThousandEyes agent coordinate map" viewBox="0 0 720 320">
        <defs>
          <linearGradient id="te-map" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#f8fafc" />
            <stop offset="1" stopColor="#ecfdf5" />
          </linearGradient>
        </defs>
        <rect fill="url(#te-map)" height="320" width="720" />
        {[90, 180, 270, 360, 450, 540, 630].map((x) => <line key={`x-${x}`} stroke="#e2e8f0" strokeDasharray="3 5" x1={x} x2={x} y1="0" y2="320" />)}
        {[80, 160, 240].map((y) => <line key={`y-${y}`} stroke="#e2e8f0" strokeDasharray="3 5" x1="0" x2="720" y1={y} y2={y} />)}
        <text fill="#94a3b8" fontSize="10" x="18" y="24">Agent coordinates returned by ThousandEyes</text>
        {clusters.map((cluster, index) => {
          const x = ((cluster.longitude + 180) / 360) * 720;
          const y = ((90 - cluster.latitude) / 180) * 320;
          const radius = Math.min(11, 3 + Math.sqrt(cluster.count));
          const label = `${cluster.locations?.join(', ') || `${cluster.latitude}, ${cluster.longitude}`} · ${cluster.count} agents`;
          return (
            <g key={`${cluster.latitude}-${cluster.longitude}-${index}`}>
              <circle cx={x} cy={y} fill="#0f766e" fillOpacity="0.18" r={radius + 4} />
              <circle cx={x} cy={y} fill="#0f766e" r={radius}>
                <title>{label}</title>
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = searchParams.get('range') || '1h';
  const page = Number(searchParams.get('page')) || 1;
  const search = searchParams.get('search') || '';
  const type = searchParams.get('type') || 'all';
  const [draftSearch, setDraftSearch] = useState(search);
  const remote = useRemoteData(
    () => getThousandEyesDashboard({ page, range, search, type }),
    [page, range, search, type],
  );
  useEffect(() => { setDraftSearch(search); }, [search]);
  const result = remote.data;
  const pagination = result?.pagination;
  function submitSearch(event) {
    event.preventDefault();
    updateParams(searchParams, setSearchParams, { page: 1, search: draftSearch.trim() });
  }
  return (
    <div>
      <WorkspaceHeader
        title="ThousandEyes"
        description="Monitor real synthetic tests, active alerts, test health, and agent coverage from the connected ThousandEyes account. Credentials remain server-side and every view is read only."
        actions={<LiveBadge />}
      />
      {remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}
      {remote.loading && !result ? <LoadingBlock /> : null}
      {result ? (
        <>
          <section className="mt-6 flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Connection</p>
              <p className="mt-2 flex items-center gap-2 text-sm font-bold text-slate-900"><span className="h-2 w-2 rounded-full bg-emerald-500" />Connected</p>
              <div className="mt-2 flex flex-wrap items-center gap-2"><Freshness value={result.lastUpdated} /><span className="text-[11px] text-slate-300">·</span><span className="text-[11px] text-slate-400">OAuth token secured in backend</span></div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TimeRange disabled={remote.loading} onChange={(value) => updateParams(searchParams, setSearchParams, { page: 1, range: value })} value={range} />
              <RefreshButton loading={remote.loading} onClick={remote.load} />
            </div>
          </section>

          <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={TestTube2} label="Tests" value={result.summary.tests.toLocaleString()} hint={`${result.summary.enabledTests.toLocaleString()} enabled`} />
            <SummaryCard icon={BellRing} label="Active Alerts" value={result.summary.activeAlerts.toLocaleString()} hint={`${result.summary.clearedAlerts24h.toLocaleString()} cleared in last 24h`} />
            <SummaryCard icon={Server} label="Agents Online" value={result.summary.agentsOnline.toLocaleString()} hint={`${result.summary.agentsTotal.toLocaleString()} agents returned`} />
            <SummaryCard icon={Network} label="Test Types" value={result.summary.testTypes.toLocaleString()} hint="Types configured in this account" />
          </section>

          <section className="mt-8">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div><h2 className="text-lg font-semibold text-slate-950">Test inventory</h2><p className="mt-1 text-xs text-slate-500">Current metrics and a compact trend from real test-result endpoints.</p></div>
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submitSearch}>
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
                  <input aria-label="Search tests" className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-xs font-medium text-slate-700 outline-none focus:border-teal-500 sm:w-64" onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search tests or targets" value={draftSearch} />
                </label>
                <select aria-label="Test type" className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 outline-none" onChange={(event) => updateParams(searchParams, setSearchParams, { page: 1, type: event.target.value })} value={type}>
                  <option value="all">All test types</option>
                  {result.availableTypes.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <button className="h-10 rounded-xl bg-slate-950 px-4 text-xs font-bold text-white" type="submit">Search</button>
              </form>
            </div>
            <div className="mt-4">
              {result.tests.length ? (
                <TableShell minWidth="1060px">
                  <TableHead headings={['Status', 'Test', 'Type', 'Target', 'Current metric', 'Trend', 'Alerts', 'Last run']} />
                  <tbody className="divide-y divide-slate-100">
                    {result.tests.map((test) => {
                      const metric = chooseMetric(test.metrics);
                      return (
                        <tr className="transition hover:bg-slate-50/80" key={test.id}>
                          <td className="px-5 py-4"><StatusBadge value={test.activeAlertCount ? test.highestSeverity || 'active' : test.enabled ? 'enabled' : 'unknown'} /></td>
                          <td className="px-5 py-4"><Link className="text-xs font-bold text-slate-900 hover:text-teal-700" to={`/thousandeyes/tests/${encodeURIComponent(test.id)}?${searchParams.toString()}`}>{test.name}</Link><p className="mt-1 text-[10px] text-slate-400">ID {test.id}</p></td>
                          <td className="px-5 py-4 text-xs font-semibold text-slate-600">{test.type}</td>
                          <td className="max-w-[260px] px-5 py-4"><p className="truncate text-xs text-slate-600" title={test.target || ''}>{test.target || '—'}</p></td>
                          <td className="px-5 py-4"><p className="text-xs font-bold text-slate-900">{formatMetric(test.metrics?.[metric.key], metric.suffix)}</p><p className="mt-1 text-[10px] text-slate-400">{metric.label}</p></td>
                          <td className="px-5 py-4"><SmallSparkline data={test.metrics?.series} dataKey={metric.key} /></td>
                          <td className="px-5 py-4 text-xs font-bold text-slate-700">{test.activeAlertCount}</td>
                          <td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(test.metrics?.lastRunAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableShell>
              ) : <EmptyState title="No tests match these filters" description="Change the search or test-type filter. No placeholder tests are shown." />}
            </div>
            {pagination ? (
              <div className="mt-4 flex items-center justify-between gap-4">
                <p className="text-xs text-slate-400">Page {pagination.page} of {pagination.totalPages} · {pagination.totalItems.toLocaleString()} tests</p>
                <div className="flex gap-2">
                  <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 disabled:opacity-40" disabled={pagination.page <= 1 || remote.loading} onClick={() => updateParams(searchParams, setSearchParams, { page: page - 1 })} type="button"><ChevronLeft className="h-3.5 w-3.5" />Previous</button>
                  <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 disabled:opacity-40" disabled={pagination.page >= pagination.totalPages || remote.loading} onClick={() => updateParams(searchParams, setSearchParams, { page: page + 1 })} type="button">Next<ChevronRight className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
            <article className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="mb-4"><h2 className="text-base font-semibold text-slate-950">Agent coverage</h2><p className="mt-1 text-xs text-slate-500">Clusters use real coordinates returned by the Agents API.</p></div>
              <AgentMap agents={result.agents} />
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="text-base font-semibold text-slate-950">Configured test types</h2>
              <div className="mt-5 space-y-4">
                {Object.entries(result.typeCounts).sort((left, right) => right[1] - left[1]).map(([name, count]) => (
                  <div key={name}>
                    <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-slate-600">{name}</span><span className="text-xs font-bold text-slate-900">{count}</span></div>
                    <div className="mt-2 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.max(4, (count / result.summary.tests) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}

function MetricChart({ data, dataKey, label, suffix }) {
  const usable = data?.filter((point) => Number.isFinite(Number(point[dataKey]))) || [];
  if (!usable.length) return null;
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4"><h3 className="text-sm font-semibold text-slate-900">{label}</h3><span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Real samples</span></div>
      <div className="mt-5 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={usable} margin={{ bottom: 0, left: -10, right: 10, top: 8 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 5" vertical={false} />
            <XAxis axisLine={false} dataKey="timestamp" minTickGap={42} tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} tickLine={false} />
            <YAxis axisLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} unit={suffix} width={52} />
            <Tooltip formatter={(value) => [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`, label]} labelFormatter={formatDateTime} />
            <Line dataKey={dataKey} dot={false} isAnimationActive={false} stroke="#0f766e" strokeWidth={2.25} type="monotone" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}

function TestDetail({ testId }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceAlertId = searchParams.get('alertId') || '';
  const range = searchParams.get('range') || '1h';
  const remote = useRemoteData(() => getThousandEyesTest(testId, { range }), [testId, range]);
  const result = remote.data;
  const metricSets = result ? Object.entries(result.metrics || {}) : [];
  const backParams = new URLSearchParams(searchParams);
  backParams.delete('alertId');
  return (
    <div>
      <WorkspaceHeader title="ThousandEyes" description="Inspect a selected real test and the result types available through the connected account." />
      <div className="mt-7"><BackLink to={sourceAlertId ? `/thousandeyes/alerts/${encodeURIComponent(sourceAlertId)}?${backParams.toString()}` : `/thousandeyes?${searchParams.toString()}`}>{sourceAlertId ? 'Back to alert' : 'Back to test inventory'}</BackLink></div>
      {remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}
      {remote.loading && !result ? <LoadingBlock label="Loading test results…" /> : null}
      {result ? (
        <>
          <section className="flex flex-col justify-between gap-5 rounded-2xl border border-slate-200 bg-white p-6 lg:flex-row lg:items-start">
            <div><div className="flex flex-wrap items-center gap-2"><StatusBadge value={result.test.activeAlertCount ? result.test.highestSeverity || 'active' : result.test.enabled ? 'enabled' : 'unknown'} /><span className="text-[11px] font-semibold text-slate-400">{result.test.type}</span></div><h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">{result.test.name}</h2><p className="mt-2 break-all text-sm text-slate-500">{result.test.target || 'No target returned'}</p><p className="mt-3 text-xs text-slate-400">Test ID {result.test.id} · interval {result.test.interval ? `${result.test.interval} sec` : 'not returned'}</p></div>
            <div className="flex flex-wrap items-center gap-2"><TimeRange disabled={remote.loading} onChange={(value) => updateParams(searchParams, setSearchParams, { range: value })} value={range} /><RefreshButton loading={remote.loading} onClick={remote.load} /></div>
          </section>
          <div className="mt-3 flex justify-end"><Freshness value={result.lastUpdated} /></div>
          {metricSets.length ? metricSets.map(([type, metrics]) => (
            <section className="mt-7" key={type}>
              <div className="flex items-end justify-between gap-4"><div><h2 className="text-lg font-semibold capitalize text-slate-950">{type.replaceAll('-', ' ')}</h2><p className="mt-1 text-xs text-slate-500">{metrics.sampleCount.toLocaleString()} returned samples{metrics.truncated ? ' · bounded preview' : ''}</p></div></div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryCard label="Availability" value={formatMetric(metrics.availability, '%')} hint="Average for selected range" />
                <SummaryCard label="Response time" value={formatMetric(metrics.responseTime, ' ms')} hint="Average" />
                <SummaryCard label="Latency" value={formatMetric(metrics.latency, ' ms')} hint="Average" />
                <SummaryCard label="Packet loss" value={formatMetric(metrics.loss, '%')} hint={metrics.lastRunAt ? `Last run ${formatDateTime(metrics.lastRunAt)}` : 'No returned sample'} />
              </div>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <MetricChart data={metrics.series} dataKey={chooseMetric(metrics).key} label={chooseMetric(metrics).label} suffix={chooseMetric(metrics).suffix.trim()} />
                <MetricChart data={metrics.series} dataKey="availability" label="Availability" suffix="%" />
              </div>
            </section>
          )) : <div className="mt-7"><EmptyState title="No test-result data returned" description={`The test exists, but its applicable result endpoints returned no samples in the selected ${range} range.`} /></div>}
          {result.activeAlerts.length ? <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-base font-semibold text-slate-950">Active alerts</h2><div className="mt-4 divide-y divide-slate-100">{result.activeAlerts.map((alert) => <Link className="flex items-center justify-between gap-4 py-3 text-xs font-semibold text-slate-700 hover:text-teal-700" key={alert.id} to={`/thousandeyes/alerts/${encodeURIComponent(alert.id)}?view=active&range=${range}`}><span>{alert.ruleName || alert.type}</span><StatusBadge value={alert.severity} /></Link>)}</div></section> : null}
          <details className="mt-8 rounded-2xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer text-xs font-bold text-slate-700">Technical details</summary><dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(result.technical || {}).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => <div key={key}><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{key}</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{String(value)}</dd></div>)}</dl></details>
        </>
      ) : null}
    </div>
  );
}

function CursorPagination({ cursorHistory, loading, nextCursor, onNext, onPrevious }) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2">
      <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 disabled:opacity-40" disabled={!cursorHistory.length || loading} onClick={onPrevious} type="button"><ChevronLeft className="h-3.5 w-3.5" />Previous</button>
      <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 disabled:opacity-40" disabled={!nextCursor || loading} onClick={onNext} type="button">Next<ChevronRight className="h-3.5 w-3.5" /></button>
    </div>
  );
}

function EventDetection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = searchParams.get('range') || '24h';
  const search = searchParams.get('search') || '';
  const type = searchParams.get('type') || 'all';
  const state = searchParams.get('state') || 'all';
  const cursor = searchParams.get('cursor') || '';
  const [history, setHistory] = useState([]);
  const [draftSearch, setDraftSearch] = useState(search);
  const remote = useRemoteData(() => getThousandEyesEvents({ cursor, range, search, state, type }), [cursor, range, search, state, type]);
  useEffect(() => { setDraftSearch(search); }, [search]);
  function changeFilters(values) { setHistory([]); updateParams(searchParams, setSearchParams, { ...values, cursor: null }); }
  return (
    <div>
      <WorkspaceHeader title="Event Detection" description="Review events detected by ThousandEyes using only the fields and access available to this account. Empty ranges remain explicitly empty." />
      <section className="mt-6 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 xl:flex-row xl:items-center xl:justify-between">
        <form className="flex flex-1 flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); changeFilters({ search: draftSearch.trim() }); }}><label className="relative block flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input aria-label="Search events" className="h-10 w-full rounded-xl border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-teal-500" onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search event type or ID" value={draftSearch} /></label><select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600" onChange={(event) => changeFilters({ type: event.target.value })} value={type}><option value="all">All types</option>{(remote.data?.filters?.types || []).map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600" onChange={(event) => changeFilters({ state: event.target.value })} value={state}><option value="all">All states</option><option value="active">Active</option><option value="resolved">Resolved</option></select><button className="h-10 rounded-xl bg-slate-950 px-4 text-xs font-bold text-white" type="submit">Search</button></form>
        <div className="flex flex-wrap items-center gap-2"><TimeRange disabled={remote.loading} onChange={(value) => changeFilters({ range: value })} value={range} /><RefreshButton loading={remote.loading} onClick={remote.load} /></div>
      </section>
      {remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}
      {remote.loading && !remote.data ? <LoadingBlock label="Loading Event Detection…" /> : null}
      {remote.data ? <div className="mt-5">{remote.data.events.length ? <TableShell minWidth="900px"><TableHead headings={['Severity', 'Event', 'Type', 'State', 'Started', 'Ended', 'Affected']} /><tbody className="divide-y divide-slate-100">{remote.data.events.map((event) => <tr key={event.id} className="hover:bg-slate-50"><td className="px-5 py-4"><StatusBadge value={event.severity} /></td><td className="px-5 py-4"><Link className="text-xs font-bold text-slate-900 hover:text-teal-700" to={`/thousandeyes/event-detection/${encodeURIComponent(event.id)}?${searchParams.toString()}`}>{event.summary}</Link><p className="mt-1 text-[10px] text-slate-400">{event.id}</p></td><td className="px-5 py-4 text-xs font-semibold text-slate-600">{event.type}</td><td className="px-5 py-4"><StatusBadge value={event.state} /></td><td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(event.startDate)}</td><td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(event.endDate)}</td><td className="px-5 py-4 text-xs font-semibold text-slate-600">{event.affectedTests.length} tests · {event.affectedAgents.length} agents</td></tr>)}</tbody></TableShell> : <EmptyState title={`No Event Detection events in the last ${range}`} description="The Event Detection API is reachable, but this account returned no events for the selected range and filters. No sample events are substituted." />}<div className="mt-3 flex justify-between"><Freshness value={remote.data.lastUpdated} /><CursorPagination cursorHistory={history} loading={remote.loading} nextCursor={remote.data.pagination.nextCursor} onNext={() => { setHistory((items) => [...items, cursor]); updateParams(searchParams, setSearchParams, { cursor: remote.data.pagination.nextCursor }); }} onPrevious={() => { const previous = history.at(-1) || null; setHistory((items) => items.slice(0, -1)); updateParams(searchParams, setSearchParams, { cursor: previous }); }} /></div></div> : null}
    </div>
  );
}

function EventDetail({ eventId }) {
  const { search } = useLocation();
  const remote = useRemoteData(() => getThousandEyesEvent(eventId), [eventId]);
  const result = remote.data;
  return <div><WorkspaceHeader title="Event Detection" description="Inspect a selected event and its real affected-test and affected-agent context." /><div className="mt-7"><BackLink to={`/thousandeyes/event-detection${search}`}>Back to Event Detection</BackLink></div>{remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}{remote.loading && !result ? <LoadingBlock /> : null}{result ? <><section className="rounded-2xl border border-slate-200 bg-white p-6"><div className="flex flex-wrap items-center gap-2"><StatusBadge value={result.event.severity} /><StatusBadge value={result.event.state} /><span className="text-[11px] font-semibold text-slate-400">{result.event.type}</span></div><h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">{result.event.summary}</h2><dl className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-[10px] font-bold uppercase text-slate-400">Started</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDateTime(result.event.startDate)}</dd></div><div><dt className="text-[10px] font-bold uppercase text-slate-400">Ended</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDateTime(result.event.endDate)}</dd></div><div><dt className="text-[10px] font-bold uppercase text-slate-400">Affected tests</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.event.affectedTests.length}</dd></div><div><dt className="text-[10px] font-bold uppercase text-slate-400">Affected agents</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.event.affectedAgents.length}</dd></div></dl><div className="mt-6"><SourceLink href={result.event.sourceLink} /></div></section><details className="mt-6 rounded-2xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer text-xs font-bold text-slate-700">Technical details</summary><pre className="mt-4 max-h-96 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-4 text-[11px] leading-5 text-slate-600">{JSON.stringify(result.technical, null, 2)}</pre></details></> : null}</div>;
}

function AlertAgentSummary({ alert }) {
  const agents = alert.affectedAgents || [];
  if (!agents.length) return <span className="text-xs text-slate-400">—</span>;
  const names = agents.map((agent) => agent.name || `Agent ${agent.id}`);
  return (
    <div className="max-w-[190px]" title={names.join(', ')}>
      <p className="truncate text-xs font-semibold text-slate-700">{names[0]}</p>
      {names.length > 1 ? <p className="mt-1 text-[10px] font-bold text-teal-700">+{names.length - 1} more</p> : null}
    </div>
  );
}

function AlertsWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const view = searchParams.get('view') === 'history' ? 'history' : 'active';
  const range = searchParams.get('range') || (view === 'active' ? '24h' : '7d');
  const search = searchParams.get('search') || '';
  const severity = searchParams.get('severity') || 'all';
  const type = searchParams.get('type') || 'all';
  const cursor = searchParams.get('cursor') || '';
  const [history, setHistory] = useState([]);
  const [draftSearch, setDraftSearch] = useState(search);
  const remote = useRemoteData(() => getThousandEyesAlerts({ cursor, range, search, severity, type, view }), [cursor, range, search, severity, type, view]);
  useEffect(() => { setDraftSearch(search); }, [search]);
  function changeFilters(values) { setHistory([]); updateParams(searchParams, setSearchParams, { ...values, cursor: null }); }
  const currentCount = remote.data?.currentCount;
  const headings = view === 'active'
    ? ['Severity', 'Alert Name', 'Test', 'Agent(s)', 'Type', 'Started', 'Duration', '']
    : ['Severity', 'Alert Name', 'Test', 'Agent(s)', 'Type', 'Started', 'Ended', 'Duration', 'Status', ''];
  return (
    <div>
      <WorkspaceHeader title="Alerts" description="Separate currently active ThousandEyes alerts from cleared alert history, with bounded real-data detail and evidence." />
      <div className="mt-6 inline-flex rounded-xl border border-slate-200 bg-white p-1"><button className={`rounded-lg px-4 py-2 text-xs font-bold ${view === 'active' ? 'bg-slate-950 text-white' : 'text-slate-500'}`} onClick={() => changeFilters({ range: '24h', view: 'active' })} type="button">Active Alerts{view === 'active' && currentCount !== null && currentCount !== undefined ? ` · ${currentCount}` : ''}</button><button className={`rounded-lg px-4 py-2 text-xs font-bold ${view === 'history' ? 'bg-slate-950 text-white' : 'text-slate-500'}`} onClick={() => changeFilters({ range: '7d', view: 'history' })} type="button">Alert History</button></div>
      <section className="mt-4 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 xl:flex-row xl:items-center xl:justify-between">
        <form className="flex flex-1 flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); changeFilters({ search: draftSearch.trim() }); }}><label className="relative block flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input aria-label="Search alerts" className="h-10 w-full rounded-xl border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-teal-500" onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search alert name, test, agent, or ID" value={draftSearch} /></label><select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600" onChange={(event) => changeFilters({ severity: event.target.value })} value={severity}><option value="all">All severities</option>{(remote.data?.filters?.severities || []).map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600" onChange={(event) => changeFilters({ type: event.target.value })} value={type}><option value="all">All types</option>{(remote.data?.filters?.types || []).map((item) => <option key={item} value={item}>{item}</option>)}</select><button className="h-10 rounded-xl bg-slate-950 px-4 text-xs font-bold text-white" type="submit">Search</button></form>
        <div className="flex flex-wrap items-center gap-2">{view === 'history' ? <TimeRange disabled={remote.loading} onChange={(value) => changeFilters({ range: value })} value={range} ranges={[...THOUSANDEYES_RANGES, { label: '30d', value: '30d' }, { label: '90d', value: '90d' }]} /> : null}<RefreshButton loading={remote.loading} onClick={remote.load} /></div>
      </section>
      {remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}
      {remote.loading && !remote.data ? <LoadingBlock label="Loading alerts…" /> : null}
      {remote.data ? <div className="mt-5"><div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-950">{view === 'active' ? `Active Alerts ${currentCount ?? remote.data.alerts.length}` : 'Alert History'}</h2><p className="mt-1 text-xs text-slate-500">{view === 'active' ? 'Current triggered alert occurrences returned by ThousandEyes.' : `Cleared alert occurrences from the selected ${range} range.`}</p></div><Freshness value={remote.data.lastUpdated} /></div>{remote.data.alerts.length ? <TableShell minWidth={view === 'active' ? '1120px' : '1320px'}><TableHead headings={headings} /><tbody className="divide-y divide-slate-100">{remote.data.alerts.map((alert) => {
        const detailUrl = `/thousandeyes/alerts/${encodeURIComponent(alert.id)}?${searchParams.toString()}`;
        return <tr aria-label={`Open ${alert.name || alert.ruleName || alert.id}`} className="cursor-pointer hover:bg-slate-50 focus-within:bg-slate-50" key={alert.id} onClick={() => navigate(detailUrl)} onKeyDown={(event) => { if (event.key === 'Enter') navigate(detailUrl); }} tabIndex={0}><td className="px-5 py-4"><StatusBadge value={alert.severity} /></td><td className="px-5 py-4"><Link className="text-xs font-bold text-slate-900 hover:text-teal-700" to={detailUrl}>{alert.name || alert.ruleName || 'ThousandEyes alert'}</Link><p className="mt-1 text-[10px] font-medium text-slate-400">Alert ID: {alert.id.slice(0, 8)}…</p>{view === 'active' ? <p className="mt-2"><StatusBadge value={alert.state} /></p> : null}</td><td className="max-w-[260px] px-5 py-4 text-xs font-semibold text-slate-700"><span className="line-clamp-2">{alert.testName || alert.testId || '—'}</span></td><td className="px-5 py-4"><AlertAgentSummary alert={alert} /></td><td className="px-5 py-4 text-xs font-semibold text-slate-600">{alert.type}</td><td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(alert.startDate)}</td>{view === 'history' ? <td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(alert.endDate)}</td> : null}<td className="px-5 py-4 text-xs font-semibold text-slate-700">{formatDuration(alert.durationSeconds)}</td>{view === 'history' ? <td className="px-5 py-4"><StatusBadge value={alert.state} /></td> : null}<td className="px-5 py-4 text-right"><ChevronRight className="h-4 w-4 text-slate-300" /></td></tr>;
      })}</tbody></TableShell> : <EmptyState title={view === 'active' ? 'No active alerts' : `No cleared alerts in the last ${range}`} description="The connected ThousandEyes account returned no alerts for this view and filter set. No synthetic records are shown." />}<div className="mt-3 flex justify-end"><CursorPagination cursorHistory={history} loading={remote.loading} nextCursor={remote.data.pagination.nextCursor} onNext={() => { setHistory((items) => [...items, cursor]); updateParams(searchParams, setSearchParams, { cursor: remote.data.pagination.nextCursor }); }} onPrevious={() => { const previous = history.at(-1) || null; setHistory((items) => items.slice(0, -1)); updateParams(searchParams, setSearchParams, { cursor: previous }); }} /></div></div> : null}
    </div>
  );
}

function readableAgentType(value) {
  if (!value) return null;
  return String(value).replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function AffectedAgentMap({ agents }) {
  const plotted = agents.filter((agent) => Number.isFinite(agent.latitude) && Number.isFinite(agent.longitude));
  if (!plotted.length) return null;
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-slate-50" id="affected-agents-map">
      <svg aria-label="Affected agents returned by ThousandEyes" className="block h-auto w-full" role="img" viewBox="0 0 720 250">
        <rect fill="#f8fafc" height="250" width="720" />
        {[90, 180, 270, 360, 450, 540, 630].map((x) => <line key={x} stroke="#e2e8f0" strokeDasharray="3 5" x1={x} x2={x} y1="0" y2="250" />)}
        {[62.5, 125, 187.5].map((y) => <line key={y} stroke="#e2e8f0" strokeDasharray="3 5" x1="0" x2="720" y1={y} y2={y} />)}
        <text fill="#64748b" fontSize="10" fontWeight="600" x="18" y="23">Exact affected-agent coordinates</text>
        {plotted.map((agent) => {
          const x = ((agent.longitude + 180) / 360) * 720;
          const y = ((90 - agent.latitude) / 180) * 250;
          return <circle cx={x} cy={y} fill="#0f766e" key={agent.id} r="7"><title>{agent.name} · {agent.location}</title></circle>;
        })}
      </svg>
    </div>
  );
}

function AlertRelationship({ result, searchParams }) {
  const testParams = new URLSearchParams(searchParams);
  testParams.set('alertId', result.alert.id);
  const agentNames = result.agents.map((agent) => agent.name);
  return (
    <section className="mt-6 grid items-stretch gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
      <div className="rounded-xl bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Alert</p><p className="mt-2 text-xs font-bold text-slate-800">{result.alert.name || result.alert.ruleName || 'ThousandEyes alert'}</p><p className="mt-1 truncate text-[10px] text-slate-400">{result.alert.id}</p></div>
      <ChevronRight className="hidden h-4 w-4 self-center text-slate-300 md:block" />
      <div className="rounded-xl bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Test</p>{result.test?.id ? <Link className="mt-2 block text-xs font-bold text-slate-800 hover:text-teal-700" to={`/thousandeyes/tests/${encodeURIComponent(result.test.id)}?${testParams.toString()}`}>{result.test.name}</Link> : <p className="mt-2 text-xs font-bold text-slate-800">{result.alert.testName || 'Unavailable'}</p>}<p className="mt-1 text-[10px] text-slate-400">{result.test?.type || result.alert.type}</p></div>
      <ChevronRight className="hidden h-4 w-4 self-center text-slate-300 md:block" />
      <div className="rounded-xl bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Affected Agents</p><p className="mt-2 text-xs font-bold text-slate-800">{result.agents.length ? `${result.agents.length} directly identified` : result.agentApplicability === 'not_applicable' ? 'Not applicable' : 'Unavailable'}</p>{agentNames.length ? <p className="mt-1 line-clamp-2 text-[10px] text-slate-400" title={agentNames.join(', ')}>{agentNames.slice(0, 2).join(', ')}{agentNames.length > 2 ? ` +${agentNames.length - 2}` : ''}</p> : null}</div>
      <ChevronRight className="hidden h-4 w-4 self-center text-slate-300 md:block" />
      <div className="rounded-xl bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Metric Details</p><p className="mt-2 text-xs font-bold text-slate-800">{result.metricDetails?.length || 0} real scope rows</p><p className="mt-1 text-[10px] text-slate-400">Start and current evidence</p></div>
    </section>
  );
}

function metricDetailLabel(metric) {
  if (metric === null || metric === undefined || metric === '') return 'Not available';
  if (typeof metric === 'string') return metric;
  if (metric.errorType && !['none', 'no error'].includes(String(metric.errorType).toLowerCase())) return `Error: ${metric.errorType}`;
  if (metric.responseCode !== null && metric.responseCode !== undefined) return `HTTP ${metric.responseCode}`;
  if (metric.responseTime !== null && metric.responseTime !== undefined) return `${formatMetric(metric.responseTime, ' ms')} response time`;
  if (metric.availability !== null && metric.availability !== undefined) return `${formatMetric(metric.availability, '%')} availability`;
  if (metric.loss !== null && metric.loss !== undefined) return `${formatMetric(metric.loss, '%')} loss`;
  if (metric.latency !== null && metric.latency !== undefined) return `${formatMetric(metric.latency, ' ms')} latency`;
  if (metric.state) return ['trigger', 'active', 'triggered'].includes(String(metric.state).toLowerCase()) ? 'Active' : String(metric.state);
  return 'Not available';
}

function MetricDetails({ result, searchParams }) {
  const [expanded, setExpanded] = useState(false);
  const rows = result.metricDetails || [];
  if (!rows.length) {
    return (
      <section className="mt-7">
        <h2 className="text-lg font-semibold text-slate-950">Metric Details</h2>
        <div className="mt-4"><EmptyState title={result.agentApplicability === 'not_applicable' ? 'Metrics are not agent-scoped for this alert' : 'Agent metric details unavailable'} description={result.agentApplicability === 'not_applicable' ? 'The alert occurrence did not return an agent-based scope.' : 'ThousandEyes returned no directly associated agent metric rows for this occurrence.'} /></div>
      </section>
    );
  }
  const visibleRows = expanded ? rows : rows.slice(0, 5);
  const agentsById = new Map(result.agents.map((agent) => [agent.id, agent]));
  return (
    <section className="mt-7">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><h2 className="text-lg font-semibold text-slate-950">Metric Details</h2><p className="mt-1 text-xs text-slate-500">One real row for every agent directly identified by this alert occurrence.</p></div>{result.agents.some((agent) => agent.latitude !== null && agent.longitude !== null) ? <a className="text-xs font-bold text-teal-700 hover:text-teal-900" href="#affected-agents-map">View affected agents on map</a> : null}</div>
      <div className="mt-4"><TableShell minWidth="1040px"><TableHead headings={['Scope', 'Start', 'Metric at Start', 'Current Metric', 'Duration', '']} /><tbody className="divide-y divide-slate-100">{visibleRows.map((row) => {
        const agent = agentsById.get(String(row.agentId));
        const next = new URLSearchParams(searchParams);
        next.set('alertId', result.alert.id);
        const agentUrl = `/thousandeyes/agents/${encodeURIComponent(row.agentId)}?${next.toString()}`;
        const startMetric = metricDetailLabel(row.metricAtStart);
        const currentMetric = metricDetailLabel(row.currentMetric);
        return <tr key={row.agentId}><td className="px-5 py-4"><Link className="text-xs font-bold text-slate-900 hover:text-teal-700" to={agentUrl}>{row.scope || row.agentName || `Agent ${row.agentId}`}</Link>{row.agentLocation && row.agentLocation !== row.scope ? <p className="mt-1 text-[10px] text-slate-500">{row.agentLocation}</p> : null}{row.agentHostname ? <p className="mt-1 text-[10px] text-slate-400">{row.agentHostname}</p> : null}<p className="mt-1 text-[10px] text-slate-400">Agent ID {row.agentId}</p></td><td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(row.startedAt)}</td><td className="max-w-[320px] px-5 py-4 text-xs font-semibold leading-5 text-slate-700"><span className="line-clamp-3" title={startMetric}>{startMetric}</span></td><td className="max-w-[220px] px-5 py-4 text-xs font-semibold leading-5 text-slate-700"><span title={currentMetric}>{currentMetric}</span>{row.currentMetric?.timestamp ? <p className="mt-1 text-[10px] font-normal text-slate-400">{formatDateTime(row.currentMetric.timestamp)}</p> : null}</td><td className="px-5 py-4 text-xs font-semibold text-slate-700">{formatDuration(row.durationSeconds)}</td><td className="px-5 py-4 text-right"><Link aria-label={`Open ${agent?.name || row.scope || row.agentId}`} to={agentUrl}><ChevronRight className="h-4 w-4 text-slate-300" /></Link></td></tr>;
      })}</tbody></TableShell></div>
      {!expanded && rows.length > 5 ? <button className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-teal-700" onClick={() => setExpanded(true)} type="button"><ChevronDown className="h-3.5 w-3.5" />+ {rows.length - 5} more agents</button> : null}
      <AffectedAgentMap agents={result.agents} />
    </section>
  );
}

function AlertDetail({ alertId }) {
  const [searchParams] = useSearchParams();
  const range = searchParams.get('range') || '24h';
  const remote = useRemoteData(() => getThousandEyesAlert(alertId, { range }), [alertId, range]);
  const result = remote.data;
  const testParams = new URLSearchParams(searchParams);
  testParams.set('alertId', alertId);
  return (
    <div>
      <WorkspaceHeader title="Alert Detail" description="Inspect one real ThousandEyes alert occurrence, its affected test, directly related agents, and metric evidence." />
      <div className="mt-7"><BackLink to={`/thousandeyes/alerts?${searchParams.toString()}`}>Back to alerts</BackLink></div>
      {remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}
      {remote.loading && !result ? <LoadingBlock label="Loading alert evidence and affected agents…" /> : null}
      {result ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start"><div><div className="flex flex-wrap items-center gap-2"><StatusBadge value={result.alert.state} /><StatusBadge value={result.alert.severity} /><span className="text-[11px] font-semibold text-slate-400">{result.alert.type}</span></div><h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">{result.alert.name || result.rule?.name || result.alert.ruleName || 'ThousandEyes alert'}</h2><p className="mt-3 text-[11px] font-medium text-slate-400">Alert ID: {result.alert.id}</p></div><SourceLink href={result.alert.sourceLink} /></div>
            <dl className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Status</dt><dd className="mt-1"><StatusBadge value={result.alert.state} /></dd></div><div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Started</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDateTime(result.alert.startDate)}</dd></div>{result.alert.endDate ? <div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Ended</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDateTime(result.alert.endDate)}</dd></div> : null}<div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Duration</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDuration(result.alert.durationSeconds)}</dd></div><div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Scope</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.agents.length} affected {result.agents.length === 1 ? 'agent' : 'agents'}</dd></div><div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Alert rule</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.rule?.name || result.alert.ruleName || 'Unavailable'}</dd></div><div className="min-w-0"><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Impacted test</dt><dd className="mt-1 break-all text-xs font-semibold leading-5 text-slate-700">{result.test?.id ? <Link className="hover:text-teal-700" to={`/thousandeyes/tests/${encodeURIComponent(result.test.id)}?${testParams.toString()}`}>{result.test.name}</Link> : result.alert.testName || 'Unavailable'}</dd></div><div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Test type</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.test?.type || result.alert.type}</dd></div><div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Severity</dt><dd className="mt-1"><StatusBadge value={result.alert.severity} /></dd></div>{result.alert.detectionMethod ? <div><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Detection method</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.alert.detectionMethod}</dd></div> : null}</dl>
          </section>
          <AlertRelationship result={result} searchParams={searchParams} />
          <MetricDetails result={result} searchParams={searchParams} />
          <section className="mt-7"><div><h2 className="text-lg font-semibold text-slate-950">Supporting Evidence</h2><p className="mt-1 text-xs text-slate-500">Bounded real test results around the alert start and end time.</p></div>{result.evidence?.status === 'data' ? <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]"><MetricChart data={result.evidence.series} dataKey={chooseMetric(result.evidence).key} label={chooseMetric(result.evidence).label} suffix={chooseMetric(result.evidence).suffix.trim()} /><article className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold text-slate-900">Evidence window</h3><dl className="mt-5 space-y-4"><div><dt className="text-[10px] font-bold uppercase text-slate-400">From</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDateTime(result.evidence.startDate)}</dd></div><div><dt className="text-[10px] font-bold uppercase text-slate-400">To</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{formatDateTime(result.evidence.endDate)}</dd></div><div><dt className="text-[10px] font-bold uppercase text-slate-400">Samples</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.evidence.sampleCount}</dd></div></dl></article></div> : <div className="mt-4"><EmptyState title="No metric evidence returned" description="The alert detail is real, but its related test endpoint returned no usable samples for the bounded evidence window." /></div>}</section>
        </>
      ) : null}
    </div>
  );
}

function AgentDetail({ agentId }) {
  const [searchParams] = useSearchParams();
  const alertId = searchParams.get('alertId') || '';
  const range = searchParams.get('range') || '24h';
  const remote = useRemoteData(() => getThousandEyesAgent(agentId, { alertId, range }), [agentId, alertId, range]);
  const result = remote.data;
  const backParams = new URLSearchParams(searchParams);
  backParams.delete('alertId');
  return (
    <div>
      <WorkspaceHeader title="Agent" description="Inspect the real ThousandEyes agent associated with the selected alert." />
      <div className="mt-7"><BackLink to={alertId ? `/thousandeyes/alerts/${encodeURIComponent(alertId)}?${backParams.toString()}` : '/thousandeyes/alerts'}>Back to alert</BackLink></div>
      {remote.error ? <ErrorPanel message={remote.error} onRetry={remote.load} /> : null}
      {remote.loading && !result ? <LoadingBlock label="Loading affected agent…" /> : null}
      {result ? <><section className="rounded-2xl border border-slate-200 bg-white p-6"><div className="flex flex-wrap items-center gap-2">{result.agent.state ? <StatusBadge value={result.agent.state} /> : null}{result.relationshipVerified ? <span className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-[10px] font-bold text-teal-700">Verified alert relationship</span> : null}</div><h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">{result.agent.name}</h2><p className="mt-2 text-xs font-medium text-slate-400">Agent ID {result.agent.id}</p><dl className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{result.agent.location ? <div><dt className="text-[10px] font-bold uppercase text-slate-400">Location</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.agent.location}</dd></div> : null}{result.agent.type ? <div><dt className="text-[10px] font-bold uppercase text-slate-400">Type</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{readableAgentType(result.agent.type)}</dd></div> : null}{result.agent.state ? <div><dt className="text-[10px] font-bold uppercase text-slate-400">Status</dt><dd className="mt-1 text-xs font-semibold capitalize text-slate-700">{result.agent.state}</dd></div> : null}{result.agent.hostname ? <div><dt className="text-[10px] font-bold uppercase text-slate-400">Hostname</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.agent.hostname}</dd></div> : null}{result.agent.publicIp ? <div><dt className="text-[10px] font-bold uppercase text-slate-400">Public IP</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.agent.publicIp}</dd></div> : null}{result.agent.privateIp ? <div><dt className="text-[10px] font-bold uppercase text-slate-400">Private IP</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{result.agent.privateIp}</dd></div> : null}</dl></section>{Number.isFinite(result.agent.latitude) && Number.isFinite(result.agent.longitude) ? <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-teal-700" /><h3 className="text-sm font-semibold text-slate-900">Agent location</h3></div><AffectedAgentMap agents={[result.agent]} /></section> : null}{result.evidence ? <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{result.evidence.availability != null ? <SummaryCard label="Availability" value={formatMetric(result.evidence.availability, '%')} /> : null}{result.evidence.latency != null ? <SummaryCard label="Latency" value={formatMetric(result.evidence.latency, ' ms')} /> : null}{result.evidence.loss != null ? <SummaryCard label="Packet loss" value={formatMetric(result.evidence.loss, '%')} /> : null}{result.evidence.sampleCount != null ? <SummaryCard label="Evidence samples" value={result.evidence.sampleCount} /> : null}</section> : null}{result.relatedAlerts.length ? <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-2"><Users className="h-4 w-4 text-teal-700" /><h3 className="text-sm font-semibold text-slate-900">Related Alerts</h3></div><div className="mt-4 divide-y divide-slate-100">{result.relatedAlerts.map((alert) => <Link className="flex items-center justify-between gap-4 py-3 text-xs font-semibold text-slate-700 hover:text-teal-700" key={alert.id} to={`/thousandeyes/alerts/${encodeURIComponent(alert.id)}?${backParams.toString()}`}><span>{alert.name || alert.ruleName || alert.type} · {result.affectedTest?.name}</span><StatusBadge value={alert.state} /></Link>)}</div></section> : null}</> : null}
    </div>
  );
}

export default function ThousandEyesWorkspace() {
  const { agentId, alertId, eventId, testId } = useParams();
  const { pathname } = useLocation();
  if (testId) return <TestDetail testId={testId} />;
  if (eventId) return <EventDetail eventId={eventId} />;
  if (alertId) return <AlertDetail alertId={alertId} />;
  if (agentId) return <AgentDetail agentId={agentId} />;
  if (pathname.startsWith('/thousandeyes/event-detection')) return <EventDetection />;
  if (pathname.startsWith('/thousandeyes/alerts')) return <AlertsWorkspace />;
  return <Dashboard />;
}

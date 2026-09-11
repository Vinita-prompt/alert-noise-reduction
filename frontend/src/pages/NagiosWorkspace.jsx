import {
  AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2,
  ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search, Server, ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getNagiosWorkspace,
  getNagiosWorkspaceRecord,
  getNagiosWorkspaceRecords,
} from '../services/api.js';

const ENVIRONMENTS = [{ key: 'd01', label: 'DC01' }, { key: 'd02', label: 'DC02' }];
const HOST_METRICS = [
  { key: 'up', label: 'Up', filter: 'up', tone: 'healthy' },
  { key: 'down', label: 'Down', filter: 'down', tone: 'danger' },
  { key: 'unreachable', label: 'Unreachable', filter: 'unreachable', tone: 'danger' },
  { key: 'pending', label: 'Pending', filter: 'pending', tone: 'neutral' },
  { key: 'unhandled', label: 'Unhandled', filter: 'unhandled', tone: 'warning' },
  { key: 'problems', label: 'Problems', filter: 'problems', tone: 'danger' },
  { key: 'total', label: 'All', filter: 'all', tone: 'neutral' },
];
const SERVICE_METRICS = [
  { key: 'ok', label: 'OK', filter: 'ok', tone: 'healthy' },
  { key: 'warning', label: 'Warning', filter: 'warning', tone: 'warning' },
  { key: 'unknown', label: 'Unknown', filter: 'unknown', tone: 'warning' },
  { key: 'critical', label: 'Critical', filter: 'critical', tone: 'danger' },
  { key: 'pending', label: 'Pending', filter: 'pending', tone: 'neutral' },
  { key: 'unhandled', label: 'Unhandled', filter: 'unhandled', tone: 'warning' },
  { key: 'problems', label: 'Problems', filter: 'problems', tone: 'danger' },
  { key: 'total', label: 'All', filter: 'all', tone: 'neutral' },
];
const INITIAL_STATE = {
  d01: { data: null, error: '', loading: false },
  d02: { data: null, error: '', loading: false },
};
const PAGE_SIZES = [25, 50, 100];

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatSourceTimestamp(value) {
  if (!value) return 'Not returned';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return String(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]} ${match[4]}:${match[5]}`;
}

function formatFetchedTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
}

function formatRecordTimestamp(sourceValue, isoValue) {
  if (sourceValue && !/^\d+$/.test(String(sourceValue))) return String(sourceValue);
  if (!isoValue) return '—';
  const date = new Date(isoValue);
  return Number.isNaN(date.getTime()) ? String(isoValue) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds)));
  if (!Number.isFinite(value)) return '—';
  if (value < 60) return value ? `${value}s` : '0m';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatAttempt(item) {
  if (item.attempt === null || item.attempt === undefined) return '—';
  return item.maxAttempts ? `${item.attempt}/${item.maxAttempts}` : String(item.attempt);
}

function statusTone(status) {
  if (['up', 'ok'].includes(status)) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (['warning', 'unknown'].includes(status)) return 'border-amber-200 bg-amber-50 text-amber-700';
  if (['down', 'unreachable', 'critical'].includes(status)) return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function rowAccent(status) {
  if (['up', 'ok'].includes(status)) return 'border-l-emerald-400';
  if (['warning', 'unknown'].includes(status)) return 'border-l-amber-400';
  if (['down', 'unreachable', 'critical'].includes(status)) return 'border-l-rose-400';
  return 'border-l-slate-300';
}

function StatusPill({ value }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold capitalize ${statusTone(value)}`}>{value}</span>;
}

function LoadingSkeleton() {
  return (
    <div className="mt-6 grid gap-5 xl:grid-cols-2" aria-label="Loading Nagios status">
      {[0, 1].map((item) => (
        <div className="rounded-2xl border border-slate-200 bg-white p-5" key={item}>
          <div className="h-4 w-44 animate-pulse rounded bg-slate-100" />
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: item ? 8 : 7 }).map((_, index) => <div className="h-20 animate-pulse rounded-xl bg-slate-50" key={index} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function EnvironmentTabs({ selected, onSelect, states }) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="Nagios environment">
      {ENVIRONMENTS.map((environment) => {
        const state = states[environment.key];
        return (
          <button
            className={`inline-flex min-w-24 items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition ${selected === environment.key ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'}`}
            key={environment.key}
            onClick={() => onSelect(environment.key)}
            type="button"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${state.error ? 'bg-rose-400' : state.data ? 'bg-emerald-400' : 'bg-slate-300'}`} />
            {environment.label}
          </button>
        );
      })}
    </div>
  );
}

function SummaryMetric({ metric, summary, type, onOpen }) {
  const value = Number(summary?.[metric.key] || 0);
  const problem = value > 0 && ['danger', 'warning'].includes(metric.tone);
  const tone = problem
    ? metric.tone === 'danger' ? 'border-rose-200 bg-rose-50/70 text-rose-800' : 'border-amber-200 bg-amber-50/70 text-amber-800'
    : metric.tone === 'healthy' ? 'border-emerald-100 bg-emerald-50/40 text-slate-800' : 'border-slate-100 bg-slate-50/70 text-slate-700';
  return (
    <button
      aria-label={`View ${formatCount(value)} ${metric.label} ${type === 'host' ? 'hosts' : 'services'}`}
      className={`flex min-h-20 flex-col items-start rounded-xl border p-3 text-left transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${tone}`}
      onClick={() => onOpen({ filter: metric.filter, label: metric.label, type })}
      type="button"
    >
      <span className="text-[10px] font-bold uppercase tracking-[0.1em] opacity-65">{metric.label}</span>
      <span className="mt-2 text-2xl font-semibold tracking-tight">{formatCount(value)}</span>
      <span className="mt-1 text-[10px] font-semibold opacity-70">View records</span>
    </button>
  );
}

function SummarySection({ metrics, onOpen, summary, title, type }) {
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Live status</p><h2 className="mt-1 text-base font-semibold text-slate-950">{title}</h2></div>
        <Server className="h-4 w-4 text-slate-300" aria-hidden="true" />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {metrics.map((metric) => <SummaryMetric key={metric.key} metric={metric} onOpen={onOpen} summary={summary} type={type} />)}
      </div>
    </article>
  );
}

function ConnectionError({ environment, message, onRetry }) {
  return (
    <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-5">
      <p className="text-sm font-semibold text-rose-800">{environment} connection unavailable</p>
      <p className="mt-1 text-xs leading-5 text-rose-700">{message}</p>
      <button className="mt-4 rounded-xl bg-rose-700 px-3.5 py-2 text-xs font-semibold text-white" onClick={onRetry} type="button">Try again</button>
    </div>
  );
}

function Breadcrumb({ environment, selection, onBack }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
      <button className="font-semibold text-teal-700 hover:text-teal-900" onClick={onBack} type="button">Nagios</button>
      <span aria-hidden="true">/</span><span>{environment}</span><span aria-hidden="true">/</span>
      <span>{selection.type === 'host' ? 'Host Status' : 'Service Status'}</span><span aria-hidden="true">/</span>
      <span className="font-semibold text-slate-700">{selection.label}</span>
    </nav>
  );
}

function DetailField({ label, children, wide = false }) {
  if (children === null || children === undefined || children === '' || children === '—') return null;
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.11em] text-slate-400">{label}</dt>
      <dd className="mt-1.5 break-words text-sm leading-6 text-slate-700">{children}</dd>
    </div>
  );
}

function RecordDetail({ environment, instance, recordId, selection, onBack }) {
  const [state, setState] = useState({ data: null, error: '', loading: true });

  useEffect(() => {
    let active = true;
    setState({ data: null, error: '', loading: true });
    getNagiosWorkspaceRecord(instance, selection.type, recordId)
      .then((data) => { if (active) setState({ data, error: '', loading: false }); })
      .catch((error) => { if (active) setState({ data: null, error: error.message, loading: false }); });
    return () => { active = false; };
  }, [instance, recordId, selection.type]);

  if (state.loading) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6" aria-label="Loading Nagios record">
        <div className="h-4 w-48 animate-pulse rounded bg-slate-100" /><div className="mt-5 h-28 animate-pulse rounded-xl bg-slate-50" />
      </section>
    );
  }
  if (state.error || !state.data) {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <p className="text-sm font-semibold text-rose-800">Nagios record unavailable</p><p className="mt-1 text-xs text-rose-700">{state.error}</p>
        <button className="mt-4 text-xs font-semibold text-rose-800" onClick={onBack} type="button">← Back to results</button>
      </section>
    );
  }

  const item = state.data.item;
  const title = selection.type === 'service' ? item.serviceDescription : item.hostName;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="border-b border-slate-100 p-5 sm:p-6">
        <Breadcrumb environment={environment} selection={selection} onBack={onBack} />
        <button className="mt-5 inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-900" onClick={onBack} type="button"><ChevronLeft className="h-3.5 w-3.5" /> Back to results</button>
        <div className="mt-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><StatusPill value={item.status} /><span className="text-xs font-medium text-slate-400">{environment} · {selection.type === 'host' ? 'Host' : 'Service'}</span></div>
            <h2 className="mt-3 break-words text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
            {selection.type === 'service' ? <p className="mt-1 text-sm text-slate-500">Host: {item.hostName}</p> : null}
          </div>
          {item.sourceUrl ? (
            <a className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white hover:bg-slate-800" href={item.sourceUrl} rel="noreferrer" target="_blank">Open in Nagios <ExternalLink className="h-3.5 w-3.5" /></a>
          ) : null}
        </div>
      </div>
      <dl className="grid gap-8 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
        <DetailField label="Host">{item.hostName}</DetailField>
        {selection.type === 'service' ? <DetailField label="Service">{item.serviceDescription}</DetailField> : null}
        <DetailField label="Current status"><StatusPill value={item.status} /></DetailField>
        <DetailField label="Duration">{formatDuration(item.durationSeconds)}</DetailField>
        <DetailField label="Attempt">{formatAttempt(item)}</DetailField>
        <DetailField label="Last check">{formatRecordTimestamp(item.lastCheckSource, item.lastCheck)}</DetailField>
        <DetailField label="Last state change">{formatRecordTimestamp(item.lastStateChangeSource, item.lastStateChange)}</DetailField>
        <DetailField label="Acknowledgement">{item.acknowledged ? 'Acknowledged' : 'Not acknowledged'}</DetailField>
        <DetailField label="Scheduled downtime">{item.scheduledDowntime ? 'In scheduled downtime' : 'No scheduled downtime'}</DetailField>
        <DetailField label="Status information" wide>{item.statusInformation}</DetailField>
      </dl>
      <div className="grid gap-4 border-t border-slate-100 bg-slate-50/60 px-5 py-4 text-xs text-slate-500 sm:grid-cols-2 sm:px-6">
        <p><span className="font-semibold text-slate-700">Nagios status updated:</span> {formatSourceTimestamp(state.data.sourceUpdatedAt)}</p>
        <p><span className="font-semibold text-slate-700">Fetched by this app:</span> {formatFetchedTimestamp(state.data.fetchedAt)}</p>
      </div>
    </section>
  );
}

function SortButton({ active, direction, label, onClick }) {
  const Icon = active ? (direction === 'desc' ? ArrowDown : ArrowUp) : ArrowUpDown;
  return <button className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-slate-700 ${active ? 'text-teal-700' : ''}`} onClick={onClick} type="button">{label} <Icon className="h-3 w-3" /></button>;
}

function DrilldownView({ environment, instance, refreshKey, searchParams, selection, setSearchParams }) {
  const requestedPage = Math.max(1, Number.parseInt(searchParams.get('page'), 10) || 1);
  const requestedPageSize = PAGE_SIZES.includes(Number(searchParams.get('pageSize'))) ? Number(searchParams.get('pageSize')) : 25;
  const requestedSearch = searchParams.get('search') || '';
  const requestedSort = searchParams.get('sort') || (selection.type === 'service' ? 'service' : 'host');
  const requestedDirection = searchParams.get('direction') === 'desc' ? 'desc' : 'asc';
  const recordId = searchParams.get('record');
  const [searchDraft, setSearchDraft] = useState(requestedSearch);
  const [state, setState] = useState({ data: null, error: '', loading: true });

  const updateQuery = useCallback((updates) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    });
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  useEffect(() => { setSearchDraft(requestedSearch); }, [requestedSearch]);
  useEffect(() => {
    if (recordId) return undefined;
    let active = true;
    setState({ data: null, error: '', loading: true });
    getNagiosWorkspaceRecords(instance, selection.type, {
      status: selection.filter,
      search: requestedSearch,
      sort: requestedSort,
      direction: requestedDirection,
      page: requestedPage,
      pageSize: requestedPageSize,
    })
      .then((data) => { if (active) setState({ data, error: '', loading: false }); })
      .catch((error) => { if (active) setState({ data: null, error: error.message, loading: false }); });
    return () => { active = false; };
  }, [instance, recordId, refreshKey, requestedDirection, requestedPage, requestedPageSize, requestedSearch, requestedSort, selection.filter, selection.type]);

  const backToOverview = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    ['view', 'status', 'search', 'sort', 'direction', 'page', 'pageSize', 'record'].forEach((key) => next.delete(key));
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  if (recordId) {
    return <RecordDetail environment={environment} instance={instance} onBack={() => updateQuery({ record: null })} recordId={recordId} selection={selection} />;
  }

  const data = state.data;
  const pagination = data?.pagination;
  const plural = selection.type === 'host' ? 'hosts' : 'services';
  const title = `${selection.label} ${selection.type === 'host' ? 'Hosts' : 'Services'}`;
  const columns = [
    { key: 'host', label: 'Host', sortable: true, render: (item) => item.hostName },
    ...(selection.type === 'service' ? [{ key: 'service', label: 'Service', sortable: true, render: (item) => item.serviceDescription }] : []),
    { key: 'status', label: 'Status', sortable: true, render: (item) => <StatusPill value={item.status} /> },
    { key: 'information', label: 'Status Information', render: (item) => item.statusInformation || '—' },
    { key: 'duration', label: 'Duration', sortable: true, render: (item) => formatDuration(item.durationSeconds) },
    { key: 'lastCheck', label: 'Last Check', sortable: true, render: (item) => formatRecordTimestamp(item.lastCheckSource, item.lastCheck) },
    { key: 'lastStateChange', label: 'Last State Change', sortable: true, render: (item) => formatRecordTimestamp(item.lastStateChangeSource, item.lastStateChange) },
    { key: 'attempt', label: 'Attempt', render: formatAttempt },
    { key: 'acknowledged', label: 'Acknowledgement', render: (item) => (item.acknowledged ? 'Acknowledged' : 'Not acknowledged') },
    { key: 'downtime', label: 'Downtime', render: (item) => (item.scheduledDowntime ? 'Scheduled' : 'No') },
  ];

  function changeSort(sort) {
    const direction = requestedSort === sort && requestedDirection === 'asc' ? 'desc' : 'asc';
    updateQuery({ sort, direction, page: 1, record: null });
  }

  function openRecord(id) {
    updateQuery({ record: id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="border-b border-slate-100 p-5 sm:p-6">
        <Breadcrumb environment={environment} onBack={backToOverview} selection={selection} />
        <button className="mt-5 inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-900" onClick={backToOverview} type="button"><ChevronLeft className="h-3.5 w-3.5" /> Back to Nagios summary</button>
        <div className="mt-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div><h2 className="text-xl font-semibold tracking-tight text-slate-950">{title}{pagination ? ` — ${formatCount(pagination.total)} ${pagination.total === 1 ? 'result' : 'results'}` : ''}</h2><p className="mt-1 text-xs text-slate-500">Read-only normalized records from {environment}.</p></div>
          {data ? (
            <div className="text-left text-[10px] leading-5 text-slate-400 sm:text-right">
              <p><span className="font-semibold text-slate-600">Nagios status updated:</span> {formatSourceTimestamp(data.sourceUpdatedAt)}</p>
              <p><span className="font-semibold text-slate-600">Fetched by this app:</span> {formatFetchedTimestamp(data.fetchedAt)}</p>
            </div>
          ) : null}
        </div>
        <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(event) => { event.preventDefault(); updateQuery({ search: searchDraft.trim() || null, page: 1, record: null }); }}
          >
            <label className="relative min-w-0 flex-1 lg:max-w-md">
              <span className="sr-only">Search {plural}</span><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-100" onChange={(event) => setSearchDraft(event.target.value)} placeholder={`Search ${plural}, status information…`} type="search" value={searchDraft} />
            </label>
            <button className="h-10 rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white hover:bg-slate-800" type="submit">Search</button>
          </form>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            Rows
            <select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-teal-500" onChange={(event) => updateQuery({ pageSize: event.target.value, page: 1, record: null })} value={requestedPageSize}>
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </div>
      </div>

      {state.loading ? (
        <div className="p-6" aria-label="Loading Nagios records"><div className="h-12 animate-pulse rounded-xl bg-slate-50" /><div className="mt-2 h-12 animate-pulse rounded-xl bg-slate-50" /><div className="mt-2 h-12 animate-pulse rounded-xl bg-slate-50" /></div>
      ) : null}
      {state.error ? (
        <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4"><p className="text-sm font-semibold text-rose-800">Records unavailable</p><p className="mt-1 text-xs text-rose-700">{state.error}</p></div>
      ) : null}
      {!state.loading && !state.error && data && !data.items.length ? (
        <div className="px-6 py-16 text-center">
          <Server className="mx-auto h-7 w-7 text-slate-300" /><h3 className="mt-4 text-sm font-semibold text-slate-800">No matching records</h3>
          <p className="mt-1 text-xs text-slate-500">{requestedSearch ? `No ${environment} ${plural} match “${requestedSearch}”.` : `No ${environment} ${plural} are currently ${selection.label}.`}</p>
        </div>
      ) : null}
      {!state.loading && !state.error && data?.items.length ? (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left">
            <thead className="bg-slate-50/80"><tr>{columns.map((column) => (
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400" key={column.key}>
                {column.sortable ? <SortButton active={requestedSort === column.key} direction={requestedDirection} label={column.label} onClick={() => changeSort(column.key)} /> : column.label}
              </th>
            ))}</tr></thead>
            <tbody className="divide-y divide-slate-100">{data.items.map((item) => (
              <tr
                className="cursor-pointer align-top transition hover:bg-teal-50/40 focus:bg-teal-50/50 focus:outline-none"
                key={item.id}
                onClick={() => openRecord(item.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRecord(item.id); } }}
                role="link"
                tabIndex={0}
              >
                {columns.map((column, index) => (
                  <td className={`px-4 py-3 text-xs text-slate-600 ${index === 0 ? `border-l-2 ${rowAccent(item.status)} font-semibold text-slate-800` : ''} ${column.key === 'information' ? 'min-w-72 max-w-xl whitespace-normal break-words leading-5' : 'whitespace-nowrap'}`} key={column.key}>{column.render(item)}</td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {pagination ? (
        <div className="flex flex-col gap-3 border-t border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">{pagination.total ? `Showing ${formatCount(pagination.from)}–${formatCount(pagination.to)} of ${formatCount(pagination.total)}` : '0 records'}</p>
          <div className="flex items-center gap-2">
            <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40" disabled={pagination.page <= 1} onClick={() => updateQuery({ page: pagination.page - 1, record: null })} type="button"><ChevronLeft className="h-3.5 w-3.5" /> Previous</button>
            <span className="px-2 text-xs font-semibold text-slate-600">Page {pagination.page} of {pagination.totalPages}</span>
            <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40" disabled={pagination.page >= pagination.totalPages} onClick={() => updateQuery({ page: pagination.page + 1, record: null })} type="button">Next <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function NagiosWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('environment') === 'dc02' ? 'd02' : 'd01';
  const selectedLabel = selected === 'd02' ? 'DC02' : 'DC01';
  const view = searchParams.get('view');
  const status = searchParams.get('status');
  const type = view === 'hosts' ? 'host' : view === 'services' ? 'service' : null;
  const metric = type === 'host'
    ? HOST_METRICS.find((item) => item.filter === status)
    : type === 'service' ? SERVICE_METRICS.find((item) => item.filter === status) : null;
  const selection = type && metric ? { type, filter: status, label: metric.label } : null;
  const [states, setStates] = useState(INITIAL_STATE);
  const inFlight = useRef({ d01: false, d02: false });
  const current = states[selected];
  const data = current.data;

  const loadEnvironment = useCallback(async (instance, options = {}) => {
    if (inFlight.current[instance]) return;
    inFlight.current[instance] = true;
    setStates((previous) => ({ ...previous, [instance]: { ...previous[instance], error: '', loading: true } }));
    try {
      const result = await getNagiosWorkspace(instance, { refresh: Boolean(options.refresh) });
      setStates((previous) => ({ ...previous, [instance]: { data: result, error: '', loading: false } }));
    } catch (requestError) {
      setStates((previous) => ({
        ...previous,
        [instance]: { ...previous[instance], error: requestError.message || `${instance.toUpperCase()} connection unavailable.`, loading: false },
      }));
    } finally {
      inFlight.current[instance] = false;
    }
  }, []);

  useEffect(() => {
    if (!states[selected].data && !states[selected].loading) loadEnvironment(selected);
  }, [loadEnvironment, selected, states]);
  useEffect(() => {
    const interval = window.setInterval(() => loadEnvironment(selected, { refresh: true }), 60_000);
    return () => window.clearInterval(interval);
  }, [loadEnvironment, selected]);

  function selectEnvironment(instance) {
    const next = new URLSearchParams(searchParams);
    next.set('environment', instance === 'd02' ? 'dc02' : 'dc01');
    next.delete('record');
    next.delete('page');
    setSearchParams(next);
  }

  function openDrilldown(nextSelection) {
    const next = new URLSearchParams();
    next.set('environment', selected === 'd02' ? 'dc02' : 'dc01');
    next.set('view', nextSelection.type === 'host' ? 'hosts' : 'services');
    next.set('status', nextSelection.filter);
    setSearchParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const hasProblems = data && (Number(data.hostSummary?.problems || 0) > 0 || Number(data.serviceSummary?.problems || 0) > 0);
  const stale = Boolean(current.error && data);

  return (
    <div className="min-w-0">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Live Nagios data</span>
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500"><ShieldCheck className="h-3 w-3" />Read-only validation</span>
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">Nagios</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Review live host and service health independently across the DC01 and DC02 Nagios XI environments.</p>
        </div>
        <EnvironmentTabs onSelect={selectEnvironment} selected={selected} states={states} />
      </div>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="grid gap-4 sm:grid-cols-3 sm:gap-8">
            <div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Selected environment</p><p className="mt-2 text-sm font-bold text-slate-950">{selectedLabel}</p></div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Connection</p>
              <p className={`mt-2 flex items-center gap-2 text-sm font-bold ${stale || (current.error && !data) ? 'text-rose-700' : data ? 'text-emerald-700' : 'text-slate-400'}`}>
                <span className={`h-2 w-2 rounded-full ${stale || (current.error && !data) ? 'bg-rose-500' : data ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                {stale || (current.error && !data) ? 'Connection unavailable' : data ? 'Connected' : 'Connecting'}
              </p>
            </div>
            <div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Last updated</p><p className="mt-2 text-sm font-bold text-slate-950">{data ? formatSourceTimestamp(data.sourceUpdatedAt) : 'Loading…'}</p>{data ? <p className="mt-1 text-[10px] text-slate-400">Nagios source time · timezone not supplied</p> : null}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {current.loading && data ? <span className="text-xs font-semibold text-teal-700">Updating…</span> : null}
            {data?.instance?.nagiosUrl ? <a className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white transition hover:bg-slate-800" href={data.instance.nagiosUrl} rel="noreferrer" target="_blank">Open in Nagios <ExternalLink className="h-3.5 w-3.5" /></a> : null}
            <button className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-950 disabled:opacity-50" disabled={current.loading} onClick={() => loadEnvironment(selected, { refresh: true })} type="button"><RefreshCw className={`h-3.5 w-3.5 ${current.loading ? 'animate-spin' : ''}`} />Refresh</button>
          </div>
        </div>
      </section>

      {current.error ? <ConnectionError environment={selectedLabel} message={stale ? `${current.error} The visible counts are the last successful snapshot and are marked stale.` : current.error} onRetry={() => loadEnvironment(selected, { refresh: true })} /> : null}
      {current.loading && !data ? <LoadingSkeleton /> : null}

      {data && selection ? (
        <div className="mt-6"><DrilldownView environment={selectedLabel} instance={selected} refreshKey={data.fetchedAt} searchParams={searchParams} selection={selection} setSearchParams={setSearchParams} /></div>
      ) : null}

      {data && !selection ? (
        <>
          <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-2">
            <SummarySection metrics={HOST_METRICS} onOpen={openDrilldown} summary={data.hostSummary} title="Host Status Summary" type="host" />
            <SummarySection metrics={SERVICE_METRICS} onOpen={openDrilldown} summary={data.serviceSummary} title="Service Status Summary" type="service" />
          </div>
          <div className={`mt-5 flex items-start gap-3 rounded-2xl border p-4 ${hasProblems ? 'border-amber-200 bg-amber-50/70' : 'border-emerald-200 bg-emerald-50/70'}`}>
            {hasProblems ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />}
            <div>
              <p className={`text-sm font-semibold ${hasProblems ? 'text-amber-900' : 'text-emerald-900'}`}>{hasProblems ? `${formatCount(data.hostSummary.problems + data.serviceSummary.problems)} current problem records` : 'No current host/service problems.'}</p>
              <p className={`mt-1 text-xs leading-5 ${hasProblems ? 'text-amber-700' : 'text-emerald-700'}`}>{hasProblems ? 'Select any summary count above to inspect its current records.' : `${selectedLabel} currently reports healthy host and service states. Every count remains available for inspection.`}</p>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-2 text-[10px] text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <span>{formatCount(data.hostSummary.total)} hosts · {formatCount(data.serviceSummary.total)} services · {data.pagination.hosts + data.pagination.services} API pages</span>
            <span>Automatic refresh every 60 seconds · {data.cache.cached ? 'Short cache used' : 'Fresh API retrieval'}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

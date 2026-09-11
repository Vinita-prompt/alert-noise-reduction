import { ChevronLeft, ChevronRight, Filter, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DatasetCard,
  formatCount,
  formatJiraDate,
  PersonLabel,
  PriorityBadge,
  ReadOnlyJiraBadge,
  StatusBadge,
} from '../components/jira/AccJiraUi.jsx';
import { PageHeader, TableHead, TableShell } from '../components/operational/DemoUi.jsx';
import useLiveDataRefresh from '../hooks/useLiveDataRefresh.js';
import { getIncidentSummary, getIncidents } from '../services/api.js';

const EMPTY_FILTERS = {
  assignee: '', createdFrom: '', createdTo: '', priority: '', resolution: '',
  resolvedFrom: '', resolvedTo: '', search: '', status: '', updatedFrom: '', updatedTo: '',
};

function FilterInput({ label, name, onChange, type = 'text', value, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.11em] text-slate-400">{label}</span>
      <input
        className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        name={name}
        onChange={onChange}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

export default function AccIncidents() {
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError('');
    setResult(null);
    setSummary(null);
    try {
      const [nextSummary, response] = await Promise.all([
        getIncidentSummary({ range: '30d' }),
        getIncidents({ ...filters, page, pageSize }),
      ]);
      if (requestSequence.current === sequence) {
        setSummary(nextSummary);
        setResult(response);
      }
    } catch {
      if (requestSequence.current === sequence) {
        setSummary(null);
        setResult(null);
        setError('Jira data unavailable');
      }
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);
  const liveConnection = useLiveDataRefresh(load);

  function updateDraft(event) {
    setDraftFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  function applyFilters(event) {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draftFilters });
  }

  function clearFilters() {
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  const totalCount = result?.totalCount ?? 0;
  const currentPage = result?.currentPage ?? page;
  const resolvedPageSize = result?.pageSize ?? pageSize;
  const firstItem = totalCount ? ((currentPage - 1) * resolvedPageSize) + 1 : 0;
  const lastItem = totalCount ? Math.min(totalCount, firstItem + resolvedPageSize - 1) : 0;
  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div>
      <PageHeader
        eyebrow="ACC Jira operations"
        title="Incidents"
        description="A compact, read-only work queue backed by real ACC Jira incidents. Search and filtering are executed by Jira; only the current page is loaded in the browser."
        actions={<ReadOnlyJiraBadge />}
      />

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Live Jira Incident totals">
        <DatasetCard active label="Jira Incidents Created Today" value={summary ? summary.incidentsCreatedToday : '—'} />
        <DatasetCard label="Jira Incidents Created This Week" value={summary ? summary.incidentsCreatedThisWeek : '—'} />
        <DatasetCard label="Jira Incidents Created This Month" value={summary ? summary.incidentsCreatedThisMonth : '—'} />
        <DatasetCard label="Jira Incidents Created To Date" value={summary ? summary.incidentsCreatedToDate : '—'} />
      </section>

      {summary?.reconciliation?.status === 'MISMATCH' ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
          Jira is authoritative at {formatCount(summary.incidentsCreatedToDate)} Incident tickets; synchronized PostgreSQL currently has {formatCount(summary.reconciliation.postgresTotal)}. Last database sync: {formatJiraDate(summary.reconciliation.lastSuccessfulSyncAt)}.
        </div>
      ) : null}

      <form className="mt-7 rounded-2xl border border-slate-200 bg-white p-5" onSubmit={applyFilters}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1.6fr)_repeat(4,minmax(120px,0.7fr))_auto] xl:items-end">
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.11em] text-slate-400">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-xs font-medium text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                name="search"
                onChange={updateDraft}
                placeholder="Issue key, summary, or exact assignee"
                value={draftFilters.search}
              />
            </span>
          </label>
          <FilterInput label="Status" name="status" onChange={updateDraft} placeholder="Exact status" value={draftFilters.status} />
          <FilterInput label="Priority" name="priority" onChange={updateDraft} placeholder="Exact priority" value={draftFilters.priority} />
          <FilterInput label="Assignee" name="assignee" onChange={updateDraft} placeholder="Name or email" value={draftFilters.assignee} />
          <FilterInput label="Resolution" name="resolution" onChange={updateDraft} placeholder="Exact resolution" value={draftFilters.resolution} />
          <button className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white transition hover:bg-slate-800" type="submit">
            <Filter className="h-3.5 w-3.5" aria-hidden="true" /> Apply
          </button>
        </div>

        <details className="mt-4 border-t border-slate-100 pt-4">
          <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">Date filters</summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <FilterInput label="Created from" name="createdFrom" onChange={updateDraft} type="date" value={draftFilters.createdFrom} />
            <FilterInput label="Created to" name="createdTo" onChange={updateDraft} type="date" value={draftFilters.createdTo} />
            <FilterInput label="Updated from" name="updatedFrom" onChange={updateDraft} type="date" value={draftFilters.updatedFrom} />
            <FilterInput label="Updated to" name="updatedTo" onChange={updateDraft} type="date" value={draftFilters.updatedTo} />
            <FilterInput label="Resolved from" name="resolvedFrom" onChange={updateDraft} type="date" value={draftFilters.resolvedFrom} />
            <FilterInput label="Resolved to" name="resolvedTo" onChange={updateDraft} type="date" value={draftFilters.resolvedTo} />
          </div>
        </details>

        {hasActiveFilters ? (
          <button className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900" onClick={clearFilters} type="button">
            <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear applied filters
          </button>
        ) : null}
      </form>

      <div className="mt-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">ACC Incidents</h2>
          <p className="mt-1 text-xs text-slate-500">
            {loading && !result ? 'Loading live Jira total…' : `${formatCount(totalCount)} total · showing ${formatCount(firstItem)}–${formatCount(lastItem)}`}
          </p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Jira {summary?.sourceStatus || 'Unavailable'} · Updated {formatJiraDate(summary?.updatedAt)} · {liveConnection === 'LIVE' ? 'Event stream live' : '30-second polling'}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            Rows
            <select
              className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-teal-500"
              onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
              value={pageSize}
            >
              <option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
            </select>
          </label>
          <button className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:text-slate-950 disabled:opacity-50" disabled={loading} onClick={load} type="button" aria-label="Refresh incidents">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</div>
      ) : null}

      <div className={`mt-4 transition-opacity ${loading ? 'opacity-60' : 'opacity-100'}`} aria-busy={loading}>
        <TableShell minWidth="1500px">
          <TableHead headings={['Issue key', 'Summary', 'Status', 'Priority', 'Assignee', 'Created', 'Updated', 'Resolved', 'Resolved by', 'Resolution']} />
          <tbody className="divide-y divide-slate-100">
            {(result?.items || []).map((incident) => (
              <tr className="align-top transition hover:bg-slate-50/80" key={incident.key}>
                <td className="whitespace-nowrap px-5 py-4">
                  <Link className="text-xs font-bold text-teal-700 hover:text-teal-900 hover:underline" to={`/incidents/${incident.key}`}>{incident.key}</Link>
                </td>
                <td className="max-w-[360px] px-5 py-4 text-xs font-semibold leading-5 text-slate-800">{incident.summary}</td>
                <td className="whitespace-nowrap px-5 py-4"><StatusBadge value={incident.status} /></td>
                <td className="whitespace-nowrap px-5 py-4"><PriorityBadge value={incident.priority} /></td>
                <td className="max-w-[190px] px-5 py-4 text-xs"><PersonLabel compact person={incident.assignee} /></td>
                <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{formatJiraDate(incident.createdAt)}</td>
                <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{formatJiraDate(incident.updatedAt)}</td>
                <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{formatJiraDate(incident.resolvedAt)}</td>
                <td className="max-w-[180px] px-5 py-4 text-xs">{incident.resolvedBy ? <PersonLabel compact person={incident.resolvedBy} /> : <span className="text-slate-400">—</span>}</td>
                <td className="max-w-[180px] px-5 py-4 text-xs font-medium text-slate-600">{incident.resolution || '—'}</td>
              </tr>
            ))}
            {!loading && result?.items?.length === 0 ? (
              <tr><td className="px-5 py-12 text-center text-sm text-slate-500" colSpan={10}>No ACC incidents match these server-side filters.</td></tr>
            ) : null}
          </tbody>
        </TableShell>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="text-xs font-semibold text-slate-500">Page {currentPage} of {result?.totalPages || 1}</p>
        <div className="flex items-center gap-2">
          <button className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40" disabled={loading || !result?.hasPrevious} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button"><ChevronLeft className="h-4 w-4" /> Previous</button>
          <button className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40" disabled={loading || !result?.hasNext} onClick={() => setPage((value) => value + 1)} type="button">Next <ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}

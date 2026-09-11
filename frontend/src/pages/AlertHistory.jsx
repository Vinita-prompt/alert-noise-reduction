import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, Database, ExternalLink,
  RefreshCw, Search, ShieldCheck, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import useLiveDataRefresh from '../hooks/useLiveDataRefresh.js';
import { getAlertOccurrence, getAlertOccurrences } from '../services/api.js';

const PAGE_SIZE = 25;

function formatDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
}

function readable(value, fallback = 'Not available') {
  if (value === 'PENDING_EVIDENCE') return 'Insufficient Evidence';
  if (value === 'NEEDS_REVIEW') return 'Insufficient Evidence';
  return value ? String(value).replaceAll('_', ' ') : fallback;
}

function Badge({ value, kind = 'slate' }) {
  const tones = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] ${tones[kind]}`}>{readable(value)}</span>;
}

function evidenceTone(value) {
  if (value === 'COMPLETE') return 'green';
  if (value === 'PENDING_EVIDENCE') return 'amber';
  if (value === 'PARTIAL') return 'blue';
  return 'slate';
}

function Select({ value, onChange, children, label }) {
  return <label className="space-y-1"><span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</span><select className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-teal-500" value={value} onChange={onChange}>{children}</select></label>;
}

function Detail({ occurrence, onClose }) {
  if (!occurrence) return null;
  return <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Alert ${occurrence.alertNumber}`}>
    <button className="absolute inset-0 bg-slate-950/30" onClick={onClose} type="button" aria-label="Close alert detail" />
    <aside className="relative h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-2xl sm:p-8">
      <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Individual Slack alert occurrence</p><h2 className="mt-2 text-xl font-semibold text-slate-950">#{occurrence.alertNumber} · {occurrence.title}</h2><p className="mt-2 text-xs text-slate-500">{formatDate(occurrence.timestamp)}</p></div><button className="rounded-xl bg-slate-100 p-2 text-slate-600" onClick={onClose} type="button"><X className="h-4 w-4" /></button></div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">{[
        ['Source', occurrence.sourceSystem], ['Priority', occurrence.priority], ['Responder', occurrence.responder],
        ['Environment', occurrence.environment], ['Current status', occurrence.status], ['Current decision', readable(occurrence.currentDecision)],
        ['Evidence status', readable(occurrence.evidenceStatus)], ['Evidence completion', `${occurrence.evidenceCompletionPercentage}%`],
        ['Source availability', readable(occurrence.sourceAvailability)], ['Evidence workflow', occurrence.evidenceWorkflow],
        ['Last refreshed', formatDate(occurrence.evidenceLastRefreshedAt)], ['Delivery', readable(occurrence.deliveryMode)],
      ].map(([label, value]) => <div className="rounded-xl border border-slate-200 bg-slate-50 p-3" key={label}><p className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</p><p className="mt-1 break-words text-xs font-semibold text-slate-800">{value || 'Not available'}</p></div>)}</div>
      <section className="mt-6 rounded-2xl border border-slate-200 p-5"><h3 className="text-sm font-semibold text-slate-950">Automatically collected evidence</h3><div className="mt-3 space-y-2">{occurrence.automaticallyCollectedEvidence?.length ? occurrence.automaticallyCollectedEvidence.map((item) => <div className="rounded-xl bg-slate-50 p-3" key={item.field}><div className="flex items-start justify-between gap-3"><p className="text-xs font-semibold text-slate-800">{item.field}</p><span className="text-[9px] font-semibold text-slate-400">{item.provenance}</span></div><p className="mt-1 break-words text-xs text-slate-600">{item.value}</p><p className="mt-1 text-[9px] text-slate-400">Source time: {formatDate(item.sourceTimestamp)}</p></div>) : <p className="text-xs text-slate-500">Not available</p>}</div></section>
      <div className="mt-6 flex flex-wrap gap-2">
        {occurrence.canonicalAlertId ? <Link className="rounded-xl bg-teal-700 px-4 py-2.5 text-xs font-bold text-white" to={`/incident-report/${encodeURIComponent(occurrence.canonicalAlertId)}`}>{occurrence.evidenceReportId ? 'View / Update Evidence' : 'Collect Evidence'}</Link> : <span className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-800">Canonical evidence context not yet available</span>}
        {occurrence.monitoringLink ? <a className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-700" href={occurrence.monitoringLink} target="_blank" rel="noreferrer">Monitoring link <ExternalLink className="h-3 w-3" /></a> : null}
        {occurrence.jiraLink ? <a className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-700" href={occurrence.jiraLink} target="_blank" rel="noreferrer">Jira link <ExternalLink className="h-3 w-3" /></a> : null}
      </div>
    </aside>
  </div>;
}

export default function AlertHistory() {
  const { occurrenceId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const filters = useMemo(() => ({
    page: Number(searchParams.get('page') || 1), pageSize: PAGE_SIZE,
    range: searchParams.get('range') || 'all', search: searchParams.get('search') || '',
    source: searchParams.get('source') || 'all', priority: searchParams.get('priority') || 'all',
    responder: searchParams.get('responder') || 'all', status: searchParams.get('status') || 'all',
    evidenceStatus: searchParams.get('evidenceStatus') || 'all',
  }), [searchParams]);
  const [draftSearch, setDraftSearch] = useState(filters.search);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await getAlertOccurrences(filters)); } catch (requestError) { setData(null); setError('Live data unavailable'); }
    finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = setInterval(load, 30_000); return () => clearInterval(timer); }, [load]);
  useLiveDataRefresh(load);
  useEffect(() => {
    if (!occurrenceId) { setSelected(null); return; }
    getAlertOccurrence(occurrenceId).then(setSelected).catch((requestError) => setError(requestError.message));
  }, [occurrenceId]);
  function change(name, value) {
    const next = new URLSearchParams(searchParams); next.set(name, String(value));
    if (name !== 'page') next.set('page', '1'); setSearchParams(next);
  }
  const facets = data?.facets || {};
  return <div className="space-y-6">
    <section className="rounded-3xl border border-teal-100 bg-gradient-to-br from-white via-teal-50/60 to-blue-50/60 p-7 shadow-sm"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start"><div><div className="flex gap-2"><Badge value="ALL STORED OCCURRENCES" kind="blue" /><Badge value="READ ONLY" kind="green" /></div><h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">Complete Alert History</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Every parsed alert message from the configured Alerts and Notifications channel. Repeated notifications remain separate occurrences; only exact Slack deliveries are deduplicated.</p></div><button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700" onClick={load} type="button"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div></section>
    {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div> : null}
    <section className="grid gap-3 sm:grid-cols-3"><div className="rounded-2xl border border-slate-200 bg-white p-5"><Database className="h-5 w-5 text-blue-600" /><p className="mt-3 text-2xl font-semibold">{data ? Number(data.filteredCount).toLocaleString() : '—'}</p><p className="text-xs text-slate-500">Matching alert occurrences · {data ? Number(data.totalCount).toLocaleString() : '—'} total</p></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><ShieldCheck className="h-5 w-5 text-emerald-600" /><p className="mt-3 text-2xl font-semibold">{data ? Number(data.facetTotals?.responders).toLocaleString() : '—'}</p><p className="text-xs text-slate-500">Responder groups represented</p></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><Activity className="h-5 w-5 text-violet-600" /><p className="mt-3 text-2xl font-semibold">{data ? Number(data.facetTotals?.priorities).toLocaleString() : '—'}</p><p className="text-xs text-slate-500">Priority values represented</p></div></section>
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><form className="grid gap-3 md:grid-cols-2 xl:grid-cols-7" onSubmit={(event) => { event.preventDefault(); change('search', draftSearch.trim()); }}><label className="relative xl:col-span-2"><span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Search</span><Search className="absolute bottom-3 left-3 h-4 w-4 text-slate-400" /><input className="mt-1 h-10 w-full rounded-xl border border-slate-200 pl-9 pr-16 text-xs" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} /><button className="absolute bottom-2 right-2 rounded-lg bg-slate-950 px-2.5 py-1.5 text-[9px] font-bold text-white" type="submit">Apply</button></label>
      <Select label="Time window" value={filters.range} onChange={(event) => change('range', event.target.value)}><option value="all">All history</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></Select>
      <Select label="Source" value={filters.source} onChange={(event) => change('source', event.target.value)}><option value="all">All sources</option>{(facets.sources || []).map((item) => <option value={item.value} key={item.value}>{item.value} ({item.count})</option>)}</Select>
      <Select label="Priority" value={filters.priority} onChange={(event) => change('priority', event.target.value)}><option value="all">All priorities</option>{(facets.priorities || []).map((item) => <option value={item.value} key={item.value}>{item.value} ({item.count})</option>)}</Select>
      <Select label="Responder" value={filters.responder} onChange={(event) => change('responder', event.target.value)}><option value="all">All responders</option>{(facets.responders || []).map((item) => <option value={item.value} key={item.value}>{item.value} ({item.count})</option>)}</Select>
      <Select label="Status" value={filters.status} onChange={(event) => change('status', event.target.value)}><option value="all">Active and resolved</option>{(facets.statuses || []).map((item) => <option value={item.value} key={item.value}>{item.value} ({item.count})</option>)}</Select>
      <Select label="Evidence" value={filters.evidenceStatus} onChange={(event) => change('evidenceStatus', event.target.value)}><option value="all">All evidence states</option><option value="NOT_STARTED">Not Started</option><option value="PARTIAL">Partial</option><option value="COMPLETE">Complete</option><option value="PENDING_EVIDENCE">Insufficient Evidence</option><option value="CONFIRMED_INCIDENT">Confirmed Incident</option><option value="CONFIRMED_NOISE">Confirmed Noise</option></Select>
    </form></section>
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h2 className="text-sm font-semibold text-slate-950">Alert occurrences</h2><p className="mt-1 text-[10px] text-slate-500">No responder, priority, state, age, or repeat exclusions</p></div><Badge value={filters.range === 'all' ? 'ALL HISTORY' : filters.range} /></div><div className="overflow-x-auto"><table className="w-full min-w-[1450px] text-left text-xs"><thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500"><tr>{['Alert','Source','Priority','Responder','Environment','Timestamp','Status','Evidence','Completion','Source availability','Workflow','Action'].map((heading) => <th className="px-4 py-3" key={heading}>{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{(data?.items || []).map((item) => <tr className="align-top hover:bg-blue-50/30" key={item.occurrenceId}><td className="max-w-[280px] px-4 py-4"><p className="font-bold text-blue-700">#{item.alertNumber}</p><p className="mt-1 font-semibold text-slate-900">{item.title}</p></td><td className="px-4 py-4"><Badge value={item.sourceSystem} kind="blue" /></td><td className="px-4 py-4"><Badge value={item.priority} kind={item.priority === 'P1' ? 'rose' : 'slate'} /></td><td className="max-w-[180px] px-4 py-4 font-semibold text-slate-700">{item.responder || 'Unassigned'}</td><td className="px-4 py-4">{item.environment || 'Not available'}</td><td className="whitespace-nowrap px-4 py-4">{formatDate(item.timestamp)}</td><td className="px-4 py-4"><Badge value={item.status} /></td><td className="px-4 py-4"><Badge value={item.evidenceStatus} kind={evidenceTone(item.evidenceStatus)} /></td><td className="px-4 py-4"><div className="h-1.5 w-20 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-teal-500" style={{ width: `${item.evidenceCompletionPercentage}%` }} /></div><p className="mt-1 text-[9px] text-slate-500">{item.evidenceCompletionPercentage}%</p></td><td className="px-4 py-4">{readable(item.sourceAvailability)}</td><td className="px-4 py-4"><Badge value={item.evidenceWorkflow} kind={item.evidenceWorkflow === 'LIVE' ? 'green' : 'amber'} /></td><td className="px-4 py-4"><button className="whitespace-nowrap rounded-lg bg-slate-950 px-3 py-2 text-[10px] font-bold text-white" onClick={() => navigate(`/alert-history/${encodeURIComponent(item.occurrenceId)}?${searchParams}`)} type="button">View Evidence</button></td></tr>)}</tbody></table></div>
      {!loading && !(data?.items || []).length ? <div className="p-12 text-center"><AlertTriangle className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-3 text-sm text-slate-600">No alert occurrences match these filters.</p></div> : null}
      {loading ? <div className="p-10 text-center text-sm text-slate-500">Loading alert occurrences…</div> : null}
      <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4"><button className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold disabled:opacity-40" disabled={!data || data.currentPage <= 1} onClick={() => change('page', data.currentPage - 1)} type="button"><ArrowLeft className="h-3.5 w-3.5" />Previous</button><p className="text-[10px] text-slate-500">Page {data?.currentPage ?? '—'} of {data?.totalPages ?? '—'}</p><button className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold disabled:opacity-40" disabled={!data || data.currentPage >= data.totalPages} onClick={() => change('page', data.currentPage + 1)} type="button">Next<ArrowRight className="h-3.5 w-3.5" /></button></div>
    </section>
    <Detail occurrence={selected} onClose={() => { setSelected(null); navigate(`/alert-history?${searchParams}`); }} />
  </div>;
}

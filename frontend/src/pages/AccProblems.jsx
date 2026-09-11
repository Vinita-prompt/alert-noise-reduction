import { ChevronLeft, ChevronRight, Link2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
import { getAccProblems, getIncidentSummary } from '../services/api.js';

export default function AccProblems() {
  const [result, setResult] = useState(null);
  const [incidentSummary, setIncidentSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [jiraError, setJiraError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setJiraError('');
    setIncidentSummary(null);
    const [problemsResult, summaryResult] = await Promise.allSettled([
      getAccProblems({ page, pageSize }),
      getIncidentSummary({ range: '30d' }),
    ]);
    if (problemsResult.status === 'fulfilled') setResult(problemsResult.value);
    else { setResult(null); setError('Jira Problem data unavailable'); }
    if (summaryResult.status === 'fulfilled') setIncidentSummary(summaryResult.value);
    else setJiraError('Jira data unavailable');
    setLoading(false);
  }, [page, pageSize]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);
  useLiveDataRefresh(load);

  return (
    <div>
      <PageHeader
        eyebrow="ACC Jira operations"
        title="Problems"
        description="All ACC Problem records, retrieved read-only through Jira pagination. Related incidents appear only when a Jira issue link confirms the relationship."
        actions={<ReadOnlyJiraBadge />}
      />

      <section className="mt-8 grid gap-4 sm:grid-cols-2" aria-label="ACC Jira dataset totals">
        <DatasetCard active label="Problems" value={result ? result.totalCount : '—'} />
        <DatasetCard label="Jira Incidents Created To Date" value={incidentSummary ? incidentSummary.incidentsCreatedToDate : '—'} />
      </section>

      {jiraError ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">Jira data unavailable</div> : null}

      <div className="mt-7 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">ACC Problems</h2>
          <p className="mt-1 text-xs text-slate-500">
            {loading && !result ? 'Loading the live Problem total…' : `${formatCount(result?.totalCount)} total · page ${formatCount(result?.currentPage)} of ${formatCount(result?.totalPages)}`}
          </p>
        </div>
        <div className="flex items-center gap-3"><label className="flex items-center gap-2 text-xs font-semibold text-slate-500">Rows<select className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700" value={pageSize} onChange={(event)=>{setPageSize(Number(event.target.value));setPage(1);}}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:text-slate-950 disabled:opacity-50" disabled={loading} onClick={load} type="button"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh</button></div>
      </div>

      {error ? <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</div> : null}

      <div className={`mt-4 transition-opacity ${loading ? 'opacity-60' : 'opacity-100'}`} aria-busy={loading}>
        <TableShell minWidth="1380px">
          <TableHead headings={['Problem key', 'Summary', 'Status', 'Priority', 'Owner', 'Created', 'Updated', 'Resolved', 'Resolution', 'Related incidents']} />
          <tbody className="divide-y divide-slate-100">
            {(result?.items || []).map((problem) => (
              <tr className="align-top transition hover:bg-slate-50/80" key={problem.key}>
                <td className="whitespace-nowrap px-5 py-4">
                  <Link className="text-xs font-bold text-teal-700 hover:text-teal-900 hover:underline" to={`/problem-candidates/${problem.key}`}>{problem.key}</Link>
                </td>
                <td className="max-w-[360px] px-5 py-4 text-xs font-semibold leading-5 text-slate-800">{problem.summary}</td>
                <td className="whitespace-nowrap px-5 py-4"><StatusBadge value={problem.status} /></td>
                <td className="whitespace-nowrap px-5 py-4"><PriorityBadge value={problem.priority} /></td>
                <td className="max-w-[190px] px-5 py-4 text-xs"><PersonLabel compact person={problem.assignee} /></td>
                <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{formatJiraDate(problem.createdAt)}</td>
                <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{formatJiraDate(problem.updatedAt)}</td>
                <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{formatJiraDate(problem.resolvedAt)}</td>
                <td className="max-w-[170px] px-5 py-4 text-xs font-medium text-slate-600">{problem.resolution || '—'}</td>
                <td className="min-w-[190px] px-5 py-4">
                  {problem.relatedIncidents?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {problem.relatedIncidents.map((link) => (
                        <Link className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700 hover:bg-blue-100" key={`${problem.key}-${link.key}`} to={`/incidents/${link.key}`} title={link.summary || link.relationship || link.key}>
                          <Link2 className="h-3 w-3" aria-hidden="true" /> {link.key}
                        </Link>
                      ))}
                    </div>
                  ) : <span className="text-xs text-slate-400">No linked incidents</span>}
                </td>
              </tr>
            ))}
            {!loading && result?.items?.length === 0 ? (
              <tr><td className="px-5 py-12 text-center text-sm text-slate-500" colSpan={10}>No ACC Problems were returned by Jira.</td></tr>
            ) : null}
          </tbody>
        </TableShell>
      </div>
      <div className="mt-5 flex items-center justify-between gap-4"><p className="text-xs font-semibold text-slate-500">Page {result?.currentPage ?? '—'} of {result?.totalPages ?? '—'} · Updated {formatJiraDate(result?.updatedAt)}</p><div className="flex gap-2"><button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold disabled:opacity-40" disabled={loading||!result?.hasPrevious} onClick={()=>setPage((value)=>Math.max(1,value-1))}><ChevronLeft className="h-4 w-4"/>Previous</button><button className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold disabled:opacity-40" disabled={loading||!result?.hasNext} onClick={()=>setPage((value)=>value+1)}>Next<ChevronRight className="h-4 w-4"/></button></div></div>
    </div>
  );
}

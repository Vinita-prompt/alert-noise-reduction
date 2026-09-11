import { ArchiveRestore, CheckCircle2, Database, FileSearch, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getEvidenceBackfillQueue,
  getEvidenceLearningSummary,
  refreshEvidenceBackfill,
  selectEvidenceBackfill,
} from '../services/api.js';

function display(value) {
  if (value === 'PENDING_EVIDENCE') return 'Insufficient Evidence';
  return value === null || value === undefined || value === '' ? '—' : String(value).replaceAll('_', ' ');
}

function Badge({ value }) {
  const status = String(value || 'UNKNOWN').toUpperCase();
  const tone = status === 'VERIFIED' || status === 'COMPLETE'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'PENDING_EVIDENCE' || status === 'PARTIAL' || status === 'IN_REVIEW'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-slate-200 bg-slate-50 text-slate-600';
  return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{display(status)}</span>;
}

export default function EvidenceBackfill() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState({ data: [], meta: {} });
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState('PENDING');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [items, metrics] = await Promise.all([
        getEvidenceBackfillQueue({ status, pageSize: 50 }),
        getEvidenceLearningSummary(),
      ]);
      setQueue(items); setSummary(metrics);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  async function refresh() {
    setWorking(true); setError('');
    try { await refreshEvidenceBackfill(); await load(); }
    catch (requestError) { setError(requestError.message); }
    finally { setWorking(false); }
  }

  async function review(item) {
    setWorking(true); setError('');
    try {
      await selectEvidenceBackfill(item.alertId);
      navigate(`/collect-evidence/${encodeURIComponent(item.alertId)}?origin=BACKFILL&queueId=${encodeURIComponent(item.queueId)}`);
    } catch (requestError) {
      setError(requestError.message); setWorking(false);
    }
  }

  const cards = [
    ['Pending review', summary?.backfillQueue?.PENDING || 0, ArchiveRestore, 'text-sky-700 bg-sky-50'],
    ['Verified labels', summary?.verifiedLabels || 0, CheckCircle2, 'text-emerald-700 bg-emerald-50'],
    ['Insufficient Evidence', summary?.pendingEvidence || 0, FileSearch, 'text-amber-700 bg-amber-50'],
    ['Training eligible', summary?.trainingEligible || 0, Database, 'text-violet-700 bg-violet-50'],
  ];

  return <div className="space-y-6">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">Append-only historical workflow</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Evidence Backfill</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Review selected historical alerts using stored operational and monitoring evidence. Missing or conflicting facts remain Insufficient Evidence.</p></div>
      <button className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-bold text-white disabled:opacity-50" disabled={working} onClick={refresh} type="button"><RefreshCw className={`h-4 w-4 ${working ? 'animate-spin' : ''}`} /> Import stored evidence</button>
    </header>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, Icon, tone]) => <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" key={label}><div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${tone}`}><Icon className="h-5 w-5" /></div><p className="mt-4 text-2xl font-semibold text-slate-950">{value}</p><p className="mt-1 text-xs font-semibold text-slate-500">{label}</p></article>)}</div>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><div><h2 className="text-sm font-semibold text-slate-950">Historical review queue</h2><p className="mt-1 text-xs text-slate-500">All rows are marked BACKFILL. Historical alerts and classifications remain unchanged.</p></div><select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700" value={status} onChange={(event) => setStatus(event.target.value)}>{['PENDING', 'IN_REVIEW', 'PENDING_EVIDENCE', 'VERIFIED'].map((value) => <option key={value}>{display(value)}</option>)}</select></div>
      {error ? <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {loading ? <div className="p-10 text-center text-sm text-slate-500">Loading backfill queue…</div> : queue.data?.length ? <div className="overflow-x-auto"><table className="min-w-full text-left text-xs"><thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Alert</th><th className="px-5 py-3">Source</th><th className="px-5 py-3">Priority</th><th className="px-5 py-3">Stored evidence</th><th className="px-5 py-3">Status</th><th className="px-5 py-3 text-right">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{queue.data.map((item) => <tr key={item.queueId}><td className="max-w-md px-5 py-4"><p className="font-bold text-slate-900">#{item.alertNumber || item.alertId} · {item.alertName}</p><p className="mt-1 text-[11px] text-slate-500">BACKFILL · {new Date(item.receivedAt).toLocaleString()}</p></td><td className="px-5 py-4 font-semibold text-slate-700">{display(item.monitoringSource)}</td><td className="px-5 py-4">{display(item.priority)}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-1">{item.evidenceSources?.map((source) => <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600" key={source}>{source}</span>)}</div></td><td className="px-5 py-4"><Badge value={item.status} /> <Badge value={item.evidenceCompleteness} /></td><td className="px-5 py-4 text-right"><button className="rounded-lg bg-teal-700 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50" disabled={working || item.status === 'VERIFIED'} onClick={() => review(item)} type="button">Add evidence</button></td></tr>)}</tbody></table></div> : <div className="p-10 text-center"><ShieldCheck className="mx-auto h-8 w-8 text-emerald-600" /><p className="mt-3 text-sm font-semibold text-slate-900">No alerts in this queue state</p><p className="mt-1 text-xs text-slate-500">Import stored evidence to discover additional historical candidates.</p></div>}
    </section>
    <p className="text-xs leading-5 text-slate-500">Shadow/read-only mode: no Jira, Slack alert state, or monitoring system is modified. Attachments support a review but are never used as the sole learning signal.</p>
  </div>;
}

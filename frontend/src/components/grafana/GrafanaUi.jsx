import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

export function formatGrafanaTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function GrafanaReadOnlyBadge({ connected = true }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] ${connected ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-400'}`} />
      {connected ? 'Connected · read only' : 'Connection unavailable'}
    </span>
  );
}

export function GrafanaLink({ href, label = 'Open in Grafana', subtle = false }) {
  if (!href) return null;

  return (
    <a
      className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition ${subtle ? 'border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-950' : 'bg-slate-950 text-white hover:bg-slate-800'}`}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

export function GrafanaRefreshButton({ label = 'Refresh', loading, onClick }) {
  return (
    <button
      className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
      {label}
    </button>
  );
}

export function GrafanaTags({ values = [], limit = 5 }) {
  const visible = values.filter(Boolean).slice(0, limit);
  if (!visible.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((value) => (
        <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600" key={value}>{value}</span>
      ))}
      {values.length > limit ? <span className="px-1 py-1 text-[10px] font-semibold text-slate-400">+{values.length - limit}</span> : null}
    </div>
  );
}

export function GrafanaPagination({ loading, pagination, onPage }) {
  if (!pagination || pagination.pageCount <= 1) return null;

  return (
    <nav className="mt-5 flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3" aria-label="Grafana result pagination">
      <p className="text-xs font-semibold text-slate-500">
        Page {pagination.page} of {pagination.pageCount}
        <span className="ml-2 font-normal text-slate-400">· {pagination.total.toLocaleString()} results</span>
      </p>
      <div className="flex gap-2">
        <button aria-label="Previous page" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-35" disabled={!pagination.hasPrevious || loading} onClick={() => onPage(pagination.page - 1)} type="button"><ChevronLeft className="h-4 w-4" /></button>
        <button aria-label="Next page" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-35" disabled={!pagination.hasNext || loading} onClick={() => onPage(pagination.page + 1)} type="button"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </nav>
  );
}

export function GrafanaEmptyState({ description, title }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-12 text-center">
      <Activity className="mx-auto h-6 w-6 text-slate-300" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold text-slate-700">{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-xl text-xs leading-5 text-slate-500">{description}</p> : null}
    </div>
  );
}

export function GrafanaDefinitionGrid({ items }) {
  const available = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== '');
  if (!available.length) return null;

  return (
    <dl className="grid gap-x-7 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
      {available.map((item) => (
        <div key={item.label}>
          <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{item.label}</dt>
          <dd className="mt-1 break-words text-sm font-semibold leading-5 text-slate-700">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function GrafanaDetailDrawer({ children, closeLabel = 'Close', onClose, title }) {
  const contentRef = useRef(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [title]);

  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <button aria-label="Close detail drawer" className="absolute inset-0 bg-slate-950/30 backdrop-blur-[2px]" onClick={onClose} type="button" />
      <aside className="relative flex h-full w-full max-w-3xl flex-col border-l border-slate-200 bg-[#f8faf8] shadow-2xl" aria-label={title}>
        <div className="flex h-[76px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 sm:px-7">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Grafana detail</p>
            <p className="mt-1 truncate text-sm font-semibold text-slate-950">{title}</p>
          </div>
          <button className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:text-slate-950" onClick={onClose} type="button" aria-label="Close detail"><X className="h-4 w-4" />{closeLabel}</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-7" ref={contentRef}>{children}</div>
      </aside>
    </div>
  );
}

export function GrafanaStateBadge({ state }) {
  const normalized = String(state || '').toLowerCase();
  const tone = ['active', 'alerting', 'firing'].includes(normalized)
    ? 'border-rose-200 bg-rose-50 text-rose-700'
    : normalized === 'pending'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-slate-200 bg-slate-50 text-slate-600';

  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold ${tone}`}>{state}</span>;
}

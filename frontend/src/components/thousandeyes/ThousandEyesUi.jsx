import {
  Activity,
  ArrowLeft,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';
import { PageHeader } from '../operational/DemoUi.jsx';

export const THOUSANDEYES_RANGES = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '12h', value: '12h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
];

const STATUS_STYLES = {
  active: 'border-rose-200 bg-rose-50 text-rose-700',
  trigger: 'border-rose-200 bg-rose-50 text-rose-700',
  triggered: 'border-rose-200 bg-rose-50 text-rose-700',
  critical: 'border-rose-200 bg-rose-50 text-rose-700',
  major: 'border-orange-200 bg-orange-50 text-orange-700',
  minor: 'border-amber-200 bg-amber-50 text-amber-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  online: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  clear: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  cleared: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  resolved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  enabled: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
};

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 'Ongoing';
  if (value < 60) return `${Math.round(value)} sec`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)} hr`;
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function formatMetric(value, suffix = '', digits = 1) {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? `${numeric.toLocaleString(undefined, { maximumFractionDigits: digits })}${suffix}`
    : '—';
}

export function Freshness({ value }) {
  if (!value) return null;
  return <span className="text-[11px] font-medium text-slate-400">Fetched {formatDateTime(value)}</span>;
}

export function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Live · read only
    </span>
  );
}

export function StatusBadge({ value }) {
  const normalized = String(value || 'unknown').toLowerCase();
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold capitalize ${STATUS_STYLES[normalized] || STATUS_STYLES.unknown}`}>
      {normalized}
    </span>
  );
}

export function TimeRange({ disabled, onChange, value, ranges = THOUSANDEYES_RANGES }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="Time range">
      {ranges.map((range) => (
        <button
          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${value === range.value ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
          disabled={disabled}
          key={range.value}
          onClick={() => onChange(range.value)}
          type="button"
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

export function RefreshButton({ loading, onClick }) {
  return (
    <button
      className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-950 disabled:opacity-50"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
      Refresh
    </button>
  );
}

export function SourceLink({ href, label = 'Open in ThousandEyes' }) {
  if (!href) return null;
  return (
    <a className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800" href={href} rel="noreferrer" target="_blank">
      {label}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function ErrorPanel({ message, onRetry }) {
  return (
    <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-5">
      <p className="text-sm font-semibold text-rose-800">ThousandEyes data could not be loaded.</p>
      <p className="mt-1 text-xs leading-5 text-rose-700">{message}</p>
      <button className="mt-4 rounded-xl bg-rose-700 px-3.5 py-2 text-xs font-semibold text-white" onClick={onRetry} type="button">Try again</button>
    </div>
  );
}

export function EmptyState({ description, title }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-12 text-center">
      <Activity className="mx-auto h-5 w-5 text-slate-300" />
      <p className="mt-3 text-sm font-semibold text-slate-700">{title}</p>
      <p className="mx-auto mt-1 max-w-2xl text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

export function SummaryCard({ hint, icon: Icon, label, value }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-slate-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{value ?? '—'}</p>
        </div>
        {Icon ? <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Icon className="h-4 w-4" /></span> : null}
      </div>
      {hint ? <p className="mt-3 text-xs text-slate-400">{hint}</p> : null}
    </article>
  );
}

export function BackLink({ children, to }) {
  return (
    <Link className="mb-5 inline-flex items-center gap-2 text-xs font-bold text-slate-500 transition hover:text-slate-950" to={to}>
      <ArrowLeft className="h-3.5 w-3.5" />
      {children}
    </Link>
  );
}

export function WorkspaceHeader({ actions, description, title }) {
  return (
    <>
      <PageHeader eyebrow="Live network intelligence" title={title} description={description} actions={actions || <LiveBadge />} />
      <nav className="mt-7 flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5" aria-label="ThousandEyes workspace">
        {[
          { label: 'Dashboard', to: '/thousandeyes' },
          { label: 'Event Detection', to: '/thousandeyes/event-detection' },
          { label: 'Alerts', to: '/thousandeyes/alerts' },
        ].map((item) => (
          <NavLink
            className={({ isActive }) => `whitespace-nowrap rounded-xl px-4 py-2.5 text-xs font-bold transition ${isActive ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'}`}
            end={item.to === '/thousandeyes'}
            key={item.to}
            to={item.to}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

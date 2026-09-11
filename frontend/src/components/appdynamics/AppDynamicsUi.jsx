import { Activity, ExternalLink, RefreshCw } from 'lucide-react';

export const TIME_RANGES = [
  { label: '15m', value: '15m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '90d', value: '90d' },
  { label: '6mo', value: '6mo' },
  { label: '1y', value: '1y' },
];

const RANGE_ALIASES = { 15: '15m', 30: '30m', 60: '1h', 240: '4h', 1440: '24h' };
const PRIMARY_RANGES = TIME_RANGES.slice(0, 7);
const MORE_RANGES = TIME_RANGES.slice(7);

export function normalizeRange(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return TIME_RANGES.some((range) => range.value === raw) ? raw : RANGE_ALIASES[raw] || '15m';
}

export function formatRange(value) {
  const normalized = normalizeRange(value);
  return TIME_RANGES.find((range) => range.value === normalized)?.label || normalized;
}

export function LiveReadOnlyBadge() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Live · read only
    </span>
  );
}

export function TimeRangeControl({ disabled, onChange, value }) {
  const normalized = normalizeRange(value);
  const moreSelected = MORE_RANGES.some((range) => range.value === normalized);
  return (
    <>
      <div className="hidden rounded-xl border border-slate-200 bg-white p-1 shadow-sm sm:inline-flex" aria-label="Metric time range">
        {PRIMARY_RANGES.map((range) => (
          <button
            className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${normalized === range.value ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
            disabled={disabled}
            key={range.value}
            onClick={() => onChange(range.value)}
            type="button"
          >
            {range.label}
          </button>
        ))}
        <select
          aria-label="More time ranges"
          className={`rounded-lg border-0 px-2 py-1.5 text-[11px] font-bold outline-none ${moreSelected ? 'bg-slate-950 text-white' : 'bg-white text-slate-500'}`}
          disabled={disabled}
          onChange={(event) => event.target.value && onChange(event.target.value)}
          value={moreSelected ? normalized : ''}
        >
          <option value="">More</option>
          {MORE_RANGES.map((range) => <option key={range.value} value={range.value}>{range.label}</option>)}
        </select>
      </div>
      <select
        aria-label="Metric time range"
        className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm outline-none sm:hidden"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={normalized}
      >
        {TIME_RANGES.map((range) => <option key={range.value} value={range.value}>{range.label}</option>)}
      </select>
    </>
  );
}

export function RefreshButton({ loading, onClick }) {
  return (
    <button
      className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
      Refresh
    </button>
  );
}

export function SourceButton({ href, compact = false }) {
  if (!href) return null;

  return (
    <a
      className={`inline-flex items-center gap-2 rounded-xl bg-slate-950 font-semibold text-white transition hover:bg-slate-800 ${compact ? 'px-3 py-2 text-[11px]' : 'px-4 py-2.5 text-xs'}`}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      Open in AppDynamics
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

export function DataStateText({ range, status, noDataLabel }) {
  if (status === 'no_data') return <>{noDataLabel || `No data in last ${formatRange(range)}`}</>;
  if (status === 'unavailable') return <>Not available through API</>;
  if (status === 'error') return <>Unable to load data</>;
  if (status === 'not_requested') return <>Loads when selected</>;
  return <>No records</>;
}

export function MetricValue({ value, suffix = '', maximumFractionDigits = 1, range, status }) {
  if (status && status !== 'data') {
    return <DataStateText range={range} status={status} />;
  }
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return <DataStateText range={range} status="no_data" />;
  }
  return <>{Number(value).toLocaleString(undefined, { maximumFractionDigits })}{suffix}</>;
}

export function MetricCard({ label, value, suffix, hint, range, status }) {
  const hasValue = status === 'data' && value !== null && value !== undefined && !Number.isNaN(Number(value));
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-400">{label}</p>
      <p className={`mt-3 font-bold tracking-tight ${hasValue ? 'text-2xl text-slate-950' : 'text-sm leading-5 text-slate-600'}`}>
        <MetricValue range={range} status={status} suffix={suffix} value={value} />
      </p>
      {hint ? <p className="mt-1.5 text-[11px] text-slate-400">{hint}</p> : null}
    </article>
  );
}

export function EmptyState({ title, description }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center">
      <Activity className="mx-auto h-5 w-5 text-slate-300" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold text-slate-700">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

export function formatFreshness(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function DefinitionList({ items }) {
  const available = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== '');
  if (!available.length) return null;

  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
      {available.map((item) => (
        <div key={item.label}>
          <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{item.label}</dt>
          <dd className="mt-1 break-words text-xs font-semibold leading-5 text-slate-700">{String(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

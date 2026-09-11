import { Database, LockKeyhole } from 'lucide-react';

export function formatJiraDate(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: options.dateOnly ? undefined : '2-digit',
    minute: options.dateOnly ? undefined : '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatCount(value) {
  if (value === '—') return '—';
  return Number(value || 0).toLocaleString('en-US');
}

export function PersonLabel({ person, compact = false }) {
  if (!person) return <span className="text-slate-400">Unassigned</span>;
  const showEmail = person.email && person.email !== person.displayName;
  return (
    <span className="block min-w-0" title={person.email || person.displayName || ''}>
      <span className="block truncate font-semibold text-slate-800">{person.displayName || person.email}</span>
      {!compact && showEmail ? <span className="mt-0.5 block truncate text-[11px] text-slate-400">{person.email}</span> : null}
    </span>
  );
}

export function PriorityBadge({ value }) {
  if (!value) return <span className="text-slate-400">—</span>;
  const tones = {
    Highest: 'border-rose-200 bg-rose-50 text-rose-700',
    High: 'border-orange-200 bg-orange-50 text-orange-700',
    Medium: 'border-amber-200 bg-amber-50 text-amber-700',
    Low: 'border-blue-200 bg-blue-50 text-blue-700',
    Lowest: 'border-slate-200 bg-slate-50 text-slate-600',
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold ${tones[value] || tones.Lowest}`}>{value}</span>;
}

export function StatusBadge({ value }) {
  if (!value) return <span className="text-slate-400">—</span>;
  const normalized = value.toLowerCase();
  const tone = /restored|resolved|closed|completed|done/.test(normalized)
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : /investigat|progress|identified|monitoring/.test(normalized)
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-slate-200 bg-slate-50 text-slate-600';
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold ${tone}`}>{value}</span>;
}

export function ReadOnlyJiraBadge() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
      <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
      Jira read-only
    </span>
  );
}

export function DatasetCard({ label, value, active = false }) {
  return (
    <article className={`rounded-2xl border p-5 ${active ? 'border-teal-200 bg-teal-50/50' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">ACC operations</p>
          <p className="mt-2 text-sm font-semibold text-slate-600">{label}</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">{formatCount(value)}</p>
        </div>
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${active ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
          <Database className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}

export function DetailField({ label, children, className = '' }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className={className}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="mt-1.5 text-sm leading-6 text-slate-700">{children}</dd>
    </div>
  );
}

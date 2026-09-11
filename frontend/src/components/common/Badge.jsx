const toneClasses = {
  critical: 'bg-red-50 text-red-700 ring-red-200',
  high: 'bg-orange-50 text-orange-700 ring-orange-200',
  medium: 'bg-yellow-50 text-yellow-800 ring-yellow-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  low: 'bg-slate-100 text-slate-700 ring-slate-200',
  open: 'bg-blue-50 text-blue-700 ring-blue-200',
  investigating: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  acknowledged: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  unacknowledged: 'bg-amber-50 text-amber-700 ring-amber-200',
  escalated: 'bg-rose-50 text-rose-700 ring-rose-200',
  suppressed: 'bg-slate-100 text-slate-700 ring-slate-200',
  'auto-resolved': 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  deduplicated: 'bg-violet-50 text-violet-700 ring-violet-200',
  incident: 'bg-rose-50 text-rose-700 ring-rose-200',
  noise: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  needs_review: 'bg-amber-50 text-amber-700 ring-amber-200',
  unclassified: 'bg-slate-100 text-slate-700 ring-slate-200',
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  draft: 'bg-blue-50 text-blue-700 ring-blue-200',
  paused: 'bg-slate-100 text-slate-700 ring-slate-200',
  default: 'bg-slate-100 text-slate-700 ring-slate-200',
};

function formatLabel(value) {
  return String(value)
    .replace(/_/g, '-')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export default function Badge({ children, tone, className = '' }) {
  const normalizedTone = tone || String(children).toLowerCase();

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${toneClasses[normalizedTone] || toneClasses.default} ${className}`}
    >
      {typeof children === 'string' ? formatLabel(children) : children}
    </span>
  );
}

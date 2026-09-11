import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

const severityStyles = {
  Critical: 'border-rose-200 bg-rose-50 text-rose-700',
  High: 'border-orange-200 bg-orange-50 text-orange-700',
  Medium: 'border-amber-200 bg-amber-50 text-amber-700',
  Low: 'border-slate-200 bg-slate-50 text-slate-600',
};

const noiseStyles = {
  Noise: 'bg-violet-50 text-violet-700',
  'Not noise': 'bg-emerald-50 text-emerald-700',
  'Under review': 'bg-amber-50 text-amber-700',
};

const actionabilityStyles = {
  Actionable: 'bg-blue-50 text-blue-700',
  'Non-actionable': 'bg-slate-100 text-slate-600',
  Review: 'bg-amber-50 text-amber-700',
};

const metricTones = {
  slate: 'bg-slate-100 text-slate-600',
  violet: 'bg-violet-50 text-violet-700',
  blue: 'bg-blue-50 text-blue-700',
  rose: 'bg-rose-50 text-rose-700',
  amber: 'bg-amber-50 text-amber-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  teal: 'bg-teal-50 text-teal-700',
};

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500 sm:text-base sm:leading-7">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}

export function DemoDataBadge({ label = 'Static demo data' }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-700 sm:text-[11px]">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      {label}
    </span>
  );
}

export function SeverityBadge({ severity }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold ${severityStyles[severity] || severityStyles.Low}`}>{severity}</span>;
}

export function NoiseBadge({ status }) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${noiseStyles[status] || noiseStyles['Under review']}`}>{status}</span>;
}

export function ActionabilityBadge({ value }) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${actionabilityStyles[value] || actionabilityStyles.Review}`}>{value}</span>;
}

export function SourceChips({ sources, compact = false }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <span key={source} className={`rounded-md border border-slate-200 bg-white font-semibold text-slate-600 ${compact ? 'px-2 py-1 text-[10px]' : 'px-2.5 py-1 text-xs'}`}>
          {source}
        </span>
      ))}
    </div>
  );
}

export function MetricCard({ metric, icon: Icon }) {
  const tone = metricTones[metric.tone] || metricTones.slate;
  const improving = metric.change?.startsWith('+');

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_35px_-30px_rgba(15,23,42,0.32)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-slate-500">{metric.label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{metric.value}</p>
        </div>
        {Icon ? (
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      <p className="mt-3 flex items-center gap-1 text-xs text-slate-400">
        {improving ? <ArrowUpRight className="h-3 w-3 text-emerald-500" aria-hidden="true" /> : null}
        {!improving && metric.change?.startsWith('-') ? <ArrowDownRight className="h-3 w-3 text-rose-500" aria-hidden="true" /> : null}
        {metric.change}
      </p>
    </article>
  );
}

export function Confidence({ value }) {
  const tone = value >= 90 ? 'bg-emerald-500' : value >= 80 ? 'bg-blue-500' : 'bg-amber-400';

  return (
    <div className="min-w-[90px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-slate-700">{value}%</span>
        <span className="text-[10px] text-slate-400">confidence</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function TableShell({ children, minWidth = '1100px' }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left" style={{ minWidth }}>{children}</table>
      </div>
    </div>
  );
}

export function TableHead({ headings }) {
  return (
    <thead className="border-b border-slate-200 bg-slate-50/80">
      <tr>
        {headings.map((heading) => (
          <th key={heading} className="px-5 py-4 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{heading}</th>
        ))}
      </tr>
    </thead>
  );
}

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import Card from '../common/Card.jsx';

const toneClasses = {
  blue: 'bg-blue-50 text-blue-700',
  violet: 'bg-violet-50 text-violet-700',
  rose: 'bg-rose-50 text-rose-700',
  amber: 'bg-amber-50 text-amber-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  cyan: 'bg-cyan-50 text-cyan-700',
};

export default function StatCard({ label, value, change, tone = 'blue', helperText = 'vs last week' }) {
  const isPositive = change?.startsWith('+');
  const isNegative = change?.startsWith('-');
  const ChangeIcon = isNegative ? ArrowDownRight : ArrowUpRight;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            {Number(value).toLocaleString()}
          </p>
        </div>
        <div className={`rounded-md p-2 ${toneClasses[tone] || toneClasses.blue}`}>
          <ChangeIcon className="h-5 w-5" aria-hidden="true" />
        </div>
      </div>
      <p className="mt-4 text-sm text-slate-500">
        <span
          className={
            isPositive
              ? 'font-semibold text-emerald-600'
              : isNegative
                ? 'font-semibold text-rose-600'
                : 'font-semibold text-slate-600'
          }
        >
          {change}
        </span>{' '}
        {helperText}
      </p>
    </Card>
  );
}

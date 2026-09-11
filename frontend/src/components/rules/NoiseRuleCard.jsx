import { Activity, CheckCircle2, Eye, PauseCircle, Pencil, SlidersHorizontal } from 'lucide-react';
import Badge from '../common/Badge.jsx';
import Button from '../common/Button.jsx';
import Card from '../common/Card.jsx';

const statusIcons = {
  active: CheckCircle2,
  draft: SlidersHorizontal,
  paused: PauseCircle,
};

export default function NoiseRuleCard({ onEdit, onView, rule }) {
  const Icon = statusIcons[rule.status] || Activity;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-100 text-slate-700">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-950">{rule.name}</h3>
            <div className="mt-1">
              <Badge tone={rule.status}>{rule.status}</Badge>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-4 min-h-12 text-sm leading-6 text-slate-600">{rule.description}</p>

      <div className="mt-5 grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Threshold</p>
          <p className="mt-1 text-sm font-semibold text-slate-950">{rule.threshold}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reduction</p>
          <p className="mt-1 text-sm font-semibold text-emerald-700">{rule.reduction}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button onClick={() => onView(rule)}>
          <Eye className="h-4 w-4" aria-hidden="true" />
          View rule
        </Button>
        <Button variant="primary" onClick={() => onEdit(rule)}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit rule
        </Button>
      </div>
    </Card>
  );
}

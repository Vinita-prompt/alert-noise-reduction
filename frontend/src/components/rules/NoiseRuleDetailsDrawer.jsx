import { useEffect, useState } from 'react';
import { CheckCircle2, Pencil, Save, X, XCircle } from 'lucide-react';
import Badge from '../common/Badge.jsx';
import Button from '../common/Button.jsx';

const ruleGuidance = {
  'duplicate-alerts': {
    recommendedThreshold: '3 matches in 10 min',
    why: 'Start here to group repeated alerts without hiding the first signal. Tighten to 5 matches if teams are missing early incidents.',
    situationNotes: 'Use same service, environment, alert name, and resource as the matching keys.',
  },
  'flapping-alerts': {
    recommendedThreshold: '5 open/recover state changes in 15 min',
    why: 'This catches noisy open/recover loops while preserving alerts that remain consistently firing.',
    situationNotes: 'Lower to 3 state changes for very chatty monitors; raise to 7 for critical customer-facing checks.',
  },
  'auto-resolved-alerts': {
    recommendedThreshold: 'Resolved within 12 min with no repeat for 10 min',
    why: 'Short-lived alerts are often transient. Keep the window small enough that real incidents still stay visible.',
    situationNotes: 'For critical services, require no repeat within the next 10 minutes before suppressing.',
  },
  'non-actionable-alerts': {
    recommendedThreshold: 'Single low-impact event with no runbook action',
    why: 'Low-signal events should not page teams unless they repeat, affect users, or have a runbook action.',
    situationNotes: 'Keep these in draft until owners agree which alerts are informational only.',
  },
  'correlated-alerts': {
    recommendedThreshold: 'Shared dependency or region within 20 min',
    why: 'A 20 minute window is usually enough to group downstream symptoms under one upstream incident candidate.',
    situationNotes: 'Use shared dependency, region, deployment, or trace/service map as correlation keys.',
  },
  'stale-alerts': {
    recommendedThreshold: 'No source heartbeat or service ownership for 7 days',
    why: 'Seven days catches retired monitors and hosts while avoiding weekend or maintenance-window false positives.',
    situationNotes: 'Reduce to 3 days for fast-moving ephemeral services; raise to 14 days for batch systems.',
  },
};

const statusOptions = ['active', 'draft', 'paused'];

function FormField({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export default function NoiseRuleDetailsDrawer({
  error,
  onClose,
  onSave,
  rule,
  saving,
  startEditing = false,
  success,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [formState, setFormState] = useState({
    description: '',
    reduction: '',
    status: 'draft',
    threshold: '',
  });
  const isOpen = Boolean(rule);
  const guidance = ruleGuidance[rule?.ruleKey] || {
    recommendedThreshold: rule?.threshold,
    why: 'Tune this threshold based on alert volume, incident misses, and team feedback.',
    situationNotes: 'Review after one week of alert traffic before making aggressive changes.',
  };

  useEffect(() => {
    if (!rule) {
      return;
    }

    setIsEditing(Boolean(startEditing));
    setFormState({
      description: rule.description || '',
      reduction: rule.reduction || '',
      status: rule.status || 'draft',
      threshold: rule.threshold || '',
    });
  }, [rule, startEditing]);

  function updateField(name, value) {
    setFormState((current) => ({
      ...current,
      [name]: value,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    try {
      await onSave(rule, formState);
      setIsEditing(false);
    } catch {
      // The parent owns the visible error message so editing can continue.
    }
  }

  return (
    <div
      className={`fixed inset-0 z-50 transition ${isOpen ? 'pointer-events-auto' : 'pointer-events-none'}`}
      aria-hidden={!isOpen}
    >
      <div
        className={`absolute inset-0 bg-slate-950/40 transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        className={`absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-white shadow-2xl transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {rule ? (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
              <div>
                <p className="text-sm font-semibold text-cyan-700">Noise rule</p>
                <h3 className="mt-2 text-xl font-semibold leading-tight text-slate-950">{rule.name}</h3>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge tone={formState.status}>{formState.status}</Badge>
                  <Badge>{rule.ruleKey || 'custom-rule'}</Badge>
                </div>
              </div>
              <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close rule details">
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>

            <form className="flex flex-1 flex-col overflow-hidden" onSubmit={handleSubmit}>
              <div className="flex-1 space-y-5 overflow-y-auto p-6">
                {error ? (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {error}
                  </div>
                ) : null}

                {success ? (
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {success}
                  </div>
                ) : null}

                <section className="rounded-lg border border-slate-200 p-4">
                  <h4 className="text-sm font-semibold text-slate-950">Recommended starting threshold</h4>
                  <p className="mt-2 text-lg font-semibold text-slate-950">{guidance.recommendedThreshold}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{guidance.why}</p>
                  <p className="mt-3 rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-600">
                    {guidance.situationNotes}
                  </p>
                </section>

                <section className="space-y-4">
                  <FormField label="Current threshold">
                    {isEditing ? (
                      <input
                        className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                        required
                        value={formState.threshold}
                        onChange={(event) => updateField('threshold', event.target.value)}
                      />
                    ) : (
                      <p className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-slate-950">
                        {formState.threshold}
                      </p>
                    )}
                  </FormField>

                  <FormField label="Description">
                    {isEditing ? (
                      <textarea
                        className="min-h-24 w-full rounded-md border border-slate-200 px-3 py-2 text-sm leading-6 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                        required
                        value={formState.description}
                        onChange={(event) => updateField('description', event.target.value)}
                      />
                    ) : (
                      <p className="rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                        {formState.description}
                      </p>
                    )}
                  </FormField>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <FormField label="Status">
                      {isEditing ? (
                        <select
                          className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                          value={formState.status}
                          onChange={(event) => updateField('status', event.target.value)}
                        >
                          {statusOptions.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="rounded-lg bg-slate-50 p-3">
                          <Badge tone={formState.status}>{formState.status}</Badge>
                        </div>
                      )}
                    </FormField>

                    <FormField label="Expected reduction">
                      {isEditing ? (
                        <input
                          className="h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                          required
                          value={formState.reduction}
                          onChange={(event) => updateField('reduction', event.target.value)}
                        />
                      ) : (
                        <p className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-emerald-700">
                          {formState.reduction}
                        </p>
                      )}
                    </FormField>
                  </div>
                </section>
              </div>

              <div className="flex flex-col gap-2 border-t border-slate-200 p-6 sm:flex-row">
                {isEditing ? (
                  <>
                    <Button className="flex-1" disabled={saving} type="submit" variant="primary">
                      {saving ? (
                        'Saving'
                      ) : (
                        <>
                          <Save className="h-4 w-4" aria-hidden="true" />
                          Save rule
                        </>
                      )}
                    </Button>
                    <Button className="flex-1" disabled={saving} onClick={() => setIsEditing(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button className="flex-1" type="button" variant="primary" onClick={() => setIsEditing(true)}>
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      Edit rule
                    </Button>
                    <Button className="flex-1" type="button" onClick={onClose}>
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      Done
                    </Button>
                  </>
                )}
              </div>
            </form>
          </>
        ) : null}
      </aside>
    </div>
  );
}

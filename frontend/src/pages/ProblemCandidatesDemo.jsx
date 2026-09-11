import { AlertTriangle, Check, Lightbulb, Repeat2, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Confidence, PageHeader, SourceChips } from '../components/operational/DemoUi.jsx';
import { problemCandidates } from '../data/operationalDemo.js';

const thresholdRecommendations = [
  { alert: 'Profile cache node unavailable', evidence: 'Auto-resolved 14 of 15 times.', recommendation: 'Consider increasing persistence from 5 minutes to 10 minutes.' },
  { alert: 'Inventory sync CPU threshold', evidence: 'Flapped 12 times during the last 24 hours.', recommendation: 'Consider reviewing the monitoring threshold.' },
  { alert: 'Development certificate reminder', evidence: '93% of these alerts required no engineer action.', recommendation: 'Consider suppression or a lower notification priority.' },
];

export default function ProblemCandidatesDemo() {
  const [notice, setNotice] = useState('');

  return (
    <div>
      <PageHeader
        eyebrow="Recurring incident patterns"
        title="Problem Candidates"
        description="Identify recurring incidents that may deserve a Jira Problem record, deeper root-cause review, or a monitoring-rule change."
        actions={(
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-700">
            <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
            4 recurring patterns
          </span>
        )}
      />

      {notice ? (
        <div className="mt-7 flex items-start justify-between gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{notice} This is a local demo action; no Jira record was created.</p>
          </div>
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice"><X className="h-4 w-4" /></button>
        </div>
      ) : null}

      <section className="mt-9 grid gap-5 lg:grid-cols-2" aria-label="Recurring problem candidates">
        {problemCandidates.map((candidate) => (
          <article key={candidate.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 bg-slate-50/70 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-violet-700">{candidate.id}</p>
                  <h2 className="mt-2 text-lg font-semibold tracking-tight text-slate-950">{candidate.title}</h2>
                  <p className="mt-1 text-xs text-slate-500">{candidate.service} · {candidate.team}</p>
                </div>
                <Confidence value={candidate.confidence} />
              </div>
            </div>
            <div className="p-5 sm:p-6">
              <dl className="grid gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Incidents</dt>
                  <dd className="mt-1 text-xl font-semibold text-slate-950">{candidate.incidents}</dd>
                  <p className="text-[10px] text-slate-400">{candidate.period}</p>
                </div>
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">First occurrence</dt>
                  <dd className="mt-1.5 text-xs font-semibold text-slate-700">{candidate.firstOccurrence}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Avg. resolution</dt>
                  <dd className="mt-1.5 text-xs font-semibold text-slate-700">{candidate.averageResolutionTime}</dd>
                </div>
              </dl>

              <dl className="mt-6 space-y-4 border-t border-slate-100 pt-5">
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Pattern</dt>
                  <dd className="mt-1.5 text-sm leading-6 text-slate-700">{candidate.pattern}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Suspected root cause</dt>
                  <dd className="mt-1.5 text-sm leading-6 text-slate-600">{candidate.suspectedRootCause}</dd>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Latest occurrence</dt>
                    <dd className="mt-1.5 text-xs font-semibold text-slate-700">{candidate.latestOccurrence}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Business impact</dt>
                    <dd className="mt-1.5 text-xs font-semibold text-slate-700">{candidate.businessImpact}</dd>
                  </div>
                </div>
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Related records</dt>
                  <dd className="mt-2"><SourceChips sources={candidate.related} /></dd>
                </div>
              </dl>

              <div className="mt-6 rounded-2xl border border-violet-100 bg-violet-50/60 p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" aria-hidden="true" />
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-violet-700">Recommendation</p>
                    <p className="mt-1.5 text-sm font-semibold leading-6 text-violet-950">{candidate.recommendation}</p>
                  </div>
                </div>
              </div>

              <button
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                type="button"
                onClick={() => setNotice(`“Recommend Problem Record” selected for ${candidate.id}.`)}
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Recommend Problem Record
              </button>
            </div>
          </article>
        ))}
      </section>

      <section className="mt-10" aria-labelledby="rule-recommendations-heading">
        <div className="mb-5">
          <div className="flex items-center gap-2.5">
            <Lightbulb className="h-5 w-5 text-amber-600" aria-hidden="true" />
            <h2 id="rule-recommendations-heading" className="text-xl font-semibold tracking-tight text-slate-950">Threshold & rule recommendations</h2>
          </div>
          <p className="mt-1.5 text-sm text-slate-500">Static recommendations only. The demo never changes monitoring configuration.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {thresholdRecommendations.map((item) => (
            <article key={item.alert} className="rounded-2xl border border-slate-200 bg-white p-5">
              <p className="text-sm font-semibold text-slate-900">{item.alert}</p>
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800">{item.evidence}</p>
              <p className="mt-3 text-xs leading-5 text-slate-600">{item.recommendation}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

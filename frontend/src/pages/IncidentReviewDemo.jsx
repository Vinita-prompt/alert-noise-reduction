import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Edit3,
  FilePlus2,
  Link2,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Confidence, PageHeader, SeverityBadge, SourceChips } from '../components/operational/DemoUi.jsx';
import { incidentCandidates, incidentRegister } from '../data/operationalDemo.js';

const actions = [
  { label: 'Approve & Create Jira', icon: CheckCircle2, primary: true },
  { label: 'Edit Draft', icon: Edit3 },
  { label: 'Link Existing Incident', icon: Link2 },
  { label: 'Mark as Noise', icon: RotateCcw },
  { label: 'Reject', icon: X },
];

const incidentTabs = ['Incident Candidates', 'Open', 'Investigating', 'Monitoring', 'Resolved'];

function IncidentRegisterPanel({ tab }) {
  const records = incidentRegister.filter((incident) => incident.status === tab);

  return (
    <section className="mt-7" aria-label={`${tab} incidents`}>
      {records.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {records.map((incident) => (
            <article key={incident.id} className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold text-teal-700">{incident.id}</p>
                  <h2 className="mt-2 text-lg font-semibold tracking-tight text-slate-950">{incident.summary}</h2>
                </div>
                <SeverityBadge severity={incident.severity} />
              </div>
              <div className="mt-4"><SourceChips sources={incident.sources} /></div>
              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-5 sm:grid-cols-4">
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Status</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{incident.status}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Age</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{incident.age}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Alerts</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{incident.alertCount}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Noise removed</dt><dd className="mt-1 text-xs font-semibold text-violet-700">{incident.noiseRemoved}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Owner</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{incident.owner}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Business impact</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{incident.businessImpact}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">Jira status</dt><dd className="mt-1 text-xs font-semibold text-slate-700">{incident.jiraStatus}</dd></div>
                <div><dt className="text-[9px] font-bold uppercase text-slate-400">SLA</dt><dd className={`mt-1 text-xs font-semibold ${incident.sla === 'SLA Breached' ? 'text-rose-700' : incident.sla === 'SLA Approaching' ? 'text-amber-700' : 'text-emerald-700'}`}>{incident.sla}</dd></div>
              </dl>
              <Link className="mt-5 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 transition hover:border-teal-200 hover:text-teal-700" to={`/incidents/${incident.id}`}>
                Open incident detail
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
      ) : (
        <div className="flex min-h-60 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center">
          <div><CircleDashed className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-700">No {tab.toLowerCase()} incidents in this demo snapshot</p></div>
        </div>
      )}
    </section>
  );
}

export default function IncidentReviewDemo() {
  const [activeTab, setActiveTab] = useState('Incident Candidates');
  const [selectedId, setSelectedId] = useState(incidentCandidates[0].id);
  const [demoNotice, setDemoNotice] = useState('');
  const candidate = useMemo(() => incidentCandidates.find((item) => item.id === selectedId) || incidentCandidates[0], [selectedId]);

  function performDemoAction(label) {
    setDemoNotice(`Demo action selected: “${label}”. No Jira or Slack request was made.`);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Human approval workflow"
        title="Incident Review"
        description="Review actionable candidates, supporting evidence, and a proposed Jira draft before any incident is created or linked."
        actions={(
          <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">
            <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />
            {incidentCandidates.length} candidates awaiting review
          </span>
        )}
      />

      <div className="mt-8 overflow-x-auto border-b border-slate-200">
        <div className="flex min-w-max gap-6">
          {incidentTabs.map((tab) => (
            <button
              key={tab}
              className={`border-b-2 px-1 pb-3 text-sm font-semibold transition ${activeTab === tab ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-400 hover:text-slate-700'}`}
              type="button"
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'Incident Candidates' ? (
      <div className="mt-7 grid gap-6 xl:grid-cols-[330px_minmax(0,1fr)]">
        <aside className="self-start rounded-2xl border border-slate-200 bg-white p-3 xl:sticky xl:top-28" aria-label="Incident candidates">
          <div className="px-2 pb-3 pt-2">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">Actionable candidates</p>
            <p className="mt-1 text-xs text-slate-500">Select one to review its draft.</p>
          </div>
          <div className="space-y-2">
            {incidentCandidates.map((item) => (
              <button
                key={item.id}
                className={`w-full rounded-xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${selectedId === item.id ? 'border-slate-900 bg-slate-950 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-900 hover:bg-slate-50'}`}
                type="button"
                onClick={() => {
                  setSelectedId(item.id);
                  setDemoNotice('');
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-[10px] font-bold uppercase tracking-[0.12em] ${selectedId === item.id ? 'text-teal-300' : 'text-teal-700'}`}>{item.id}</span>
                  <ChevronRight className={`h-4 w-4 ${selectedId === item.id ? 'text-slate-400' : 'text-slate-300'}`} aria-hidden="true" />
                </div>
                <p className="mt-2 text-sm font-semibold leading-5">{item.title}</p>
                <div className={`mt-3 flex items-center justify-between text-xs ${selectedId === item.id ? 'text-slate-400' : 'text-slate-500'}`}>
                  <span>{item.severity}</span>
                  <span>{item.confidence}% confidence</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 space-y-6">
          {demoNotice ? (
            <div className="flex items-start justify-between gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{demoNotice}</p>
              </div>
              <button type="button" onClick={() => setDemoNotice('')} aria-label="Dismiss demo notice"><X className="h-4 w-4" /></button>
            </div>
          ) : null}

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="candidate-heading">
            <div className="border-b border-slate-200 bg-slate-50/70 p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-[0.12em] text-teal-700">{candidate.id}</span>
                    <span className="text-xs text-slate-400">Incident candidate</span>
                  </div>
                  <h2 id="candidate-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{candidate.title}</h2>
                  <p className="mt-2 text-sm text-slate-500">{candidate.service} · {candidate.environment}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <SeverityBadge severity={candidate.severity} />
                  <Confidence value={candidate.confidence} />
                </div>
              </div>
            </div>

            <div className="grid lg:grid-cols-[1.1fr_0.9fr]">
              <div className="p-6 lg:border-r lg:border-slate-200">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-violet-600" aria-hidden="true" />
                  <h3 className="text-sm font-semibold text-slate-950">AI-generated Jira draft</h3>
                  <span className="rounded-full bg-violet-50 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-violet-700">Static demo</span>
                </div>
                <div className="mt-4 space-y-4 rounded-2xl border border-violet-100 bg-violet-50/35 p-5">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Proposed Jira incident</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{candidate.proposedKey}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Summary</p>
                    <p className="mt-1.5 text-sm font-semibold leading-6 text-slate-900">{candidate.proposedSummary}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Description</p>
                    <p className="mt-1.5 text-sm leading-6 text-slate-600">{candidate.proposedDescription}</p>
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="text-sm font-semibold text-slate-950">Evidence</h3>
                  <div className="mt-3 space-y-2.5">
                    {candidate.evidence.map((item) => (
                      <div key={item} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden="true" />
                        <p className="text-xs leading-5 text-slate-600">{item}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-6 bg-[#fbfcfb] p-6">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Business impact</p>
                  <p className="mt-2 text-sm leading-6 text-slate-700">{candidate.businessImpact}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Affected context</p>
                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-200 bg-white p-3">
                      <dt className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">Service</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800">{candidate.service}</dd>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white p-3">
                      <dt className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">Environment</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800">{candidate.environment}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Related alerts</p>
                  <div className="mt-3"><SourceChips sources={candidate.relatedAlerts} /></div>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Existing Jira match</p>
                  {candidate.existingMatch ? (
                    <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-bold text-blue-700">{candidate.existingMatch.key}</p>
                          <p className="mt-1 text-sm font-semibold text-blue-950">{candidate.existingMatch.title}</p>
                        </div>
                        <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold text-blue-700">{candidate.existingMatch.similarity}% match</span>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">
                      <ShieldCheck className="h-4 w-4 text-slate-400" aria-hidden="true" />
                      No strong existing Jira match found.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-4 w-4 text-fuchsia-700" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-950">Slack context</h3>
              </div>
              <div className="mt-4 space-y-3">
                {candidate.slackContext.map((message) => (
                  <div key={`${message.author}-${message.time}`} className="rounded-2xl bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold text-slate-800">{message.author}</p>
                      <p className="text-[10px] text-slate-400">{message.time}</p>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{message.message}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-teal-200 bg-teal-50/60 p-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-teal-700">System recommendation</p>
              <p className="mt-3 text-sm font-semibold leading-6 text-teal-950">{candidate.recommendation}</p>
              <div className="mt-5 border-t border-teal-200 pt-5">
                <p className="text-xs leading-5 text-teal-800/80">Human approval is required. No Jira record will be created from this demo.</p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-label="Incident review actions">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Review actions · Demo only</p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              {actions.map(({ label, icon: Icon, primary }) => (
                <button
                  key={label}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${primary ? 'bg-slate-950 text-white hover:bg-slate-800 focus-visible:ring-slate-950' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400'}`}
                  type="button"
                  onClick={() => performDemoAction(label)}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
      ) : <IncidentRegisterPanel tab={activeTab} />}
    </div>
  );
}

import { ArrowLeft, Check, Clock3, History, Link2, ShieldAlert, Users } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { IncidentMiniChart } from '../components/operational/DemoCharts.jsx';
import { SeverityBadge, SourceChips } from '../components/operational/DemoUi.jsx';
import { openIncidents, resolvedIncidents } from '../data/dailyUpdates.js';
import { incidentRegister } from '../data/operationalDemo.js';

const expandedTimeline = [
  { time: '09:22', event: 'AppDynamics alert detected' },
  { time: '09:23', event: 'Duplicate alert grouped' },
  { time: '09:25', event: 'Grafana latency alert correlated' },
  { time: '09:27', event: 'Slack discussion started' },
  { time: '09:30', event: 'Correlation group created' },
  { time: '09:31', event: 'Engineer acknowledged' },
  { time: '09:35', event: 'Existing Jira search performed' },
  { time: '09:38', event: 'Jira incident draft approved in demo' },
  { time: '10:48', event: 'Deployment identified as change point' },
  { time: '11:12', event: 'Rollback started' },
  { time: '11:36', event: 'Metrics recovered and incident resolved' },
];

export default function IncidentDetailDemo() {
  const { incidentId } = useParams();
  const register = incidentRegister.find((incident) => incident.id === incidentId) || incidentRegister[0];
  const resolved = resolvedIncidents.find((incident) => incident.id === incidentId);
  const open = openIncidents.find((incident) => incident.id === incidentId);
  const isResolved = Boolean(resolved) || register.status === 'Resolved';
  const title = resolved?.title || open?.title || register.summary;
  const sources = resolved?.source || open?.source || register.sources;
  const people = resolved?.peopleInvolved || open?.peopleInvolved || [register.owner, register.service + ' team'];

  return (
    <div>
      <Link className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition hover:text-slate-950" to="/incidents">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Incidents
      </Link>

      <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50/70 p-6 sm:p-7">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-teal-700">Incident detail</span>
                <span className="text-xs text-slate-400">{register.id}</span>
              </div>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">{title}</h1>
              <p className="mt-2 text-sm text-slate-500">{register.service} · {register.environment}</p>
            </div>
            <div className="flex items-center gap-2">
              <SeverityBadge severity={register.severity} />
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${isResolved ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{isResolved ? 'Resolved' : register.status}</span>
            </div>
          </div>
        </div>

        <div className="grid xl:grid-cols-[1.08fr_0.92fr]">
          <div className="p-6 sm:p-7 xl:border-r xl:border-slate-200">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['First detected', resolved?.openedAt || open?.openedAt || '09:22'],
                ['Acknowledged at', '09:31'],
                ['Current owner', register.owner],
                ['Assigned team', register.service + ' team'],
                ['Business impact', register.businessImpact],
                ['Jira issue', register.jiraStatus === 'Not created' ? 'Draft only' : register.id],
                ['Alerts correlated', register.alertCount],
                ['Noise removed', register.noiseRemoved],
                ['Age / resolution time', resolved?.resolutionTime || register.age],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</p>
                  <p className="mt-1.5 text-sm font-semibold leading-5 text-slate-800">{value}</p>
                </div>
              ))}
            </div>

            {isResolved ? (
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 p-5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Resolved by</p>
                  <p className="mt-2 text-base font-semibold text-slate-950">{resolved?.resolvedBy.name || register.owner}</p>
                  <p className="mt-1 text-xs text-slate-500">{resolved?.resolvedBy.role || 'Operations engineer'}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Resolved at</p>
                  <p className="mt-2 text-base font-semibold text-slate-950">10 Aug · {resolved?.resolvedAt || '11:36'}</p>
                  <p className="mt-1 text-xs text-slate-500">Resolution time: {resolved?.resolutionTime || register.age}</p>
                </div>
              </div>
            ) : (
              <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
                <div><p className="text-sm font-semibold text-amber-950">Incident is still {register.status.toLowerCase()}.</p><p className="mt-1 text-sm leading-6 text-amber-800/80">Resolved By and final resolution fields remain empty until a human closes the incident.</p></div>
              </div>
            )}

            <dl className="mt-6 space-y-5">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5">
                <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-emerald-700">How it was resolved</dt>
                <dd className="mt-2 text-base font-semibold text-emerald-950">{resolved?.howResolved || (isResolved ? 'Rolled back deployment' : 'Pending resolution')}</dd>
              </div>
              <div><dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Resolution / action taken</dt><dd className="mt-2 text-sm leading-6 text-slate-700">{resolved?.resolutionAction || (isResolved ? 'Rolled back the affected release and validated service recovery.' : 'Investigation and remediation are still in progress.')}</dd></div>
              <div><dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Final outcome</dt><dd className="mt-2 flex items-start gap-2 text-sm leading-6 text-slate-700"><Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />{isResolved ? 'Service recovered and the incident was closed after validation.' : 'Not available until the incident is resolved.'}</dd></div>
              <div><dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Root cause</dt><dd className="mt-2 text-sm leading-6 text-slate-700">{resolved?.rootCause || 'Under investigation'}</dd></div>
              <div><dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Preventive action</dt><dd className="mt-2 text-sm leading-6 text-slate-700">Add a regression check and review capacity or recovery controls for the affected service.</dd></div>
            </dl>

            <div className="mt-6 border-t border-slate-100 pt-6">
              <div className="flex items-center gap-2"><Users className="h-4 w-4 text-slate-400" /><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">People involved</p></div>
              <p className="mt-1 text-xs text-slate-500">Separate from the current owner and the person who resolved it.</p>
              <div className="mt-3 flex flex-wrap gap-2">{people.map((person) => <span key={person} className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">{person}</span>)}</div>
            </div>
          </div>

          <div className="bg-[#fbfcfb] p-6 sm:p-7">
            <div className="flex items-center gap-2"><History className="h-4 w-4 text-slate-400" /><h2 className="text-sm font-semibold text-slate-950">Activity Timeline</h2></div>
            <div className="relative mt-6 space-y-4 pl-7">
              <span className="absolute bottom-2 left-[5px] top-2 w-px bg-slate-200" aria-hidden="true" />
              {expandedTimeline.map((item, index) => (
                <div key={`${item.time}-${item.event}`} className="relative">
                  <span className={`absolute -left-7 top-1 h-2.5 w-2.5 rounded-full border-2 border-[#fbfcfb] ring-1 ${index === expandedTimeline.length - 1 && isResolved ? 'bg-emerald-500 ring-emerald-200' : 'bg-slate-300 ring-slate-200'}`} />
                  <p className="text-[10px] font-bold text-slate-400">{item.time}</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600">{item.event}</p>
                </div>
              ))}
            </div>

            <IncidentMiniChart />

            <div className="mt-6 border-t border-slate-200 pt-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Systems involved</p>
              <div className="mt-3"><SourceChips sources={sources} /></div>
            </div>
            <div className="mt-6 rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="flex items-start gap-3"><Link2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" /><div><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-blue-700">Correlation result</p><p className="mt-1.5 text-sm font-semibold leading-6 text-blue-950">{register.alertCount} alerts grouped into 1 incident; {register.noiseRemoved} duplicate or correlated signals removed.</p></div></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

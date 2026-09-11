import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Database, PlugZap, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/operational/DemoUi.jsx';
import { integrationHealth } from '../data/operationalDemo.js';

const statusStyles = {
  Connected: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  Ready: 'border-blue-200 bg-blue-50 text-blue-700',
  'Not Connected': 'border-slate-200 bg-slate-50 text-slate-600',
  Delayed: 'border-amber-200 bg-amber-50 text-amber-700',
  Error: 'border-rose-200 bg-rose-50 text-rose-700',
};

const iconStyles = {
  fuchsia: 'bg-fuchsia-50 text-fuchsia-700',
  blue: 'bg-blue-50 text-blue-700',
  orange: 'bg-orange-50 text-orange-700',
  violet: 'bg-violet-50 text-violet-700',
  rose: 'bg-rose-50 text-rose-700',
  sky: 'bg-sky-50 text-sky-700',
};

const activeIntegrations = integrationHealth.filter((source) => source.name !== 'ThousandEyes');

export default function IntegrationsDemo() {
  return (
    <div>
      <PageHeader
        eyebrow="Source readiness"
        title="Integrations"
        description="Static connection states and source-specific field plans for Slack, Jira, and future monitoring systems. No API credentials are used by this demo."
        actions={(
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-500">
            <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
            Demo statuses only
          </span>
        )}
      />

      <section className="mt-9" aria-labelledby="source-health-heading">
        <div className="mb-5">
          <h2 id="source-health-heading" className="text-xl font-semibold tracking-tight text-slate-950">Source Health</h2>
          <p className="mt-1.5 text-sm text-slate-500">Mock ingestion freshness, retry state, and record volume.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {activeIntegrations.map((source) => (
            <article key={source.name} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-slate-900">{source.name}</p>
                <span className={`h-2.5 w-2.5 rounded-full ${source.health === 'Delayed' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              </div>
              <p className={`mt-2 text-[10px] font-bold uppercase tracking-[0.1em] ${source.health === 'Delayed' ? 'text-amber-600' : 'text-emerald-600'}`}>{source.health}</p>
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-[10px] text-slate-500">
                <div className="flex justify-between gap-2"><span>Last sync</span><span className="font-semibold text-slate-700">{source.lastSync}</span></div>
                <div className="flex justify-between gap-2"><span>Records</span><span className="font-semibold text-slate-700">{source.recordsReceived}</span></div>
                <div className="flex justify-between gap-2"><span>Retry</span><span className="truncate font-semibold text-slate-700">{source.retryStatus}</span></div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-10 grid gap-5 lg:grid-cols-2 xl:grid-cols-3" aria-label="Integration details">
        {activeIntegrations.map((source) => (
          <article key={source.name} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-xs font-bold ${iconStyles[source.tone]}`}>{source.initials}</span>
                <div>
                  <h2 className="text-base font-semibold text-slate-950">{source.name}</h2>
                  <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{source.phase}</p>
                </div>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusStyles[source.status]}`}>{source.status}</span>
            </div>
            <p className="mt-5 text-sm leading-6 text-slate-600">{source.description}</p>

            <dl className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-slate-50 p-3">
                <dt className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400"><Clock3 className="h-3 w-3" />Last sync</dt>
                <dd className="mt-1.5 text-xs font-semibold text-slate-700">{source.lastSync}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <dt className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400"><Database className="h-3 w-3" />Records</dt>
                <dd className="mt-1.5 text-xs font-semibold text-slate-700">{source.recordsReceived}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <dt className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400"><RefreshCw className="h-3 w-3" />Ingestion</dt>
                <dd className="mt-1.5 text-xs font-semibold text-slate-700">{source.ingestionStatus}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <dt className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">Last error</dt>
                <dd className={`mt-1.5 truncate text-xs font-semibold ${source.lastError === 'None' ? 'text-slate-700' : 'text-amber-700'}`}>{source.lastError}</dd>
              </div>
            </dl>

            <div className="mt-5 border-t border-slate-100 pt-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Planned source fields</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {source.placeholderFields.map((field) => (
                  <span key={field} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold text-slate-600">{field}</span>
                ))}
              </div>
            </div>

            <button className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-400" type="button" disabled>
              <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />
              Configure after frontend freeze
            </button>
          </article>
        ))}
      </section>

      <aside className="mt-8 flex items-start gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-5 text-sm text-slate-500">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        All connection states, sync times, record counts, and errors are mock values. No credentials, tokens, or external requests are present in this frontend.
      </aside>
    </div>
  );
}

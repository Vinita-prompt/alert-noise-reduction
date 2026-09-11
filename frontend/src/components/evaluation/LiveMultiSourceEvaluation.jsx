import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, CircleHelp, Database,
  ExternalLink, Filter, Network, RefreshCw, Search, ShieldAlert, ShieldCheck,
  Siren, UserCheck, X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  getCurrentUser,
  getEvaluationEpisodeDiagnostics,
  getGoldReviewQueue,
  getLiveEvaluationCandidates,
  getLiveEvaluationConnectivity,
  getLiveShadowEvaluation,
  getMlPrediction,
  getPopulationReconciliation,
  loginCurrentUser,
  logoutCurrentUser,
  getModelPerformance,
  runLiveShadowEvaluation,
} from '../../services/api.js';

const PAGE_SIZE = 25;
const SOURCE_NAMES = ['AppDynamics', 'Grafana', 'Nagios'];
const SOURCE_TONES = {
  AppDynamics: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  Grafana: 'border-orange-200 bg-orange-50 text-orange-700',
  Nagios: 'border-violet-200 bg-violet-50 text-violet-700',
  'ACC Jira': 'border-blue-200 bg-blue-50 text-blue-700',
  Slack: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700',
};
const STATUS_TONES = {
  CONNECTED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  PARTIAL: 'border-amber-200 bg-amber-50 text-amber-700',
  NOISE: 'border-sky-200 bg-sky-50 text-sky-800',
  INCIDENT: 'border-rose-200 bg-rose-50 text-rose-800',
  NEEDS_REVIEW: 'border-amber-200 bg-amber-50 text-amber-800',
  UNCONFIRMED: 'border-slate-200 bg-slate-50 text-slate-600',
  CONFIRMED_NOISE: 'border-sky-200 bg-sky-50 text-sky-800',
  CONFIRMED_INCIDENT: 'border-rose-200 bg-rose-50 text-rose-800',
  UNKNOWN: 'border-slate-300 bg-slate-100 text-slate-700',
  NOT_READY: 'border-slate-200 bg-slate-100 text-slate-700',
  SHADOW: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  UNAVAILABLE: 'border-rose-200 bg-rose-50 text-rose-700',
  EVIDENCE_READY: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  MAPPING_PARTIAL: 'border-amber-200 bg-amber-50 text-amber-700',
  RESOLVED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  COMPLETE: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  EVALUABLE: 'border-blue-200 bg-blue-50 text-blue-700',
  NOT_EVALUABLE: 'border-amber-200 bg-amber-50 text-amber-700',
  API_UNAVAILABLE: 'border-rose-200 bg-rose-50 text-rose-700',
  SOURCE_API_UNAVAILABLE: 'border-rose-200 bg-rose-50 text-rose-700',
  MISSING: 'border-amber-200 bg-amber-50 text-amber-700',
};

const readable = (value) => {
  const raw = String(value ?? '');
  const normalized = raw === 'NO_ACCEPTED_SOURCE_MAPPING' ? 'GRAFANA_ALERT_MAPPING_UNRESOLVED'
    : raw === 'NEEDS_REVIEW' ? 'INSUFFICIENT_EVIDENCE' : raw;
  return normalized.replaceAll('_', ' ');
};
const formatNumber = (value) => new Intl.NumberFormat('en-US').format(Number(value || 0));

function presentationFailure(source, value) {
  const raw = String(value || '');
  const normalized = raw.toUpperCase();
  if (source === 'Grafana' && normalized.includes('GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED')) {
    return 'GRAFANA_EXTERNAL_INSTANCE_UNAVAILABLE';
  }
  if (source === 'Grafana' && normalized.includes('NO_ACCEPTED_SOURCE_MAPPING')) {
    return 'GRAFANA_ALERT_MAPPING_UNRESOLVED';
  }
  if (source === 'Nagios' && ['SOURCE_ERROR', 'SOURCE_CIRCUIT_OPEN', 'SOURCE_TIMEOUT', 'DNS'].some((code) => normalized.includes(code))) {
    return 'NAGIOS_SOURCE_UNAVAILABLE';
  }
  return raw;
}

function formatDate(value, includeDate = true) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', includeDate
    ? { day: '2-digit', hour: '2-digit', minute: '2-digit', month: 'short', year: 'numeric' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function formatDuration(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const seconds = Math.max(0, Math.round(Number(value)));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const formatOptionalDate = (value, includeDate = true) => value ? formatDate(value, includeDate) : null;

function Badge({ value, tone }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] ${tone || STATUS_TONES[value] || 'border-slate-200 bg-white text-slate-600'}`}>{readable(value)}</span>;
}

function DecisionBadge({ value }) {
  const Icon = value === 'INCIDENT' ? Siren : value === 'NOISE' ? ShieldCheck : AlertTriangle;
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] ${STATUS_TONES[value] || STATUS_TONES.NEEDS_REVIEW}`}><Icon className="h-3 w-3" aria-hidden="true" />{readable(value || 'INSUFFICIENT_EVIDENCE')}</span>;
}

function Kpi({ icon: Icon, label, value, helper, tone = 'blue' }) {
  const tones = { blue: 'bg-blue-50 text-blue-700', amber: 'bg-amber-50 text-amber-700', emerald: 'bg-emerald-50 text-emerald-700', rose: 'bg-rose-50 text-rose-700', slate: 'bg-slate-100 text-slate-700' };
  return <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">{helper}</p></div><span className={`rounded-xl p-2 ${tones[tone]}`}><Icon className="h-4 w-4" /></span></div></article>;
}

function HelpTip({ text }) {
  return <span className="group relative inline-flex">
    <button className="rounded-full text-slate-400 outline-none transition hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-blue-400" type="button" aria-label={text} title={text}><CircleHelp className="h-3.5 w-3.5" /></button>
    <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-56 -translate-x-1/2 rounded-lg bg-slate-950 px-3 py-2 text-[10px] font-medium normal-case leading-4 tracking-normal text-white shadow-lg group-hover:block group-focus-within:block" role="tooltip">{text}</span>
  </span>;
}

function DecisionQualityOverview({ summary, episodeDiagnostics }) {
  const noise = summary?.noiseBreakdown || {};
  const observed = summary?.observedBehavior || {};
  const changes = summary?.decisionChanges || {};
  const noiseEpisodes = episodeDiagnostics?.episodeDecisions?.noise;
  const nonActionable = Number(noise.nonActionable || 0) + Number(noise.operationallyNonActionable || 0);
  const observedNonActionable = Number(observed.nonActionable || 0) + Number(observed.operationallyNonActionable || 0);
  const noiseRows = [
    { label: 'Repeat Notification', value: noise.repeat, helper: 'Redundant notification in an existing episode', help: 'Additional notification belonging to an already represented alert episode.' },
    { label: 'Auto-resolved', value: noise.autoResolved, observed: observed.autoResolved },
    { label: 'Flapping', value: noise.flapping, observed: observed.flapping },
    { label: 'Duplicate', value: noise.duplicate, observed: observed.duplicate },
    { label: 'Correlated', value: noise.correlated, observed: observed.correlated },
    { label: 'Non-actionable', value: nonActionable, observed: observedNonActionable },
    { label: 'Informational', value: noise.informationalPriority, helper: 'Informational-priority notification' },
    { label: 'Stale', value: noise.stale, observed: observed.stale },
  ];
  const noiseBreakdownTotal = noiseRows.reduce((total, item) => total + Number(item.value || 0), 0);
  const totalNoiseNotifications = Number(summary?.noise || 0);
  const showAccountingWarning = Boolean(summary)
    && noiseBreakdownTotal !== totalNoiseNotifications
    && (import.meta.env.DEV || import.meta.env.VITE_READ_ONLY_VALIDATION === 'true');
  const changeRows = [
    ['Incident → Noise', changes.incidentToNoise],
    ['Incident → Review', changes.incidentToReview],
    ['Review → Incident', changes.reviewToIncident],
    ['Review → Noise', changes.reviewToNoise],
    ['Noise → Incident', changes.noiseToIncident],
    ['Noise → Review', changes.noiseToReview],
  ];
  return <section className="grid gap-4 lg:grid-cols-2" aria-label="Phase 14 monitoring lifecycle summary">
    <article className="rounded-2xl border border-sky-100 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-1.5"><h2 className="text-sm font-semibold text-slate-950">Noise breakdown</h2><HelpTip text="Noise includes noisy primary episodes and redundant notifications belonging to existing episodes." /></div><p className="mt-1 text-[10px] text-slate-500">{formatNumber(totalNoiseNotifications)} noisy notifications across {noiseEpisodes === null || noiseEpisodes === undefined ? '—' : formatNumber(noiseEpisodes)} Noise episodes</p></div><Badge value={`${formatNumber(totalNoiseNotifications)} NOISE NOTIFICATIONS`} tone={STATUS_TONES.NOISE} /></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">{noiseRows.map((item) => <div key={item.label} className="min-h-[96px] rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="text-lg font-semibold text-slate-950">{formatNumber(item.value)}</p><div className="mt-1 flex items-center gap-1"><p className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-500">{item.label}</p>{item.help ? <HelpTip text={item.help} /> : null}</div><p className="mt-1 text-[9px] leading-4 text-slate-400">{item.helper || `${formatNumber(item.observed)} observed`}</p></div>)}</div>
      {showAccountingWarning ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-semibold text-amber-800" role="status">Noise breakdown does not reconcile with total Noise.</p> : null}
    </article>
    <article className="rounded-2xl border border-indigo-100 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-950">Decision changes from Phase 13</h2><p className="mt-1 text-[10px] text-slate-500">Append-only comparison under PHASE14_MONITORING_LIFECYCLE_V1</p></div><Badge value="AUDITED" tone="border-indigo-200 bg-indigo-50 text-indigo-700" /></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">{changeRows.map(([label, value]) => <div key={label} className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="text-lg font-semibold text-slate-950">{formatNumber(value)}</p><p className="mt-1 text-[9px] font-bold uppercase leading-4 tracking-[0.06em] text-slate-500">{label}</p></div>)}</div>
    </article>
  </section>;
}

function parentPercentage(value, parent) {
  return parent ? `${((Number(value || 0) / Number(parent)) * 100).toFixed(1)}% of previous stage` : '—';
}

function PopulationOverview({ population, loading }) {
  const funnel = population?.funnel || {};
  const sources = population?.sourceBreakdown || {};
  const comparison = population?.comparison || {};
  const window = population?.window || {};
  const stages = [
    ['24H Alerts', funnel.total24h, funnel.total24h],
    ['Supported', funnel.supportedMonitoring, funnel.total24h],
    ['Source resolved', funnel.sourceResolved, funnel.supportedMonitoring],
    ['Technical evidence complete', funnel.technicalEvidenceComplete, funnel.supportedMonitoring],
    ['Evaluable', funnel.evaluable, funnel.technicalEvidenceComplete],
    ['Gold Review', funnel.goldReviewEligible, funnel.evaluable],
    ['Reviewed', funnel.reviewed, funnel.goldReviewEligible],
  ];
  return <div className="space-y-4">
    <section className="rounded-2xl border border-blue-100 bg-white p-5 shadow-sm" aria-label="Exact rolling population window">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div><p className="text-[9px] font-bold uppercase tracking-[0.14em] text-blue-700">Rolling window · {window.timeZone || 'Asia/Kolkata'}</p><div className="mt-3 flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-950"><span>{window.startDisplay || '—'}</span><ArrowRight className="h-4 w-4 text-slate-300" /><span>{window.endDisplay || '—'}</span></div><p className="mt-2 text-[10px] text-slate-500">UTC: {window.start || '—'} → {window.end || '—'} · membership uses Operations created/received time</p></div>
        <div className="text-left lg:text-right"><Badge value={population?.provenance?.status || 'LOADING'} /><p className="mt-2 text-[10px] text-slate-500">{population?.livePagination?.pageCount || 0} Operations page(s) · {comparison.duplicateCanonicalIds || 0} canonical duplicate(s)</p></div>
      </div>
      {population?.provenance?.warning ? <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-800">{population.provenance.warning}</p> : null}
    </section>
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7" aria-label="Authoritative population funnel cards">
      <Kpi icon={Database} label="24H Alerts" value={loading ? '—' : formatNumber(funnel.total24h)} helper="All authoritative Operations occurrences" />
      <Kpi icon={Network} label="Supported Monitoring" value={loading ? '—' : formatNumber(funnel.supportedMonitoring)} helper={parentPercentage(funnel.supportedMonitoring, funnel.total24h)} tone="slate" />
      <Kpi icon={ShieldCheck} label="Source resolved" value={loading ? '—' : `${formatNumber(funnel.sourceResolved)} / ${formatNumber(funnel.supportedMonitoring)}`} helper={parentPercentage(funnel.sourceResolved, funnel.supportedMonitoring)} tone="emerald" />
      <Kpi icon={Activity} label="Source Evidence Complete" value={loading ? '—' : `${formatNumber(funnel.technicalEvidenceComplete)} / ${formatNumber(funnel.supportedMonitoring)}`} helper={parentPercentage(funnel.technicalEvidenceComplete, funnel.supportedMonitoring)} tone="emerald" />
      <Kpi icon={ShieldAlert} label="Evaluable alerts" value={loading ? '—' : formatNumber(funnel.evaluable)} helper={parentPercentage(funnel.evaluable, funnel.technicalEvidenceComplete)} tone="blue" />
      <Kpi icon={AlertTriangle} label="Gold Review Eligible" value={loading ? '—' : formatNumber(funnel.goldReviewEligible)} helper={parentPercentage(funnel.goldReviewEligible, funnel.evaluable)} tone="amber" />
      <Kpi icon={Siren} label="Reviewed" value={loading ? '—' : formatNumber(funnel.reviewed)} helper={`${formatNumber(funnel.unreviewed)} eligible remain unreviewed`} tone="rose" />
    </section>
    <p className="text-[10px] leading-5 text-slate-500">Source resolved, Technical evidence complete, and Evaluable alerts are nested funnel stages. Source unresolved, Source API unavailable, and Evidence missing remain explicit, overlapping measures in the population diagnostics below.</p>
    <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-950">24-hour source breakdown</h2><p className="mt-1 text-[10px] text-slate-500">Same authoritative rolling population</p></div><Badge value={`${formatNumber(funnel.total24h)} TOTAL`} /></div><div className="mt-4 grid grid-cols-2 gap-2">{[['AppDynamics', sources.AppDynamics], ['Grafana', sources.Grafana], ['Nagios', sources.Nagios], ['Other', sources.Other], ['Unsupported', sources.Unsupported], ['Unknown', sources.Unknown]].map(([label, value]) => <div key={label} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-[11px]"><span className="font-semibold text-slate-600">{label}</span><strong className="text-slate-950">{formatNumber(value)}</strong></div>)}</div></article>
      <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-950">Population funnel</h2><p className="mt-1 text-[10px] text-slate-500">Every downstream count is measured from the full Operations population</p></div><Badge value="READ ONLY" /></div><div className="mt-4 grid gap-2 sm:grid-cols-7">{stages.map(([label, value, parent], index) => <div key={label} className="relative rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="text-lg font-semibold text-slate-950">{loading ? '—' : formatNumber(value)}</p><p className="mt-1 text-[9px] font-bold uppercase leading-4 text-slate-500">{label}</p><p className="mt-1 text-[8px] text-slate-400">{index === 0 ? 'Authoritative total' : parentPercentage(value, parent)}</p>{index < stages.length - 1 ? <ArrowRight className="absolute -right-2.5 top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-slate-300 sm:block" /> : null}</div>)}</div><div className="mt-4 grid gap-2 text-[10px] text-slate-500 sm:grid-cols-3"><p>Live / stored: <strong className="text-slate-700">{comparison.liveCount ?? 'Unavailable'} / {formatNumber(comparison.storedCount)}</strong></p><p>Missing local / local only: <strong className="text-slate-700">{comparison.missingLocally ?? '—'} / {comparison.localOnly ?? '—'}</strong></p><p>Entered / left / net: <strong className="text-slate-700">{population?.drift?.available ? `${population.drift.entered} / ${population.drift.left} / ${population.drift.net}` : 'No previous snapshot'}</strong></p></div></article>
    </section>
  </div>;
}

function PopulationAudit({ initialPopulation }) {
  const [filters, setFilters] = useState({ page: 1, source: '', supported: '', sourceResolution: '', evidence: '', evaluable: '', gold: '', blocker: '' });
  const [result, setResult] = useState(initialPopulation);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const filterKey = JSON.stringify(filters);
  useEffect(() => { if (!Object.values(filters).some((value) => value !== '' && value !== 1)) setResult(initialPopulation); }, [initialPopulation, filterKey]);
  useEffect(() => {
    if (!Object.values(filters).some((value) => value !== '' && value !== 1)) return undefined;
    let active = true;
    setLoading(true);
    getPopulationReconciliation({ ...filters, pageSize: 25 }).then((value) => { if (active) setResult(value); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterKey]);
  const setFilter = (name, value) => setFilters((current) => ({ ...current, [name]: value, page: name === 'page' ? value : 1 }));
  const pagination = result?.pagination || { page: 1, totalPages: 0, totalRecords: 0 };
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Full 24-hour population audit">
    <div className="border-b border-slate-100 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-950">Full 24-hour population audit</h2><p className="mt-1 text-[11px] text-slate-500">{formatNumber(pagination.totalRecords)} Operations occurrences match these diagnostics · no alert is reviewed or changed here</p></div><Badge value="DIAGNOSTIC · READ ONLY" /></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-7"><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.source} onChange={(event) => setFilter('source', event.target.value)}><option value="">All sources</option>{[...SOURCE_NAMES, 'Unsupported', 'Unknown'].map((value) => <option key={value}>{value}</option>)}</select><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.supported} onChange={(event) => setFilter('supported', event.target.value)}><option value="">Supported + unsupported</option><option value="true">Supported</option><option value="false">Unsupported / unknown</option></select><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.sourceResolution} onChange={(event) => setFilter('sourceResolution', event.target.value)}><option value="">All resolution states</option><option value="RESOLVED">Resolved</option><option value="UNRESOLVED">Unresolved</option><option value="NOT_APPLICABLE">Not applicable</option></select><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.evidence} onChange={(event) => setFilter('evidence', event.target.value)}><option value="">All evidence states</option><option value="COMPLETE">Complete</option><option value="INCOMPLETE">Incomplete</option></select><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.evaluable} onChange={(event) => setFilter('evaluable', event.target.value)}><option value="">Evaluable + not</option><option value="true">Evaluable</option><option value="false">Not evaluable</option></select><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.gold} onChange={(event) => setFilter('gold', event.target.value)}><option value="">All gold states</option><option value="true">Gold eligible</option><option value="false">Not gold eligible</option></select><select className="h-9 rounded-lg border border-slate-200 px-2 text-[10px]" value={filters.blocker} onChange={(event) => setFilter('blocker', event.target.value)}><option value="">All blockers</option>{Object.keys(initialPopulation?.exclusionReasons || {}).sort().map((value) => <option key={value}>{value}</option>)}</select></div>
    </div>
    <div className="overflow-x-auto"><table className="w-full min-w-[1060px] text-left"><thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500"><tr>{['Alert', 'Created', 'Original Source', 'Canonical Source', 'Supported', 'Source Resolution', 'Evidence', 'Evaluable', 'Gold Review', 'Blockers'].map((heading) => <th key={heading} className="border-b border-slate-200 px-3 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{(result?.records || []).map((record) => <tr key={record.canonicalAlertId} className="align-top hover:bg-blue-50/30"><td className="px-3 py-3"><button className="text-left text-[10px] font-bold text-blue-700 hover:underline" type="button" onClick={() => setSelected(record)}>{record.displayId || record.canonicalAlertId}</button><p className="mt-1 max-w-[220px] text-[10px] leading-4 text-slate-700">{record.title}</p></td><td className="whitespace-nowrap px-3 py-3 text-[9px] text-slate-600">{formatDate(record.createdAt)}</td><td className="px-3 py-3 text-[10px] text-slate-600">{record.originalSource || 'Unknown'}</td><td className="px-3 py-3"><Badge value={record.canonicalSource || 'UNKNOWN'} tone={SOURCE_TONES[record.canonicalSource]} /></td><td className="px-3 py-3"><Badge value={record.supported ? 'SUPPORTED' : 'UNSUPPORTED'} /></td><td className="px-3 py-3"><Badge value={record.sourceResolutionStatus} /></td><td className="px-3 py-3"><Badge value={record.technicalEvidenceStatus} /></td><td className="px-3 py-3"><Badge value={record.evaluable ? 'EVALUABLE' : 'NOT_EVALUABLE'} /></td><td className="px-3 py-3"><Badge value={record.goldReviewEligible ? (record.reviewed ? 'REVIEWED' : 'ELIGIBLE') : 'NOT_ELIGIBLE'} /></td><td className="px-3 py-3"><div className="flex max-w-[240px] flex-wrap gap-1">{(record.blockerCodes || []).slice(0, 3).map((value) => <Badge key={value} value={value} />)}</div></td></tr>)}</tbody></table></div>
    {!loading && !(result?.records || []).length ? <div className="p-10 text-center text-xs text-slate-500">No population records match these filters.</div> : null}{loading ? <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-500"><RefreshCw className="h-3.5 w-3.5 animate-spin" />Filtering authoritative population…</div> : null}
    <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4"><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold disabled:opacity-40" type="button" disabled={pagination.page <= 1 || loading} onClick={() => setFilter('page', pagination.page - 1)}>Previous</button><p className="text-[10px] text-slate-500">Page {pagination.page} of {Math.max(1, pagination.totalPages)}</p><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold disabled:opacity-40" type="button" disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setFilter('page', pagination.page + 1)}>Next</button></div>
    {selected ? <div className="border-t border-blue-100 bg-blue-50/40 p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-[9px] font-bold uppercase tracking-[0.14em] text-blue-700">Population record</p><h3 className="mt-2 text-sm font-semibold text-slate-950">{selected.displayId || selected.canonicalAlertId} · {selected.title}</h3></div><button className="rounded-lg border border-slate-200 bg-white p-2" type="button" onClick={() => setSelected(null)} aria-label="Close population record"><X className="h-4 w-4" /></button></div><dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Field label="Canonical Operations ID" value={selected.canonicalAlertId} /><Field label="Population timestamp" value={selected.createdAt} /><Field label="Timestamp field" value={selected.populationTimestampField} /><Field label="Original source" value={selected.originalSource} /><Field label="Canonical source" value={selected.canonicalSource} /><Field label="Source resolution" value={selected.sourceResolutionStatus} /><Field label="Technical evidence" value={selected.technicalEvidenceStatus} /><Field label="Evaluability" value={selected.evaluable ? 'EVALUABLE' : 'NOT_EVALUABLE'} /><Field label="Gold review eligibility" value={selected.goldReviewEligible ? 'ELIGIBLE' : 'NOT_ELIGIBLE'} /><Field label="Current outcome" value={selected.currentOutcome} /><Field label="Blockers" value={selected.blockerCodes} /></dl></div> : null}
  </section>;
}

function canRecordOutcomes(authentication) {
  const roles = (authentication?.user?.roles || []).map((value) => String(value).toLowerCase());
  const permissions = (authentication?.user?.permissions || []).map((value) => String(value).toLowerCase());
  return Boolean(authentication?.authenticated && (
    roles.some((role) => ['operator', 'incident_manager', 'admin'].includes(role))
    || permissions.includes('outcomes:write')
  ));
}

function GoldReviewAuthentication({ authentication, onAuthenticationChanged }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const canWrite = canRecordOutcomes(authentication);

  async function signIn(event) {
    event.preventDefault();
    setSubmitting(true); setError('');
    try {
      const result = await loginCurrentUser({ email: email.trim(), password });
      setPassword('');
      await onAuthenticationChanged(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    setSubmitting(true); setError('');
    try {
      await logoutCurrentUser();
      setPassword('');
      await onAuthenticationChanged(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return <section className="rounded-2xl border border-blue-100 bg-white p-4 shadow-sm" aria-label="Gold Review authentication">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-blue-700">Gold Review access</p>
        {authentication?.authenticated ? <><p className="mt-2 text-sm font-semibold text-slate-950">{authentication.user.name}</p><p className="mt-0.5 text-[11px] text-slate-500">{authentication.user.email}</p></> : <p className="mt-2 text-xs font-semibold text-slate-700">Reviewer sign-in required</p>}
      </div>
      {authentication?.authenticated ? <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold text-slate-600 disabled:opacity-50" type="button" disabled={submitting} onClick={signOut}>Sign out</button> : null}
    </div>
    <div className={`mt-3 rounded-xl border p-3 text-[11px] leading-5 ${canWrite ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
      <p className="font-semibold">{canWrite ? 'Authorized to record reviewed outcomes' : 'Outcome capture is fail-closed'}</p>
      <p>{canWrite ? 'Verified operator session with outcomes:write access.' : authentication?.reason || (authentication?.authenticated ? 'This account does not have the required role or permission.' : 'Sign in with the configured local development reviewer.')}</p>
    </div>
    {!authentication?.authenticated && authentication?.loginAvailable ? <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={signIn}>
      <input className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-blue-400" type="email" autoComplete="username" placeholder="Reviewer email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      <input className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-blue-400" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <button className="h-10 rounded-lg bg-slate-950 px-4 text-xs font-bold text-white disabled:opacity-50" disabled={submitting} type="submit">{submitting ? 'Signing in…' : 'Sign in'}</button>
    </form> : null}
    {error ? <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p> : null}
  </section>;
}

function sourceStatus(checks, source, coverage = null) {
  const relevant = checks.filter((item) => item.source === source);
  if (!relevant.length) return 'UNAVAILABLE';
  if (relevant.every((item) => item.status === 'CONNECTED')) {
    if (coverage?.totalAlerts && coverage.technicalEvidenceComplete === coverage.totalAlerts) return 'EVIDENCE_READY';
    if (coverage?.totalAlerts && (coverage.sourceResolved < coverage.totalAlerts || coverage.technicalEvidenceComplete < coverage.totalAlerts)) return 'MAPPING_PARTIAL';
    return 'CONNECTED';
  }
  if (relevant.some((item) => item.status === 'CONNECTED')) return 'PARTIAL';
  return 'UNAVAILABLE';
}

function SourceStatus({ checks = [], coverage = [], loading, onRefresh }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Source status</p><div className="mt-2 flex flex-wrap gap-2">{SOURCE_NAMES.map((source) => { const sourceCoverage = coverage.find((item) => item.source === source); return <span key={source} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><span className="text-[10px] font-semibold text-slate-700">{source}</span><Badge value={sourceStatus(checks, source, sourceCoverage)} /></span>; })}</div></div><button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-[10px] font-bold text-slate-700 disabled:opacity-50" type="button" disabled={loading} onClick={onRefresh}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Check sources</button></div></section>;
}

function Field({ label, value }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null;
  if (['History transitions', 'Transitions'].includes(label) && Array.isArray(value)) {
    return <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 sm:col-span-2"><dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{label} · {value.length}</dt><dd className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">{value.map((item, index) => <div key={`${item.timestamp || 'transition'}-${index}`} className="grid gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] text-slate-700 sm:grid-cols-[9rem_1fr]"><span className="font-semibold text-slate-500">{formatOptionalDate(item.timestamp)}</span><span><strong>{readable(item.previousState || item.from || 'Initial')}</strong> → <strong>{readable(item.state || item.to)}</strong>{item.reason ? ` · ${item.reason}` : ''}</span></div>)}</dd></div>;
  }
  const displayed = typeof value === 'object' ? JSON.stringify(value) : readable(value);
  return <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"><dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</dt><dd className="mt-1 break-words text-xs font-semibold leading-5 text-slate-800">{displayed}</dd></div>;
}

function Section({ title, helper, children }) {
  return <section className="border-t border-slate-100 py-6 first:border-0 first:pt-0"><div className="mb-3"><h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">{title}</h3>{helper ? <p className="mt-1 text-[10px] leading-4 text-slate-500">{helper}</p> : null}</div>{children}</section>;
}

function DimensionCard({ label, value, detail }) {
  return <article className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</p><Badge value={value || 'UNKNOWN'} /></div><p className="mt-3 text-[11px] leading-5 text-slate-700">{detail?.reason || 'No evidence-backed explanation is available.'}</p>{detail?.evidenceIds?.length ? <p className="mt-2 text-[9px] font-semibold text-slate-400">{formatNumber(detail.evidenceIds.length)} evidence reference(s)</p> : null}</article>;
}

function scoreValue(value) {
  return value === null || value === undefined ? 'INCOMPLETE' : Number(value).toFixed(2);
}

function GrafanaEvidenceSections({ completeness, sourceResolution }) {
  const fields = completeness.fields || {};
  const alerting = fields.grafanaAlerting || {};
  const irm = fields.grafanaIrm || {};
  const showAlerting = fields.ruleUid || fields.state || fields.grafanaAlertingResolved;
  const showIrm = Boolean(irm.resolved || irm.alertGroups?.length || irm.incidents?.length || irm.tasks?.length
    || irm.schedules?.length || irm.escalations?.length || irm.integrations?.length || irm.insights);
  const showDashboard = Boolean(fields.dashboardUid || fields.panelId || fields.grafanaDashboardResolved || fields.grafanaPanelEvidence);
  return <>
    {showAlerting ? <Section title="Grafana Alerting" helper="Authoritative rule, occurrence history, notification routing, and matching silence context. Silence remains evidence only and does not determine the alert outcome.">
      <div className="mb-3 flex flex-wrap gap-2"><Badge value={fields.grafanaAlertingResolved ? 'RESOLVED' : 'MISSING'} /><Badge value={fields.state} /><Badge value={alerting.silenceState} /></div>
      <dl className="grid gap-2 sm:grid-cols-2"><Field label="Grafana instance" value={fields.instance} /><Field label="Rule UID" value={fields.ruleUid} /><Field label="Rule name" value={fields.ruleName} /><Field label="Rule group" value={fields.ruleGroup} /><Field label="Folder" value={fields.folder} /><Field label="Occurrence state" value={fields.state} /><Field label="State observed at" value={formatOptionalDate(fields.stateObservedAt)} /><Field label="State source" value={fields.stateSource} /><Field label="Evaluation result" value={fields.evaluationResult} /><Field label="Condition / threshold" value={fields.threshold || fields.condition} /><Field label="History transitions" value={alerting.history} /><Field label="Notification receiver" value={alerting.notification?.receiver} /><Field label="Notification grouping" value={alerting.notification?.groupBy} /><Field label="Repeat interval" value={alerting.notification?.repeatInterval} /><Field label="Contact point types" value={alerting.notification?.contactPoints?.map((item) => item.type).filter(Boolean)} /><Field label="Matching silences" value={alerting.silences} /><Field label="No-data observed" value={fields.noDataObserved === true ? 'Yes' : fields.noDataObserved === false ? 'No' : null} /><Field label="Recovered" value={fields.recovered === true ? 'Yes' : fields.recovered === false ? 'No' : null} /><Field label="Recovered at" value={formatOptionalDate(fields.recoveredAt)} /><Field label="Source event time" value={formatOptionalDate(completeness.sourceEventTime)} /><Field label="Evidence retrieved at" value={formatOptionalDate(completeness.retrievedAt)} /></dl>
      {fields.deepLink || sourceResolution.deepLink ? <a className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-[10px] font-bold text-orange-800" href={fields.deepLink || sourceResolution.deepLink} target="_blank" rel="noreferrer">Open Grafana Rule<ExternalLink className="h-3 w-3" /></a> : null}
    </Section> : null}
    {showIrm ? <Section title="Grafana IRM" helper="Related operational group, incident, task, escalation, and integration context only. These relationships do not change the alert decision.">
      <dl className="grid gap-2 sm:grid-cols-2"><Field label="Alert groups" value={irm.alertGroups} /><Field label="Incidents" value={irm.incidents} /><Field label="Tasks" value={irm.tasks} /><Field label="Schedules" value={irm.schedules} /><Field label="Escalations" value={irm.escalations} /><Field label="Integrations" value={irm.integrations} /><Field label="Insights" value={irm.insights} /><Field label="Evidence retrieved at" value={formatOptionalDate(irm.retrievedAt)} /></dl>
    </Section> : null}
    {showDashboard ? <Section title="Grafana Dashboard" helper="Dashboard and panel telemetry is queried only for the bounded occurrence window. Dashboard coverage is enrichment, not a universal completeness gate.">
      <div className="mb-3 flex flex-wrap gap-2"><Badge value={fields.grafanaDashboardResolved ? 'RESOLVED' : 'MISSING'} /><Badge value={fields.grafanaPanelEvidence ? 'BOUNDED PANEL EVIDENCE' : 'PANEL EVIDENCE MISSING'} /></div>
      <dl className="grid gap-2 sm:grid-cols-2"><Field label="Dashboard" value={fields.dashboardTitle} /><Field label="Dashboard UID" value={fields.dashboardUid} /><Field label="Panel" value={fields.panelTitle} /><Field label="Panel ID" value={fields.panelId} /><Field label="Datasource" value={fields.datasource} /><Field label="Query references" value={fields.queryReferences} /><Field label="Metric" value={fields.metric} /><Field label="Value at occurrence" value={fields.valueAtOccurrence ?? fields.value} /><Field label="Threshold / condition" value={fields.threshold || fields.condition} /><Field label="Peak in window" value={fields.peak} /><Field label="Minimum in window" value={fields.minimum} /><Field label="Time above threshold" value={fields.timeAboveThresholdSeconds === null || fields.timeAboveThresholdSeconds === undefined ? null : `${formatNumber(fields.timeAboveThresholdSeconds)} seconds`} /><Field label="Persistence" value={fields.persistenceSeconds === null || fields.persistenceSeconds === undefined ? null : `${formatNumber(fields.persistenceSeconds)} seconds`} /><Field label="Recovered" value={fields.recovered === true ? 'Yes' : fields.recovered === false ? 'No' : null} /><Field label="Recovered at" value={formatOptionalDate(fields.recoveredAt)} /><Field label="Metric window" value={fields.metricWindowStart && fields.metricWindowEnd ? `${formatDate(fields.metricWindowStart)} — ${formatDate(fields.metricWindowEnd)}` : null} /></dl>
      {fields.panelDeepLink ? <a className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-[10px] font-bold text-orange-800" href={fields.panelDeepLink} target="_blank" rel="noreferrer">Open Dashboard Panel<ExternalLink className="h-3 w-3" /></a> : null}
    </Section> : null}
  </>;
}

function MonitoringLifecycleSections({ lifecycle = {} }) {
  if (!lifecycle.schemaVersion) return null;
  const history = lifecycle.historicalBehavior || {};
  const deviation = lifecycle.deviationFromHistory || {};
  const intervention = lifecycle.intervention || {};
  const transitions = lifecycle.transitions || [];
  const beforeMetrics = lifecycle.before?.metrics || [];
  const firingMetrics = lifecycle.firing?.metrics || [];
  const afterMetrics = lifecycle.after?.metrics || [];
  const metricLabel = (items) => items.map((item) => `${item.metric}: ${item.average ?? item.last ?? '—'}${item.unit ? ` ${item.unit}` : ''}`);
  return <>
    <Section title="Monitoring lifecycle" helper="Authoritative source occurrence evidence. Current state never replaces the state that fired this alert.">
      <div className="mb-3 flex flex-wrap gap-2"><Badge value={lifecycle.occurrence?.firingState || 'UNKNOWN'} /><Badge value={lifecycle.recovery?.recovered ? 'RECOVERED' : lifecycle.persistence?.currentlyFiring ? 'FIRING' : 'RECOVERY UNKNOWN'} />{(lifecycle.signals || []).slice(0, 4).map((signal) => <Badge key={signal} value={signal} />)}</div>
      <dl className="grid gap-2 sm:grid-cols-2"><Field label="Before window" value={lifecycle.before?.available ? `${formatDate(lifecycle.before.start)} — ${formatDate(lifecycle.before.end)}` : null} /><Field label="Before baseline" value={metricLabel(beforeMetrics)} /><Field label="Firing state" value={lifecycle.occurrence?.firingState} /><Field label="Firing time" value={formatOptionalDate(lifecycle.occurrence?.startedAt)} /><Field label="Firing metrics" value={metricLabel(firingMetrics)} /><Field label="Thresholds" value={(lifecycle.firing?.thresholds || []).map((item) => `${item.metric || 'Metric'}: ${typeof item.threshold === 'object' ? JSON.stringify(item.threshold) : item.threshold}`)} /><Field label="Persistence" value={formatDuration(lifecycle.persistence?.durationSeconds)} /><Field label="Breach duration" value={formatDuration(lifecycle.persistence?.breachDurationSeconds)} /><Field label="Transitions" value={transitions} /><Field label="Recovery" value={lifecycle.recovery?.recovered ? `Recovered ${formatDate(lifecycle.recovery.recoveredAt)}` : null} /><Field label="Automatic recovery" value={lifecycle.recovery?.automaticallyRecovered === true ? 'Yes' : lifecycle.recovery?.recovered ? 'No' : null} /><Field label="After recovery" value={metricLabel(afterMetrics)} /><Field label="Stabilization time" value={formatDuration(lifecycle.after?.stabilizationTimeSeconds)} /></dl>
    </Section>
    <Section title="Historical behavior" helper={`${history.windowDays || 90}-day stored source-identity profile. Historical frequency is evidence, never a classification by itself.`}>
      <div className="mb-3 flex flex-wrap gap-2"><Badge value={history.historyStatus || 'INSUFFICIENT_HISTORY'} /><Badge value={history.matchMethod} /></div>
      <dl className="grid gap-2 sm:grid-cols-2"><Field label="Prior occurrences" value={history.occurrenceCount} /><Field label="Median duration" value={formatDuration(history.medianDurationSeconds)} /><Field label="P95 duration" value={formatDuration(history.p95DurationSeconds)} /><Field label="Auto-recovery rate" value={history.autoRecoveryRate === null || history.autoRecoveryRate === undefined ? null : `${(Number(history.autoRecoveryRate) * 100).toFixed(1)}% (${history.autoRecoveryCount}/${history.lifecycleObservedCount})`} /><Field label="Incident association" value={history.incidentAssociationRate === null || history.incidentAssociationRate === undefined ? null : `${(Number(history.incidentAssociationRate) * 100).toFixed(1)}% (${history.incidentAssociationCount}/${history.occurrenceCount})`} /><Field label="Flapping frequency" value={history.flappingRate === null || history.flappingRate === undefined ? null : `${(Number(history.flappingRate) * 100).toFixed(1)}% (${history.flappingCount}/${history.lifecycleObservedCount})`} /><Field label="Recurrence rate" value={history.recurrenceRatePerDay === null || history.recurrenceRatePerDay === undefined ? null : `${history.recurrenceRatePerDay} / day`} /><Field label="Severity distribution" value={history.severityDistribution} /></dl>
    </Section>
    <Section title="Deviation" helper="Current behavior compared with the stored source-identity profile."><dl className="grid gap-2 sm:grid-cols-2"><Field label="Current vs historical duration" value={deviation.duration ? `${formatDuration(deviation.duration.currentSeconds)} vs median ${formatDuration(deviation.duration.medianSeconds)} · ${readable(deviation.duration.status)}` : null} /><Field label="Current metric vs baseline" value={(deviation.metric || []).map((item) => `${item.metric}: ${item.firing} vs ${item.baseline} (${item.ratioToBaseline ?? '—'}×)`)} /><Field label="Current severity vs historical" value={deviation.severity} /><Field label="Historical recurrence" value={deviation.recurrence ? `${deviation.recurrence.priorOccurrences} prior · ${deviation.recurrence.ratePerDay}/day` : null} /></dl></Section>
    <Section title="Intervention" helper="Acknowledgement, investigation, remediation, and escalation are distinct observations."><dl className="grid gap-2 sm:grid-cols-2"><Field label="Acknowledged" value={intervention.acknowledged === true ? 'Yes' : 'No evidence observed'} /><Field label="Acknowledged at" value={formatOptionalDate(intervention.acknowledgedAt)} /><Field label="Investigated" value={intervention.investigated === true ? 'Yes' : 'No evidence observed'} /><Field label="Remediated" value={intervention.remediated === true ? 'Yes' : 'No evidence observed'} /><Field label="Escalated" value={intervention.escalated === true ? 'Yes' : 'No evidence observed'} /></dl></Section>
  </>;
}

function SourceEvidenceCard({ source, fields = {}, items = [], unavailable, failure }) {
  const values = Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length));
  if (!values.length && !items.length && !unavailable) return null;
  return (
    <details className={`group rounded-xl border ${unavailable ? 'border-rose-200 bg-rose-50/50' : 'border-slate-200 bg-white'}`} open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2"><Badge value={source} tone={SOURCE_TONES[source]} />{unavailable ? <Badge value="UNAVAILABLE" /> : <span className="text-[10px] font-semibold text-slate-500">{items.length || values.length} evidence item(s)</span>}</div>
        <span className="text-xs text-slate-400 transition group-open:rotate-180">⌄</span>
      </summary>
      <div className="border-t border-slate-100 px-4 py-4">
        {unavailable ? <div className="mb-3 rounded-lg border border-rose-100 bg-white p-3"><p className="text-[10px] font-bold uppercase text-rose-700">{source.toUpperCase()} EVIDENCE UNAVAILABLE</p><p className="mt-1 text-[11px] leading-5 text-rose-700">Reason: {readable(presentationFailure(source, failure || 'Source connection unavailable'))}</p></div> : null}
        {values.length ? <dl className="grid gap-2 sm:grid-cols-2">{values.map(([key, value]) => <Field key={key} label={readable(key)} value={value} />)}</dl> : null}
        {items.length ? <ul className="mt-3 space-y-2">{items.slice(0, 8).map((item, index) => <li key={`${source}-${item.id || item.type || 'evidence'}-${index}`} className="rounded-lg bg-slate-50 px-3 py-2 text-[10px] leading-4 text-slate-600"><p className="font-semibold text-slate-700">{readable(item.type)}</p><p className="mt-0.5 break-all text-slate-400">{item.id}</p>{item.url ? <a className="mt-1 inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline" href={item.url} target="_blank" rel="noreferrer">Open {source}<ExternalLink className="h-3 w-3" /></a> : null}</li>)}</ul> : null}
      </div>
    </details>
  );
}

function EvidenceSection({ evaluation }) {
  const references = evaluation.evidenceReferences || [];
  const monitoringUnavailable = evaluation.technicalEvidence?.provenance?.primaryStatus !== 'working';
  const sourceDetails = evaluation.sourceDetails || {};
  const jira = evaluation.context?.jiraIncident || {};
  const problem = evaluation.context?.jiraProblem || {};
  const slack = evaluation.context?.slack || {};
  const cards = SOURCE_NAMES.map((source) => ({
    source, fields: sourceDetails[source] || {}, items: references.filter((item) => item.source === source),
    unavailable: source === evaluation.source && monitoringUnavailable,
    failure: evaluation.technicalEvidence?.provenance?.primaryFailureReason || evaluation.failureReasons?.join(' · '),
  }));
  cards.push({ source: 'ACC Jira', fields: { alert: evaluation.sourceAlertId, incident: jira.jiraIncidentKey, incidentStatus: jira.jiraIncidentStatus, problem: problem.jiraProblemKey, problemStatus: problem.jiraProblemStatus, priority: evaluation.alert?.priority }, items: references.filter((item) => item.source === 'ACC Jira') });
  cards.push({ source: 'Slack', fields: { notificationCount: slack.slackMessageCount, acknowledged: slack.slackAcknowledged ? 'Yes' : null, acknowledgedBy: slack.slackResponder, acknowledgementTime: slack.slackAcknowledgedAt, threadActivity: slack.slackThreadActivity, channel: slack.slackChannel }, items: references.filter((item) => item.source === 'Slack') });
  return <div className="space-y-3">{cards.map((card) => <SourceEvidenceCard key={card.source} {...card} />)}</div>;
}

function FeedbackPanel({ evaluation, authentication }) {
  const current = evaluation.feedback?.current;
  const canWrite = canRecordOutcomes(authentication);
  return <div className="space-y-3">
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-center gap-2"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Human outcome</p><Badge value={current?.humanDecision || 'UNCONFIRMED'} />{current?.humanSubtype ? <Badge value={current.humanSubtype} /> : null}</div><p className="mt-2 text-xs font-semibold text-slate-800">{current?.humanEvidenceText || current?.comment || current?.reasonCode || 'No authenticated human verification has been recorded.'}</p>{current ? <dl className="mt-3 grid gap-2 sm:grid-cols-2"><Field label="Verified by" value={current.responderDisplayName} /><Field label="Verified at" value={formatDate(current.createdAt)} /><Field label="Reason" value={current.reasonCode} /><Field label="Responder evidence" value={current.humanEvidenceText} /><Field label="Comment" value={current.comment} /><Field label="Channel" value={current.channel} /><Field label="Feedback ID" value={current.feedbackId} /><Field label="Training eligibility" value={current.trainingEligible ? 'ELIGIBLE' : current.trainingExclusionReason || 'EXCLUDED'} /></dl> : null}</div>
    <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-4"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-teal-700">Evidence collection</p><p className="mt-2 text-xs leading-5 text-slate-700">Add operational evidence and a responder assessment in the same structured workflow used by Slack. Alert context is prefilled and read-only.</p><Link className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-[10px] font-bold text-white" to={`/collect-evidence/${encodeURIComponent(evaluation.alertId)}`}>Collect Evidence<ExternalLink className="h-3 w-3" /></Link>{!canWrite ? <p className="mt-2 text-[10px] text-amber-800">Sign in as an authorized reviewer before submitting.</p> : null}</div>
    <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[10px] leading-5 text-blue-800">Only current-revision, conflict-free, authenticated human outcomes become eligible learning labels. System recommendations never become training labels automatically. System and model recommendations remain separate.</p>
    {evaluation.feedback?.history?.length ? <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-[10px] font-bold uppercase text-slate-500">Append-only verification history · {evaluation.feedback.history.length}</summary><div className="mt-2 space-y-2">{evaluation.feedback.history.map((entry) => <p key={entry.feedbackId || entry.recordedAt} className="text-[10px] text-slate-600">{formatDate(entry.recordedAt)} · {readable(entry.humanDecision)}{entry.humanSubtype ? ` / ${readable(entry.humanSubtype)}` : ''} · {entry.recordedBy} · {readable(entry.status)}</p>)}</div></details> : null}
  </div>;
}

function DecisionSummary({ evaluation }) {
  const details = evaluation.explanation?.dimensionDetails || {};
  const scores = evaluation.explanation?.evidenceScores || {};
  const evidenceUsed = evaluation.explanation?.evidenceUsed || [];
  const evidenceMissing = evaluation.explanation?.evidenceMissing || [];
  const blockers = evaluation.explanation?.decisionBlockers || [];
  const decisionChange = evaluation.explanation?.decisionChange || null;
  const detectedMechanisms = evaluation.noiseDetection?.detectedMechanisms || [];
  const positiveEvidenceIds = evaluation.explanation?.noiseEvidence?.evidenceIds || [];
  const maintenanceNotification = evaluation.explanation?.maintenanceNotification
    || evaluation.noiseDetection?.detectors?.INFORMATIONAL?.maintenanceNotification
    || null;
  return <Section title="Final decision" helper="Evidence-based system result. Human outcome remains separate and no external action is triggered.">
    <article className="rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[9px] font-bold uppercase tracking-[0.14em] text-blue-700">Final decision</p><div className="mt-3 flex flex-wrap items-center gap-2"><DecisionBadge value={evaluation.finalDecision} /><Badge value={evaluation.prioritySignal || 'UNKNOWN'} /><Badge value={'REVIEW PRIORITY ' + (evaluation.explanation?.reviewPriority || 4)} /></div></div><div className="text-right"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Evidence strength</p><p className="mt-2 text-xl font-semibold text-slate-950">{scoreValue(scores.decisionSupportScore ?? evaluation.evidenceScore)}</p><p className="mt-1 text-[9px] text-slate-500">Not probability or ML confidence</p></div></div>
      {decisionChange ? <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3"><Badge value="CHANGED FROM PHASE 13" tone="border-indigo-200 bg-white text-indigo-700" /><span className="text-[10px] font-semibold text-indigo-900">{readable(decisionChange.oldDecision)} → {readable(decisionChange.newDecision)}</span></div> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><DimensionCard label="Priority Signal" value={evaluation.prioritySignal} detail={details.prioritySignal} /><DimensionCard label="Noise Detection" value={evaluation.noiseDetection?.primarySubtype || evaluation.noiseDetection?.primary} detail={details.noiseDetection} /><DimensionCard label="Classification" value={`${readable(evaluation.classification?.domain || 'UNKNOWN')} / ${readable(evaluation.classification?.subtype || 'UNKNOWN')}`} detail={details.classification} /><DimensionCard label="Business Impact" value={evaluation.businessImpact} detail={details.businessImpact} /><DimensionCard label="Actionability" value={evaluation.actionability} detail={details.actionability} /><DimensionCard label="Underlying Event" value={evaluation.underlyingEvent} detail={details.underlyingEvent} /><DimensionCard label="Notification Role" value={evaluation.notificationRole} detail={details.notificationRole} /></div>
      {detectedMechanisms.length || positiveEvidenceIds.length ? <div className="mt-3 rounded-xl border border-sky-100 bg-sky-50/60 p-4"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-sky-700">Detected mechanisms</p><div className="mt-2 flex flex-wrap gap-2">{detectedMechanisms.map((mechanism) => <Badge key={mechanism} value={mechanism} />)}</div>{maintenanceNotification ? <div className="mt-3"><p className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500">Positive evidence</p><p className="mt-1 text-[10px] font-semibold text-slate-800">{maintenanceNotification.title}</p><p className="mt-1 text-[10px] leading-4 text-slate-600">{maintenanceNotification.impactStatement || maintenanceNotification.evidenceReason}</p></div> : null}{positiveEvidenceIds.length ? <div className="mt-3"><p className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500">Positive evidence IDs</p><ul className="mt-1 space-y-1">{positiveEvidenceIds.map((id) => <li key={id} className="break-all text-[10px] text-slate-600">{id}</li>)}</ul></div> : null}</div> : null}
      <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Why this decision?</p><ul className="mt-2 space-y-2">{(evaluation.explanation?.reasons || []).map((reason) => <li key={reason} className="flex gap-2 text-xs leading-5 text-slate-700"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />{reason}</li>)}</ul></div>
      {evaluation.finalDecision === 'NOISE' && evaluation.explanation?.whyNoise ? <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-4"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-sky-700">Why this is Noise</p><p className="mt-2 text-xs leading-5 text-sky-950">{evaluation.explanation.whyNoise}</p></div> : null}
      {evaluation.finalDecision === 'NEEDS_REVIEW' ? <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-amber-700">Decision blockers</p><Badge value={evaluation.explanation?.evidenceExhausted ? 'EVIDENCE EXHAUSTED' : 'LOOKUP INCOMPLETE'} /></div><p className="mt-2 text-xs font-semibold leading-5 text-amber-950">{evaluation.explanation?.reviewQuestion}</p><div className="mt-3 space-y-2">{blockers.map((blocker) => <div key={blocker.field + '-' + blocker.missingEvidence} className="rounded-lg border border-amber-200 bg-white p-3"><p className="text-[10px] font-bold text-slate-900">{blocker.field}</p><p className="mt-1 text-[10px] leading-4 text-slate-600"><strong>Current:</strong> {blocker.currentEvidence}</p><p className="mt-1 text-[10px] leading-4 text-slate-600"><strong>Missing:</strong> {blocker.missingEvidence}</p><p className="mt-1 text-[10px] leading-4 text-slate-600"><strong>Why it matters:</strong> {blocker.whyItMatters}</p><p className="mt-1 text-[9px] text-slate-400">Searched: {(blocker.systemsSearched || []).join(', ')} · Could change decision: {blocker.couldChangeDecision ? 'Yes' : 'No'}</p></div>)}</div></div> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4"><p className="text-[9px] font-bold uppercase tracking-[0.1em] text-emerald-700">Evidence used</p>{evidenceUsed.length ? <ul className="mt-2 space-y-1 text-[10px] leading-5 text-emerald-900">{evidenceUsed.slice(0, 12).map((value) => <li key={value}>• {value}</li>)}</ul> : <p className="mt-2 text-[10px] text-emerald-900">JSM alert and stored historical context only.</p>}</div><div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-[9px] font-bold uppercase tracking-[0.1em] text-amber-700">Evidence missing</p>{evidenceMissing.length ? <ul className="mt-2 space-y-1 text-[10px] leading-5 text-amber-900">{evidenceMissing.slice(0, 12).map((value) => <li key={value}>• {readable(presentationFailure(evaluation.source, value))}</li>)}</ul> : <p className="mt-2 text-[10px] text-amber-900">No required evidence gaps recorded.</p>}</div></div>
    </article>
  </Section>;
}

function EvaluationDrawer({ item, authentication, onClose, onUpdated, onReviewNext }) {
  const [evaluation, setEvaluation] = useState(null);
  const [mlRecommendation, setMlRecommendation] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const topRef = useRef(null);
  const load = useCallback(async () => {
    setError('');
    try {
      const [evaluationValue, recommendationValue] = await Promise.all([
        getLiveShadowEvaluation(item.alertId),
        getMlPrediction(item.alertId).catch(() => null),
      ]);
      setEvaluation(evaluationValue);
      setMlRecommendation(recommendationValue);
    } catch (requestError) { setError(requestError.message); }
  }, [item.alertId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { topRef.current?.scrollTo({ top: 0 }); }, [evaluation]);
  async function refreshEvidence() {
    setRefreshing(true); setError('');
    try { await runLiveShadowEvaluation(item.alertId, { refresh: true }); await load(); await onUpdated(); } catch (requestError) { setError(requestError.message); } finally { setRefreshing(false); }
  }
  const monitoringUrl = evaluation?.technicalEvidence?.coverage?.sourceResolution?.deepLink
    || evaluation?.technicalEvidence?.deepLink || item.monitoringUrl;
  const jiraUrl = evaluation?.context?.jiraIncident?.sourceUrl || item.workflow?.incidentUrl || item.jiraUrl;
  const identity = evaluation?.context?.sourceIdentity || {};
  const history = evaluation?.context?.historicalContext || {};
  const sourceCoverage = evaluation?.technicalEvidence?.coverage || {};
  const sourceResolution = sourceCoverage.sourceResolution || {};
  const completeness = sourceCoverage.evidenceCompleteness || {};
  const evaluability = sourceCoverage.evaluability || {};
  return <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/25" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={topRef} className="h-full w-full overflow-y-auto bg-white shadow-2xl sm:max-w-3xl"><header className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur"><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">Alert Evaluation</p><h2 className="mt-1 text-xl font-semibold text-slate-950">{item.displayId}</h2><p className="mt-1 max-w-xl text-sm leading-5 text-slate-700">{item.title}</p></div><button aria-label="Close evaluation detail" className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50" type="button" onClick={onClose}><X className="h-4 w-4" /></button></div></header><div className="p-5 sm:p-6">{error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</p> : null}{!evaluation && !error ? <p className="flex items-center gap-2 py-8 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />Loading stored unified evaluation…</p> : null}{evaluation ? <>
    <DecisionSummary evaluation={evaluation} />
    <Section title="Source identity"><div className="flex flex-wrap gap-2"><Badge value={evaluation.source} tone={SOURCE_TONES[evaluation.source]} /><Badge value={item.priority || evaluation.alert?.priority} /><Badge value={item.environment || identity.environment} /><Badge value={item.status || evaluation.alert?.status} /></div><dl className="mt-4 grid gap-2 sm:grid-cols-2"><Field label="Alert ID" value={item.displayId} /><Field label="Original source" value={sourceResolution.originalSource} /><Field label="Canonical source" value={sourceResolution.canonicalSource || evaluation.source} /><Field label="Application" value={identity.application} /><Field label="Application ID" value={identity.applicationId} /><Field label="Service" value={identity.service || item.service} /><Field label="Entity" value={identity.entity} /><Field label="Entity ID" value={identity.entityId} /><Field label="Environment" value={identity.environment || item.environment} /><Field label="First seen" value={formatDate(item.firstSeen)} /></dl><div className="mt-3 flex flex-wrap gap-2">{jiraUrl ? <a className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[10px] font-bold text-blue-700" href={jiraUrl} target="_blank" rel="noreferrer">Open Jira<ExternalLink className="h-3 w-3" /></a> : null}{monitoringUrl ? <a className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-bold text-slate-700" href={monitoringUrl} target="_blank" rel="noreferrer">Open {evaluation.source}<ExternalLink className="h-3 w-3" /></a> : null}<button className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-bold text-slate-700 disabled:opacity-50" type="button" disabled={refreshing} onClick={refreshEvidence}><RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />Refresh Evidence</button></div><p className="mt-3 text-[10px] text-slate-400">Evidence retrieved at: {formatDate(evaluation.createdAt || evaluation.featureAsOf)}</p></Section>
    <Section title="Monitoring evidence" helper="Source resolution and technical evidence completeness are shown independently from the final result."><div className="flex flex-wrap gap-2"><Badge value={sourceResolution.status || 'UNRESOLVED'} /><Badge value={completeness.status || 'INCOMPLETE'} /></div><dl className="mt-3 grid gap-2 sm:grid-cols-2"><Field label="Original source" value={sourceResolution.originalSource} /><Field label="Canonical source" value={sourceResolution.canonicalSource || evaluation.source} /><Field label="Source alert ID" value={sourceResolution.sourceAlertId} /><Field label="Source entity" value={sourceResolution.sourceEntityId} /><Field label="Source object type" value={sourceResolution.sourceObjectType} /><Field label="Mapping method" value={sourceResolution.mappingMethod} /><Field label="Mapping confidence" value={sourceResolution.mappingConfidence} /><Field label="Technical evidence status" value={completeness.status} /><Field label="Evidence retrieved at" value={formatDate(completeness.retrievedAt)} /><Field label="Source event time" value={formatDate(completeness.sourceEventTime)} /><Field label="Evidence freshness" value={completeness.freshnessSeconds === null || completeness.freshnessSeconds === undefined ? null : `${formatNumber(completeness.freshnessSeconds)} seconds`} /><Field label="Missing fields" value={completeness.missingFields?.length ? completeness.missingFields.join(', ') : null} /></dl>{!evaluability.evaluable ? <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-[9px] font-bold uppercase tracking-[0.1em] text-amber-700">Monitoring evidence gap</p><p className="mt-1 text-[10px] leading-5 text-amber-900">{readable(presentationFailure(evaluation.source, evaluability.reason))}</p>{sourceResolution.failureReason ? <p className="mt-1 text-[10px] font-semibold text-amber-800">Failure: {readable(presentationFailure(evaluation.source, sourceResolution.failureReason))}</p> : null}</div> : null}</Section>
    {evaluation.source === 'AppDynamics' ? <Section title="AppDynamics occurrence evidence" helper="The occurrence event is resolved by exact AppDynamics application/event identity and a bounded source timestamp. Current application state is kept separate from the historical occurrence state."><div className="mb-3 flex flex-wrap gap-2"><Badge value={sourceResolution.status || 'UNRESOLVED'} /><Badge value={completeness.fields?.occurrenceState || completeness.fields?.state} /><Badge value={completeness.fields?.evidenceType} /></div><dl className="grid gap-2 sm:grid-cols-2"><Field label="Source alert ID" value={sourceResolution.sourceAlertId} /><Field label="Application" value={completeness.fields?.application} /><Field label="Application ID" value={completeness.fields?.applicationId} /><Field label="Tier" value={completeness.fields?.tier} /><Field label="Tier ID" value={completeness.fields?.tierId} /><Field label="Node" value={completeness.fields?.node} /><Field label="Node ID" value={completeness.fields?.nodeId} /><Field label="Business transaction" value={completeness.fields?.businessTransaction} /><Field label="Business transaction ID" value={completeness.fields?.businessTransactionId} /><Field label="Health rule / event" value={completeness.fields?.healthRule || completeness.fields?.eventType || completeness.fields?.metricOrEvent} /><Field label="Health rule ID" value={completeness.fields?.healthRuleId} /><Field label="Policy" value={completeness.fields?.policy} /><Field label="Event ID" value={completeness.fields?.eventId} /><Field label="Violation ID" value={completeness.fields?.violationId} /><Field label="Occurrence state" value={completeness.fields?.occurrenceState || completeness.fields?.state} /><Field label="Current state" value={completeness.fields?.currentState} /><Field label="Source event time" value={formatDate(completeness.sourceEventTime)} /><Field label="Evidence retrieved at" value={formatDate(completeness.retrievedAt)} /><Field label="Metric" value={completeness.fields?.metric} /><Field label="Metric value" value={completeness.fields?.metricValue} /><Field label="Technical evidence" value={completeness.status} /><Field label="Evidence endpoint" value={completeness.fields?.sourceProvenance?.endpointCategory} /><Field label="Mapping method" value={completeness.fields?.sourceProvenance?.mappingMethod || sourceResolution.mappingMethod} /></dl>{sourceResolution.deepLink ? <a className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-[10px] font-bold text-cyan-800" href={sourceResolution.deepLink} target="_blank" rel="noreferrer">Open AppDynamics<ExternalLink className="h-3 w-3" /></a> : null}</Section> : null}
    {evaluation.source === 'Grafana' ? <GrafanaEvidenceSections completeness={completeness} sourceResolution={sourceResolution} /> : null}
    {evaluation.source === 'Nagios' ? <Section title="Nagios historical occurrence" helper="Authoritative Nagios state and log history are correlated to the JSM alert by exact host/service identity and a bounded occurrence window. Current status is displayed separately when the entity still exists."><div className="mb-3 flex flex-wrap gap-2"><Badge value={completeness.fields?.sourceEntityType || 'HISTORICAL_SOURCE_ENTITY'} /><Badge value={completeness.fields?.occurrenceState || completeness.fields?.state} /></div><dl className="grid gap-2 sm:grid-cols-2"><Field label="Host" value={completeness.fields?.host} /><Field label="Service" value={completeness.fields?.service} /><Field label="Source entity ID" value={sourceResolution.sourceAlertId || sourceResolution.sourceEntityId} /><Field label="Occurrence state" value={completeness.fields?.occurrenceState} /><Field label="State type" value={completeness.fields?.stateType} /><Field label="Plugin output" value={completeness.fields?.pluginOutput} /><Field label="Attempt" value={completeness.fields?.attempts && completeness.fields?.maxAttempts ? `${completeness.fields.attempts} / ${completeness.fields.maxAttempts}` : completeness.fields?.attempts} /><Field label="Fired at" value={formatDate(completeness.fields?.firedAt || completeness.fields?.sourceEventTimestamp)} /><Field label="Last state transition" value={formatDate(completeness.fields?.lastStateChange)} /><Field label="Notification state" value={completeness.fields?.notificationState} /><Field label="Notification time" value={formatOptionalDate(completeness.fields?.notificationAt)} /><Field label="Notification type" value={completeness.fields?.notificationType} /><Field label="Acknowledged" value={completeness.fields?.acknowledged === true ? 'Yes' : completeness.fields?.acknowledged === false ? 'No' : null} /><Field label="Acknowledged at" value={formatOptionalDate(completeness.fields?.acknowledgementAt)} /><Field label="Recovery state" value={completeness.fields?.recoveryState} /><Field label="Recovery time" value={formatOptionalDate(completeness.fields?.recoveryAt)} /><Field label="Recovered" value={completeness.fields?.recovered === true ? 'Yes' : null} /><Field label="Occurrence duration" value={completeness.fields?.durationSeconds === null || completeness.fields?.durationSeconds === undefined ? null : `${formatNumber(completeness.fields.durationSeconds)} seconds`} /><Field label="Flapping observed" value={completeness.fields?.flapping === true ? 'Yes' : null} /><Field label="State transitions" value={completeness.fields?.stateTransitionCount} /><Field label="Current state" value={completeness.fields?.currentStatus} /><Field label="Current entity present" value={completeness.fields?.currentSourceRecord ? 'Yes' : 'No'} /><Field label="Evidence source" value={completeness.fields?.sourceProvenance?.source} /><Field label="Timestamp normalization" value={completeness.fields?.sourceProvenance?.timestampMethod} /><Field label="Historical mapping" value={completeness.fields?.historicalMappingMethod} /><Field label="Mapping evidence" value={completeness.fields?.historicalMappingEvidence} /><Field label="Mapping confidence" value={completeness.fields?.historicalMappingConfidence} /><Field label="Historical query window" value={completeness.fields?.sourceProvenance?.queryWindow ? `${formatDate(completeness.fields.sourceProvenance.queryWindow.from)} — ${formatDate(completeness.fields.sourceProvenance.queryWindow.to)}` : null} /></dl>{sourceResolution.deepLink ? <a className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[10px] font-bold text-violet-800" href={sourceResolution.deepLink} target="_blank" rel="noreferrer">Open Nagios<ExternalLink className="h-3 w-3" /></a> : null}</Section> : null}
    <MonitoringLifecycleSections lifecycle={evaluation.technicalEvidence?.monitoringLifecycle || {}} />
    <Section title="Evidence" helper="Only evidence actually retrieved for this occurrence is shown."><EvidenceSection evaluation={evaluation} /></Section>
    <Section title="Historical context"><dl className="grid gap-2 sm:grid-cols-2"><Field label="Previous similar alerts" value={history.previousSameSignature} /><Field label="Previous same service" value={history.previousSameService} /><Field label="Previous same entity" value={history.previousSameEntity} /><Field label="Previous Incident associations" value={history.previousIncidentOccurrences} /><Field label="Previous confirmed Noise outcomes" value={history.previousConfirmedNoiseOutcomes} /><Field label="Context as of" value={formatDate(history.asOf)} /></dl><p className="mt-2 text-[10px] text-slate-500">Legacy classifier output is not used as authoritative evidence.</p></Section>
    <Section title="Operational workflow"><dl className="grid gap-2 sm:grid-cols-2"><Field label="Jira Incident" value={evaluation.context?.jiraIncident?.jiraIncidentKey} /><Field label="Jira Problem" value={evaluation.context?.jiraProblem?.jiraProblemKey} /><Field label="Incident status" value={evaluation.context?.jiraIncident?.jiraIncidentStatus} /><Field label="Slack notifications" value={evaluation.context?.slack?.slackMessageCount} /><Field label="Slack acknowledged" value={evaluation.context?.slack?.slackAcknowledged ? 'Observed' : null} /><Field label="Slack responder" value={evaluation.context?.slack?.slackResponder} /></dl></Section>
    <Section title="Feedback"><FeedbackPanel evaluation={evaluation} authentication={authentication} /></Section>
    <Section title="Model Recommendation" helper="SHADOW RECOMMENDATION — does not change final decision"><div className="rounded-2xl bg-slate-950 p-5 text-white"><div className="flex flex-wrap items-center gap-2"><Badge value="SHADOW" /><Badge value={mlRecommendation?.recommendationAvailable ? mlRecommendation.predictedClass : mlRecommendation?.status || 'NOT TRAINED'} /></div>{mlRecommendation?.recommendationAvailable ? <><dl className="mt-4 grid gap-3 sm:grid-cols-2"><div><dt className="text-[9px] uppercase text-slate-500">Model version</dt><dd className="mt-1 text-xs font-semibold">{mlRecommendation.modelVersion}</dd></div><div><dt className="text-[9px] uppercase text-slate-500">Predicted class</dt><dd className="mt-1 text-xs font-semibold">{readable(mlRecommendation.predictedClass)}</dd></div><div><dt className="text-[9px] uppercase text-slate-500">{mlRecommendation.scoreLabel === 'MODEL_SCORE' ? 'Model score' : 'Calibrated probability'}</dt><dd className="mt-1 text-xs font-semibold">{(Number(mlRecommendation.modelScore) * 100).toFixed(1)}%</dd></div><div><dt className="text-[9px] uppercase text-slate-500">Final-decision authority</dt><dd className="mt-1 text-xs font-semibold">DETERMINISTIC ENGINE</dd></div></dl><div className="mt-4 grid grid-cols-3 gap-2">{[['Incident', mlRecommendation.probabilities?.incident], ['Noise', mlRecommendation.probabilities?.noise], ['Insufficient Evidence', mlRecommendation.probabilities?.needsReview]].map(([label, value]) => <div key={label} className="rounded-xl bg-white/5 p-3"><p className="text-[9px] text-slate-400">{label}</p><p className="mt-1 text-xs font-semibold">{(Number(value || 0) * 100).toFixed(1)}%</p></div>)}</div>{mlRecommendation.topContributors?.length ? <div className="mt-4"><p className="text-[9px] font-bold uppercase text-slate-500">Top contributing features</p><div className="mt-2 flex flex-wrap gap-2">{mlRecommendation.topContributors.map((item) => <span key={item.feature} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[10px] text-slate-200">{readable(item.feature)} · {Number(item.contribution).toFixed(3)}</span>)}</div></div> : null}</> : <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-300/10 p-4"><p className="text-xs font-semibold text-amber-100">{readable(mlRecommendation?.message || mlRecommendation?.status || 'INSUFFICIENT VALIDATED TRAINING DATA')}</p><p className="mt-1 text-[10px] leading-5 text-slate-300">No model score or performance value is fabricated.</p></div>}<div className="mt-4 border-t border-white/10 pt-4"><dl className="grid gap-2 sm:grid-cols-2"><div><dt className="text-[9px] uppercase text-slate-500">Deterministic decision</dt><dd className="mt-1 text-xs font-semibold">{readable(evaluation.finalDecision)}</dd></div><div><dt className="text-[9px] uppercase text-slate-500">Automation</dt><dd className="mt-1 text-xs font-semibold">DISABLED</dd></div></dl><Link className="mt-4 inline-flex items-center gap-1 text-[10px] font-bold text-blue-300 hover:text-blue-200" to="/model-evaluation" onClick={onClose}>Open Model Evaluation<ArrowRight className="h-3 w-3" /></Link></div></div></Section>
  </> : null}</div></aside></div>;
}

function classificationLabel(evaluation) {
  if (!evaluation) return 'UNKNOWN / UNKNOWN';
  return `${readable(evaluation.classification?.domain || 'UNKNOWN')} / ${readable(evaluation.classification?.subtype || 'UNKNOWN')}`;
}

function SourceIdentityCell({ item }) {
  const identity = item.sourceIdentity || {};
  return <div className="min-w-[180px] space-y-1 text-[10px] leading-4 text-slate-600"><p className="font-semibold text-slate-900">{identity.entity || identity.entityId || identity.service || identity.application || 'Unresolved identity'}</p>{identity.application ? <p>App: {identity.application}</p> : null}{identity.service ? <p>Service: {identity.service}</p> : null}{identity.environment ? <p>Env: {identity.environment}</p> : null}{identity.entityId ? <p className="max-w-[180px] truncate" title={identity.entityId}>ID: {identity.entityId}</p> : null}</div>;
}

function workflowLabel(item) {
  if (item.workflow?.sourceUnavailable) return 'Source unavailable';
  if (item.workflow?.incidentKey) return `Incident ${item.workflow.incidentKey}`;
  if (item.workflow?.acknowledged) return 'Acknowledged';
  return 'No linked Incident';
}

function AlertMobileCard({ item, onOpen, running }) {
  const evidence = item.sourceEvidenceCoverage?.evidenceCompleteness || {};
  return <button className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm" type="button" onClick={() => onOpen(item)}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-blue-700">{item.displayId}</p><p className="mt-1 text-sm font-semibold leading-5 text-slate-900">{item.title}</p></div><Badge value={item.source} tone={SOURCE_TONES[item.source]} /></div><div className="mt-3 flex flex-wrap gap-2"><Badge value={item.priority || item.severity} /><Badge value={item.environment} /><Badge value={evidence.status || 'INCOMPLETE'} /><DecisionBadge value={item.evaluation?.finalDecision || 'NEEDS_REVIEW'} /></div><dl className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-500"><div><dt>First seen</dt><dd className="font-semibold text-slate-700">{formatDate(item.firstSeen)}</dd></div><div><dt>Evidence strength</dt><dd className="font-semibold text-slate-700">{item.evaluation?.evidenceScore === null || item.evaluation?.evidenceScore === undefined ? 'Unavailable' : Number(item.evaluation.evidenceScore).toFixed(2)}</dd></div><div><dt>Human outcome</dt><dd className="font-semibold text-slate-700">{readable(item.feedback.status)}</dd></div><div><dt>Noise detection</dt><dd className="font-semibold text-slate-700">{readable(item.evaluation?.noiseDetection?.primarySubtype || item.evaluation?.noiseDetection?.primary || 'UNKNOWN')}</dd></div></dl>{running ? <p className="mt-3 flex items-center gap-1 text-[10px] font-semibold text-blue-700"><RefreshCw className="h-3 w-3 animate-spin" />Refreshing evidence…</p> : null}</button>;
}

export default function LiveMultiSourceEvaluation() {
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get('search') || '';
  const [filters, setFilters] = useState({ page: 1, source: '', decision: '', classification: '', noiseType: '', evidence: '', reviewed: '', feedback: '', goldReview: searchParams.get('goldReview') === 'true', search: initialSearch, range: '24h' });
  const [draftSearch, setDraftSearch] = useState(initialSearch);
  const [data, setData] = useState(null);
  const [episodeDiagnostics, setEpisodeDiagnostics] = useState(null);
  const [population, setPopulation] = useState(null);
  const [reviewQueue, setReviewQueue] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [connectivity, setConnectivity] = useState([]);
  const [authentication, setAuthentication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const loadAuthentication = useCallback(async () => {
    try {
      const auth = await getCurrentUser();
      setAuthentication(auth);
      return auth;
    } catch (requestError) {
      const auth = {
        authenticated: false,
        loginAvailable: Boolean(requestError.details?.loginAvailable),
        reason: requestError.details?.reason || requestError.message,
      };
      setAuthentication(auth);
      return auth;
    }
  }, []);
  const requestFilters = useMemo(() => ({ ...filters, goldReview: filters.goldReview ? 'true' : '', pageSize: PAGE_SIZE }), [filters]);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const queueStatus = !filters.feedback || filters.feedback === 'UNCONFIRMED' ? 'UNREVIEWED' : 'REVIEWED';
      const [records, model, sources, auth, queue, authoritativePopulation, episodes] = await Promise.all([
        getLiveEvaluationCandidates(filters.goldReview
          ? { range: '24h', page: 1, pageSize: 1 }
          : requestFilters), getModelPerformance(),
        getLiveEvaluationConnectivity(), getCurrentUser().catch((requestError) => ({ authenticated: false, loginAvailable: Boolean(requestError.details?.loginAvailable), reason: requestError.details?.reason || requestError.message })),
        filters.goldReview ? getGoldReviewQueue({ status: queueStatus, source: filters.source, limit: 300 }) : null,
        getPopulationReconciliation({ page: 1, pageSize: 25 }),
        getEvaluationEpisodeDiagnostics().catch(() => null),
      ]);
      if (queue) {
        const needle = filters.search.trim().toLowerCase();
        const filtered = (queue.items || []).filter((item) => (
          (!filters.decision || item.evaluation?.finalDecision === filters.decision)
          && (!filters.feedback || filters.feedback === 'UNCONFIRMED' || item.feedback?.outcome === filters.feedback)
          && (!needle || [item.displayId, item.title, item.message, item.service, item.source]
            .some((value) => String(value || '').toLowerCase().includes(needle)))
        ));
        const totalRecords = filtered.length;
        const start = (filters.page - 1) * PAGE_SIZE;
        setData({
          ...records,
          items: filtered.slice(start, start + PAGE_SIZE),
          pagination: {
            page: filters.page,
            pageSize: PAGE_SIZE,
            totalRecords,
            totalPages: totalRecords ? Math.ceil(totalRecords / PAGE_SIZE) : 0,
          },
        });
        setReviewQueue(queue);
      } else {
        setData(records);
        setReviewQueue(null);
      }
      setPerformance(model); setConnectivity(sources.checks || []); setAuthentication(auth); setPopulation(authoritativePopulation);
      if (episodes) setEpisodeDiagnostics(episodes);
    } catch (requestError) { setError(requestError.message); } finally { if (!silent) setLoading(false); }
  }, [filters, requestFilters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = setInterval(() => load(true), 30_000); return () => clearInterval(timer); }, [load]);
  function setFilter(name, value) { setFilters((current) => ({ ...current, [name]: value, page: 1 })); }
  async function validateSources() {
    setValidating(true); setError('');
    try { const result = await getLiveEvaluationConnectivity({ refresh: true }); setConnectivity(result.checks || []); } catch (requestError) { setError(requestError.message); } finally { setValidating(false); }
  }
  async function openAlert(item) {
    if (item.evaluation) { setSelected(item); return; }
    setRunningId(item.alertId); setError('');
    try { await runLiveShadowEvaluation(item.alertId); await load(true); setSelected(item); } catch (requestError) { setError(requestError.message); } finally { setRunningId(null); }
  }
  function reviewNextAlert(currentAlertId) {
    const next = (data?.items || []).find((item) => item.alertId !== currentAlertId
      && item.feedback?.status === 'UNCONFIRMED');
    setSelected(next || null);
  }
  const pagination = data?.pagination || { page: 1, totalPages: 0, totalRecords: 0 };
  const summary = data?.summary || {};
  const noiseEpisodeCount = episodeDiagnostics?.episodeDecisions?.noise;
  const repeatNotificationCount = summary.noiseBreakdown?.repeat;
  const grafanaSummary = (summary.bySource || []).find((item) => item.source === 'Grafana') || null;
  const nagiosSummary = (summary.bySource || []).find((item) => item.source === 'Nagios') || null;
  const percentage = (value) => value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
  return <div className="space-y-6">
    <section className="overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-white via-blue-50/70 to-cyan-50/50 p-6 shadow-sm md:p-8"><div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between"><div className="max-w-3xl"><div className="flex flex-wrap gap-2"><Badge value="LAST 24 HOURS" /><Badge value="READ ONLY" /><Badge value="SHADOW" /></div><h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">24-Hour Alert Results</h1><p className="mt-3 text-sm leading-6 text-slate-600">Every current JSM Operations alert receives an evidence-based result using monitoring, Jira, Slack, cross-source, and historical context.</p><div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><span>Last updated: {formatDate(summary.lastUpdated)}</span><span>ML trained: No</span><span>Automatic actions: Disabled</span></div></div><button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-sm disabled:opacity-50" type="button" onClick={() => load()} disabled={loading}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh results</button></div></section>
    {error ? <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</section> : null}
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="24-hour alert result summary"><Kpi icon={Database} label="Total Alerts" value={loading ? '—' : formatNumber(summary.totalAlerts)} helper="Authoritative JSM population" /><Kpi icon={CheckCircle2} label="Evaluated" value={loading ? '—' : formatNumber(summary.evaluated)} helper="Every alert has a result" tone="emerald" /><Kpi icon={Siren} label="Incident" value={loading ? '—' : formatNumber(summary.incident)} helper="Evidence-backed result" tone="rose" /><Kpi icon={ShieldCheck} label="Noise" value={loading ? '—' : formatNumber(summary.noise)} helper={loading ? 'Loading episode accounting…' : `${noiseEpisodeCount === null || noiseEpisodeCount === undefined ? '—' : formatNumber(noiseEpisodeCount)} noise episodes · ${formatNumber(repeatNotificationCount)} repeat notifications`} tone="blue" /><Kpi icon={AlertTriangle} label="Insufficient Evidence" value={loading ? '—' : formatNumber(summary.needsReview)} helper="Material evidence is missing or conflicting" tone="amber" /></section>
    {!loading && (summary.totalAlerts !== summary.evaluated || summary.incident + summary.noise + summary.needsReview !== summary.totalAlerts) ? <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs font-semibold text-rose-800">Result reconciliation failed. Refreshing will continue, but no alert is hidden.</section> : null}
    <DecisionQualityOverview summary={summary} episodeDiagnostics={episodeDiagnostics} />
    {filters.goldReview ? <GoldReviewAuthentication authentication={authentication} onAuthenticationChanged={async (auth) => { if (auth) setAuthentication(auth); else await loadAuthentication(); }} /> : null}
    {filters.goldReview && reviewQueue ? <section className="rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-white p-5 shadow-sm"><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center"><div><div className="flex flex-wrap items-center gap-2"><Badge value="GOLD REVIEW QUEUE" tone="border-indigo-200 bg-indigo-100 text-indigo-800" /><Badge value={reviewQueue.status} /></div><h2 className="mt-3 text-lg font-semibold text-slate-950">{formatNumber(reviewQueue.eligible)} eligible review candidates</h2><p className="mt-1 text-[11px] leading-5 text-slate-600">from {formatNumber(population?.funnel?.total24h)} total alerts in the current rolling 24-hour window · Gold Review is a downstream subset, not total alert volume.</p></div><div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-xl border border-indigo-100 bg-white px-4 py-3"><p className="text-[9px] font-bold uppercase text-slate-400">Eligible</p><p className="mt-1 text-lg font-semibold">{formatNumber(reviewQueue.eligible)}</p></div><div className="rounded-xl border border-indigo-100 bg-white px-4 py-3"><p className="text-[9px] font-bold uppercase text-slate-400">Reviewed</p><p className="mt-1 text-lg font-semibold">{formatNumber(reviewQueue.reviewed)}</p></div><div className="rounded-xl border border-indigo-100 bg-white px-4 py-3"><p className="text-[9px] font-bold uppercase text-slate-400">Remaining</p><p className="mt-1 text-lg font-semibold">{formatNumber(reviewQueue.remaining)}</p></div></div></div><div className="mt-4 flex flex-wrap gap-2"><Badge value={`${reviewQueue.outcomes?.confirmedNoise || 0} CONFIRMED NOISE`} /><Badge value={`${reviewQueue.outcomes?.confirmedIncident || 0} CONFIRMED INCIDENT`} /><Badge value={`${reviewQueue.outcomes?.unknown || 0} UNKNOWN`} /></div></section> : null}
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500"><Filter className="h-3.5 w-3.5" />Alert filters</div><div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
      <form className="relative xl:col-span-2" onSubmit={(event) => { event.preventDefault(); setFilter('search', draftSearch.trim()); }}><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-20 text-xs outline-none focus:border-blue-400" placeholder="Search alert, message, service…" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} /><button className="absolute right-1.5 top-1.5 rounded-md bg-slate-900 px-2.5 py-1 text-[10px] font-bold text-white" type="submit">Apply</button></form>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.source} onChange={(event) => setFilter('source', event.target.value)}><option value="">All sources</option>{[...SOURCE_NAMES, 'Unsupported/Unknown'].map((source) => <option key={source}>{source}</option>)}</select>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.decision} onChange={(event) => setFilter('decision', event.target.value)}><option value="">All decisions</option><option value="NOISE">Noise</option><option value="INCIDENT">Incident</option><option value="NEEDS_REVIEW">Insufficient Evidence</option></select>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.classification} onChange={(event) => setFilter('classification', event.target.value)}><option value="">All classifications</option>{['INFRASTRUCTURE', 'APPLICATION', 'NETWORK', 'DEPENDENCY', 'JOB_BATCH_DATA', 'UNKNOWN'].map((value) => <option key={value}>{value}</option>)}</select>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.noiseType} onChange={(event) => setFilter('noiseType', event.target.value)}><option value="">All noise types</option>{['DUPLICATE', 'FLAPPING', 'AUTO_RESOLVED', 'NON_ACTIONABLE', 'CORRELATED', 'STALE', 'NO_STRONG_NOISE_PATTERN', 'UNKNOWN'].map((value) => <option key={value} value={value}>{readable(value)}</option>)}</select>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.evidence} onChange={(event) => setFilter('evidence', event.target.value)}><option value="">Complete + incomplete evidence</option><option value="COMPLETE">Evidence complete</option><option value="INCOMPLETE">Evidence incomplete</option></select>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.reviewed} onChange={(event) => setFilter('reviewed', event.target.value)}><option value="">Reviewed + unreviewed</option><option value="REVIEWED">Human reviewed</option><option value="UNREVIEWED">Human unreviewed</option></select>
      <select className="h-9 rounded-lg border border-slate-200 px-3 text-xs" value={filters.feedback} onChange={(event) => setFilter('feedback', event.target.value)}><option value="">All human outcomes</option><option value="UNCONFIRMED">Unconfirmed</option><option value="CONFIRMED_NOISE">Confirmed Noise</option><option value="CONFIRMED_INCIDENT">Confirmed Incident</option><option value="UNKNOWN">Unknown</option></select>
      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600"><input type="checkbox" checked={filters.goldReview} onChange={(event) => setFilter('goldReview', event.target.checked)} />Gold Review queue</label>
    </div></section>
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-semibold text-slate-950">{filters.goldReview ? 'Gold Review Queue' : 'Operational alerts'}</h2><p className="mt-1 text-[11px] text-slate-500">{formatNumber(pagination.totalRecords)} real {filters.goldReview ? 'eligible review candidates' : 'Jira/JSM alerts'} · click any alert to inspect its unified evidence</p></div><span className="text-[10px] font-semibold text-slate-400">30-second dataset refresh · source evidence refresh is explicit</span></div>
      <div className="hidden overflow-x-auto lg:block"><table className="w-full min-w-[1900px] text-left"><thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500"><tr>{['Alert', 'First Seen', 'Source', 'Source Identity', 'Classification', 'Noise Detection', 'Lifecycle', 'Historical Pattern', 'Noise Signal', 'Final Decision', 'Evidence Strength', 'Evidence Status', 'Human Outcome'].map((heading) => <th key={heading} className="border-b border-slate-200 px-4 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{(data?.items || []).map((item) => { const evidence = item.sourceEvidenceCoverage?.evidenceCompleteness || {}; const lifecycle = item.evaluation?.lifecycle || {}; const history = lifecycle.historicalBehavior || {}; return <tr key={item.alertId} className="cursor-pointer align-top hover:bg-blue-50/40" tabIndex={0} onClick={() => openAlert(item)} onKeyDown={(event) => { if (event.key === 'Enter') openAlert(item); }}><td className="px-4 py-4"><p className="text-xs font-bold text-blue-700">{item.displayId}</p><p className="mt-1 max-w-[260px] text-xs font-semibold leading-5 text-slate-900">{item.title}</p><div className="mt-2 flex flex-wrap gap-1"><Badge value={item.priority || item.severity} /><Badge value={item.evaluation?.prioritySignal} /><Badge value={item.environment} /></div></td><td className="whitespace-nowrap px-4 py-4 text-[10px] text-slate-600">{formatDate(item.firstSeen)}</td><td className="px-4 py-4"><Badge value={item.source} tone={SOURCE_TONES[item.source]} /></td><td className="px-4 py-4"><SourceIdentityCell item={item} /></td><td className="px-4 py-4"><p className="max-w-[170px] text-[10px] font-semibold leading-4 text-slate-700">{classificationLabel(item.evaluation)}</p></td><td className="px-4 py-4 text-[10px] font-semibold text-slate-600">{readable(item.evaluation?.noiseDetection?.primarySubtype || item.evaluation?.noiseDetection?.primary || 'UNKNOWN')}</td><td className="px-4 py-4"><p className="text-[10px] font-semibold text-slate-800">{lifecycle.recovery?.recovered ? 'Recovered' : lifecycle.persistence?.currentlyFiring ? 'Firing' : 'Unknown'}</p><p className="mt-1 text-[9px] text-slate-500">{formatDuration(lifecycle.persistence?.durationSeconds) || 'Duration unavailable'}</p></td><td className="px-4 py-4"><p className="text-[10px] font-semibold text-slate-800">{formatNumber(history.occurrenceCount)} prior</p><p className="mt-1 text-[9px] text-slate-500">{readable(history.historyStatus || 'INSUFFICIENT_HISTORY')}</p></td><td className="px-4 py-4"><div className="flex max-w-[180px] flex-wrap gap-1">{(lifecycle.signals || []).slice(0, 2).map((signal) => <Badge key={signal} value={signal} />)}{!(lifecycle.signals || []).length ? <span className="text-[9px] text-slate-400">No strong signal</span> : null}</div></td><td className="px-4 py-4"><DecisionBadge value={item.evaluation?.finalDecision || 'NEEDS_REVIEW'} /></td><td className="px-4 py-4"><p className="text-sm font-semibold text-slate-900">{item.evaluation?.evidenceScore === null || item.evaluation?.evidenceScore === undefined ? '—' : Number(item.evaluation.evidenceScore).toFixed(2)}</p><p className="mt-1 text-[9px] text-slate-400">Not ML confidence</p></td><td className="px-4 py-4"><Badge value={evidence.status || 'INCOMPLETE'} /><p className="mt-2 max-w-[170px] text-[9px] leading-4 text-slate-500">{evidence.missingFields?.length ? `Missing: ${evidence.missingFields.join(', ')}` : item.evaluation?.evidenceCount ? `${item.evaluation.evidenceCount} evidence item(s)` : 'JSM and stored context only'}</p></td><td className="px-4 py-4"><Badge value={item.feedback.status} /></td></tr>; })}</tbody></table></div>
      <div className="space-y-3 bg-slate-50/50 p-3 lg:hidden">{(data?.items || []).map((item) => <AlertMobileCard key={item.alertId} item={item} running={runningId === item.alertId} onOpen={openAlert} />)}</div>
      {!loading && !(data?.items || []).length ? <div className="px-6 py-16 text-center"><Network className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-700">No real alerts match these filters.</p><p className="mt-1 text-xs text-slate-500">No alerts, evidence, or feedback labels are fabricated.</p></div> : null}{loading ? <div className="flex items-center justify-center gap-2 px-6 py-14 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />Loading the rolling alert dataset…</div> : null}<div className="flex items-center justify-between border-t border-slate-100 px-5 py-4"><button className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40" type="button" disabled={pagination.page <= 1 || loading} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ArrowLeft className="h-3.5 w-3.5" />Previous</button><p className="text-[11px] text-slate-500">Page {pagination.page} of {Math.max(1, pagination.totalPages)}</p><button className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40" type="button" disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next<ArrowRight className="h-3.5 w-3.5" /></button></div></section>
    <section className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><p className="text-xs font-semibold text-blue-950">Feedback learning remains controlled</p><p className="mt-1 text-[10px] leading-5 text-blue-800">Recommendation → human review → confirmed outcome → evaluation dataset. No continuous automatic retraining or source action is enabled.</p></div><Link className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-bold text-blue-700" to="/model-evaluation">View Model Evaluation<ArrowRight className="h-3 w-3" /></Link></div></section>
    {selected ? <EvaluationDrawer item={selected} authentication={authentication} onClose={() => setSelected(null)} onUpdated={() => load(true)} onReviewNext={() => reviewNextAlert(selected.alertId)} /> : null}
  </div>;
}

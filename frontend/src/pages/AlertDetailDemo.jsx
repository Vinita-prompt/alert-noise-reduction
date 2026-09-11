import {
  Activity,
  BookOpenText,
  ChevronDown,
  ExternalLink,
  MessageSquareText,
  RefreshCw,
  Tag,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getOperationsLiveAlert,
  getOperationsLiveAlertActivity,
  getOperationsLiveAlertNotes,
  getOperationsLiveAlertSlackContext,
  getSlackThread,
} from '../services/api.js';
import {
  cleanOperationsMarkup,
  compactOperationsText,
  formatOperationsDescription,
  formatOperatorTime,
  formatOperatorTimestamp,
  resolveOperatorIdentities,
  sourceActionLabel,
  validOperationsUrl,
} from '../utils/operationsPresentation.js';

const statusTone = {
  Acknowledged: 'bg-blue-50 text-blue-700',
  Closed: 'bg-emerald-50 text-emerald-700',
  Open: 'bg-rose-50 text-rose-700',
  Unacknowledged: 'bg-rose-50 text-rose-700',
};

function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return null;
  const seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function humanizeKey(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function capitalizeSimple(value) {
  if (!value) return value;
  return /^[a-z]+$/.test(value) ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function readableValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return value;
}

function conciseText(value, limit = 520) {
  const text = compactOperationsText(String(value || '')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<@[^>]+>/g, 'a responder')
    .replace(/:white_check_mark:/g, '✓')
    .replace(/[*`]/g, ''));
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > limit * 0.75 ? boundary : limit).trim()}…`;
}

function normalizeTagChips(tags = []) {
  const hiddenKeys = new Set(['og_priority', 'page', 'slack']);
  const seen = new Set();
  return tags.map((tag) => {
    const value = String(tag || '').trim();
    const match = value.match(/^([^:=]+)[:=](.+)$/);
    if (!match) return value;
    const key = match[1].trim().toLowerCase();
    const tagValue = match[2].trim();
    if (!tagValue || hiddenKeys.has(key)) return null;
    return `${key}:${tagValue}`;
  }).filter((tag) => {
    if (!tag || !/[a-z0-9]/i.test(tag)) return false;
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFieldKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function valueFrom(object, ...keys) {
  if (!object || typeof object !== 'object') return null;
  const entries = new Map(Object.entries(object).map(([key, value]) => [normalizeFieldKey(key), value]));
  for (const key of keys) {
    const value = entries.get(normalizeFieldKey(key));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function labeledDescriptionFields(value) {
  const fields = {};
  cleanOperationsMarkup(value).split('\n').forEach((line) => {
    const match = line.match(/^([^:]{2,40})\s*:\s*(.+)$/);
    if (!match) return;
    const key = normalizeFieldKey(match[1]);
    if (!fields[key]) fields[key] = match[2].trim();
  });
  return fields;
}

function sourceKey(value) {
  return String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
}

function sourcePresentation(alert) {
  if (!alert) return { fields: [], key: 'unknown', summary: null, title: 'Source Details' };
  const key = sourceKey(alert.sourceSystem);
  const extra = alert.extraProperties || {};
  const described = labeledDescriptionFields(alert.description);
  const parsedDescription = formatOperationsDescription(alert.description);
  const parsedValue = (label) => parsedDescription.find((section) => section.label === label)?.paragraphs?.[0] || null;
  const sourceDetails = alert.sourceDetails || {};

  if (key === 'nagios') {
    const host = described.host || valueFrom(extra, 'host_name', 'host_alias') || sourceDetails.host;
    const service = described.service || valueFrom(extra, 'service_name') || sourceDetails.nagiosService;
    const state = described.state || valueFrom(extra, 'host_state', 'service_state');
    const address = described.address || valueFrom(extra, 'host_address');
    const output = described.additionalinfo || described.output || valueFrom(extra, 'host_output', 'service_output');
    const attempt = valueFrom(extra, 'host_attempt', 'service_attempt');
    const maxAttempts = valueFrom(extra, 'max_host_attempts', 'max_service_attempts');
    const attempts = attempt && maxAttempts ? `${attempt} of ${maxAttempts}` : attempt || maxAttempts;
    const unreachable = /unreachable/i.test(String(output || ''));
    const summary = host && service && state
      ? `Service ${service} on ${host} is ${state}.`
      : host && state
        ? `Host ${host} is ${state}${unreachable ? ' and unreachable' : ''}.`
        : null;
    return {
      fields: [
        ['Host', host],
        ['Service', service],
        ['State', state],
        ['Address', address],
        ['Notification Type', described.notificationtype],
        [described.additionalinfo ? 'Additional Info' : 'Output', output],
        ['Attempts', attempts],
        ['Duration', valueFrom(extra, 'host_duration', 'service_duration')],
        ['Latency', valueFrom(extra, 'host_latency', 'service_latency')],
        ['Performance data', valueFrom(extra, 'host_perf_data', 'service_perf_data')],
        ['Nagios server', valueFrom(extra, 'nagios_server')],
        ['Date/Time', described.datetime],
      ],
      key,
      summary,
      title: 'Nagios Details',
    };
  }

  if (key === 'appdynamics') {
    return {
      fields: [
        ['Tier', alert.tier || parsedValue('Tier')],
        ['Business transaction', valueFrom(extra, 'Entity') || alert.entity],
        ['Severity', parsedValue('Severity') || alert.severity],
        ['Event time', parsedValue('Event Time')],
        ['Health rule', valueFrom(extra, 'Health Rule', 'Health Rule ID')],
        ['Controller', valueFrom(extra, 'Controller URL') || sourceDetails.controllerUrl],
      ],
      key,
      summary: null,
      title: 'AppDynamics Details',
    };
  }

  if (key === 'grafana') {
    return {
      fields: [
        ['Service', alert.service],
        ['Team', alert.team],
        ['Environment', alert.environment],
        ['Folder', sourceDetails.grafanaFolder || valueFrom(extra, 'grafana_folder')],
        ['Runbook', alert.runbook, alert.runbook],
      ],
      key,
      summary: null,
      title: 'Grafana Details',
    };
  }

  if (key === 'thousandeyes') {
    const permalink = valueFrom(extra, 'Permalink');
    return {
      fields: [
        ['Type', valueFrom(extra, 'Type')],
        ['Violation count', valueFrom(extra, 'Violation Count', 'violationCount')],
        ['Rule', valueFrom(extra, 'Rule')],
        ['Rule ID', valueFrom(extra, 'Rule ID', 'ruleId')],
        ['Event ID', valueFrom(extra, 'Event ID', 'eventId')],
        ['Permalink', permalink, permalink],
      ],
      key,
      summary: null,
      title: 'ThousandEyes Details',
    };
  }

  return {
    fields: [],
    key,
    summary: null,
    title: 'Source Details',
  };
}

function lifecycleCategory(item) {
  const text = `${item?.category || ''} ${item?.type || ''} ${item?.message || ''}`.toLowerCase();
  const lowerValueEvent = /added as recipient|routing rule|notification|submitted to provider|executionstatus|successful http execution|sent \[[^\]]+\] (?:notification|action)|received \[[^\]]+\] notification|executed \[[^\]]+\] action/.test(text);
  if (lowerValueEvent) return null;
  if (/alert unacknowledged|acknowledgement removed/.test(text)) return 'unacknowledged';
  if (/alert acknowledged|acknowledged by/.test(text)) return 'acknowledged';
  if (/alert closed|\bclosed\b/.test(text)) return 'closed';
  if (/alert created|\bcreated\b/.test(text)) return 'created';
  if (/reopened/.test(text)) return 'reopened';
  if (/alert escalated|status changed to escalated/.test(text)) return 'escalated';
  if (/assigned|ownership changed/.test(text) && !/recipient|routing rule|notification/.test(text)) return 'assigned';
  return null;
}

function timestampValue(item) {
  const parsed = Date.parse(item?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultLifecycleItems(items = [], currentOwner) {
  const ordered = [...items].sort((left, right) => timestampValue(left) - timestampValue(right));
  const meaningful = ordered
    .map((item) => ({ ...item, presentationCategory: lifecycleCategory(item) }))
    .filter((item) => item.presentationCategory);
  const assignments = meaningful.filter((item) => item.presentationCategory === 'assigned');
  const preferredAssignment = assignments.find((item) => currentOwner && item.actor === currentOwner) || assignments.at(-1) || null;
  const seen = new Set();
  return meaningful.filter((item) => {
    if (item.presentationCategory === 'assigned' && item !== preferredAssignment) return false;
    const signature = `${item.presentationCategory}|${item.actor || ''}|${item.timestamp || ''}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function fullActivityItems(items = []) {
  return [...items].sort((left, right) => timestampValue(left) - timestampValue(right));
}

function DetailField({ label, value, mono = false }) {
  const displayValue = readableValue(value);
  if (!displayValue && displayValue !== 0) return null;
  const emailValue = typeof displayValue === 'string' && /\S+@\S+/.test(displayValue);
  return (
    <div className={`min-w-0 ${emailValue ? 'col-span-2 sm:col-span-1' : ''}`}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</dt>
      <dd className={`mt-1 text-sm font-semibold leading-5 text-slate-700 ${emailValue ? 'truncate' : 'break-words'} ${mono ? 'font-mono text-xs font-medium' : ''}`} title={emailValue ? displayValue : undefined}>{displayValue}</dd>
    </div>
  );
}

function SourceDetailField({ label, value, href }) {
  const displayValue = readableValue(value);
  if (!displayValue && displayValue !== 0) return null;
  const safeHref = validOperationsUrl(href);
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold leading-5 text-slate-700">
        {safeHref ? <a className="inline-flex items-center gap-1.5 text-teal-700 hover:text-teal-800" href={safeHref} target="_blank" rel="noreferrer">{displayValue}<ExternalLink className="h-3.5 w-3.5 shrink-0" /></a> : displayValue}
      </dd>
    </div>
  );
}

function OperatorIdentityValue({ candidates = [], primary, compact = false }) {
  const identities = resolveOperatorIdentities(primary, candidates);
  if (!identities.length) return null;
  return (
    <span className={`block min-w-0 ${compact ? 'space-y-0.5' : 'space-y-1'}`}>
      {identities.map((identity, index) => (
        <span className="block min-w-0" key={`${identity.email || identity.displayName || identity.fallback}-${index}`}>
          {identity.displayName ? <span className="block break-words">{identity.displayName}</span> : null}
          {identity.email ? <span className={`block break-all ${identity.displayName ? 'font-medium text-slate-500' : ''}`} title={identity.email}>{identity.email}</span> : null}
          {!identity.displayName && !identity.email ? <span className="block break-words" title={identity.fallback}>{identity.fallback}</span> : null}
        </span>
      ))}
    </span>
  );
}

function OperatorIdentityField({ candidates = [], label, primary }) {
  const identities = resolveOperatorIdentities(primary, candidates);
  if (!identities.length) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm font-semibold leading-5 text-slate-700"><OperatorIdentityValue candidates={candidates} primary={primary} /></dd>
    </div>
  );
}

function FormattedDescription({ sections }) {
  return (
    <div className="space-y-4">
      {sections.map((section, sectionIndex) => (
        <div key={`${section.label || 'description'}-${sectionIndex}`}>
          {section.label ? <h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{section.label}</h3> : null}
          <div className={`${section.label ? 'mt-1.5' : ''} space-y-2`}>
            {section.paragraphs.map((paragraph, paragraphIndex) => <p key={`${paragraphIndex}-${paragraph.slice(0, 20)}`} className="break-words text-sm leading-6 text-slate-700">{paragraph}</p>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadButton({ icon: Icon, label, loading, loadingLabel, onClick }) {
  return (
    <button className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={loading} onClick={onClick}>
      <Icon className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? loadingLabel : label}
    </button>
  );
}

function DrawerSection({ id, number, title, description, action, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby={id}>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-teal-700">{number}</p>
          <h2 id={id} className="mt-1 text-base font-semibold text-slate-950">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DrawerSkeleton() {
  return (
    <div className="space-y-4 p-5 sm:p-6" aria-label="Loading JSM Operations alert detail">
      {[0, 1, 2].map((item) => <div key={item} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5"><div className="h-3 w-28 rounded bg-slate-100" /><div className="mt-3 h-5 w-48 rounded bg-slate-100" /><div className="mt-5 grid grid-cols-2 gap-4"><span className="h-12 rounded bg-slate-100" /><span className="h-12 rounded bg-slate-100" /></div></div>)}
    </div>
  );
}

function activityLabel(item, detailed = false) {
  const category = item?.presentationCategory || item?.category;
  const message = String(item?.message || '').toLowerCase();
  const lifecycle = {
    acknowledged: 'Acknowledged',
    assigned: 'Assigned',
    closed: 'Closed',
    created: 'Alert created',
    escalated: 'Escalated',
    reopened: 'Alert reopened',
    unacknowledged: 'Unacknowledged',
  }[String(category || '').toLowerCase()];
  if (lifecycle) return lifecycle;
  if (!detailed) return 'Operations activity';
  if (/added as recipient|routing rule/.test(message)) return 'Assigned';
  if (/notification|submitted to provider|\bemail\b|\bmobile\b|\bsms\b|\bvoice\b/.test(message)) return 'Notification';
  if (/plugin|integration|oec\[|http execution/.test(message)) return 'Integration activity';
  return {
    routing: 'Assigned',
    notification: 'Notification',
    integration: 'Integration activity',
  }[String(category || '').toLowerCase()] || humanizeKey(category || 'Operations activity');
}

export default function AlertDetailDemo() {
  const { alertId } = useParams();
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');
  const [fullActivity, setFullActivity] = useState(false);
  const [notes, setNotes] = useState(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [slackContext, setSlackContext] = useState(null);
  const [slackLoading, setSlackLoading] = useState(false);
  const [slackError, setSlackError] = useState('');
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setActivity(null);
    setNotes(null);
    setSlackContext(null);
    setThread(null);
    setFullActivity(false);
    setShowAllTags(false);

    getOperationsLiveAlert(alertId)
      .then((nextAlert) => { if (active) setAlert(nextAlert); })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [alertId]);

  const source = useMemo(() => sourcePresentation(alert), [alert]);
  const detailTags = useMemo(() => normalizeTagChips([
    ...(alert?.rawTags || alert?.tags || []),
    alert?.service ? `service:${alert.service}` : null,
    alert?.environment ? `environment:${alert.environment}` : null,
    alert?.team ? `team:${alert.team}` : null,
  ].filter(Boolean)), [alert]);
  const visibleTags = showAllTags ? detailTags : detailTags.slice(0, 5);
  const displayTitle = String(alert?.title || '').replace(/\*\*/g, '').trim();
  const lifecycle = activity?.summary || {};
  const correlation = slackContext?.correlation || alert?.slackCorrelation || null;
  const responderRecords = (alert?.responders || [])
    .filter((responder) => responder?.name && !/^(?:og-[a-f0-9-]+|[a-f0-9]{20,})$/i.test(responder.name));
  const ownerIdentities = resolveOperatorIdentities(
    alert?.responderTeam || alert?.responder || alert?.team || alert?.owner || alert?.currentOwner,
    alert?.responders || [],
  );
  const responderIdentities = resolveOperatorIdentities(null, responderRecords);
  const descriptionSections = useMemo(() => formatOperationsDescription(alert?.description), [alert]);
  const sourceFields = source.fields.filter(([, value]) => value !== null && value !== undefined && value !== '');
  const sourceUrl = validOperationsUrl(alert?.sourceUrl);
  const runbookUrl = validOperationsUrl(alert?.runbook);
  const hasDescription = Boolean(source.summary || descriptionSections.length);
  const hasContext = [
    alert?.owner,
    alert?.currentOwner,
    ownerIdentities.length,
    responderIdentities.length,
    alert?.team,
    alert?.service,
    alert?.application,
    alert?.environment,
    alert?.tier,
  ].some(Boolean);
  const visibleActivityItems = fullActivity
    ? fullActivityItems(activity?.items || [])
    : defaultLifecycleItems(activity?.items || [], alert?.owner || alert?.currentOwner);

  async function loadActivity(includeAll = fullActivity) {
    setActivityLoading(true);
    setActivityError('');
    try {
      setActivity(await getOperationsLiveAlertActivity(alertId, { full: includeAll }));
    } catch (requestError) {
      setActivityError(requestError.message);
    } finally {
      setActivityLoading(false);
    }
  }

  async function toggleFullActivity() {
    const next = !fullActivity;
    setFullActivity(next);
    if (activity) await loadActivity(next);
  }

  async function loadNotes() {
    setNotesLoading(true);
    setNotesError('');
    try {
      setNotes(await getOperationsLiveAlertNotes(alertId));
    } catch (requestError) {
      setNotesError(requestError.message);
    } finally {
      setNotesLoading(false);
    }
  }

  async function loadSlackContext() {
    setSlackLoading(true);
    setSlackError('');
    try {
      setSlackContext(await getOperationsLiveAlertSlackContext(alertId));
    } catch (requestError) {
      setSlackError(requestError.message);
    } finally {
      setSlackLoading(false);
    }
  }

  async function loadThread(threadTs) {
    if (!threadTs) return;
    setThreadLoading(true);
    setSlackError('');
    try {
      setThread(await getSlackThread(threadTs, { includePermalinks: true, includeUserProfiles: true }));
    } catch (requestError) {
      setSlackError(requestError.message);
    } finally {
      setThreadLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 lg:left-[268px]">
      <Link className="absolute inset-0 bg-slate-950/25 backdrop-blur-[1px]" to="/live-alerts" aria-label="Close alert details" />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-slate-200 bg-slate-50 shadow-2xl sm:max-w-[min(900px,calc(100vw-2rem))]" role="dialog" aria-modal="true" aria-labelledby="alert-drawer-title">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-teal-700">{alert ? `Alert #${alert.tinyId || alert.alertNumber}` : 'Alert investigation'}</p>
                {alert?.sourceSystem ? <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-600">{alert.sourceSystem}</span> : null}
                {alert?.priority ? <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">{alert.priority}</span> : null}
                {alert?.status ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusTone[alert.status] || 'bg-slate-100 text-slate-600'}`}>{alert.status}</span> : null}
              </div>
              <h1 id="alert-drawer-title" className="mt-1 truncate text-base font-semibold text-slate-950 sm:text-lg">{displayTitle || (loading ? 'Loading Operations alert…' : 'Operations alert details')}</h1>
            </div>
            <Link className="rounded-xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900" to="/live-alerts" aria-label="Close alert details"><X className="h-4 w-4" /></Link>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="m-5 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800" role="alert"><p className="font-semibold">Operations alert detail could not be loaded</p><p className="mt-1 text-xs leading-5">{error}</p></div>
          ) : loading ? <DrawerSkeleton /> : alert ? (
            <div className="space-y-4 p-4 pb-10 sm:p-6 sm:pb-10">
              <DrawerSection id="alert-overview-heading" number="01 · Alert overview" title="Alert Overview">
                <p className="break-words text-sm leading-6 text-slate-700">{source.key === 'nagios' && source.summary ? source.summary : conciseText(alert.message || alert.title, 1200)}</p>
                <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 rounded-xl border border-slate-100 bg-slate-50/70 p-4 sm:grid-cols-4">
                  <DetailField label="Source" value={alert.sourceSystem} />
                  <DetailField label="Priority" value={alert.priority} />
                  <DetailField label="Status" value={alert.status} />
                  <DetailField label="Severity" value={alert.severity} />
                  <DetailField label="Occurrences" value={alert.occurrenceCount ?? alert.occurrences} />
                  <DetailField label="Integration" value={alert.integration?.name} />
                </dl>
              </DrawerSection>

              {hasContext ? (
                <DrawerSection id="context-heading" number="02 · Context" title="Context">
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                    <OperatorIdentityField label="Owner" primary={alert.responderTeam || alert.responder || alert.team || alert.owner || alert.currentOwner} candidates={alert.responders || []} />
                    <OperatorIdentityField label="Responder" candidates={responderRecords} />
                    <DetailField label="Team" value={alert.team} />
                    <DetailField label="Service" value={capitalizeSimple(alert.service)} />
                    <DetailField label="Application" value={capitalizeSimple(alert.application)} />
                    <DetailField label="Environment" value={capitalizeSimple(alert.environment)} />
                    <DetailField label="Tier" value={alert.tier} />
                  </dl>
                </DrawerSection>
              ) : null}

              <DrawerSection id="timing-heading" number="03 · Timing" title="Timing">
                <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                  <DetailField label="Created at" value={formatOperatorTimestamp(alert.createdAt)} />
                  <DetailField label="Updated at" value={formatOperatorTimestamp(alert.updatedAt)} />
                  <DetailField label="Last occurrence" value={formatOperatorTimestamp(alert.lastOccurredAt)} />
                  <DetailField label="Acknowledged at" value={formatOperatorTimestamp(lifecycle.ackTime || alert.ackTime)} />
                  <OperatorIdentityField label="Acknowledged by" primary={lifecycle.acknowledgedBy} />
                  <DetailField label="MTTA" value={formatDuration(lifecycle.mttaMs ?? alert.mttaMs)} />
                  <DetailField label="Closed at" value={formatOperatorTimestamp(lifecycle.closeTime || alert.closeTime)} />
                  <OperatorIdentityField label="Closed by" primary={lifecycle.closedBy} />
                  <DetailField label="Time to close" value={formatDuration(lifecycle.timeToCloseMs ?? alert.timeToCloseMs)} />
                </dl>
              </DrawerSection>

              {hasDescription ? (
                <DrawerSection id="description-heading" number="04 · Description" title="Description">
                  {source.key === 'nagios' && source.summary
                    ? <p className="break-words text-sm leading-6 text-slate-700">{source.summary}</p>
                    : <FormattedDescription sections={descriptionSections} />}
                </DrawerSection>
              ) : null}

              {sourceFields.length || detailTags.length ? (
                <DrawerSection id="source-details-heading" number="05 · Source details" title={source.title}>
                  {sourceFields.length ? <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">{sourceFields.map(([label, value, href]) => <SourceDetailField key={label} label={label} value={value} href={href} />)}</dl> : null}
                  {detailTags.length ? (
                    <div className={`${sourceFields.length ? 'mt-5 border-t border-slate-100 pt-4' : ''} flex flex-wrap items-center gap-2`}>
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400"><Tag className="h-3.5 w-3.5" />Tags</span>
                      {visibleTags.map((tag) => <span key={tag} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600">{tag}</span>)}
                      {detailTags.length > 5 ? <button className="text-xs font-bold text-teal-700" type="button" onClick={() => setShowAllTags((current) => !current)}>{showAllTags ? 'Show fewer' : `View all tags (+${detailTags.length - 5})`}</button> : null}
                    </div>
                  ) : null}
                </DrawerSection>
              ) : null}

              <DrawerSection
                id="activity-heading"
                number="06 · Activity & notes"
                title="Activity & Notes"
                action={<LoadButton icon={Activity} label={activity ? 'Refresh activity' : 'Load activity'} loading={activityLoading} loadingLabel="Loading…" onClick={() => loadActivity()} />}
              >
                {activityError ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{activityError}</p> : null}
                {activity ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-slate-500">{visibleActivityItems.length} {fullActivity ? 'event' : 'important event'}{visibleActivityItems.length === 1 ? '' : 's'}</p>
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600"><input type="checkbox" checked={fullActivity} onChange={toggleFullActivity} />Show full activity</label>
                    </div>
                    {visibleActivityItems.length ? <div className="relative mt-4 space-y-3 pl-5"><span className="absolute bottom-2 left-1 top-2 w-px bg-slate-200" />{visibleActivityItems.map((item, index) => { const actor = item.actor || (lifecycleCategory(item) === 'created' ? alert.integration?.name || alert.sourceSystem : null); return <article key={item.id || `${item.timestamp}-${index}`} className="relative rounded-xl border border-slate-100 bg-slate-50/70 p-3.5"><span className={`absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border-2 border-white ring-1 ${index === 0 ? 'bg-teal-500 ring-teal-200' : 'bg-slate-300 ring-slate-200'}`} /><time className="block text-[10px] font-semibold text-slate-400" title={formatOperatorTimestamp(item.timestamp)}>{formatOperatorTime(item.timestamp)}</time><p className="mt-1 text-xs font-semibold text-slate-800">{activityLabel(item, fullActivity)}</p>{actor ? <div className="mt-1 flex min-w-0 gap-1 text-xs text-slate-500"><span className="shrink-0">Actor:</span><OperatorIdentityValue primary={actor} compact /></div> : null}{fullActivity && item.message ? <p className="mt-2 break-words text-xs leading-5 text-slate-600">{conciseText(item.message)}</p> : null}</article>; })}</div> : <p className="mt-4 text-sm text-slate-500">No meaningful lifecycle events.</p>}
                  </>
                ) : <p className="text-sm text-slate-500">Load activity to see acknowledgements, closure details, and other meaningful lifecycle events.</p>}

                <div className="mt-5 border-t border-slate-100 pt-5">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><h3 className="text-sm font-semibold text-slate-900">Operations Notes</h3><LoadButton icon={BookOpenText} label={notes ? 'Refresh notes' : 'Load notes'} loading={notesLoading} loadingLabel="Loading…" onClick={loadNotes} /></div>
                  {notesError ? <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{notesError}</p> : null}
                  {notes ? notes.items.length ? <div className="mt-4 space-y-3">{notes.items.map((note) => <article key={note.id} className="rounded-xl border border-slate-200 p-3.5"><div className="flex flex-wrap justify-between gap-2"><p className="truncate text-xs font-semibold text-slate-800" title={note.author || 'Operations'}>{note.author || 'Operations'}</p><time className="text-[10px] text-slate-400">{formatOperatorTimestamp(note.timestamp)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{note.note}</p></article>)}</div> : <p className="mt-4 text-sm text-slate-500">No Operations notes.</p> : null}
                </div>
              </DrawerSection>

              <DrawerSection
                id="slack-context-heading"
                number="07 · Slack context"
                title="Slack Context"
                action={<LoadButton icon={MessageSquareText} label={slackContext ? 'Refresh Slack' : 'Load Slack'} loading={slackLoading} loadingLabel="Loading…" onClick={loadSlackContext} />}
              >
                <span className={`inline-flex rounded-lg border px-3 py-2 text-xs font-semibold ${correlation?.available ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>{correlation?.available ? `${correlation.messageCount} matching Slack message${correlation.messageCount === 1 ? '' : 's'}${correlation.replyCount ? ` · ${correlation.replyCount} replies` : ''}` : 'No matching Slack messages'}</span>
                {slackError ? <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{slackError}</p> : null}
                {slackContext?.correlation?.messages?.length ? <div className="mt-4 space-y-3">{slackContext.correlation.messages.map((message) => <article key={message.messageTs} className="rounded-xl border border-violet-100 bg-violet-50/25 p-4"><div className="flex flex-wrap justify-between gap-2"><p className="truncate text-xs font-semibold text-slate-800" title={message.author?.name || message.author?.id || 'Slack user'}>{message.author?.name || message.author?.id || 'Slack user'}</p><time className="text-[10px] text-slate-400">{formatOperatorTimestamp(message.messageAt)}</time></div><p className="mt-2 break-words text-sm leading-6 text-slate-600">{conciseText(message.message)}</p><div className="mt-3 flex flex-wrap gap-4">{message.slackPermalink ? <a className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700" href={message.slackPermalink} target="_blank" rel="noreferrer">View in Slack<ExternalLink className="h-3.5 w-3.5" /></a> : null}{message.threadTs ? <button className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 disabled:opacity-45" type="button" disabled={threadLoading} onClick={() => loadThread(message.threadTs)}><RefreshCw className={`h-3.5 w-3.5 ${threadLoading ? 'animate-spin' : ''}`} />Load full thread</button> : null}</div></article>)}</div> : slackContext ? <p className="mt-4 text-sm text-slate-500">No matching Slack messages.</p> : null}
                {thread ? <div className="mt-5 border-t border-slate-100 pt-5"><h3 className="text-sm font-semibold text-slate-950">Full Slack thread</h3><div className="mt-3 space-y-3">{[thread.parent, ...(thread.replies || [])].filter(Boolean).map((message, index) => <article key={message.ts || index} className="rounded-xl border border-violet-100 bg-violet-50/25 p-4"><div className="flex flex-wrap justify-between gap-2"><p className="truncate text-xs font-semibold text-slate-800" title={message.user_display_name || message.user_name || message.user_id || 'Slack user'}>{message.user_display_name || message.user_name || message.user_id || 'Slack user'}</p><time className="text-[10px] text-slate-400">{formatOperatorTimestamp(message.created_at || message.message_ts)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{message.text}</p></article>)}</div></div> : null}
              </DrawerSection>

              <DrawerSection id="investigation-heading" number="08 · Investigation / source" title="Investigation">
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DetailField label="Source" value={alert.integration?.name || alert.sourceSystem} />
                  {source.key === 'nagios' ? <DetailField label="Description" value="Use Nagios to inspect host/service state, daemon health, and related performance details." /> : null}
                </dl>
                {runbookUrl || sourceUrl ? <div className="mt-4 flex flex-wrap gap-2">{runbookUrl ? <a className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-teal-700" href={runbookUrl} target="_blank" rel="noreferrer">Runbook<ExternalLink className="h-3.5 w-3.5" /></a> : null}{sourceUrl ? <a className="inline-flex items-center gap-1.5 rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800" href={sourceUrl} target="_blank" rel="noreferrer">{sourceActionLabel(alert.sourceSystem)}<ExternalLink className="h-3.5 w-3.5" /></a> : null}</div> : null}
              </DrawerSection>

              <details className="group overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 text-sm font-semibold text-slate-800 marker:hidden">
                  <span><span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-teal-700">09 · Technical metadata</span><span className="mt-1 block">Canonical identifiers and raw Operations payload</span></span>
                  <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
                </summary>
                <div className="border-t border-slate-100 p-5">
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                    <DetailField label="Canonical ID" value={alert.canonicalOperationsId || alert.id} mono />
                    <DetailField label="tinyId" value={alert.tinyId || alert.alertNumber} mono />
                    <DetailField label="Alias" value={alert.alias} mono />
                    <DetailField label="Integration type" value={alert.integration?.type} />
                    <DetailField label="Original source" value={alert.sourceDetails?.originalSource || alert.sourceSystem} />
                    <DetailField label="Raw status" value={alert.operationsStatus || alert.rawOperationsPayload?.status} />
                    <DetailField label="Raw priority" value={alert.rawOperationsPayload?.priority || alert.priority} />
                  </dl>
                  {alert.description ? <details className="group/description mt-5 rounded-xl border border-slate-200"><summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-semibold text-slate-700 marker:hidden">Raw description<ChevronDown className="h-3.5 w-3.5 transition group-open/description:rotate-180" /></summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200">{alert.description}</pre></details> : null}
                  {alert.rawOperationsPayload?.extraProperties ? <details className="group/extra mt-5 rounded-xl border border-slate-200"><summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-semibold text-slate-700 marker:hidden">extraProperties<ChevronDown className="h-3.5 w-3.5 transition group-open/extra:rotate-180" /></summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200">{JSON.stringify(alert.rawOperationsPayload.extraProperties, null, 2)}</pre></details> : null}
                  <details className="group/raw mt-3 rounded-xl border border-slate-200"><summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-semibold text-slate-700 marker:hidden">Raw payload<ChevronDown className="h-3.5 w-3.5 transition group-open/raw:rotate-180" /></summary><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border-t border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200">{JSON.stringify(alert.rawOperationsPayload || {}, null, 2)}</pre></details>
                </div>
              </details>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

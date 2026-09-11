import {
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Ellipsis,
  ExternalLink,
  Link2,
  LockKeyhole,
  MessageSquarePlus,
  ShieldAlert,
  Tag,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ActionabilityBadge,
  DemoDataBadge,
  NoiseBadge,
  SeverityBadge,
  SourceChips,
} from '../operational/DemoUi.jsx';
import {
  operationsCardPresentation,
  resolveOperatorIdentities,
  sourceActionLabel,
  validOperationsUrl,
} from '../../utils/operationsPresentation.js';

const severityAccent = {
  Critical: 'border-l-rose-500',
  High: 'border-l-orange-400',
  Medium: 'border-l-amber-400',
  Low: 'border-l-slate-300',
};

const statusTone = {
  Acknowledged: 'bg-blue-50 text-blue-700',
  Closed: 'bg-emerald-50 text-emerald-700',
  Firing: 'bg-rose-50 text-rose-700',
  Grouped: 'bg-violet-50 text-violet-700',
  Identified: 'bg-blue-50 text-blue-700',
  Investigating: 'bg-blue-50 text-blue-700',
  Monitoring: 'bg-amber-50 text-amber-700',
  Open: 'bg-rose-50 text-rose-700',
  Resolved: 'bg-emerald-50 text-emerald-700',
  Stale: 'bg-slate-100 text-slate-600',
};

const terminalStatuses = new Set(['Closed', 'Resolved', 'Stale']);

function formatCompactTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    hour12: true,
    minute: '2-digit',
  }).format(date);
}

function capitalizeSimple(value) {
  if (!value) return value;
  return /^[a-z]+$/.test(value) ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function CompactField({ label, value }) {
  if (!value && value !== 0) return null;
  const displayValue = ['Environment', 'Service', 'Team'].includes(label) ? capitalizeSimple(value) : value;
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="mt-0.5 max-h-10 overflow-hidden break-words text-xs font-semibold leading-5 text-slate-800" title={String(displayValue)}>{displayValue}</dd>
    </div>
  );
}

function CompactOwner({ candidates, primary }) {
  const identities = resolveOperatorIdentities(primary, candidates);
  if (!identities.length) return null;
  const identity = identities[0];
  const compactEmail = identity.email?.split('@')[0] || null;
  return (
    <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
      <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Owner</p>
      {identity.displayName ? <p className="mt-0.5 break-words text-xs font-bold text-slate-800">{identity.displayName}</p> : null}
      {identity.email ? <p className={`mt-0.5 truncate text-xs ${identity.displayName ? 'font-medium text-slate-500' : 'font-semibold text-slate-800'}`} title={identity.email}>{identity.displayName ? identity.email : compactEmail}</p> : null}
      {!identity.displayName && !identity.email ? <p className="mt-0.5 truncate text-xs font-semibold text-slate-800" title={identity.fallback}>{identity.fallback}</p> : null}
    </div>
  );
}

function LiveAlertCard({ alert, onNewAlertSeen, showFullDetailsLink }) {
  const cardRef = useRef(null);
  const presentation = operationsCardPresentation(alert);
  const displayedSeverity = alert.severity || presentation.severity;
  const ownerPrimary = alert.responderTeam || alert.responder || alert.team || alert.owner || alert.currentOwner;
  const ownerIdentities = resolveOperatorIdentities(ownerPrimary, alert.responders || []);
  const sourceUrl = validOperationsUrl(alert.sourceUrl);
  const runbookUrl = validOperationsUrl(alert.runbook);
  const title = String(alert.title || 'Untitled alert').replace(/\*\*/g, '').trim();
  const slackMessageCount = Number(alert.slackCorrelation?.messageCount || 0);

  useEffect(() => {
    if (!alert.isNew || !cardRef.current || !onNewAlertSeen) return undefined;
    let viewedTimer;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && entry.intersectionRatio >= 0.35) {
        if (!viewedTimer) {
          viewedTimer = window.setTimeout(() => {
            onNewAlertSeen(alert.id);
            observer.disconnect();
          }, 4000);
        }
        return;
      }
      if (viewedTimer) {
        window.clearTimeout(viewedTimer);
        viewedTimer = undefined;
      }
    }, { threshold: 0.35 });
    observer.observe(cardRef.current);
    return () => {
      observer.disconnect();
      if (viewedTimer) window.clearTimeout(viewedTimer);
    };
  }, [alert.id, alert.isNew, onNewAlertSeen]);

  return (
    <article ref={cardRef} className={`overflow-hidden rounded-2xl border border-l-4 bg-white shadow-[0_16px_40px_-36px_rgba(15,23,42,0.65)] transition-colors ${alert.isNew ? 'border-teal-300 bg-teal-50/20 ring-2 ring-teal-100' : 'border-slate-200'} ${severityAccent[displayedSeverity] || 'border-l-slate-300'}`} data-testid="live-alert-card" data-source={presentation.key}>
      <header className="border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {alert.isNew ? <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-100 px-2 py-1 text-[9px] font-extrabold uppercase tracking-[0.14em] text-teal-800"><span className="h-1.5 w-1.5 rounded-full bg-teal-500" />NEW</span> : null}
            <p className="text-base font-extrabold tracking-tight text-teal-800">Alert #{alert.alertNumber || alert.tinyId}</p>
            {alert.slackCorrelation?.available ? <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-violet-700">Slack context · {slackMessageCount}</span> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-bold text-slate-600">{alert.sourceSystem || 'Unknown source'}</span>
            {alert.priority ? <span className="inline-flex rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-bold text-slate-700">{alert.priority}</span> : null}
            <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold ${statusTone[alert.status] || 'bg-slate-100 text-slate-600'}`}>{alert.status || 'Unknown'}</span>
            {displayedSeverity ? <SeverityBadge severity={displayedSeverity} /> : null}
          </div>
        </div>
        <h2 className="mt-2 text-base font-semibold leading-6 tracking-tight text-slate-950 sm:text-lg">{title}</h2>
      </header>

      <div className="px-4 py-3 sm:px-5">
        <div className={`grid gap-3 ${ownerIdentities.length ? 'lg:grid-cols-[minmax(0,1fr)_220px]' : ''}`}>
          {presentation.fields.length ? <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">{presentation.fields.map(([label, value]) => <CompactField key={label} label={label} value={value} />)}</dl> : null}
          {ownerIdentities.length ? <CompactOwner primary={ownerPrimary} candidates={alert.responders || []} /> : null}
        </div>

        {presentation.description ? <p className="mt-3 rounded-lg border-l-2 border-teal-300 bg-slate-50 px-3 py-2 text-xs font-medium leading-5 text-slate-600">{presentation.description}</p> : null}

        <div className="mt-3 flex flex-col justify-between gap-3 border-t border-slate-100 pt-3 xl:flex-row xl:items-center">
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <CompactField label="Created" value={formatCompactTimestamp(alert.createdAt)} />
            <CompactField label="Updated" value={formatCompactTimestamp(alert.updatedAt)} />
            <CompactField label="Occurrences" value={alert.occurrenceCount ?? alert.occurrences} />
          </dl>
          <div className="flex flex-wrap items-center gap-2" aria-label={`Read-only actions for Alert #${alert.alertNumber}`}>
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400"><LockKeyhole className="h-3 w-3" />Read-only</span>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] font-semibold text-slate-500 disabled:cursor-not-allowed" type="button" disabled title="Write actions are disabled."><CheckCircle2 className="h-3 w-3" />Acknowledge</button>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] font-semibold text-slate-500 disabled:cursor-not-allowed" type="button" disabled title="Write actions are disabled."><X className="h-3 w-3" />Close</button>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] font-semibold text-slate-500 disabled:cursor-not-allowed" type="button" disabled title="Write actions are disabled."><MessageSquarePlus className="h-3 w-3" />Add note</button>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap justify-end gap-2">
          {alert.slackCorrelation?.available && alert.slackPermalink ? <a className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 transition hover:bg-violet-50 hover:text-violet-900" href={alert.slackPermalink} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />View in Slack</a> : null}
          {runbookUrl ? <a className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-teal-700 hover:bg-slate-50 hover:text-teal-900" href={runbookUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Runbook</a> : null}
          {sourceUrl ? <a className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-slate-800" href={sourceUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />{sourceActionLabel(alert.sourceSystem)}</a> : null}
          {showFullDetailsLink ? <Link className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-[11px] font-bold text-teal-800 transition hover:bg-teal-100" to={`/live-alerts/${alert.id}`} onClick={() => onNewAlertSeen?.(alert.id)}><Link2 className="h-3.5 w-3.5" />View details</Link> : null}
        </div>
      </div>
    </article>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</dt>
      <dd className="mt-1.5 text-sm font-semibold leading-5 text-slate-700">{value || '—'}</dd>
    </div>
  );
}

function ActionDialog({ action, alert, busy, onCancel, onConfirm }) {
  const [note, setNote] = useState('');
  const requiresText = action === 'note';
  const actionLabel = {
    acknowledge: 'Acknowledge',
    close: 'Close alert',
    note: 'Add note',
    unacknowledge: 'Unacknowledge',
  }[action];
  const description = {
    acknowledge: 'This will assign the alert to Current User and add an acknowledgement event to its activity timeline.',
    close: 'This will mark the alert closed in the local demo and retain the optional resolution note in its activity.',
    note: 'Add investigation context for other operators. The note stays in this browser session only.',
    unacknowledge: 'This will return the alert to an unacknowledged firing state in the local demo.',
  }[action];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="alert-action-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DemoDataBadge label="Demo-only action" />
            <h2 id="alert-action-title" className="mt-4 text-xl font-semibold tracking-tight text-slate-950">{actionLabel} {alert.id}?</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
          </div>
          <button className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" type="button" onClick={onCancel} aria-label="Close confirmation">
            <X className="h-4 w-4" />
          </button>
        </div>

        {(requiresText || action === 'close') ? (
          <label className="mt-5 block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{requiresText ? 'Note' : 'Resolution note (optional)'}</span>
            <textarea
              className="mt-2 min-h-28 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-100"
              placeholder={requiresText ? 'What did you investigate or observe?' : 'Why is this alert being closed?'}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              autoFocus
            />
          </label>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50" type="button" onClick={onCancel}>Cancel</button>
          <button
            className={`rounded-xl px-4 py-2.5 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${action === 'close' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-950 hover:bg-slate-800'}`}
            type="button"
            disabled={busy || (requiresText && !note.trim())}
            onClick={() => onConfirm({ note: note.trim(), reason: note.trim() })}
          >
            {busy ? 'Updating…' : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OperationalAlertCard({
  alert,
  defaultExpanded = false,
  onNewAlertSeen,
  onAction,
  showFullDetailsLink = true,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [dialogAction, setDialogAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const isLive = Boolean(alert.liveData);
  const actionsDisabled = Boolean(alert.readOnlyActions);
  const terminal = terminalStatuses.has(alert.status);
  const activity = [...(alert.activity || [])].reverse();

  if (isLive) {
    return (
      <LiveAlertCard
        alert={alert}
        defaultExpanded={defaultExpanded}
        onNewAlertSeen={onNewAlertSeen}
        showFullDetailsLink={showFullDetailsLink}
      />
    );
  }

  async function confirmAction(payload) {
    setBusy(true);

    try {
      await onAction?.(alert, dialogAction, payload);
      setDialogAction(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <article className={`overflow-hidden rounded-2xl border border-l-4 border-slate-200 bg-white shadow-[0_18px_45px_-38px_rgba(15,23,42,0.55)] ${severityAccent[alert.severity] || severityAccent.Low}`}>
        <div className="border-b border-slate-100 p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-teal-700">{isLive ? `Alert #${alert.alertNumber}` : `Alert ${alert.id}`}</span>
                <span className="text-xs text-slate-400">Source event {alert.sourceEventId}</span>
                {isLive ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Live Slack data
                  </span>
                ) : <DemoDataBadge />}
              </div>
              <h2 className="mt-2 text-lg font-semibold leading-7 tracking-tight text-slate-950 sm:text-xl">{alert.title}</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <SeverityBadge severity={alert.severity || 'Not supplied'} />
                <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${statusTone[alert.status] || statusTone.Monitoring}`}>{alert.status || 'Not supplied'}</span>
                {!isLive ? alert.noiseStatus === 'Noise' ? (
                  <span className="inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-bold text-violet-700">Noise · {alert.noiseType}</span>
                ) : <NoiseBadge status={alert.noiseStatus} /> : null}
                {!isLive ? <ActionabilityBadge value={alert.actionability} /> : null}
                <span className="inline-flex rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600">{alert.priority ? `${alert.priority} priority` : 'Priority not supplied'}</span>
              </div>
            </div>

            <SourceChips sources={alert.sources || [alert.sourceSystem || 'Unknown']} />
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {alert.acknowledged ? (
              <button className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={terminal || actionsDisabled} title={actionsDisabled ? 'Real Slack actions are not enabled.' : undefined} onClick={() => setDialogAction('unacknowledge')}>
                <Check className="h-3.5 w-3.5" />
                Unacknowledge
              </button>
            ) : (
              <button className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={terminal || actionsDisabled} title={actionsDisabled ? 'Real Slack actions are not enabled.' : undefined} onClick={() => setDialogAction('acknowledge')}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Acknowledge
              </button>
            )}
            <button className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={terminal || actionsDisabled} title={actionsDisabled ? 'Real Slack actions are not enabled.' : undefined} onClick={() => setDialogAction('close')}>
              <X className="h-3.5 w-3.5" />
              {terminal ? 'Closed' : 'Close'}
            </button>
            <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-700 transition hover:border-teal-200 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={actionsDisabled} title={actionsDisabled ? 'Real Slack actions are not enabled.' : undefined} onClick={() => setDialogAction('note')}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Add note
            </button>
            <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-700 transition hover:border-teal-200 hover:text-teal-700" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
              <Ellipsis className="h-3.5 w-3.5" />
              More
              <ChevronDown className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        <div className="p-5 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center gap-2 text-slate-400"><BellRing className="h-4 w-4" /><span className="text-[10px] font-bold uppercase tracking-[0.1em]">Status</span></div>
              <p className="mt-2 text-sm font-semibold text-slate-900">{alert.status || 'Not supplied by Slack'}</p>
              <p className="mt-1 text-xs text-slate-500">{isLive ? 'Read-only extracted state' : alert.acknowledgedAt ? `Acknowledged at ${alert.acknowledgedAt}` : 'Awaiting acknowledgement'}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center gap-2 text-slate-400"><UserRound className="h-4 w-4" /><span className="text-[10px] font-bold uppercase tracking-[0.1em]">Responder</span></div>
              <p className="mt-2 text-sm font-semibold text-slate-900">{alert.responder || alert.acknowledgedBy || 'Not supplied'}</p>
              <p className="mt-1 text-xs text-slate-500">{isLive ? alert.author?.name || 'Slack author unavailable' : alert.team}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center gap-2 text-slate-400"><ShieldAlert className="h-4 w-4" /><span className="text-[10px] font-bold uppercase tracking-[0.1em]">Priority</span></div>
              <p className="mt-2 text-sm font-semibold text-slate-900">{[alert.priority, alert.severity].filter(Boolean).join(' · ') || 'Not supplied'}</p>
              <p className="mt-1 text-xs text-slate-500">{isLive ? 'Parsed only from explicit Slack text' : 'Severity remains independent from noise'}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Description</p>
              <div className="mt-2 space-y-1 text-sm leading-6 text-slate-600">
                {alert.tier ? <p><span className="font-semibold text-slate-800">Tier:</span> {alert.tier}</p> : null}
                <p className={isLive ? 'whitespace-pre-wrap break-words' : ''}><span className="font-semibold text-slate-800">Event message:</span> {alert.message}</p>
                {!isLive && alert.noiseReason ? <p>{alert.noiseReason}</p> : null}
              </div>
              <div className="mt-4 flex items-start gap-2">
                <Tag className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <div className="flex flex-wrap gap-1.5">
                  {(alert.tags || []).length ? alert.tags.map((tag) => <span key={tag} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600">{tag}</span>) : <span className="text-xs text-slate-400">No tags supplied</span>}
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-4">
              <Detail label="First seen" value={alert.firstSeen} />
              <Detail label="Last seen" value={alert.lastSeen} />
              <Detail label="Occurrences" value={alert.occurrences} />
              <Detail label={isLive ? 'Thread replies' : 'Related incident'} value={isLive ? alert.replyCount : alert.existingIncident || alert.relatedIncident || 'None'} />
            </dl>
          </div>

          {!isLive && alert.noiseStatus === 'Noise' ? (
            <div className="mt-5 rounded-xl border border-violet-100 bg-violet-50/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-violet-800">Why this is noise · {alert.noiseType}</p>
                <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-violet-600">{alert.noiseConfidence}% confidence</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-violet-900">{alert.noiseReason}</p>
            </div>
          ) : null}

          {expanded ? (
            <div className="mt-6 border-t border-slate-100 pt-6">
              <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                <div>
                  <h3 className="text-sm font-semibold text-slate-950">Full alert details</h3>
                  <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4">
                    <Detail label="Alert ID" value={alert.alertId} />
                    <Detail label="Source event ID" value={alert.sourceEventId} />
                    <Detail label="Service / app" value={[alert.service, alert.application].filter(Boolean).join(' / ')} />
                    <Detail label="Tier / environment" value={[alert.tier, alert.environment].filter(Boolean).join(' / ')} />
                    {isLive ? <Detail label="Source system" value={alert.sourceSystem} /> : <Detail label="Assigned team" value={alert.assignedTeam} />}
                    {isLive ? <Detail label="Slack author" value={alert.author?.name || alert.author?.id} /> : <Detail label="Correlation window" value={alert.correlationWindow} />}
                    <Detail label={isLive ? 'First seen' : 'Created'} value={isLive ? alert.firstSeen : alert.createdAt} />
                    <Detail label={isLive ? 'Last seen' : 'Updated'} value={isLive ? alert.lastSeen : alert.updatedAt} />
                    <Detail label="Slack context" value={alert.relatedSlackThread || 'None'} />
                    {isLive ? <Detail label="Slack channel" value={alert.slackChannelName ? `#${alert.slackChannelName}` : alert.slackChannelId} /> : <Detail label="Jira issue" value={alert.relatedJiraIssue || 'None'} />}
                  </dl>
                  {!isLive ? <div className="mt-5 rounded-xl border border-teal-100 bg-teal-50/60 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-teal-700">Recommended action</p>
                    <p className="mt-2 text-sm font-semibold leading-6 text-teal-950">{alert.recommendedAction}</p>
                  </div> : null}
                  {!isLive ? <div className="mt-5">
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">People involved</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(alert.peopleInvolved || []).map((person) => <span key={person} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600">{person}</span>)}
                    </div>
                  </div> : null}
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-slate-950">Activity timeline</h3>
                    <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{isLive ? 'Extraction events' : 'Audited demo events'}</span>
                  </div>
                  <div className="relative mt-4 space-y-4 pl-6">
                    <span className="absolute bottom-2 left-[5px] top-2 w-px bg-slate-200" aria-hidden="true" />
                    {activity.map((item, index) => (
                      <div key={`${item.timestamp}-${item.action}-${index}`} className="relative rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                        <span className={`absolute -left-[25px] top-4 h-2.5 w-2.5 rounded-full border-2 border-white ring-1 ${index === 0 ? 'bg-teal-500 ring-teal-200' : 'bg-slate-300 ring-slate-200'}`} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-slate-800">{item.event}</p>
                          <span className="text-[10px] font-bold text-slate-400">{item.time}</span>
                        </div>
                        <p className="mt-1 text-[10px] leading-4 text-slate-400">Action: {item.action} · User: {item.user} · Source: {item.source} · Result: {item.result}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="inline-flex items-center gap-2 text-[10px] text-slate-400"><Clock3 className="h-3.5 w-3.5" />{isLive ? 'Live Slack-derived record · real actions are disabled' : 'Static demo record · actions never call Slack, Jira, or monitoring APIs'}</p>
            {isLive && alert.slackPermalink ? (
              <a className="inline-flex items-center gap-2 text-xs font-semibold text-teal-700 transition hover:text-teal-900" href={alert.slackPermalink} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />View in Slack
              </a>
            ) : null}
            {showFullDetailsLink ? (
              <Link className="inline-flex items-center gap-2 text-xs font-semibold text-teal-700 transition hover:text-teal-900" to={`/live-alerts/${alert.id}`}>
                <Link2 className="h-3.5 w-3.5" />View full details
              </Link>
            ) : null}
          </div>
        </div>
      </article>

      {dialogAction ? (
        <ActionDialog
          action={dialogAction}
          alert={alert}
          busy={busy}
          onCancel={() => setDialogAction(null)}
          onConfirm={confirmAction}
        />
      ) : null}
    </>
  );
}

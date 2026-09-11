import { ArrowLeft, CheckCircle2, Clock3, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DetailField,
  formatJiraDate,
  PersonLabel,
  PriorityBadge,
  ReadOnlyJiraBadge,
  StatusBadge,
} from '../components/jira/AccJiraUi.jsx';
import { getAccIssue } from '../services/api.js';

function Section({ children, description, title }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
        {description ? <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p> : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function HistoryCard({ history }) {
  return (
    <article className="relative border-l border-slate-200 pb-5 pl-5 last:pb-0">
      <span className="absolute -left-1 top-1 h-2 w-2 rounded-full bg-teal-500 ring-4 ring-white" />
      <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-center">
        <p className="text-xs font-semibold text-slate-800">{history.actor?.displayName || history.actor?.email || 'Jira'}</p>
        <time className="text-[11px] text-slate-400">{formatJiraDate(history.createdAt)}</time>
      </div>
      <div className="mt-2 space-y-1">
        {history.items.map((item, index) => (
          <p className="text-xs leading-5 text-slate-600" key={`${history.id}-${item.field}-${index}`}>
            <span className="font-semibold text-slate-700">{item.field}</span>
            {item.from ? `: ${item.from}` : ''} <span className="text-slate-400">→</span> {item.to || 'cleared'}
          </p>
        ))}
      </div>
    </article>
  );
}

export default function AccIssueDetail() {
  const params = useParams();
  const issueKey = params.incidentId || params.problemId;
  const [issue, setIssue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getAccIssue(issueKey)
      .then((data) => { if (active) setIssue(data); })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [issueKey]);

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">Loading real ACC Jira issue…</div>;
  }
  if (error || !issue) {
    return <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error || 'Issue was not returned by Jira.'}</div>;
  }

  const isProblem = /problem/i.test(issue.ticketCategory || issue.issueType || '');
  const backPath = isProblem ? '/problem-candidates' : '/incidents';
  const backLabel = isProblem ? 'Back to Problems' : 'Back to Incidents';

  return (
    <div>
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
        <div>
          <Link className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-950" to={backPath}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {backLabel}
          </Link>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <span className="text-xs font-bold uppercase tracking-[0.15em] text-teal-700">{issue.key}</span>
            <StatusBadge value={issue.status} />
            <PriorityBadge value={issue.priority} />
          </div>
          <h1 className="mt-3 max-w-5xl text-3xl font-semibold tracking-[-0.035em] text-slate-950">{issue.summary}</h1>
          <p className="mt-3 text-sm text-slate-500">{issue.ticketCategory || issue.issueType} · ACC Jira</p>
        </div>
        <ReadOnlyJiraBadge />
      </div>

      <section className="mt-8 grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4 sm:p-6">
        <DetailField label="Owner / Assignee"><PersonLabel person={issue.assignee} /></DetailField>
        <DetailField label="Reporter"><PersonLabel person={issue.reporter} /></DetailField>
        <DetailField label="Created">{formatJiraDate(issue.createdAt)}</DetailField>
        <DetailField label="Updated">{formatJiraDate(issue.updatedAt)}</DetailField>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-5">
          <Section title="Resolution" description="Who closed the work, when it closed, and what Jira records as the final outcome are kept as separate concepts.">
            <dl className="grid gap-5 sm:grid-cols-2">
              <DetailField label="Resolved By">{issue.resolvedBy ? <PersonLabel person={issue.resolvedBy} /> : 'Not documented'}</DetailField>
              <DetailField label="Resolved At">{formatJiraDate(issue.resolvedAt)}</DetailField>
              <DetailField label="Resolution">{issue.resolution || 'Not documented'}</DetailField>
              <DetailField label="How It Was Resolved">{issue.howResolved || 'Not documented'}</DetailField>
            </dl>
          </Section>

          <Section title="Investigation / Activity" description="Lifecycle and ownership changes from the Jira changelog.">
            {issue.activity?.length ? (
              <div>{issue.activity.map((history) => <HistoryCard history={history} key={history.id} />)}</div>
            ) : <p className="text-sm text-slate-500">No lifecycle activity was returned.</p>}
          </Section>

          <Section title={`Comments · ${issue.comments?.length || 0}`}>
            {issue.comments?.length ? (
              <div className="space-y-3">
                {issue.comments.map((comment) => (
                  <article className="rounded-xl border border-slate-100 bg-slate-50/70 p-4" key={comment.id}>
                    <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-center">
                      <p className="text-xs font-semibold text-slate-800">{comment.author?.displayName || comment.author?.email || 'Jira user'}</p>
                      <time className="text-[11px] text-slate-400">{formatJiraDate(comment.createdAt)}</time>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{comment.body}</p>
                  </article>
                ))}
              </div>
            ) : <p className="text-sm text-slate-500">No comments were returned.</p>}
          </Section>
        </div>

        <div className="space-y-5">
          <Section title="Related Alerts" description="Only explicit Alert # references in Jira fields or comments are treated as direct matches.">
            {issue.relatedAlerts?.length ? (
              <div className="space-y-2">
                {issue.relatedAlerts.map((alert) => (
                  <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3" key={alert.alertNumber}>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                    <div><p className="text-xs font-bold text-emerald-800">Direct alert match</p><p className="mt-0.5 text-xs text-emerald-700">{alert.label}</p></div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm font-medium text-slate-600">No direct alert match found.</p>}
          </Section>

          <Section title={`Issue Links · ${issue.issueLinks?.length || 0}`}>
            {issue.issueLinks?.length ? (
              <div className="space-y-2">
                {issue.issueLinks.map((link) => (
                  <Link className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 transition hover:border-teal-300 hover:bg-teal-50/30" key={`${link.direction}-${link.key}-${link.relationship}`} to={/incident/i.test(link.issueType || link.type || '') ? `/incidents/${link.key}` : '#'}>
                    <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="min-w-0"><span className="block text-xs font-bold text-slate-800">{link.key}</span><span className="mt-0.5 block text-xs text-slate-500">{link.relationship || link.type}{link.summary ? ` · ${link.summary}` : ''}</span></span>
                  </Link>
                ))}
              </div>
            ) : <p className="text-sm text-slate-500">No Jira issue links were returned.</p>}
          </Section>

          <Section title="Record summary">
            <dl className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
              <DetailField label="Ticket Category">{issue.ticketCategory}</DetailField>
              <DetailField label="Status"><StatusBadge value={issue.status} /></DetailField>
              <DetailField label="Priority"><PriorityBadge value={issue.priority} /></DetailField>
              <DetailField label="Resolved">{formatJiraDate(issue.resolvedAt)}</DetailField>
            </dl>
          </Section>

          <details className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-slate-950">
              <span>Full changelog · {issue.changelog?.length || 0}</span>
              <Clock3 className="h-4 w-4 text-slate-400" aria-hidden="true" />
            </summary>
            <div className="mt-5">{issue.changelog?.map((history) => <HistoryCard history={history} key={`full-${history.id}`} />)}</div>
          </details>
        </div>
      </div>
    </div>
  );
}

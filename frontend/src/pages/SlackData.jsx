import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Hash,
  LoaderCircle,
  MessageSquareReply,
  MessagesSquare,
  RefreshCw,
  Server,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/operational/DemoUi.jsx';
import { getSlackIngestionStatus, getSlackMessages, getSlackThread } from '../services/api.js';

function formatDate(value, includeDate = true) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function StatCard({ label, value, helper, icon: Icon, tone = 'slate' }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    teal: 'bg-teal-50 text-teal-700',
    slate: 'bg-slate-100 text-slate-600',
  };

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_35px_-30px_rgba(15,23,42,0.32)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-500">{label}</p>
          <p className="mt-3 truncate text-xl font-semibold tracking-tight text-slate-950">{value}</p>
          <p className="mt-2 text-xs text-slate-400">{helper}</p>
        </div>
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}

function MessageBody({ message, onOpenThread, compact = false }) {
  const hasThread = Number(message.reply_count || 0) > 0 || message.message_type === 'parent';

  return (
    <article className={`border-b border-slate-100 last:border-b-0 ${compact ? 'py-4' : 'px-5 py-5 sm:px-6'}`}>
      <div className="flex items-start gap-3">
        <span className={`flex shrink-0 items-center justify-center rounded-xl bg-fuchsia-50 font-bold text-fuchsia-700 ${compact ? 'h-8 w-8 text-[10px]' : 'h-10 w-10 text-xs'}`}>
          {(message.user_name || '?').slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold text-slate-900">{message.user_name || message.user_id || 'Unknown user'}</p>
            {message.is_bot ? <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">Bot</span> : null}
            {message.message_type === 'reply' ? <span className="text-[10px] font-bold uppercase tracking-wide text-blue-600">Reply</span> : null}
            <time className="text-xs text-slate-400" dateTime={message.created_at || undefined}>{formatDate(message.created_at)}</time>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{message.text || <span className="italic text-slate-400">No text content</span>}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {hasThread && onOpenThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(message.thread_ts || message.message_ts)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 transition hover:text-teal-900"
              >
                <MessageSquareReply className="h-3.5 w-3.5" aria-hidden="true" />
                {message.reply_count || message.replies?.length || 0} replies
              </button>
            ) : null}
            {message.permalink ? (
              <a
                href={message.permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-slate-900"
              >
                View in Slack <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : null}
            <span className="font-mono text-[10px] text-slate-400">{message.message_ts}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function ThreadPanel({ thread, loading, error, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Slack thread">
      <button type="button" className="absolute inset-0 bg-slate-950/25 backdrop-blur-[2px]" onClick={onClose} aria-label="Close thread" />
      <aside className="relative flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-5 sm:px-6">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Live Slack thread</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">Conversation context</h2>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600" aria-label="Close thread panel">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 sm:px-6">
          {loading ? (
            <div className="flex h-52 items-center justify-center gap-2 text-sm text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Retrieving complete thread…
            </div>
          ) : null}
          {error ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
          ) : null}
          {thread?.parent ? (
            <>
              <MessageBody message={thread.parent} compact />
              <div className="border-l-2 border-slate-100 pl-4">
                {thread.replies.map((reply) => <MessageBody key={reply.message_ts} message={reply} compact />)}
              </div>
              {thread.replies.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">No replies were returned.</p> : null}
            </>
          ) : null}
        </div>

        {thread?.summary ? (
          <div className="border-t border-slate-200 bg-slate-50 px-6 py-4 text-xs text-slate-500">
            {thread.summary.repliesRetrieved} replies across {thread.summary.pagesFetched} API page{thread.summary.pagesFetched === 1 ? '' : 's'}
            {thread.summary.complete ? ' · Complete thread' : ' · Partial thread'}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

export default function SlackData() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [threadState, setThreadState] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const connectionStatus = await getSlackIngestionStatus();
      setStatus(connectionStatus);
      const result = await getSlackMessages({ limit: 20, maxPages: 1, includeThreads: true });
      setData(result);
    } catch (requestError) {
      setError(requestError.message || 'Slack data could not be retrieved.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openThread = async (threadTs) => {
    setThreadState({ loading: true, error: '', data: null });
    try {
      const thread = await getSlackThread(threadTs, { limit: 100, maxPages: 'all' });
      setThreadState({ loading: false, error: '', data: thread });
    } catch (requestError) {
      setThreadState({ loading: false, error: requestError.message || 'The Slack thread could not be retrieved.', data: null });
    }
  };

  const connection = data?.connection || status?.connection;
  const channel = data?.channel || status?.channel;
  const summary = data?.summary;
  const fetchTime = data?.lastFetch?.completedAt || status?.lastFetch?.completedAt;

  return (
    <div>
      <PageHeader
        eyebrow="Phase 1 · Read-only ingestion"
        title="Slack Data"
        description="Real messages from the configured Slack channel, retrieved and normalized by the backend. This validation feed is kept separate from all static demo dashboards."
        actions={(
          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh from Slack
          </button>
        )}
      />

      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Live Slack data
        </span>
        <p className="text-xs leading-5 text-emerald-800">No Slack records on this page are mock data. They are not yet classified, scored, or added to incident statistics.</p>
      </div>

      {error ? (
        <section className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-5" aria-live="polite">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-rose-900">Slack ingestion needs attention</h2>
              <p className="mt-1 text-sm leading-6 text-rose-700">{error}</p>
              <p className="mt-2 text-xs text-rose-600">Credentials stay in backend/.env. Never place a Slack token in frontend environment files.</p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="Slack ingestion status">
        <StatCard
          label="Connection status"
          value={loading ? 'Checking…' : connection?.authenticated ? 'Connected' : 'Unavailable'}
          helper={connection?.identity?.userName ? `Authenticated as ${connection.identity.userName}` : 'Validated with auth.test'}
          icon={connection?.authenticated ? CheckCircle2 : Server}
          tone="emerald"
        />
        <StatCard label="Workspace" value={connection?.workspace?.name || '—'} helper="Authenticated Slack team" icon={Users} tone="blue" />
        <StatCard label="Channel" value={channel?.name ? `#${channel.name}` : channel?.id || '—'} helper={channel?.isPrivate ? 'Private channel' : 'Public channel'} icon={Hash} tone="violet" />
        <StatCard label="Messages retrieved" value={summary?.messagesRetrieved ?? '—'} helper={`${summary?.totalRecords ?? 0} total records with replies`} icon={MessagesSquare} tone="teal" />
        <StatCard label="Threads retrieved" value={summary?.threadsRetrieved ?? '—'} helper={`${summary?.repliesRetrieved ?? 0} replies retrieved`} icon={MessageSquareReply} tone="blue" />
      </section>

      <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="recent-slack-heading">
        <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-5 sm:flex-row sm:items-center sm:px-6">
          <div>
            <h2 id="recent-slack-heading" className="text-lg font-semibold text-slate-950">Recent messages</h2>
            <p className="mt-1 text-xs text-slate-500">Newest channel messages first. Open a parent message to inspect replies in context.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" /> Last fetch {formatDate(fetchTime)}</span>
            {summary ? <span>{summary.historyPagesFetched} recent history page{summary.historyPagesFetched === 1 ? '' : 's'}</span> : null}
          </div>
        </div>

        {loading && !data ? (
          <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-500">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Retrieving Slack history and complete threads…
          </div>
        ) : null}

        {!loading && data?.messages?.length === 0 ? (
          <div className="flex h-52 flex-col items-center justify-center px-6 text-center">
            <MessagesSquare className="h-7 w-7 text-slate-300" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-slate-700">The configured channel is empty</p>
            <p className="mt-1 text-xs text-slate-400">Authentication and channel access still completed successfully.</p>
          </div>
        ) : null}

        {data?.messages?.map((message) => (
          <MessageBody key={message.message_ts} message={message} onOpenThread={openThread} />
        ))}
      </section>

      {summary?.truncated ? (
        <p className="mt-3 text-xs text-slate-400">This screen intentionally shows the newest Slack page for fast review. The backend validator can traverse a larger configured history window or run an explicit exhaustive crawl.</p>
      ) : null}

      {data?.warnings?.length ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5" aria-labelledby="slack-warnings-heading">
          <h2 id="slack-warnings-heading" className="text-sm font-semibold text-amber-900">Partial Slack metadata</h2>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-800">
            {data.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>• {warning.message}</li>)}
          </ul>
        </section>
      ) : null}

      <aside className="mt-6 flex items-start gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-5 text-sm text-slate-500">
        <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        This is a read-only validation surface. It performs no Jira calls, ticket creation, alert suppression, AI analysis, or database writes.
      </aside>

      {threadState ? (
        <ThreadPanel
          thread={threadState.data}
          loading={threadState.loading}
          error={threadState.error}
          onClose={() => setThreadState(null)}
        />
      ) : null}
    </div>
  );
}

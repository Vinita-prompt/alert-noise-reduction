import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ExternalLink, Loader2, MessageSquare, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import Badge from '../common/Badge.jsx';
import { getAlerts } from '../../services/api.js';

const lastOpenedStorageKey = 'ops-signal-slack-notifications-opened-at';
const liveStatuses = new Set(['open', 'firing', 'triggered', 'investigating']);

function isSlackAlert(alert) {
  return Boolean(alert.slackChannelId)
    || String(alert.sourceType || '').toLowerCase() === 'slack'
    || String(alert.extractedDetails?.normalized_alert?.delivery_channel || '').toLowerCase() === 'slack';
}

function getAlertTime(alert) {
  const date = new Date(alert.receivedAt || alert.lastSeenAt);

  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export default function AlertNotificationButton() {
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [lastOpenedAt, setLastOpenedAt] = useState(() => {
    const stored = window.localStorage.getItem(lastOpenedStorageKey);
    return stored ? Number(stored) : 0;
  });
  const containerRef = useRef(null);

  useEffect(() => {
    let mounted = true;

    async function loadSlackAlerts(isRefresh = false) {
      if (!isRefresh) {
        setLoading(true);
      }

      try {
        const data = await getAlerts();

        if (!mounted) {
          return;
        }

        setAlerts(data.filter(isSlackAlert));
        setError(null);
      } catch (requestError) {
        if (!mounted) {
          return;
        }

        setError(requestError.message);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadSlackAlerts();
    const intervalId = window.setInterval(() => loadSlackAlerts(true), 30000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    function closeOnOutsideClick(event) {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', closeOnOutsideClick);

    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  const sortedAlerts = useMemo(
    () => alerts.slice().sort((first, second) => getAlertTime(second) - getAlertTime(first)),
    [alerts],
  );
  const unreadCount = sortedAlerts.filter((alert) => getAlertTime(alert) > lastOpenedAt).length;
  const activeCount = sortedAlerts.filter((alert) => liveStatuses.has(alert.status)).length;
  const latestAlerts = sortedAlerts.slice(0, 6);

  function toggleOpen() {
    setOpen((current) => {
      const nextOpen = !current;

      if (nextOpen) {
        const now = Date.now();
        window.localStorage.setItem(lastOpenedStorageKey, String(now));
        setLastOpenedAt(now);
      }

      return nextOpen;
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2"
        type="button"
        onClick={toggleOpen}
        aria-label="Slack alert notifications"
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <Bell className="h-5 w-5" aria-hidden="true" />
        )}
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
        {error ? <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500" /> : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-12 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-200 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">Slack alert notifications</h3>
                <p className="mt-1 text-sm text-slate-500">Alerts received from the Slack events API.</p>
              </div>
              <Badge tone={activeCount > 0 ? 'open' : 'paused'}>{activeCount} active</Badge>
            </div>
          </div>

          {error ? (
            <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Unable to load Slack alerts. {error}
            </div>
          ) : null}

          {latestAlerts.length > 0 ? (
            <div className="max-h-96 overflow-y-auto">
              {latestAlerts.map((alert) => (
                <div key={alert.id} className="border-b border-slate-100 p-4 last:border-b-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-950">{alert.title}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {alert.service} · {alert.environment} · {formatTime(alert.receivedAt)}
                      </p>
                    </div>
                    <Badge tone={alert.severity}>{alert.severity}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge tone={alert.status}>{alert.status}</Badge>
                    <Badge tone={alert.classification}>{alert.classification || 'unclassified'}</Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-44 items-center justify-center p-6 text-center">
              <div>
                <MessageSquare className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
                <p className="mt-3 font-semibold text-slate-900">No Slack alerts yet</p>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  New Slack alert messages will appear here after Slack sends events to the backend.
                </p>
              </div>
            </div>
          )}

          <div className="border-t border-slate-200 bg-slate-50 p-3">
            <Link
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 transition hover:bg-slate-100"
              to="/alerts"
              onClick={() => setOpen(false)}
            >
              View all alerts
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

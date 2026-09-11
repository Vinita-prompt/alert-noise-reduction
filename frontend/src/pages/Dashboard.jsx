import { useEffect, useMemo, useState } from 'react';
import PageState from '../components/common/PageState.jsx';
import AlertTrendChart from '../components/dashboard/AlertTrendChart.jsx';
import ClassificationTrendChart from '../components/dashboard/ClassificationTrendChart.jsx';
import DecisionMixChart from '../components/dashboard/DecisionMixChart.jsx';
import NoiseBreakdown from '../components/dashboard/NoiseBreakdown.jsx';
import StatCard from '../components/dashboard/StatCard.jsx';
import { getAlerts, getAlertTrend } from '../services/api.js';

const noiseTypeColors = {
  duplicate: '#f59e0b',
  flapping: '#8b5cf6',
  'auto-resolved': '#10b981',
  'non-actionable': '#64748b',
  correlated: '#0ea5e9',
  stale: '#f43f5e',
};

const decisionMixColors = {
  correlated: '#f59e0b',
  incident: '#f43f5e',
  noise: '#6366f1',
  unclassified: '#94a3b8',
};

const timeWindowOptions = [
  { value: '24h', label: 'Last 24h' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All stored' },
];

function dateInputValue(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function daysAgoInputValue(days) {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() - days);
  return dateInputValue(date);
}

function toPercent(value, total) {
  return `${Math.round((value / Math.max(total, 1)) * 100)}%`;
}

function getAlertTime(alert) {
  const timestamp = new Date(alert.receivedAt || alert.lastSeenAt);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: 'short',
  }).format(date);
}

function isCorrelatedIncident(alert) {
  return alert.classification === 'incident'
    && (
      Boolean(alert.jiraTicketId)
      || alert.recurringIncident
      || (Array.isArray(alert.relatedAlerts) && alert.relatedAlerts.length > 0)
    );
}

function getWindowStart(windowKey) {
  const now = new Date();

  if (windowKey === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  if (windowKey === '24h') {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  if (windowKey === '7d') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }

  if (windowKey === '30d') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  return null;
}

function filterAlertsByWindow(alerts, windowKey) {
  const start = getWindowStart(windowKey);

  if (!start) {
    return alerts;
  }

  return alerts.filter((alert) => {
    const timestamp = getAlertTime(alert);

    return timestamp && timestamp >= start;
  });
}

function buildDashboardStats(alerts, sourceLabel, windowLabel) {
  const total = alerts.length;
  const noiseAlerts = alerts.filter((alert) => alert.classification === 'noise').length;
  const incidentAlerts = alerts.filter((alert) => alert.classification === 'incident').length;
  const duplicateAlerts = alerts.filter(
    (alert) => alert.noiseType === 'duplicate' || alert.status === 'deduplicated',
  ).length;
  const autoResolvedAlerts = alerts.filter((alert) => alert.status === 'auto-resolved').length;
  const jiraTickets = alerts.filter((alert) => alert.jiraTicketId).length;

  return [
    {
      label: 'Total alerts',
      value: total,
      change: windowLabel,
      helperText: `from ${sourceLabel}`,
      tone: 'blue',
    },
    {
      label: 'Noise alerts',
      value: noiseAlerts,
      change: toPercent(noiseAlerts, total),
      helperText: 'of total alerts',
      tone: 'violet',
    },
    {
      label: 'Incident alerts',
      value: incidentAlerts,
      change: toPercent(incidentAlerts, total),
      helperText: 'of total alerts',
      tone: 'rose',
    },
    {
      label: 'Duplicate alerts',
      value: duplicateAlerts,
      change: toPercent(duplicateAlerts, total),
      helperText: 'of total alerts',
      tone: 'amber',
    },
    {
      label: 'Auto-resolved alerts',
      value: autoResolvedAlerts,
      change: toPercent(autoResolvedAlerts, total),
      helperText: 'of total alerts',
      tone: 'emerald',
    },
    {
      label: 'ACC incidents linked',
      value: jiraTickets,
      change: toPercent(jiraTickets, total),
      helperText: 'of total alerts',
      tone: 'cyan',
    },
  ];
}

function buildNoiseBreakdown(alerts) {
  return Object.entries(noiseTypeColors).map(([noiseType, color]) => ({
    name: noiseType
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    value: alerts.filter((alert) => alert.classification === 'noise' && alert.noiseType === noiseType).length,
    color,
  }));
}

function buildDecisionMix(alerts) {
  const correlated = alerts.filter(isCorrelatedIncident).length;
  const incident = alerts.filter((alert) => alert.classification === 'incident' && !isCorrelatedIncident(alert)).length;
  const noise = alerts.filter((alert) => alert.classification === 'noise').length;
  const unclassified = alerts.filter((alert) => (
    alert.classification === 'needs_review'
    || alert.classification === 'unclassified'
    || !alert.classification
  )).length;

  return [
    { name: 'Correlated Incident', value: correlated, color: decisionMixColors.correlated },
    { name: 'Incident', value: incident, color: decisionMixColors.incident },
    { name: 'Noise', value: noise, color: decisionMixColors.noise },
    { name: 'Unclassified', value: unclassified, color: decisionMixColors.unclassified },
  ];
}

function buildClassificationTrend(alerts) {
  const sortedAlerts = alerts
    .map((alert) => ({
      ...alert,
      timestamp: getAlertTime(alert),
    }))
    .filter((alert) => alert.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (sortedAlerts.length === 0) {
    return [];
  }

  const grouped = new Map();

  sortedAlerts.forEach((alert) => {
    const dateKey = alert.timestamp.toISOString().slice(0, 10);

    if (!grouped.has(dateKey)) {
      grouped.set(dateKey, {
        date: dateKey,
        label: formatShortDate(alert.timestamp),
        correlated: 0,
        incidents: 0,
        noise: 0,
      });
    }

    const bucket = grouped.get(dateKey);

    if (alert.classification === 'noise') {
      bucket.noise += 1;
    }

    if (alert.classification === 'incident') {
      bucket.incidents += 1;
    }

    if (isCorrelatedIncident(alert)) {
      bucket.correlated += 1;
    }
  });

  let cumulativeCorrelated = 0;
  let cumulativeIncidents = 0;
  let cumulativeNoise = 0;

  return [...grouped.values()].map((bucket) => {
    cumulativeCorrelated += bucket.correlated;
    cumulativeIncidents += bucket.incidents;
    cumulativeNoise += bucket.noise;

    return {
      ...bucket,
      correlated: cumulativeCorrelated,
      incidents: cumulativeIncidents,
      noise: cumulativeNoise,
    };
  });
}

export default function Dashboard() {
  const [alerts, setAlerts] = useState([]);
  const [timeWindow, setTimeWindow] = useState('24h');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [trendRange, setTrendRange] = useState('30d');
  const [trendFrom, setTrendFrom] = useState(daysAgoInputValue(29));
  const [trendTo, setTrendTo] = useState(dateInputValue());
  const [trendData, setTrendData] = useState([]);
  const [trendStatus, setTrendStatus] = useState('loading');
  const [trendError, setTrendError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    async function loadAlerts() {
      try {
        const data = await getAlerts();

        if (!isMounted) {
          return;
        }

        setAlerts(data);
        setStatus('success');
        setError(null);
      } catch (requestError) {
        if (!isMounted) {
          return;
        }

        setAlerts([]);
        setStatus('error');
        setError(requestError.message);
      }
    }

    loadAlerts();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let intervalId = null;

    async function loadTrend(isRefresh = false) {
      if (isMounted) {
        setTrendStatus(isRefresh ? 'refreshing' : 'loading');
      }

      try {
        const params = {
          range: trendRange,
        };

        if (trendRange === 'custom') {
          params.from = trendFrom;
          params.to = trendTo;
        }

        const trend = await getAlertTrend(params);

        if (!isMounted) {
          return;
        }

        setTrendData(trend.data || []);
        setTrendStatus('success');
        setTrendError(null);
      } catch (requestError) {
        if (!isMounted) {
          return;
        }

        setTrendData([]);
        setTrendStatus('error');
        setTrendError(requestError.message);
      }
    }

    loadTrend();
    intervalId = window.setInterval(() => loadTrend(true), 30000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [trendRange, trendFrom, trendTo]);

  const selectedWindowLabel = timeWindowOptions.find((option) => option.value === timeWindow)?.label || 'Selected window';
  const windowedAlerts = useMemo(
    () => filterAlertsByWindow(alerts, timeWindow),
    [alerts, timeWindow],
  );
  const dashboardStats = useMemo(
    () => buildDashboardStats(windowedAlerts, 'backend', selectedWindowLabel),
    [windowedAlerts, selectedWindowLabel],
  );
  const noiseBreakdownData = useMemo(() => buildNoiseBreakdown(windowedAlerts), [windowedAlerts]);
  const decisionMixData = useMemo(() => buildDecisionMix(windowedAlerts), [windowedAlerts]);
  const classificationTrendData = useMemo(() => buildClassificationTrend(windowedAlerts), [windowedAlerts]);

  if (status === 'loading') {
    return (
      <PageState
        title="Loading dashboard"
        message="Fetching alert data from the backend."
        variant="loading"
      />
    );
  }

  return (
    <div className="space-y-6">
      {status === 'error' ? (
        <PageState
          title="Backend unavailable"
          message={`No demo data is shown. Start the backend or sync Jira alerts. ${error}`}
          variant="error"
        />
      ) : null}

      {alerts.length === 0 ? (
        <PageState title="No alerts found" message="The backend returned an empty alert list." />
      ) : null}

      <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-950">Dashboard time window</h3>
          <p className="mt-1 text-sm text-slate-500">
            Showing {windowedAlerts.length.toLocaleString()} of {alerts.length.toLocaleString()} stored alerts.
            Backfilled Jira history stays stored, but daily metrics use the selected window.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {timeWindowOptions.map((option) => (
            <button
              key={option.value}
              className={`h-9 rounded-md border px-3 text-sm font-semibold transition ${
                timeWindow === option.value
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
              type="button"
              onClick={() => setTimeWindow(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        {dashboardStats.map((stat) => (
          <StatCard key={stat.label} {...stat} />
        ))}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <AlertTrendChart
          customFrom={trendFrom}
          customTo={trendTo}
          data={trendData}
          error={trendError}
          loading={trendStatus === 'loading' || trendStatus === 'refreshing'}
          onCustomFromChange={setTrendFrom}
          onCustomToChange={setTrendTo}
          onRangeChange={setTrendRange}
          range={trendRange}
        />
        <NoiseBreakdown data={noiseBreakdownData} />
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <ClassificationTrendChart data={classificationTrendData} />
        <DecisionMixChart data={decisionMixData} />
      </section>
    </div>
  );
}

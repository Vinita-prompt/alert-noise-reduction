import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, DownloadCloud, Loader2 } from 'lucide-react';
import AlertDetailsDrawer from '../components/alerts/AlertDetailsDrawer.jsx';
import AlertFilters from '../components/alerts/AlertFilters.jsx';
import AlertsTable from '../components/alerts/AlertsTable.jsx';
import Button from '../components/common/Button.jsx';
import PageState from '../components/common/PageState.jsx';
import ProcessingPanel from '../components/live-demo/ProcessingPanel.jsx';
import {
  classificationOptions,
  environmentOptions,
  severityOptions,
} from '../data/alertOptions.js';
import {
  acknowledgeAlert,
  addAlertNote,
  applyAlertAction,
  assignAlertResponder,
  closeOperationsAlert,
  createJiraTicketForAlert,
  getAlertActivity,
  getAlertById,
  getAlertsResponse,
  importJiraAlerts,
  linkJiraIncident,
  processAlert,
} from '../services/api.js';
import { getDeliveryChannel, getMonitoringSource } from '../utils/alertSource.js';

const initialFilters = {
  search: '',
  priority: 'all',
  severity: 'all',
  service: 'all',
  source: 'all',
  status: 'all',
  state: 'all',
  environment: 'all',
  classification: 'all',
  sort: 'latest',
  acknowledged: 'all',
  createdFrom: '',
  createdTo: '',
  updatedFrom: '',
  updatedTo: '',
};

const stepDelayMs = 420;
const monitoringDelayMs = 1400;
const jiraImportRanges = [
  { value: 'all', label: 'All history backfill' },
  { value: 'incremental', label: 'Incremental refresh' },
  { value: '1d', label: 'Last 1 day' },
  { value: '1w', label: 'Last 1 week' },
  { value: '1m', label: 'Last 1 month' },
  { value: 'custom', label: 'Custom dates' },
];
const sortOptions = [
  { value: 'latest', label: 'Latest to Oldest' },
  { value: 'oldest', label: 'Oldest to Latest' },
];
const alertsPageLimit = 500;

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) {
    return 'Not available';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function titleCase(value) {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function toWorkflowClassification(classification) {
  if (classification === 'noise') {
    return 'Noise';
  }

  if (classification === 'incident') {
    return 'Incident';
  }

  if (classification === 'needs_review') {
    return 'Insufficient Evidence';
  }

  return 'Unclassified';
}

function getDecisionType(alert) {
  if (alert.classification === 'noise') {
    const noiseTypes = {
      duplicate: 'Duplicate Alert',
      flapping: 'Flapping monitor',
      'auto-resolved': 'Auto-resolved',
      'non-actionable': 'Non-actionable',
      correlated: 'Correlated symptom',
      stale: 'Stale signal',
    };

    return noiseTypes[alert.noiseType] || 'Noise reduction';
  }

  if (alert.classification === 'incident') {
    return alert.severity === 'critical' ? 'Critical outage' : 'New incident';
  }

  return 'Insufficient evidence';
}

function getConfidence(alert) {
  if (Number.isFinite(Number(alert.confidenceScore))) {
    return Number(alert.confidenceScore);
  }

  if (alert.classification === 'noise') {
    const confidenceByNoiseType = {
      duplicate: 97,
      flapping: 91,
      'auto-resolved': 94,
      'non-actionable': 86,
      correlated: 89,
      stale: 88,
    };

    return confidenceByNoiseType[alert.noiseType] || 84;
  }

  if (alert.classification === 'incident') {
    if (alert.severity === 'critical') {
      return 96;
    }

    if (alert.severity === 'high') {
      return 91;
    }

    return 82;
  }

  return 62;
}

function getRecommendedAction(alert) {
  if (alert.classification === 'noise') {
    if (alert.noiseType === 'duplicate') {
      return 'Suppress duplicate notification';
    }

    if (alert.noiseType === 'auto-resolved') {
      return 'Suppress and continue monitoring';
    }

    if (alert.noiseType === 'correlated') {
      return 'Group into existing incident context';
    }

    return 'Suppress or monitor without paging';
  }

  if (alert.classification === 'incident') {
    return alert.severity === 'critical'
      ? 'Escalate, create Jira Incident, and notify Slack'
      : 'Create Jira Incident and assign service owner';
  }

  return 'Route to operator review';
}

function getFinalOutcome(alert) {
  if (alert.classification === 'noise') {
    return alert.noiseType === 'correlated' ? 'Grouped' : 'Suppressed';
  }

  if (alert.classification === 'incident') {
    return alert.severity === 'critical' ? 'Escalated' : 'Incident Created';
  }

  return 'Unclassified';
}

function getMonitoringCondition(alert) {
  if (alert.status === 'auto-resolved' || alert.status === 'resolved' || alert.status === 'recovered') {
    return 'Recovered';
  }

  if (alert.classification === 'incident' && alert.severity === 'critical') {
    return 'Escalating';
  }

  if (alert.classification === 'incident') {
    return 'Still Breaching';
  }

  return 'Stable';
}

function getWorkflowMetrics(alert) {
  const critical = alert.severity === 'critical';
  const high = alert.severity === 'high';
  const active = ['open', 'firing', 'triggered', 'investigating'].includes(alert.status);

  return {
    cpu: critical ? '91%' : high ? '84%' : active ? '72%' : '42%',
    memory: critical ? '86%' : high ? '78%' : active ? '64%' : '51%',
    latency: critical ? '2.1 s' : high ? '920 ms' : active ? '410 ms' : '120 ms',
    errorRate: critical ? '8.7%' : high ? '3.2%' : active ? '1.1%' : '0.1%',
    availability: critical ? '94.6%' : high ? '98.2%' : active ? '99.4%' : '99.99%',
  };
}

function buildReasoning(alert) {
  const reasons = [
    alert.classificationReason,
    alert.noiseReason,
    `${titleCase(alert.severity)} severity from ${getMonitoringSource(alert)} for ${alert.service}.`,
    `${alert.occurrences || 1} occurrence(s) observed in ${alert.environment}.`,
  ].filter(Boolean);

  return [...new Set(reasons)];
}

function adaptAlertForWorkflow(alert) {
  if (!alert) {
    return null;
  }

  return {
    ...alert,
    message: alert.title,
    classification: toWorkflowClassification(alert.classification),
    confidence: getConfidence(alert),
    decisionType: getDecisionType(alert),
    finalOutcome: getFinalOutcome(alert),
    metrics: getWorkflowMetrics(alert),
    monitoringCondition: getMonitoringCondition(alert),
    nextEvaluation: alert.classification === 'incident' ? 'Recheck in 2 minutes' : 'Recheck in 5 minutes',
    reasoning: buildReasoning(alert),
    recommendedAction: getRecommendedAction(alert),
    assignedEngineer: alert.owner || 'On-call engineer',
  };
}

function getAlertSortTime(alert) {
  const timestamp = new Date(alert.lastSeenAt || alert.receivedAt || alert.createdAt || 0).getTime();

  return Number.isFinite(timestamp) ? timestamp : 0;
}

export default function Alerts() {
  const [alerts, setAlerts] = useState([]);
  const [alertsMeta, setAlertsMeta] = useState({ totalCount: 0, returnedCount: 0, limit: alertsPageLimit });
  const [filters, setFilters] = useState(initialFilters);
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [classifying, setClassifying] = useState(false);
  const [classificationResult, setClassificationResult] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [workflowStates, setWorkflowStates] = useState({});
  const [processingAlert, setProcessingAlert] = useState(null);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [processingStep, setProcessingStep] = useState(0);
  const [workflowProcessingId, setWorkflowProcessingId] = useState(null);
  const [jiraImportRange, setJiraImportRange] = useState('all');
  const [jiraImportFrom, setJiraImportFrom] = useState(todayInputValue());
  const [jiraImportTo, setJiraImportTo] = useState(todayInputValue());
  const [jiraImporting, setJiraImporting] = useState(false);
  const [jiraImportResult, setJiraImportResult] = useState(null);
  const timersRef = useRef([]);

  async function loadAlerts({ shouldApply = () => true } = {}) {
    try {
      const result = await getAlertsResponse({
        acknowledged: filters.acknowledged,
        classification: filters.classification,
        createdFrom: filters.createdFrom,
        createdTo: filters.createdTo,
        environment: filters.environment,
        limit: alertsPageLimit,
        search: filters.search,
        service: filters.service,
        severity: filters.severity,
        sort: filters.sort,
        source: filters.source,
        status: filters.status,
        updatedFrom: filters.updatedFrom,
        updatedTo: filters.updatedTo,
      });
      const data = result.data || [];

      if (shouldApply()) {
        setAlerts(data);
        setAlertsMeta(result.meta || { totalCount: data.length, returnedCount: data.length, limit: alertsPageLimit });
        setStatus('success');
        setError(null);
      }

      return data;
    } catch (requestError) {
      if (shouldApply()) {
        setAlerts([]);
        setAlertsMeta({ totalCount: 0, returnedCount: 0, limit: alertsPageLimit });
        setStatus('error');
        setError(requestError.message);
      }

      throw requestError;
    }
  }

  useEffect(() => {
    let isMounted = true;

    loadAlerts({ shouldApply: () => isMounted }).catch(() => {});

    const intervalId = window.setInterval(() => {
      loadAlerts({ shouldApply: () => isMounted }).catch(() => {});
    }, 30000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      clearWorkflowTimers();
    };
  }, [filters]);

  function clearWorkflowTimers() {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current = [];
  }

  const serviceOptions = useMemo(
    () => [...new Set(alerts.map((alert) => alert.service))].sort(),
    [alerts],
  );
  const priorityOptions = useMemo(
    () => [...new Set(alerts.map((alert) => alert.priority).filter(Boolean))].sort(),
    [alerts],
  );
  const statusOptions = useMemo(
    () => [...new Set(alerts.map((alert) => alert.status).filter(Boolean))].sort(),
    [alerts],
  );
  const sourceOptions = useMemo(
    () => [...new Set(alerts.map((alert) => getMonitoringSource(alert)).filter(Boolean))].sort(),
    [alerts],
  );
  const stateOptions = useMemo(
    () => [...new Set(alerts.map((alert) => alert.openClosedState).filter(Boolean))].sort(),
    [alerts],
  );

  const filteredAlerts = useMemo(() => {
    const searchTerm = filters.search.trim().toLowerCase();

    return alerts.filter((alert) => {
      const matchesSearch =
        !searchTerm ||
        [
          alert.id,
          alert.title,
          alert.service,
          alert.owner,
          getMonitoringSource(alert),
          getDeliveryChannel(alert),
          alert.jiraIssueKey,
          alert.priority,
          alert.assignee,
          alert.assignedTeam,
        ]
          .join(' ')
          .toLowerCase()
          .includes(searchTerm);
      const matchesPriority = filters.priority === 'all' || alert.priority === filters.priority;
      const matchesSeverity = filters.severity === 'all' || alert.severity === filters.severity;
      const matchesService = filters.service === 'all' || alert.service === filters.service;
      const matchesSource =
        filters.source === 'all' || getMonitoringSource(alert) === filters.source;
      const matchesStatus = filters.status === 'all' || alert.status === filters.status;
      const matchesState = filters.state === 'all' || alert.openClosedState === filters.state;
      const matchesEnvironment = filters.environment === 'all' || alert.environment === filters.environment;
      const matchesClassification =
        filters.classification === 'all' || alert.classification === filters.classification;
      const matchesAcknowledged =
        filters.acknowledged === 'all'
        || (filters.acknowledged === 'acknowledged' && alert.acknowledged)
        || (filters.acknowledged === 'unacknowledged' && !alert.acknowledged);
      const createdTime = getAlertSortTime({ lastSeenAt: null, receivedAt: alert.receivedAt, createdAt: alert.createdAt });
      const updatedTime = getAlertSortTime(alert);
      const createdFrom = filters.createdFrom ? new Date(filters.createdFrom).getTime() : null;
      const createdTo = filters.createdTo ? new Date(filters.createdTo).getTime() : null;
      const updatedFrom = filters.updatedFrom ? new Date(filters.updatedFrom).getTime() : null;
      const updatedTo = filters.updatedTo ? new Date(filters.updatedTo).getTime() : null;
      const matchesCreatedFrom = !createdFrom || createdTime >= createdFrom;
      const matchesCreatedTo = !createdTo || createdTime <= createdTo;
      const matchesUpdatedFrom = !updatedFrom || updatedTime >= updatedFrom;
      const matchesUpdatedTo = !updatedTo || updatedTime <= updatedTo;

      return (
        matchesSearch &&
        matchesPriority &&
        matchesSeverity &&
        matchesService &&
        matchesSource &&
        matchesStatus &&
        matchesState &&
        matchesEnvironment &&
        matchesClassification &&
        matchesAcknowledged &&
        matchesCreatedFrom &&
        matchesCreatedTo &&
        matchesUpdatedFrom &&
        matchesUpdatedTo
      );
    }).sort((first, second) => {
      const firstTime = getAlertSortTime(first);
      const secondTime = getAlertSortTime(second);

      return filters.sort === 'oldest' ? firstTime - secondTime : secondTime - firstTime;
    });
  }, [alerts, filters]);

  function handleFilterChange(key, value) {
    setFilters((currentFilters) => ({
      ...currentFilters,
      [key]: value,
    }));
  }

  async function handleSelectAlert(alert) {
    setSelectedAlert(alert);
    setActionError(null);
    setDetailsLoading(true);

    try {
      const [fullAlert, activity] = await Promise.all([
        getAlertById(alert.id),
        getAlertActivity(alert.id).catch(() => []),
      ]);
      setSelectedAlert((currentAlert) => (
        currentAlert?.id === alert.id ? { ...fullAlert, activity } : currentAlert
      ));
    } catch (requestError) {
      setActionError(`Unable to load full alert details. ${requestError.message}`);
    } finally {
      setDetailsLoading(false);
    }
  }

  async function handleClassifyAlerts() {
    setClassifying(true);
    setClassificationResult(null);

    try {
      const result = await classifyAlerts({ force: false });

      setAlerts(result.alerts);
      setClassificationResult(result.summary);
      if (selectedAlert) {
        setSelectedAlert(result.alerts.find((alert) => alert.id === selectedAlert.id) || selectedAlert);
      }
    } catch (requestError) {
      setClassificationResult({
        error: requestError.message,
      });
    } finally {
      setClassifying(false);
    }
  }

  async function handleJiraAlertImport() {
    setJiraImporting(true);
    setJiraImportResult(null);

    try {
      const payload = {
        range: jiraImportRange === 'incremental' ? 'all' : jiraImportRange,
        incremental: jiraImportRange === 'incremental',
      };

      if (jiraImportRange === 'custom') {
        payload.from = jiraImportFrom || null;
        payload.to = jiraImportTo || null;
      }

      const result = await importJiraAlerts(payload);

      setJiraImportResult({
        type: 'success',
        message: `Operations ${result.mode === 'incremental_refresh' ? 'refresh' : 'historical backfill'} complete: ${result.inserted} new alerts, ${result.updated} updated, ${result.skipped} skipped. Fetched ${result.totalFetched} alerts and stored ${result.incidentsStored || 0} incidents.`,
        query: result.query,
        jql: result.jql,
        incidentsJql: result.incidentsJql,
        syncRunId: result.syncRunId,
        cursorValue: result.cursorValue,
        minTinyId: result.minTinyId,
        maxTinyId: result.maxTinyId,
      });
      await loadAlerts();
    } catch (requestError) {
      setJiraImportResult({
        type: 'error',
        message: requestError.message,
      });
    } finally {
      setJiraImporting(false);
    }
  }

  async function handleAlertAction(alert, action) {
    setActionLoading(action);
    setActionError(null);

    try {
      let updatedAlert = null;

      if (alert.source === 'jsm_ops' && action === 'close') {
        updatedAlert = await closeOperationsAlert(alert.id, {
          actor: 'Website operator',
          reason: 'Closed from Alert Noise Reduction website.',
        });
      } else if (alert.source === 'jsm_ops' && action === 'jira') {
        const result = await createJiraTicketForAlert(alert.id, {
          actor: 'Website operator',
        });
        updatedAlert = await getAlertById(alert.id).catch(() => result.alert || alert);
      } else {
        updatedAlert = await applyAlertAction(alert.id, action);
      }

      setAlerts((current) => current.map((item) => (
        item.id === updatedAlert.id ? updatedAlert : item
      )));
      setSelectedAlert(updatedAlert);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleAddNote(alert, note) {
    setActionLoading('note');
    setActionError(null);

    try {
      const updatedAlert = await addAlertNote(alert.id, {
        note,
        createdBy: 'Website operator',
      });

      setAlerts((current) => current.map((item) => (
        item.id === updatedAlert.id ? updatedAlert : item
      )));
      setSelectedAlert(updatedAlert);
    } catch (requestError) {
      setActionError(requestError.message);
      throw requestError;
    } finally {
      setActionLoading(null);
    }
  }

  async function handleLinkJira(alert, jiraTicketId) {
    setActionLoading('link-jira');
    setActionError(null);

    try {
      const updatedAlert = await linkJiraIncident(alert.id, {
        jiraTicketId,
        linkedBy: 'Website operator',
      });

      setAlerts((current) => current.map((item) => (
        item.id === updatedAlert.id ? updatedAlert : item
      )));
      setSelectedAlert(updatedAlert);
    } catch (requestError) {
      setActionError(requestError.message);
      throw requestError;
    } finally {
      setActionLoading(null);
    }
  }

  async function handleAssignResponder(alert, responderName) {
    setActionLoading('assign-responder');
    setActionError(null);

    try {
      const result = await assignAlertResponder(alert.id, {
        assignedBy: 'Website operator',
        responders: [
          {
            id: responderName,
            name: responderName,
            type: 'user',
          },
        ],
      });
      const updatedAlert = result.alert || result;

      setAlerts((current) => current.map((item) => (
        item.id === updatedAlert.id ? updatedAlert : item
      )));
      setSelectedAlert(updatedAlert);
    } catch (requestError) {
      setActionError(requestError.message);
      throw requestError;
    } finally {
      setActionLoading(null);
    }
  }

  function setWorkflowProcessed(alert) {
    setWorkflowStates((current) => ({
      ...current,
      [alert.id]: {
        ...current[alert.id],
        acknowledged: false,
        confidence: getConfidence(alert),
        monitoringComplete: false,
        processed: true,
        status: 'Classified',
      },
    }));
  }

  async function handleProcessAlert(alert) {
    if (!alert || workflowProcessingId) {
      return;
    }

    if (!alert.acknowledged && alert.source !== 'jsm_ops') {
      setActionError('Acknowledge this alert first. Investigation and classification are locked until acknowledgement is stored.');
      return;
    }

    const startingAlert = adaptAlertForWorkflow(alert);
    setProcessingAlert(startingAlert);
    setProcessingOpen(true);
    setProcessingStep(0);
    setWorkflowProcessingId(alert.id);

    for (let stepIndex = 1; stepIndex <= 8; stepIndex += 1) {
      const timerId = window.setTimeout(() => {
        setProcessingStep(stepIndex);
      }, stepIndex * stepDelayMs);
      timersRef.current.push(timerId);
    }

    const completeTimerId = window.setTimeout(async () => {
      try {
        const result = await processAlert(alert.id, { force: true });
        const updatedAlert = result.alert || alert;

        setAlerts((current) => current.map((item) => (
          item.id === updatedAlert.id ? updatedAlert : item
        )));
        setSelectedAlert(updatedAlert);
        setProcessingAlert(adaptAlertForWorkflow(updatedAlert));
        setWorkflowProcessed(updatedAlert);
      } catch (requestError) {
        setActionError(requestError.message);
      } finally {
        setWorkflowProcessingId(null);
        setProcessingOpen(false);
      }
    }, 9 * stepDelayMs);
    timersRef.current.push(completeTimerId);
  }

  function handleAcknowledgeAlert(alert) {
    if (!alert) {
      return;
    }

    setActionLoading('acknowledge');
    setActionError(null);

    acknowledgeAlert(alert.id, {
      acknowledgedBy: 'Website operator',
      source: 'website',
    })
      .then((updatedAlert) => {
        setAlerts((current) => current.map((item) => (
          item.id === updatedAlert.id ? updatedAlert : item
        )));
        setSelectedAlert(updatedAlert);
        setWorkflowStates((current) => ({
          ...current,
          [updatedAlert.id]: {
            ...current[updatedAlert.id],
            acknowledged: true,
            acknowledgedAt: `Acknowledged at ${formatDateTime(updatedAlert.acknowledgedAt)}`,
            monitoringComplete: false,
            status: 'Monitoring',
          },
        }));

        const timerId = window.setTimeout(() => {
          setWorkflowStates((current) => ({
            ...current,
            [updatedAlert.id]: {
              ...current[updatedAlert.id],
              monitoringComplete: true,
              status: adaptAlertForWorkflow(updatedAlert).finalOutcome,
            },
          }));
        }, monitoringDelayMs);
        timersRef.current.push(timerId);
      })
      .catch((requestError) => {
        setActionError(requestError.message);
      })
      .finally(() => {
        setActionLoading(null);
      });
  }

  const workflowAlert = adaptAlertForWorkflow(selectedAlert);
  const workflowState = selectedAlert
    ? workflowStates[selectedAlert.id] || {
        acknowledged: Boolean(selectedAlert.acknowledged || selectedAlert.source === 'jsm_ops'),
        acknowledgedAt: selectedAlert.acknowledgedAt
          ? `Acknowledged at ${formatDateTime(selectedAlert.acknowledgedAt)}`
          : selectedAlert.source === 'jsm_ops'
            ? 'Read-only JSM Operations alert'
            : null,
        escalated: Boolean(selectedAlert.escalated),
        confidence: getConfidence(selectedAlert),
        monitoringComplete: false,
        processed: false,
        status: selectedAlert.acknowledgedStatus || selectedAlert.status,
      }
    : null;

  if (status === 'loading') {
    return (
      <PageState title="Loading alerts" message="Fetching alerts from the backend." variant="loading" />
    );
  }

  return (
    <div className="space-y-5">
      {status === 'error' ? (
        <PageState
          title="Backend unavailable"
          message={`No demo data is shown. Start the backend or ingest alerts from monitoring sources. ${error}`}
          variant="error"
        />
      ) : null}

      {alerts.length === 0 ? (
        <PageState title="No alerts found" message="The backend returned an empty alert list." />
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 text-sm leading-6 text-slate-600 lg:grid-cols-3">
          <div>
            <p className="font-semibold text-slate-950">Operations Alerts</p>
            <p>Full source alert records are stored in the backend first.</p>
          </div>
          <div>
            <p className="font-semibold text-slate-950">Operations Incidents</p>
            <p>Incident lifecycle data enriches and links alerts when available.</p>
          </div>
          <div>
            <p className="font-semibold text-slate-950">Slack</p>
            <p>Notifications only. Slack is not the alert system of record.</p>
          </div>
        </div>
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Showing the latest {alerts.length} loaded alerts in the browser. Full Slack and source history remains stored in PostgreSQL and alert details load on demand.
        </p>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-cyan-700" aria-hidden="true" />
              <h3 className="text-base font-semibold text-slate-950">Operations alert history import</h3>
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Run a full JSM Operations historical backfill by default. Alerts and incidents are stored as separate datasets first, with raw payloads preserved before classification and linking.
            </p>
            {jiraImportResult ? (
              <div
                className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                  jiraImportResult.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-rose-200 bg-rose-50 text-rose-800'
                }`}
              >
                <p className="font-medium">{jiraImportResult.message}</p>
                {jiraImportResult.query ? (
                  <p className="mt-1 break-words text-xs opacity-80">Operations query: {jiraImportResult.query}</p>
                ) : null}
                {jiraImportResult.jql ? (
                  <p className="mt-1 break-words text-xs opacity-80">Alerts JQL: {jiraImportResult.jql}</p>
                ) : null}
                {jiraImportResult.incidentsJql ? (
                  <p className="mt-1 break-words text-xs opacity-80">Incidents JQL: {jiraImportResult.incidentsJql}</p>
                ) : null}
                {jiraImportResult.syncRunId ? (
                  <p className="mt-1 break-words text-xs opacity-80">Sync run: {jiraImportResult.syncRunId}</p>
                ) : null}
                {jiraImportResult.cursorValue ? (
                  <p className="mt-1 break-words text-xs opacity-80">Next incremental cursor: {jiraImportResult.cursorValue}</p>
                ) : null}
                {jiraImportResult.maxTinyId ? (
                  <p className="mt-1 break-words text-xs opacity-80">
                    TinyId range imported: #{jiraImportResult.minTinyId || '?'} to #{jiraImportResult.maxTinyId}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 xl:w-auto xl:grid-cols-[180px_150px_150px_auto]">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Time range
              <select
                className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={jiraImportRange}
                onChange={(event) => setJiraImportRange(event.target.value)}
              >
                {jiraImportRanges.map((range) => (
                  <option key={range.value} value={range.value}>
                    {range.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              From
              <input
                className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:bg-slate-50"
                disabled={jiraImportRange !== 'custom'}
                type="date"
                value={jiraImportFrom}
                onChange={(event) => setJiraImportFrom(event.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              To
              <input
                className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:bg-slate-50"
                disabled={jiraImportRange !== 'custom'}
                type="date"
                value={jiraImportTo}
                onChange={(event) => setJiraImportTo(event.target.value)}
              />
            </label>

            <Button
              className="self-end"
              disabled={status !== 'success' || jiraImporting}
              onClick={handleJiraAlertImport}
              variant="primary"
            >
              {jiraImporting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Importing
                </>
              ) : (
                <>
                  <DownloadCloud className="h-4 w-4" aria-hidden="true" />
                  Run Operations backfill
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-950">Alert classification</h3>
          <p className="mt-1 text-sm text-slate-500">
            Firing means the source monitor says the alert is currently active. Run classification to label active alerts as incident or noise with a saved justification.
          </p>
          {classificationResult ? (
            <p className={`mt-2 text-sm font-medium ${classificationResult.error ? 'text-rose-700' : 'text-slate-700'}`}>
              {classificationResult.error
                ? classificationResult.error
                : `${classificationResult.updated} updated. ${classificationResult.incidents} incidents, ${classificationResult.noise} noise, ${classificationResult.unclassified} still need review. ${classificationResult.skippedUnacknowledged || 0} skipped until acknowledgement.`}
            </p>
          ) : null}
        </div>
        <Button
          disabled={status !== 'success' || classifying}
          onClick={handleClassifyAlerts}
          variant="primary"
        >
          {classifying ? 'Classifying' : 'Classify alerts'}
        </Button>
      </section>

      <AlertFilters
        filters={filters}
        onFilterChange={handleFilterChange}
        onReset={() => setFilters(initialFilters)}
        serviceOptions={serviceOptions}
        priorityOptions={priorityOptions}
        statusOptions={statusOptions}
        sourceOptions={sourceOptions}
        stateOptions={stateOptions}
        severityOptions={severityOptions}
        environmentOptions={environmentOptions}
        classificationOptions={classificationOptions}
        sortOptions={sortOptions}
      />
      <AlertsTable alerts={filteredAlerts} meta={alertsMeta} loadedCount={alerts.length} onSelectAlert={handleSelectAlert} />
      <AlertDetailsDrawer
        actionError={actionError}
        actionLoading={actionLoading}
        alert={selectedAlert}
        detailsLoading={detailsLoading}
        onAcknowledge={handleAcknowledgeAlert}
        onAction={handleAlertAction}
        onAddNote={handleAddNote}
        onAssignResponder={handleAssignResponder}
        onClose={() => {
          setActionError(null);
          setSelectedAlert(null);
        }}
        onLinkJira={handleLinkJira}
        onProcess={handleProcessAlert}
        workflowAlert={workflowAlert}
        workflowProcessing={Boolean(selectedAlert && workflowProcessingId === selectedAlert.id)}
        workflowState={workflowState}
      />
      <ProcessingPanel
        alert={processingAlert}
        currentStep={processingStep}
        onClose={() => {
          if (!workflowProcessingId) {
            setProcessingOpen(false);
          }
        }}
        open={processingOpen}
      />
    </div>
  );
}

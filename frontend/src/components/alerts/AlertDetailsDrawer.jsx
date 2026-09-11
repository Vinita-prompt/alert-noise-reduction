import { useState } from 'react';
import {
  Bot,
  CheckCircle2,
  CopyCheck,
  ExternalLink,
  FileJson,
  RotateCcw,
  Ticket,
  X,
  XCircle,
} from 'lucide-react';
import Badge from '../common/Badge.jsx';
import Button from '../common/Button.jsx';
import DecisionExplanation from '../live-demo/DecisionExplanation.jsx';
import MonitoringVerification from '../live-demo/MonitoringVerification.jsx';
import { getDeliveryChannel, getMonitoringSource } from '../../utils/alertSource.js';

function formatDate(dateString) {
  if (!dateString) {
    return 'Not available';
  }

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    return String(dateString);
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getPersonName(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  return value.displayName || value.name || value.emailAddress || value.accountId || null;
}

function normalizeList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      return value.name || value.value || value.issue_key || value.key || value.summary || null;
    })
    .filter(Boolean);
}

function formatResponders(responders) {
  if (!Array.isArray(responders) || responders.length === 0) {
    return null;
  }

  return responders
    .map((responder) => {
      if (!responder) return null;
      if (typeof responder === 'string') return responder;
      return responder.displayName || responder.responderName || responder.name || responder.id || responder.accountId || responder.teamId || null;
    })
    .filter(Boolean)
    .join(', ');
}

function getOpsAlertId(alert, extractedAlert, normalizedAlert) {
  const candidates = [
    alert?.extractedDetails?.jsm_ops?.alert_id,
    normalizedAlert?.ops_alert_id,
    extractedAlert?.ops_alert_id,
    ...(Array.isArray(alert?.relatedAlerts) ? alert.relatedAlerts : []),
    alert?.title,
  ];
  const value = candidates.find((candidate) => candidate);
  const match = String(value || '').match(/#?(\d{3,})/);

  return match?.[1] || value || null;
}

function copyToClipboard(value) {
  if (!value || !navigator.clipboard) {
    return;
  }

  navigator.clipboard.writeText(String(value)).catch(() => {});
}

function DetailRow({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">{value || 'Not available'}</dd>
    </div>
  );
}

function DetailLink({ label, href, children }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">
        {href ? (
          <a
            className="inline-flex max-w-full items-center gap-1 break-all text-cyan-700 hover:text-cyan-800"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {children || href}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </a>
        ) : (
          'Not available'
        )}
      </dd>
    </div>
  );
}

function countItems(value) {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).length;
  }

  return 0;
}

function ValueList({ items }) {
  if (!items || items.length === 0) {
    return <p className="mt-2 text-sm text-slate-500">Not available</p>;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={String(item)}>{String(item)}</Badge>
      ))}
    </div>
  );
}

function normalizeDisplayValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Not available';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'Not available';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return value;
}

function DetailSection({ title, children }) {
  return (
    <section className="mt-6 rounded-lg border border-slate-200 p-4">
      <h4 className="text-sm font-semibold text-slate-950">{title}</h4>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DetailsGrid({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <DetailRow key={item.label} label={item.label} value={normalizeDisplayValue(item.value)} />
      ))}
    </dl>
  );
}

function CompactJson({ value }) {
  if (!value) {
    return null;
  }

  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function JiraComments({ comments }) {
  if (!comments?.length) {
    return <p className="mt-3 text-sm text-slate-500">No Jira comments available.</p>;
  }

  return (
    <div className="mt-3 space-y-3">
      {comments.slice(0, 5).map((comment) => (
        <div key={comment.id || `${comment.author?.displayName}-${comment.created}`} className="rounded-md bg-slate-50 p-3 text-sm">
          <p className="leading-6 text-slate-700">{comment.body || 'No comment text available.'}</p>
          <p className="mt-2 text-xs font-medium text-slate-500">
            {[getPersonName(comment.author), formatDate(comment.created)].filter(Boolean).join(' · ') || 'Jira comment'}
          </p>
        </div>
      ))}
    </div>
  );
}

function JiraChangelog({ histories, summary }) {
  const statusChanges = summary?.status_changes || [];
  const assigneeChanges = summary?.assignee_changes || [];
  const priorityChanges = summary?.priority_changes || [];
  const acknowledgementUpdates = summary?.acknowledgement_updates || [];
  const highlightedChanges = [
    ...statusChanges.map((change) => ({ ...change, type: 'Status' })),
    ...assigneeChanges.map((change) => ({ ...change, type: 'Assignee' })),
    ...priorityChanges.map((change) => ({ ...change, type: 'Priority' })),
    ...acknowledgementUpdates.map((change) => ({ ...change, type: 'Acknowledgement' })),
  ].slice(0, 8);

  if (!histories?.length && highlightedChanges.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No Jira changelog history available.</p>;
  }

  if (highlightedChanges.length > 0) {
    return (
      <div className="mt-3 space-y-3">
        {highlightedChanges.map((change, index) => (
          <div key={`${change.type}-${change.created}-${index}`} className="rounded-md bg-slate-50 p-3 text-sm">
            <p className="font-semibold text-slate-900">{change.type} changed</p>
            <p className="mt-1 leading-6 text-slate-700">
              {change.from || 'Not set'} {'->'} {change.to || 'Not set'}
            </p>
            <p className="mt-2 text-xs font-medium text-slate-500">
              {[getPersonName(change.author), formatDate(change.created)].filter(Boolean).join(' · ') || 'Jira history'}
            </p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {histories.slice(0, 6).map((history) => (
        <div key={history.id || `${history.created}-${history.items?.length}`} className="rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-semibold text-slate-900">
            {[getPersonName(history.author), formatDate(history.created)].filter(Boolean).join(' · ') || 'Jira history'}
          </p>
          <p className="mt-1 text-slate-600">
            {(history.items || []).map((item) => item.field).filter(Boolean).join(', ') || 'Field update'}
          </p>
        </div>
      ))}
    </div>
  );
}

function JiraCustomFields({ fields }) {
  const allFields = Object.values(fields || {})
    .filter((field) => field?.text || field?.raw !== undefined)
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const visibleFields = allFields.slice(0, 24);

  if (visibleFields.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No incident/root-cause custom fields found.</p>;
  }

  return (
    <>
      <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visibleFields.map((field) => (
          <div key={field.id || field.name}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{field.name || field.id}</dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">{normalizeDisplayValue(field.text || field.raw)}</dd>
            {field.id && field.name !== field.id ? (
              <p className="mt-1 text-xs text-slate-500">{field.id}</p>
            ) : null}
          </div>
        ))}
      </dl>
      {allFields.length > visibleFields.length ? (
        <p className="mt-3 text-xs text-slate-500">
          Showing {visibleFields.length} of {allFields.length} mapped custom fields. Full raw custom field data is preserved in the raw Jira payload.
        </p>
      ) : null}
    </>
  );
}

function ActivityTimeline({ activity }) {
  if (!Array.isArray(activity) || activity.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No Operations activity is stored for this alert yet.</p>;
  }

  return (
    <div className="mt-3 space-y-3">
      {activity.slice(0, 30).map((item, index) => (
        <div key={`${item.type}-${item.occurredAt}-${index}`} className="rounded-md bg-slate-50 p-3 text-sm">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <p className="font-semibold text-slate-900">{item.eventType || item.type || 'Activity'}</p>
            <p className="text-xs font-medium text-slate-500">{formatDate(item.occurredAt)}</p>
          </div>
          <p className="mt-1 leading-6 text-slate-700">{item.message || 'Activity metadata stored.'}</p>
          {item.actor ? <p className="mt-1 text-xs font-medium text-slate-500">Actor: {item.actor}</p> : null}
        </div>
      ))}
    </div>
  );
}

function StructuredAlertSections({ structuredAlert }) {
  if (!structuredAlert) {
    return null;
  }

  return (
    <>
      <DetailSection title="People">
        <DetailsGrid
          items={[
            { label: 'Assignee', value: structuredAlert.people?.assignee },
            { label: 'Responders', value: structuredAlert.people?.responders },
          ]}
        />
      </DetailSection>

      <DetailSection title="Timings">
        <DetailsGrid
          items={[
            { label: 'Elapsed time', value: structuredAlert.timings?.elapsed_time },
            { label: 'Created', value: formatDate(structuredAlert.timings?.created_at || structuredAlert.created_at) },
            { label: 'Last updated', value: formatDate(structuredAlert.timings?.last_updated_at || structuredAlert.updated_at) },
            { label: 'Last duplicated', value: formatDate(structuredAlert.timings?.last_duplicated_at) },
            { label: 'Timezone', value: structuredAlert.timings?.timezone },
          ]}
        />
      </DetailSection>

      <DetailSection title="Details">
        <DetailsGrid
          items={[
            { label: 'Source', value: structuredAlert.details?.source || structuredAlert.source },
            { label: 'Integration', value: structuredAlert.details?.integration || structuredAlert.integration },
            { label: 'Alias', value: structuredAlert.details?.alias || structuredAlert.alias },
            { label: 'Duplicate', value: structuredAlert.deduplication?.is_duplicate },
            { label: 'Duplicate count', value: structuredAlert.deduplication?.duplicate_count },
            { label: 'Duplicate group', value: structuredAlert.deduplication?.duplicate_group_id },
          ]}
        />
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tags</p>
          <ValueList items={structuredAlert.tags || structuredAlert.details?.tags || []} />
        </div>
      </DetailSection>

      <DetailSection title="Extra properties">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DetailLink label="Event deep link" href={structuredAlert.extra_properties?.event_deep_link || structuredAlert.event_deep_link}>
            Open event source
          </DetailLink>
          <DetailLink label="Controller URL" href={structuredAlert.extra_properties?.controller_url || structuredAlert.controller_url}>
            Open controller
          </DetailLink>
          <DetailRow label="Entity" value={structuredAlert.extra_properties?.entity || structuredAlert.entity} />
          <DetailRow label="Health rule ID" value={structuredAlert.extra_properties?.health_rule_id || structuredAlert.health_rule_id} />
        </dl>
      </DetailSection>
    </>
  );
}

function ExtractedDetailsPanel({ details }) {
  if (!details) {
    return null;
  }

  const extractedAlert = details.alert || {};
  const jira = details.jira || {};
  const normalized = details.normalized_alert || {};
  const classification = details.classification || {};
  const slackEnrichment = details.slack_enrichment || {};

  return (
    <section className="mt-6 rounded-lg border border-slate-200 p-4">
      <div className="flex items-center gap-2 text-slate-800">
        <FileJson className="h-5 w-5" aria-hidden="true" />
        <h4 className="text-sm font-semibold text-slate-950">Full extracted alert details</h4>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Parsed from the alert notification, monitoring source, and linked Jira context, then stored with the alert for investigation and future learning.
      </p>

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DetailRow label="Alert ID" value={extractedAlert.alert_id} />
        <DetailRow label="Operations alert key" value={normalized.jira_issue_key || jira.issue_key} />
        <DetailRow label="Jira incident key" value={normalized.jira_incident_key || extractedAlert.jira_incident_key} />
        <DetailRow label="Source tool" value={extractedAlert.source_tool} />
        <DetailRow label="Monitoring tool" value={slackEnrichment.monitoring_tool || normalized.monitoring_tool || extractedAlert.monitoring_tool} />
        <DetailRow label="Source name" value={normalized.source_name} />
        <DetailRow label="Source type" value={extractedAlert.source_type} />
        <DetailRow label="Priority" value={normalized.priority || jira.priority} />
        <DetailRow label="Severity" value={normalized.severity || extractedAlert.severity} />
        <DetailRow label="Open/closed state" value={normalized.state || extractedAlert.state} />
        <DetailRow label="Correlation ID" value={extractedAlert.correlation_id} />
        <DetailRow label="Duplicate signature" value={extractedAlert.duplicate_signature} />
        <DetailRow label="Jira incident key" value={extractedAlert.jira_incident_key || extractedAlert.jira_key} />
        <DetailRow label="Jira summary" value={slackEnrichment.jira_summary || normalized.jira_summary || jira.summary} />
        <DetailRow label="Jira status" value={jira.status} />
        <DetailRow label="Jira priority" value={jira.priority} />
        <DetailRow label="Issue type" value={jira.issue_type} />
        <DetailRow label="Resolution" value={jira.resolution} />
        <DetailRow label="Resolved at" value={normalized.resolved_at || jira.resolution_date} />
        <DetailRow label="Assigned team" value={normalized.assigned_team} />
        <DetailRow label="Assignee" value={normalized.assignee?.displayName || jira.assignee?.displayName} />
        <DetailRow label="Reporter" value={normalized.reporter?.displayName || jira.reporter?.displayName} />
        <DetailRow label="Confidence" value={classification.confidence ? `${Math.round(classification.confidence * 100)}%` : null} />
        <DetailRow label="Recommended action" value={classification.recommended_action || normalized.recommended_action} />
        <DetailRow label="Comments" value={countItems(jira.comments)} />
        <DetailRow label="Attachments" value={countItems(jira.attachments)} />
        <DetailRow label="Linked issues" value={countItems(jira.linked_issues)} />
        <DetailRow label="Sub-tasks" value={countItems(jira.sub_tasks)} />
        <DetailRow label="Custom fields" value={countItems(jira.custom_fields)} />
      </dl>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason codes</p>
          <ValueList items={classification.reason_codes || normalized.reason_codes || []} />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Labels / tags</p>
          <ValueList items={normalized.tags || jira.labels || []} />
        </div>
      </div>

      {classification.justification ? (
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-700">
          {classification.justification}
        </div>
      ) : null}

      {slackEnrichment.monitoring_event_url || extractedAlert.deep_event_link || extractedAlert.event_link ? (
        <a
          className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-cyan-700 hover:text-cyan-800"
          href={slackEnrichment.monitoring_event_url || extractedAlert.deep_event_link || extractedAlert.event_link}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          Open deep event link
        </a>
      ) : null}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
          View complete extracted JSON
        </summary>
        <div className="mt-3">
          <CompactJson value={details} />
        </div>
      </details>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
          View raw Operations payload
        </summary>
        <div className="mt-3">
          <CompactJson value={jira.raw_payload || normalized.raw_payload} />
        </div>
      </details>
    </section>
  );
}

const alertActions = [
  {
    action: 'incident',
    label: 'Mark as Incident',
    icon: CheckCircle2,
  },
  {
    action: 'noise',
    label: 'Mark as Noise',
    icon: XCircle,
  },
  {
    action: 'needs_review',
    label: 'Mark as Insufficient Evidence',
    icon: Bot,
  },
  {
    action: 'duplicate',
    label: 'Duplicate',
    icon: CopyCheck,
  },
  {
    action: 'resolved',
    label: 'Resolve',
    icon: CheckCircle2,
  },
  {
    action: 'close',
    label: 'Close',
    icon: X,
  },
  {
    action: 'jira',
    label: 'Create Jira Incident',
    icon: Ticket,
  },
  {
    action: 'reopen',
    label: 'Reopen',
    icon: RotateCcw,
  },
];

export default function AlertDetailsDrawer({
  actionError,
  actionLoading,
  alert,
  detailsLoading = false,
  onAcknowledge,
  onAction,
  onAddNote,
  onAssignResponder,
  onClose,
  onLinkJira,
  onProcess,
  workflowAlert,
  workflowProcessing,
  workflowState,
}) {
  const [noteText, setNoteText] = useState('');
  const [jiraKey, setJiraKey] = useState('');
  const [responderName, setResponderName] = useState('');
  const isOpen = Boolean(alert);
  const extractedAlert = alert?.extractedDetails?.alert || {};
  const normalizedAlert = alert?.extractedDetails?.normalized_alert || {};
  const isOperationsAlert = alert?.source === 'jsm_ops'
    || normalizedAlert.source_tool === 'jsm_ops'
    || alert?.sourceName === 'JSM Operations';
  const isReadOnlyOperationsAlert = isOperationsAlert && !alert?.writeActionsEnabled;
  const canInvestigate = Boolean(alert?.acknowledged || isOperationsAlert);
  const slackEnrichment = alert?.extractedDetails?.slack_enrichment || {};
  const slackDetails = alert?.extractedDetails?.slack || {};
  const slackAcknowledgement = alert?.extractedDetails?.slack_acknowledgement
    || slackDetails.acknowledgement
    || slackEnrichment.slack_acknowledgement
    || {};
  const jiraDetails = alert?.extractedDetails?.jira || {};
  const jiraBaseUrl = alert?.sourceUrl?.includes('/browse/')
    ? alert.sourceUrl.split('/browse/')[0]
    : null;
  const jiraIssueKey = alert?.jiraIssueKey
    || slackEnrichment.jira_key
    || normalizedAlert.jira_issue_key
    || extractedAlert.jira_key
    || jiraDetails.issue_key
    || alert?.jiraTicketId;
  const jiraIncidentUrl = alert?.originalJiraUrl
    || alert?.jiraUrl
    || slackEnrichment.jira_url
    || slackEnrichment.original_jira_url
    || normalizedAlert.jira_url
    || normalizedAlert.original_jira_url
    || extractedAlert.jira_url
    || extractedAlert.original_jira_url
    || jiraDetails.jira_url
    || jiraDetails.original_jira_url
    || jiraDetails.issue_url
    || jiraDetails.event_link
    || (jiraBaseUrl && jiraIssueKey
      ? `${jiraBaseUrl}/browse/${jiraIssueKey}`
      : null);
  const monitoringEventUrl = alert?.monitoringEventUrl
    || slackEnrichment.monitoring_event_url
    || normalizedAlert.monitoring_event_url
    || extractedAlert.monitoring_event_url
    || alert?.deepEventLink;
  const monitoringTool = getMonitoringSource(alert);
  const opsAlertId = getOpsAlertId(alert, extractedAlert, normalizedAlert);
  const slackPermalink = alert?.slackPermalink
    || slackDetails.permalink
    || slackAcknowledgement.permalink
    || slackEnrichment.slack_permalink
    || alert?.eventLink;
  const slackAssignee = alert?.slackAssigneeName
    || alert?.assignee_name
    || alert?.slackAssignee
    || slackAcknowledgement.assignee
    || slackAcknowledgement.assignee_name
    || slackDetails.assignee
    || slackDetails.assignee_name
    || slackEnrichment.slack_assignee;
  const slackAckStatus = alert?.slackAcknowledgementStatus || slackAcknowledgement.status;
  const slackAckBy = alert?.slackAcknowledgedByName
    || alert?.acknowledgedByName
    || alert?.slackAcknowledgedBy
    || slackAcknowledgement.acknowledged_by_name
    || slackAcknowledgement.acknowledged_by;
  const slackAckByUserId = alert?.slackAcknowledgedByUserId
    || alert?.acknowledgedByUserId
    || slackAcknowledgement.acknowledged_by_user_id
    || slackAcknowledgement.acknowledged_by_slack_user_id;
  const slackAssigneeUserId = alert?.slackAssigneeUserId
    || alert?.assignee_user_id
    || slackAcknowledgement.assignee_user_id
    || slackAcknowledgement.assignee_slack_user_id;
  const slackAckAt = alert?.slackAcknowledgedAt || slackAcknowledgement.acknowledged_at;
  const slackResponders = alert?.responders?.length
    ? alert.responders
    : slackDetails.responders || slackAcknowledgement.responders || slackEnrichment.slack_responders || [];
  const hasSlackNotificationDetails = Boolean(
    alert?.slackChannelId
    || alert?.slackMessageTs
    || slackPermalink
    || slackAssignee
    || slackAssigneeUserId
    || slackResponders.length
    || slackAckStatus
    || slackAckBy
    || slackAckByUserId
    || slackAckAt,
  );
  const jiraLabels = normalizeList(jiraDetails.labels || alert?.labels || []);
  const jiraComponents = normalizeList(jiraDetails.components || []);
  const jiraComments = Array.isArray(jiraDetails.comments) ? jiraDetails.comments : [];
  const jiraChangelog = Array.isArray(jiraDetails.changelog) ? jiraDetails.changelog : [];
  const jiraChangelogSummary = jiraDetails.changelog_summary || {};
  const linkedIssues = Array.isArray(jiraDetails.linked_issues) ? jiraDetails.linked_issues : [];
  const customFields = jiraDetails.custom_fields || {};
  const rawSlackPayload = alert?.rawPayload || slackEnrichment.raw_payload || extractedAlert.raw_payload;
  const rawJiraIssuePayload = jiraDetails.raw_issue_payload || jiraDetails.raw_payload;
  const rawJiraCommentsPayload = jiraDetails.raw_comments_payload;
  const rawJiraChangelogPayload = jiraDetails.raw_changelog_payload;
  const operationsActivity = alert?.activity || [];
  const openJiraLabel = jiraIssueKey ? `Open ${jiraIssueKey}` : 'Open Jira Incident';
  const jiraSummary = alert?.jiraSummary
    || slackEnrichment.jira_summary
    || normalizedAlert.jira_summary
    || extractedAlert.jira_summary
    || jiraDetails.summary;
  const jiraStatus = alert?.jiraIssueStatus
    || slackEnrichment.jira_status
    || normalizedAlert.jira_status
    || extractedAlert.jira_status
    || jiraDetails.status;
  const jiraPriority = slackEnrichment.jira_priority || jiraDetails.priority || alert?.priority;
  const jiraAssignee = getPersonName(slackEnrichment.jira_assignee || jiraDetails.assignee || alert?.assignee);
  const jiraReporter = getPersonName(slackEnrichment.jira_reporter || jiraDetails.reporter || alert?.reporter);
  const structuredAlert = alert?.structuredAlert || alert?.extractedDetails?.structured_alert || {};
  const extraProperties = structuredAlert.extra_properties || extractedAlert.extra_properties || {};
  const tags = alert?.tags?.length
    ? alert.tags
    : normalizedAlert.tags || structuredAlert.tags || structuredAlert.details?.tags || [];

  async function submitNote(event) {
    event.preventDefault();

    if (!noteText.trim() || !alert) {
      return;
    }

    try {
      await onAddNote(alert, noteText.trim());
      setNoteText('');
    } catch {
      // The page-level error banner already shows the backend message.
    }
  }

  async function submitJiraLink(event) {
    event.preventDefault();

    if (!jiraKey.trim() || !alert) {
      return;
    }

    try {
      await onLinkJira(alert, jiraKey.trim());
      setJiraKey('');
    } catch {
      // The page-level error banner already shows the backend message.
    }
  }

  async function submitResponder(event) {
    event.preventDefault();

    if (!responderName.trim() || !alert) {
      return;
    }

    try {
      await onAssignResponder(alert, responderName.trim());
      setResponderName('');
    } catch {
      // The page-level error banner already shows the backend message.
    }
  }

  return (
    <div
      className={`fixed inset-0 z-50 transition ${isOpen ? 'pointer-events-auto' : 'pointer-events-none'}`}
      aria-hidden={!isOpen}
    >
      <div
        className={`absolute inset-0 bg-slate-950/40 transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        className={`absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {alert && (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
              <div>
                <p className="text-sm font-semibold text-cyan-700">{alert.id}</p>
                <h3 className="mt-2 text-xl font-semibold leading-tight text-slate-950">{alert.title}</h3>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge tone={alert.severity}>{alert.severity}</Badge>
                  <Badge tone={alert.status}>{alert.status}</Badge>
                  <Badge tone={alert.classification}>{alert.classification}</Badge>
                </div>
              </div>
              <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close alert details">
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <section>
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Signal summary</h4>
                {detailsLoading ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    Loading full alert details from the backend...
                  </div>
                ) : null}
                <p className="mt-3 rounded-lg bg-slate-50 p-4 text-sm leading-6 text-slate-700">{alert.signal}</p>
                <p className="mt-4 text-sm leading-6 text-slate-600">{alert.description}</p>
              </section>

              <section className={`mt-6 rounded-lg border p-4 ${
                alert.escalated
                  ? 'border-rose-200 bg-rose-50'
                  : alert.acknowledged
                    ? 'border-emerald-200 bg-emerald-50'
                    : 'border-amber-200 bg-amber-50'
              }`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-950">Acknowledgement gate</h4>
                    <p className="mt-1 text-sm leading-6 text-slate-700">
                      Slack is the notification surface. Investigation and classification are available after acknowledgement is stored.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge tone={alert.acknowledgedStatus}>{alert.acknowledgedStatus || 'unacknowledged'}</Badge>
                      {alert.escalated ? <Badge tone="escalated">Escalated</Badge> : null}
                      {isReadOnlyOperationsAlert ? <Badge tone="draft">Atlassian read-only</Badge> : null}
                    </div>
                  </div>
                  {!alert.acknowledged && !isReadOnlyOperationsAlert ? (
                    <Button
                      className="shrink-0"
                      disabled={actionLoading === 'acknowledge'}
                      onClick={() => onAcknowledge(alert)}
                      variant="primary"
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      {actionLoading === 'acknowledge' ? 'Acknowledging' : 'Acknowledge'}
                    </Button>
                  ) : null}
                </div>
                <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DetailRow label="Acknowledged by" value={alert.acknowledgedBy} />
                  <DetailRow label="Acknowledged at" value={alert.acknowledgedAt ? formatDate(alert.acknowledgedAt) : null} />
                  <DetailRow label="Acknowledgement source" value={alert.acknowledgementSource} />
                  <DetailRow label="Escalated at" value={alert.escalatedAt ? formatDate(alert.escalatedAt) : null} />
                  <DetailRow label="Escalation reason" value={alert.escalationReason} />
                </dl>
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-950">Slack Notification Details</h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Slack is used only to deliver the alert. Any acknowledgement shown here was extracted from the Slack alert text.
                    </p>
                  </div>
                  {slackAckStatus ? <Badge tone={slackAckStatus}>{slackAckStatus}</Badge> : null}
                </div>
                {hasSlackNotificationDetails ? (
                  <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <DetailRow label="Slack assignee / responder" value={slackAssignee} />
                    <DetailRow label="Slack assignee user ID" value={slackAssigneeUserId} />
                    <DetailRow label="Slack acknowledgement status" value={slackAckStatus} />
                    <DetailRow label="Acknowledged by in Slack" value={slackAckBy} />
                    <DetailRow label="Acknowledged Slack user ID" value={slackAckByUserId} />
                    <DetailRow label="Acknowledged at in Slack" value={slackAckAt ? formatDate(slackAckAt) : null} />
                    <DetailRow label="Responders from Slack" value={formatResponders(slackResponders)} />
                    <DetailRow label="Slack channel ID" value={alert.slackChannelId || slackDetails.channel_id} />
                    <DetailRow label="Slack message timestamp" value={alert.slackMessageTs || slackDetails.message_ts} />
                    <DetailLink label="Slack permalink" href={slackPermalink}>
                      Open Slack notification
                    </DetailLink>
                  </dl>
                ) : (
                  <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-500">
                    No Slack acknowledgement data was found in this alert message.
                  </p>
                )}
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Source of truth</h4>
                <div className="mt-3 grid grid-cols-1 gap-3 text-sm leading-6 text-slate-700">
                  <p>
                    <span className="font-semibold text-slate-900">Operations Alerts</span> stores the full alert record and is the backend alert source.
                  </p>
                  <p>
                    <span className="font-semibold text-slate-900">Operations Incidents</span> enriches alert history and lifecycle when a matching incident exists.
                  </p>
                  <p>
                    <span className="font-semibold text-slate-900">Slack</span> is notification-only and is not treated as the alert system of record.
                  </p>
                </div>
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-950">Monitoring Link</h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Slack delivered this notification, but the source system is {monitoringTool}.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {monitoringEventUrl ? (
                      <>
                        <a
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-800"
                          href={monitoringEventUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open Event
                          <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        </a>
                        <Button size="sm" onClick={() => copyToClipboard(monitoringEventUrl)}>
                          <CopyCheck className="h-4 w-4" aria-hidden="true" />
                          Copy Link
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DetailRow label="Monitoring tool" value={monitoringTool} />
                  <DetailRow label="Ops alert ID" value={opsAlertId} />
                  <DetailRow label="Delivery channel" value={getDeliveryChannel(alert)} />
                  <DetailLink label="Monitoring event deep link" href={monitoringEventUrl}>
                    Open in {monitoringTool}
                  </DetailLink>
                  <DetailLink label="Slack message permalink" href={slackPermalink}>
                    Open Slack message
                  </DetailLink>
                </dl>
                {!monitoringEventUrl ? (
                  <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-500">
                    No monitoring deep link was found in this Slack message. The raw message is still stored for review.
                  </p>
                ) : null}
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-950">Jira Incident Details</h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      ACC is the Jira incident key. The Operations alert remains the alert number from the monitoring source.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {jiraIssueKey ? (
                      <Button size="sm" onClick={() => copyToClipboard(jiraIssueKey)}>
                        <CopyCheck className="h-4 w-4" aria-hidden="true" />
                        Copy Incident Key
                      </Button>
                    ) : null}
                    {jiraIncidentUrl ? (
                      <a
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-800"
                        href={jiraIncidentUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {openJiraLabel}
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                </div>
                {jiraIssueKey || jiraSummary || jiraIncidentUrl ? (
                  <>
                    <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <DetailRow label="ACC incident key" value={jiraIssueKey} />
                      <DetailRow label="Summary" value={jiraSummary} />
                      <DetailRow label="Status" value={jiraStatus} />
                      <DetailRow label="Priority" value={jiraPriority} />
                      <DetailRow label="Assignee" value={jiraAssignee} />
                      <DetailRow label="Reporter" value={jiraReporter} />
                      <DetailRow label="Project key" value={slackEnrichment.jira_project_key || jiraDetails.project_key} />
                      <DetailRow label="Issue type" value={jiraDetails.issue_type || alert.issueType} />
                      <DetailRow label="Created" value={jiraDetails.created ? formatDate(jiraDetails.created) : null} />
                      <DetailRow label="Updated" value={jiraDetails.updated ? formatDate(jiraDetails.updated) : null} />
                      <DetailRow label="Resolution" value={jiraDetails.resolution} />
                      <DetailRow label="Resolution date" value={jiraDetails.resolution_date ? formatDate(jiraDetails.resolution_date) : null} />
                      <DetailLink label="Jira incident URL" href={jiraIncidentUrl}>
                        {jiraIssueKey || 'Open Jira incident'}
                      </DetailLink>
                    </dl>
                    {jiraDetails.description ? (
                      <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                        {jiraDetails.description}
                      </div>
                    ) : null}
                    {jiraDetails.enrichment_error || jiraDetails.comments_error || jiraDetails.changelog_error ? (
                      <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm leading-6 text-amber-800">
                        {[jiraDetails.enrichment_error, jiraDetails.comments_error, jiraDetails.changelog_error]
                          .filter(Boolean)
                          .join(' ')}
                      </div>
                    ) : null}
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Labels</p>
                        <ValueList items={jiraLabels} />
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Components</p>
                        <ValueList items={jiraComponents} />
                      </div>
                    </div>
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Linked issues</p>
                      {linkedIssues.length > 0 ? (
                        <div className="mt-3 space-y-3">
                          {linkedIssues.slice(0, 5).map((issue) => (
                            <div key={issue.id || issue.issue_key} className="rounded-md bg-slate-50 p-3 text-sm">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <p className="font-semibold text-slate-900">{issue.issue_key || 'Linked issue'}</p>
                                  <p className="mt-1 text-slate-600">{issue.summary || 'No summary available'}</p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {[issue.relationship, issue.status, issue.priority].filter(Boolean).join(' · ') || 'No status available'}
                                  </p>
                                </div>
                                {issue.url ? (
                                  <a
                                    className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 hover:text-cyan-800"
                                    href={issue.url}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    Open
                                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                  </a>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-3 text-sm text-slate-500">No linked Jira issues available.</p>
                      )}
                    </div>
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Jira comments</p>
                      <JiraComments comments={jiraComments} />
                    </div>
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Jira changelog</p>
                      <JiraChangelog histories={jiraChangelog} summary={jiraChangelogSummary} />
                    </div>
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Incident / root-cause custom fields</p>
                      <JiraCustomFields fields={customFields} />
                    </div>
                  </>
                ) : (
                  <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-500">
                    No Jira incident linked.
                  </p>
                )}
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Classification justification</h4>
                <p className="mt-3 text-sm leading-6 text-slate-700">
                  {alert.justification || alert.classificationReason || 'This alert has not been classified yet. Run classification to generate a reason.'}
                </p>
                <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DetailRow label="Confidence" value={alert.confidenceScore ? `${alert.confidenceScore}%` : null} />
                  <DetailRow label="Recommended action" value={alert.recommendedAction} />
                  <DetailRow label="Review status" value={alert.reviewStatus} />
                  <DetailRow label="Open/closed state" value={alert.openClosedState} />
                </dl>
                {alert.reasonCodes?.length > 0 ? (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason codes</p>
                    <ValueList items={alert.reasonCodes} />
                  </div>
                ) : null}
                {alert.noiseReason ? (
                  <p className="mt-3 rounded-md bg-cyan-50 p-3 text-sm leading-6 text-cyan-800">
                    {alert.noiseReason}
                  </p>
                ) : null}
              </section>

              <StructuredAlertSections structuredAlert={alert.structuredAlert} />

              <section className="mt-6 rounded-lg border border-cyan-200 bg-cyan-50/50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-cyan-800">
                      <Bot className="h-5 w-5" aria-hidden="true" />
                      <h4 className="text-sm font-semibold text-slate-950">Decision engine workflow</h4>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {canInvestigate
                        ? 'Process this alert to evaluate metadata, duplicate history, active incidents, source status, correlation, confidence, and final classification.'
                        : 'Acknowledge this alert first. Investigation and classification are locked until acknowledgement is stored.'}
                    </p>
                  </div>
                  <Button
                    className="shrink-0"
                    disabled={!canInvestigate || workflowProcessing}
                    onClick={() => onProcess(alert)}
                    variant="primary"
                  >
                    {workflowProcessing ? 'Processing' : 'Process Alert'}
                  </Button>
                </div>

                <div className="mt-4 space-y-4">
                  <DecisionExplanation
                    alert={workflowAlert}
                    acknowledgedAt={workflowState?.acknowledgedAt}
                    onAcknowledge={() => onAcknowledge(alert)}
                    state={workflowState}
                  />
                  <MonitoringVerification alert={workflowAlert} state={workflowState} />
                </div>
              </section>

              {isReadOnlyOperationsAlert ? (
                <section className="mt-6 rounded-lg border border-cyan-200 bg-cyan-50/60 p-4">
                  <h4 className="text-sm font-semibold text-slate-950">Read-only Operations alert</h4>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Atlassian write actions are disabled for this phase. The app can sync, classify, display links, and preserve history without acknowledging, assigning, closing, or snoozing the source alert.
                  </p>
                  {jiraIncidentUrl ? (
                    <a
                      className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-cyan-700 hover:text-cyan-800"
                      href={jiraIncidentUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open {jiraIssueKey || alert.jiraTicketId || 'Jira record'}
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </a>
                  ) : null}
                </section>
              ) : (
                <section className="mt-6 rounded-lg border border-slate-200 p-4">
                  <h4 className="text-sm font-semibold text-slate-950">Change alert status</h4>
                  <p className="mt-1 text-sm text-slate-500">
                    Use these actions when operator review changes the alert outcome.
                  </p>
                  {actionError ? (
                    <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-700">{actionError}</div>
                  ) : null}
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {alertActions.map((item) => {
                      const Icon = item.icon;

                      return (
                        <Button
                          key={item.action}
                          disabled={!canInvestigate || actionLoading === item.action}
                          onClick={() => onAction(alert, item.action)}
                        >
                          <Icon className="h-4 w-4" aria-hidden="true" />
                          {actionLoading === item.action ? 'Updating' : item.label}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <form className="rounded-lg bg-slate-50 p-3" onSubmit={submitResponder}>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Assign Responder
                        </span>
                        <input
                          className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                          disabled={!canInvestigate || actionLoading === 'assign-responder'}
                          placeholder="Responder account id, name, or team id"
                          value={responderName}
                          onChange={(event) => setResponderName(event.target.value)}
                        />
                      </label>
                      <Button
                        className="mt-3 w-full"
                        disabled={!canInvestigate || actionLoading === 'assign-responder' || !responderName.trim()}
                        type="submit"
                      >
                        {actionLoading === 'assign-responder' ? 'Assigning' : 'Assign Responder'}
                      </Button>
                    </form>
                    <form className="rounded-lg bg-slate-50 p-3" onSubmit={submitJiraLink}>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Link Jira Incident
                        </span>
                        <input
                          className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                          disabled={!canInvestigate || actionLoading === 'link-jira'}
                          placeholder="ACC-1234"
                          value={jiraKey}
                          onChange={(event) => setJiraKey(event.target.value)}
                        />
                      </label>
                      <Button
                        className="mt-3 w-full"
                        disabled={!canInvestigate || actionLoading === 'link-jira' || !jiraKey.trim()}
                        type="submit"
                      >
                        {actionLoading === 'link-jira' ? 'Linking' : 'Link Jira Incident'}
                      </Button>
                    </form>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open Jira Incident</p>
                      {jiraIncidentUrl ? (
                        <a
                          className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                          href={jiraIncidentUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open {alert.jiraTicketId}
                          <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        </a>
                      ) : (
                        <p className="mt-3 text-sm leading-6 text-slate-500">
                          Link or create a Jira incident to enable a direct incident link.
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              )}

              <dl className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
                <DetailRow label="Service" value={alert.service} />
                <DetailRow label="Application" value={alert.application} />
                <DetailRow label="Environment" value={alert.environment} />
                <DetailRow label="Priority" value={alert.priority} />
                <DetailRow label="Jira status" value={alert.jiraStatus} />
                <DetailRow label="Issue type" value={alert.issueType} />
                <DetailRow label="Source tool" value={getMonitoringSource(alert)} />
                <DetailRow label="Delivery channel" value={getDeliveryChannel(alert)} />
                <DetailRow label="Raw source type" value={alert.sourceType} />
                <DetailRow label="Source alert ID" value={alert.sourceAlertId} />
                <DetailRow label="Alias" value={structuredAlert.alias || extractedAlert.alias} />
                <DetailRow label="Entity" value={structuredAlert.entity || extraProperties.entity || extractedAlert.entity} />
                <DetailRow label="Integration" value={structuredAlert.integration || structuredAlert.details?.integration || extractedAlert.integration} />
                <DetailRow label="Health rule ID" value={structuredAlert.health_rule_id || extraProperties.health_rule_id || extractedAlert.health_rule_id} />
                <DetailRow label="Owner" value={alert.owner} />
                <DetailRow label="Assignee" value={alert.assignee} />
                <DetailRow label="Reporter" value={alert.reporter} />
                <DetailRow label="Assigned team" value={alert.assignedTeam} />
                <DetailRow label="Responders" value={formatResponders(alert.responders)} />
                <DetailRow label="Received" value={formatDate(alert.receivedAt)} />
                <DetailRow label="Last seen" value={formatDate(alert.lastSeenAt)} />
                <DetailRow label="Resolved at" value={alert.resolvedAt ? formatDate(alert.resolvedAt) : null} />
                <DetailRow label="Closed at" value={alert.closedAt ? formatDate(alert.closedAt) : null} />
                <DetailRow label="Occurrences" value={alert.occurrences} />
                <DetailRow label="Confidence" value={alert.confidenceScore ? `${alert.confidenceScore}%` : null} />
                <DetailRow label="Noise type" value={alert.noiseType} />
                <DetailRow label="Duplicate signature" value={alert.duplicateSignature} />
                <DetailRow label="Correlation ID" value={alert.correlationId} />
                <DetailRow label="ACC incident" value={alert.jiraTicketId} />
                <DetailRow label="Jira incident key" value={alert.jiraIssueKey} />
                <DetailRow label="Recurring incident" value={alert.recurringIncident ? 'Yes' : 'No'} />
                <DetailLink label="Deep event link" href={alert.deepEventLink}>
                  Open event source
                </DetailLink>
                <DetailLink label="Controller URL" href={structuredAlert.controller_url || extraProperties.controller_url || extractedAlert.controller_url}>
                  Open controller
                </DetailLink>
                <DetailLink label="Jira incident link" href={jiraIncidentUrl}>
                  {alert.jiraTicketId}
                </DetailLink>
              </dl>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Tags</h4>
                <ValueList items={tags} />
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Notes</h4>
                <form className="mt-3" onSubmit={submitNote}>
                  <textarea
                    className="min-h-24 w-full rounded-md border border-slate-200 p-3 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                    disabled={!canInvestigate || actionLoading === 'note'}
                    placeholder={canInvestigate ? 'Add investigation notes for this alert...' : 'Acknowledge the alert before adding notes.'}
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                  />
                  <Button
                    className="mt-3"
                    disabled={!canInvestigate || actionLoading === 'note' || !noteText.trim()}
                    type="submit"
                    variant="primary"
                  >
                    {actionLoading === 'note' ? 'Saving Note' : 'Add Note'}
                  </Button>
                </form>
                {alert.notes?.length > 0 ? (
                  <div className="mt-4 space-y-3">
                    {alert.notes.map((note) => (
                      <div key={note.id || `${note.createdBy}-${note.createdAt}`} className="rounded-md bg-slate-50 p-3 text-sm">
                        <p className="leading-6 text-slate-700">{note.note}</p>
                        <p className="mt-2 text-xs font-medium text-slate-500">
                          {[note.createdBy, formatDate(note.createdAt)].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">No notes have been added yet.</p>
                )}
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Audit trail</h4>
                {alert.auditEvents?.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {alert.auditEvents.map((event) => (
                      <div key={event.id || `${event.eventType}-${event.createdAt}`} className="rounded-md bg-slate-50 p-3 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-900">{event.eventType}</p>
                            <p className="mt-1 text-slate-600">
                              {[event.actor, event.source].filter(Boolean).join(' · ') || 'System event'}
                            </p>
                          </div>
                          <span className="shrink-0 text-xs font-medium text-slate-500">{formatDate(event.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No audit events captured yet.</p>
                )}
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Operations incident history</h4>
                {alert.incidentHistory?.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {alert.incidentHistory.map((incident) => (
                      <div key={incident.incident_key} className="rounded-md bg-slate-50 p-3 text-sm">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="font-semibold text-slate-900">{incident.incident_key}</p>
                            <p className="mt-1 text-slate-600">{incident.summary || 'No summary available'}</p>
                          </div>
                          {incident.source_url ? (
                            <a
                              className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 hover:text-cyan-800"
                              href={incident.source_url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open incident
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {[incident.status, incident.priority, incident.resolution].filter(Boolean).join(' · ') || 'No status available'}
                        </p>
                        {incident.root_cause_notes?.length > 0 ? (
                          <p className="mt-2 rounded-md bg-white p-2 text-xs leading-5 text-slate-600">
                            {incident.root_cause_notes[0]}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : alert.linkedIssues?.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {alert.linkedIssues.map((issue) => (
                      <div key={issue.id || issue.issue_key} className="rounded-md bg-slate-50 p-3 text-sm">
                        <p className="font-semibold text-slate-900">{issue.issue_key || 'Linked issue'}</p>
                        <p className="mt-1 text-slate-600">{issue.summary || 'No summary available'}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {[issue.relationship, issue.status, issue.priority].filter(Boolean).join(' · ') || 'No status available'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No linked Operations incidents found.</p>
                )}
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Activity timeline</h4>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Read-only Operations activity, notes, responders, and attachment metadata stored during synchronization.
                </p>
                <ActivityTimeline activity={operationsActivity} />
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Raw payloads</h4>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Raw Slack and Jira payloads are preserved for debugging, audit, and future parsing improvements.
                </p>
                <div className="mt-4 space-y-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Raw Slack payload</p>
                    <div className="mt-2">
                      <CompactJson value={rawSlackPayload} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Raw Jira issue payload</p>
                    <div className="mt-2">
                      <CompactJson value={rawJiraIssuePayload} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Raw Jira comments payload</p>
                    <div className="mt-2">
                      <CompactJson value={rawJiraCommentsPayload} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Raw Jira changelog payload</p>
                    <div className="mt-2">
                      <CompactJson value={rawJiraChangelogPayload} />
                    </div>
                  </div>
                </div>
              </section>

              <section className="mt-6 rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-950">Related alerts</h4>
                {alert.relatedAlerts.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {alert.relatedAlerts.map((relatedAlert) => (
                      <Badge key={relatedAlert}>{relatedAlert}</Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No related alerts found.</p>
                )}
              </section>

              <ExtractedDetailsPanel details={alert.extractedDetails} />
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

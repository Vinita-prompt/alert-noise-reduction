import { ExternalLink, X } from 'lucide-react';
import Badge from '../common/Badge.jsx';
import Button from '../common/Button.jsx';

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

function isPresent(value) {
  if (value === null || value === undefined || value === '') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(isPresent);
  }

  if (typeof value === 'object') {
    return Object.values(value).some(isPresent);
  }

  const normalized = String(value).trim().toLowerCase();

  return normalized !== ''
    && normalized !== 'not available'
    && normalized !== 'n/a'
    && normalized !== 'null'
    && normalized !== 'undefined';
}

function extractObjectText(value) {
  const fragments = [];

  function walk(node) {
    if (!node) {
      return;
    }

    if (typeof node === 'string' || typeof node === 'number') {
      fragments.push(String(node));
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    if (node.type === 'hardBreak' || node.type === 'paragraph') {
      fragments.push('\n');
    }

    if (node.text) {
      fragments.push(node.text);
    }

    if (node.url) {
      fragments.push(node.url);
    }

    if (node.content) {
      walk(node.content);
    }
  }

  walk(value);

  return fragments.join(' ');
}

function cleanText(value) {
  if (!isPresent(value)) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean).join(', ');
  }

  if (typeof value === 'object') {
    return extractObjectText(value)
      .replace(/\s+\n/g, '\n')
      .replace(/\n\s+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return String(value)
    .replace(/\\n/g, '\n')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 - $2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const INCIDENT_DESCRIPTION_LABELS = [
  'Category',
  'Urgency',
  'Impact to Operations',
  'Impact',
  'Business Impact',
  'Meeting / Chat Links',
  'Meeting Chat Links',
  'Teams Bridge',
  'Slack Thread Started',
];

function normalizeDescriptionText(value) {
  const labelPattern = INCIDENT_DESCRIPTION_LABELS.map(escapeRegExp).join('|');

  return cleanText(value)
    .replace(new RegExp(`\\s+(${labelPattern})\\s*:`, 'gi'), '\n$1:')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripLeadingLabels(value, labels) {
  let text = normalizeDescriptionText(value);

  labels.forEach((label) => {
    text = text.replace(new RegExp(`^\\s*${escapeRegExp(label)}\\s*[:=-]\\s*`, 'i'), '');
  });

  return text.trim();
}

function trimAtLabels(value, labels) {
  let text = normalizeDescriptionText(value);

  labels.forEach((label) => {
    const match = text.match(new RegExp(`(?:\\n|\\s)${escapeRegExp(label)}\\s*[:=-]`, 'i'));

    if (match?.index > 0) {
      text = text.slice(0, match.index);
    }
  });

  return text.trim();
}

function removeUrls(value) {
  return cleanText(value)
    .replace(/https?:\/\/[^\s)>,"]+/gi, '')
    .replace(/\s+\([^)]*$/g, '')
    .replace(/\s*[-–:,(]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripMachineSuffix(value) {
  return cleanText(value)
    .replace(/\s+\d+_\*:\*.*$/i, '')
    .replace(/\s+\d+\s+\*:\*.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanLabelledField(value, ownLabels = [], stopLabels = INCIDENT_DESCRIPTION_LABELS) {
  const withoutOwnLabel = stripLeadingLabels(value, ownLabels);
  const stops = stopLabels.filter((label) => !ownLabels.some((ownLabel) => ownLabel.toLowerCase() === label.toLowerCase()));

  return trimAtLabels(withoutOwnLabel, stops);
}

function extractUrls(...values) {
  return [...new Set(
    values
      .flat()
      .map(cleanText)
      .join('\n')
      .match(/https?:\/\/[^\s)>,"]+/gi) || [],
  )].filter((url) => /teams|slack|meet|zoom|bridge|chat/i.test(url));
}

function buildCleanDescription(description) {
  const meetingChatLinks = Array.isArray(description.meeting_chat_links)
    ? description.meeting_chat_links
    : [description.meeting_chat_links].filter(Boolean);
  const sourceValues = [
    description.category,
    description.urgency,
    description.impact,
    description.impact_to_operations,
    description.teams_bridge,
    description.slack_thread_started,
    description.business_impact,
    ...meetingChatLinks,
  ];
  const category = cleanLabelledField(description.category, ['Category'], [
    'Urgency',
    'Impact',
    'Impact to Operations',
    'Business Impact',
    'Meeting / Chat Links',
    'Meeting Chat Links',
    'Teams Bridge',
    'Slack Thread Started',
  ]);
  const impactToOperations = removeUrls(cleanLabelledField(description.impact_to_operations, ['Impact to Operations'], [
    'Meeting / Chat Links',
    'Meeting Chat Links',
    'Teams Bridge',
    'Slack Thread Started',
    'Business Impact',
  ]));
  const teamsBridge = removeUrls(stripMachineSuffix(cleanLabelledField(description.teams_bridge, ['Teams Bridge', 'Bridge'], [
    'Slack Thread Started',
    'Business Impact',
  ])));
  const slackThreadStarted = stripMachineSuffix(cleanLabelledField(description.slack_thread_started, ['Slack Thread Started', 'Slack Thread'], [
    'Business Impact',
    'Meeting / Chat Links',
    'Meeting Chat Links',
    'Teams Bridge',
  ]));

  return {
    category,
    urgency: cleanLabelledField(description.urgency, ['Urgency'], [
      'Impact',
      'Impact to Operations',
      'Business Impact',
      'Meeting / Chat Links',
      'Meeting Chat Links',
      'Teams Bridge',
      'Slack Thread Started',
    ]),
    impact: cleanLabelledField(description.impact, ['Impact'], [
      'Impact to Operations',
      'Business Impact',
      'Meeting / Chat Links',
      'Meeting Chat Links',
      'Teams Bridge',
      'Slack Thread Started',
    ]),
    impact_to_operations: impactToOperations,
    teams_bridge: teamsBridge,
    slack_thread_started: slackThreadStarted,
    business_impact: cleanLabelledField(description.business_impact, ['Business Impact'], [
      'Meeting / Chat Links',
      'Meeting Chat Links',
      'Teams Bridge',
      'Slack Thread Started',
    ]),
    meeting_chat_links: extractUrls(sourceValues),
  };
}

function displayValue(value) {
  return cleanText(value) || 'Not available';
}

function DetailRow({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-900">{displayValue(value)}</dd>
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

function DetailSection({ title, children }) {
  return (
    <section className="mt-6 rounded-lg border border-slate-200 p-4">
      <h4 className="text-sm font-semibold text-slate-950">{title}</h4>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DetailsGrid({ items }) {
  const visibleItems = items.filter((item) => isPresent(item.value));

  if (visibleItems.length === 0) {
    return <p className="text-sm text-slate-500">No details captured yet.</p>;
  }

  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {visibleItems.map((item) => (
        <DetailRow key={item.label} label={item.label} value={item.value} />
      ))}
    </dl>
  );
}

function ValueList({ items }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-slate-500">Not available</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={String(item)}>{String(item)}</Badge>
      ))}
    </div>
  );
}

function ExternalLinksList({ links }) {
  if (!links || links.length === 0) {
    return <p className="text-sm text-slate-500">No meeting or chat links captured.</p>;
  }

  return (
    <div className="space-y-2">
      {links.map((link) => (
        <a
          key={link}
          className="flex items-center justify-between gap-3 rounded-md border border-cyan-100 bg-cyan-50 px-3 py-2 text-sm font-medium text-cyan-800 hover:border-cyan-200 hover:bg-cyan-100"
          href={link}
          rel="noreferrer"
          target="_blank"
        >
          <span>{/teams/i.test(link) ? 'Open Teams bridge' : 'Open meeting / chat link'}</span>
          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

function TextBlock({ value, fallback = 'No details captured yet.' }) {
  const text = cleanText(value);

  if (!text) {
    return <p className="text-sm text-slate-500">{fallback}</p>;
  }

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => /^[-*•]\s+/.test(line));

  if (bulletLines.length >= 2 && bulletLines.length === lines.length) {
    return (
      <ul className="space-y-2 text-sm leading-6 text-slate-700">
        {lines.map((line) => (
          <li key={line} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" />
            <span>{line.replace(/^[-*•]\s+/, '')}</span>
          </li>
        ))}
      </ul>
    );
  }

  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);

  return (
    <div className="space-y-3">
      {paragraphs.map((paragraph) => (
        <p key={paragraph} className="break-words text-sm leading-6 text-slate-700">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function DescriptionPanel({ description }) {
  const primaryItems = [
    { label: 'Category', value: description.category },
    { label: 'Urgency', value: description.urgency },
    { label: 'Impact', value: description.impact },
    { label: 'Impact to operations', value: description.impact_to_operations },
    { label: 'Teams bridge', value: description.teams_bridge },
    { label: 'Slack thread started', value: description.slack_thread_started },
  ];
  const hasLinks = Array.isArray(description.meeting_chat_links) && description.meeting_chat_links.length > 0;

  return (
    <div className="space-y-5">
      <DetailsGrid items={primaryItems} />
      {hasLinks ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Meeting / chat links</p>
          <div className="mt-2">
            <ExternalLinksList links={description.meeting_chat_links} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function IncidentDetailsDrawer({ incident, onClose }) {
  const isOpen = Boolean(incident);
  const details = incident?.incidentDetails || {};
  const description = buildCleanDescription(details.description || {});

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
        {incident ? (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
              <div>
                <p className="text-sm font-semibold text-cyan-700">{details.incident_key || incident.incidentKey || incident.jiraTicketId}</p>
                <h3 className="mt-2 text-xl font-semibold leading-tight text-slate-950">{incident.title}</h3>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge tone={incident.severity}>{incident.severity}</Badge>
                  <Badge tone={incident.status}>{incident.status}</Badge>
                  {incident.resolution ? <Badge>{incident.resolution}</Badge> : null}
                </div>
              </div>
              <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close incident details">
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <DetailSection title="Key details">
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DetailRow label="Assignee" value={details.assignee || incident.assignee} />
                  <DetailRow label="Raised via" value={details.raised_via} />
                  <DetailRow label="Priority" value={details.priority || incident.priority} />
                  <DetailRow label="Platform" value={details.platform} />
                  <DetailLink label="View in Jira" href={details.source_url || incident.sourceUrl}>
                    {details.incident_key || incident.jiraTicketId}
                  </DetailLink>
                  <DetailRow label="Reporter" value={incident.reporter} />
                </dl>
              </DetailSection>

              <DetailSection title="Incident Impact">
                <DetailsGrid
                  items={[
                    { label: 'Executive summary', value: details.incident_executive_summary },
                    { label: 'Duration', value: details.incident_duration },
                    { label: 'Urgency', value: details.urgency },
                    { label: 'Impact', value: details.impact },
                    { label: 'Start time', value: formatDate(details.start_time) },
                    { label: 'End time', value: formatDate(details.end_time) },
                    { label: 'Change related', value: details.change_related },
                  ]}
                />
              </DetailSection>

              <DetailSection title="Root Cause">
                <DetailsGrid
                  items={[
                    { label: 'Category', value: details.root_cause_category },
                    { label: 'Owner team', value: details.root_cause_owner_team },
                    { label: 'Excluded / Nonexcluded', value: details.excluded_or_nonexcluded },
                    { label: 'Affected products', value: details.affected_products },
                    { label: 'Affected business services', value: details.affected_business_services },
                    { label: 'Affected objects', value: details.affected_objects },
                  ]}
                />
                <div className="mt-4 rounded-md bg-slate-50 p-3">
                  <TextBlock value={details.root_cause || incident.rootCauseNotes?.[0]} />
                </div>
              </DetailSection>

              <DetailSection title="Description">
                <DescriptionPanel description={description} />
              </DetailSection>

              <DetailSection title="Business Impact">
                <TextBlock value={description.business_impact} />
              </DetailSection>

              <DetailSection title="Recovery Actions">
                <TextBlock value={details.recovery_actions} />
              </DetailSection>

              <DetailSection title="Preventative Measures">
                <TextBlock value={details.preventative_measures} />
              </DetailSection>

              <DetailSection title="People and teams">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">People involved</p>
                    <div className="mt-2">
                      <ValueList items={details.people_involved || []} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Teams involved</p>
                    <div className="mt-2">
                      <ValueList items={details.teams_involved || []} />
                    </div>
                  </div>
                </div>
              </DetailSection>

              <DetailSection title="Timeline">
                {details.timeline?.length > 0 ? (
                  <div className="space-y-3">
                    {details.timeline.map((event, index) => (
                      <div key={`${event.time}-${index}`} className="rounded-md bg-slate-50 p-3 text-sm">
                        <p className="font-semibold text-slate-900">{formatDate(event.time)}</p>
                        <div className="mt-1">
                          <TextBlock value={event.event} fallback="No event details captured." />
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{event.actor || 'Unknown actor'}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Not available</p>
                )}
              </DetailSection>

              <DetailSection title="Attachments">
                {details.attachments?.length > 0 ? (
                  <div className="space-y-2">
                    {details.attachments.map((attachment) => (
                      <a
                        key={attachment.url || attachment.name}
                        className="flex items-center justify-between gap-3 rounded-md bg-slate-50 p-3 text-sm font-medium text-cyan-700 hover:text-cyan-800"
                        href={attachment.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <span>{attachment.name || 'Attachment'}</span>
                        <span className="text-xs text-slate-500">{attachment.type || 'file'}</span>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Not available</p>
                )}
              </DetailSection>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}

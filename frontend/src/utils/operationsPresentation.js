const SOURCE_ACTION_LABELS = {
  appdynamics: 'Open in AppDynamics',
  grafana: 'Open in Grafana',
  nagios: 'Open in Nagios',
  thousandeyes: 'Open in ThousandEyes',
};

const DESCRIPTION_LABELS = new Map([
  ['event message', 'Event Message'],
  ['event time', 'Event Time'],
  ['severity', 'Severity'],
  ['tier', 'Tier'],
]);

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isOpaqueIdentity(value) {
  return /^(?:og-[a-f0-9-]+|[a-f0-9]{20,})$/i.test(String(value || '').trim());
}

function operatorIdentity(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return {
      displayName: isEmail(text) || isOpaqueIdentity(text) ? null : text,
      email: isEmail(text) ? text : null,
      fallback: text,
      keys: new Set([text.toLowerCase()]),
    };
  }
  if (typeof value !== 'object') return null;

  const email = [value.email, value.emailAddress, value.username, value.name, value.id]
    .map((item) => String(item || '').trim())
    .find(isEmail) || null;
  const displayName = [value.displayName, value.fullName, value.name, value.username]
    .map((item) => String(item || '').trim())
    .find((item) => item && !isEmail(item) && !isOpaqueIdentity(item)) || null;
  const fallback = email || displayName || [value.name, value.username, value.id, value.accountId]
    .map((item) => String(item || '').trim())
    .find(Boolean) || null;
  const keys = new Set([value.id, value.accountId, email]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean));
  return fallback ? { displayName, email, fallback, keys } : null;
}

function normalizedOperationsKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function operationsValueFrom(object, ...keys) {
  if (!object || typeof object !== 'object') return null;
  const entries = new Map(Object.entries(object)
    .map(([key, value]) => [normalizedOperationsKey(key), value]));
  for (const key of keys) {
    const value = entries.get(normalizedOperationsKey(key));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function operationsDescriptionFields(value) {
  const fields = {};
  cleanOperationsMarkup(value).split('\n').forEach((line) => {
    const match = line.match(/^([^:]{2,40})\s*:\s*(.+)$/);
    if (!match) return;
    const key = normalizedOperationsKey(match[1]);
    if (!fields[key]) fields[key] = match[2].trim();
  });
  return fields;
}

function sourceKey(value) {
  return String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
}

function conciseValue(value, limit = 150) {
  const text = compactOperationsText(value);
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > limit * 0.7 ? boundary : limit).trim()}…`;
}

function conciseDescription(value, excludedLabels = []) {
  const excluded = new Set(excludedLabels.map(normalizedOperationsKey));
  const lines = cleanOperationsMarkup(value).split('\n').filter((line) => {
    const match = line.match(/^([^:]{2,40})\s*:/);
    return !match || !excluded.has(normalizedOperationsKey(match[1]));
  });
  return conciseValue(lines.join(' '), 190) || null;
}

export function resolveOperatorIdentities(primary, candidates = []) {
  const candidateIdentities = candidates.map(operatorIdentity).filter(Boolean);
  const primaryIdentity = operatorIdentity(primary);
  if (primaryIdentity) {
    const match = candidateIdentities.find((candidate) => [...candidate.keys]
      .some((key) => primaryIdentity.keys.has(key)));
    return [{
      displayName: primaryIdentity.displayName || match?.displayName || null,
      email: primaryIdentity.email || match?.email || null,
      fallback: primaryIdentity.fallback,
    }];
  }

  const seen = new Set();
  return candidateIdentities.reduce((identities, identity) => {
    const signature = String(identity.email || identity.displayName || identity.fallback).toLowerCase();
    if (!signature || seen.has(signature) || isOpaqueIdentity(identity.fallback)) return identities;
    seen.add(signature);
    identities.push({
      displayName: identity.displayName,
      email: identity.email,
      fallback: identity.fallback,
    });
    return identities;
  }, []);
}

export function operationsCardPresentation(alert = {}) {
  const key = sourceKey(alert.sourceSystem);
  const title = compactOperationsText(alert.title || alert.message);
  const extra = alert.extraProperties || {};
  const described = operationsDescriptionFields(alert.description);
  const parsedDescription = formatOperationsDescription(alert.description);
  const parsedValue = (label) => parsedDescription.find((section) => section.label === label)?.paragraphs?.[0] || null;
  const sourceDetails = alert.sourceDetails || {};

  if (key === 'nagios') {
    const titleMatch = title.match(/Host Alert:\s*(.+?)\s+is\s+([A-Z]+)\b/i);
    const host = described.host || operationsValueFrom(extra, 'host_name', 'host_alias') || sourceDetails.host || titleMatch?.[1] || alert.service;
    const service = described.service || operationsValueFrom(extra, 'service_name') || sourceDetails.nagiosService;
    const state = described.state || operationsValueFrom(extra, 'host_state', 'service_state') || titleMatch?.[2]?.toUpperCase();
    const output = described.additionalinfo || described.output || operationsValueFrom(extra, 'host_output', 'service_output');
    const unreachable = /unreachable/i.test(String(output || ''));
    const packetLoss = String(output || '').match(/(?:lost\s+|pl=)(\d+(?:\.\d+)?)%/i)?.[1];
    const summary = [
      host && unreachable ? `Host ${host} is unreachable.` : host && state ? `Host ${host} is ${state}.` : null,
      packetLoss ? `${packetLoss}% packet loss detected.` : null,
    ].filter(Boolean).join(' ');
    return {
      description: summary || conciseValue(output, 190) || null,
      fields: [
        ['Host', host],
        ['State', state],
        ['Service', service && service !== host ? service : null],
        ['Output', conciseValue(output, 100)],
      ].filter(([, value]) => value !== null && value !== undefined && value !== ''),
      key,
      severity: alert.severity,
    };
  }

  if (key === 'grafana') {
    return {
      description: conciseDescription(alert.description, ['Runbook', 'Service', 'Team', 'Environment']),
      fields: [
        ['Service', alert.service],
        ['Team', alert.team],
        ['Environment', alert.environment],
        ['Severity', alert.severity],
      ].filter(([, value]) => value !== null && value !== undefined && value !== ''),
      key,
      severity: alert.severity,
    };
  }

  if (key === 'appdynamics') {
    const titleMatch = title.match(/^(.+?)\s+Business Transaction Health is\s+([^.]+)\.?$/i);
    const application = alert.application || parsedValue('Application') || titleMatch?.[1] || alert.service;
    const tier = alert.tier || parsedValue('Tier');
    const severity = parsedValue('Severity') || alert.severity || (titleMatch?.[2] ? `${titleMatch[2][0].toUpperCase()}${titleMatch[2].slice(1).toLowerCase()}` : null);
    return {
      description: conciseDescription(alert.description, ['Tier', 'Severity', 'Event Time'])
        || (application && severity ? `Business transaction health is ${String(severity).toLowerCase()} for ${application}.` : null),
      fields: [
        ['Application / Tier', [application, tier].filter(Boolean).join(' · ')],
        ['Business transaction', operationsValueFrom(extra, 'Entity') || alert.entity],
        ['Severity', severity],
        ['Environment', alert.environment],
      ].filter(([, value]) => value !== null && value !== undefined && value !== ''),
      key,
      severity,
    };
  }

  if (key === 'thousandeyes') {
    const titleMatch = title.match(/^Availability Alert for\s+(.+)$/i);
    const testOrRule = operationsValueFrom(extra, 'Test', 'Test Name', 'Rule') || titleMatch?.[1];
    return {
      description: conciseDescription(alert.description)
        || (testOrRule ? `External availability may be impacted for ${testOrRule}.` : null),
      fields: [
        ['Test / Rule', testOrRule],
        ['Violation count', operationsValueFrom(extra, 'Violation Count', 'violationCount')],
        ['Event ID', operationsValueFrom(extra, 'Event ID', 'eventId')],
        ['Severity', alert.severity],
        ['Service', alert.service],
      ].filter(([, value]) => value !== null && value !== undefined && value !== '').slice(0, 4),
      key,
      severity: alert.severity,
    };
  }

  return {
    description: conciseDescription(alert.description),
    fields: [
      ['Service', alert.service],
      ['Team', alert.team],
      ['Environment', alert.environment],
      ['Severity', alert.severity],
    ].filter(([, value]) => value !== null && value !== undefined && value !== ''),
    key,
    severity: alert.severity,
  };
}

function decodeEntity(entity) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  const normalized = entity.toLowerCase();
  if (named[normalized]) return named[normalized];
  if (/^#\d+$/.test(normalized)) {
    const codePoint = Number(normalized.slice(1));
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  if (/^#x[\da-f]+$/i.test(normalized)) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  return `&${entity};`;
}

export function cleanOperationsMarkup(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(?:div|li|p)\s*>/gi, '\n')
    .replace(/<\s*li(?:\s[^>]*)?>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&([#\w]+);/g, (_, entity) => decodeEntity(entity))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function compactOperationsText(value) {
  return cleanOperationsMarkup(value).replace(/\s+/g, ' ').trim();
}

export function formatOperationsDescription(value) {
  const lines = cleanOperationsMarkup(value).split('\n').filter(Boolean);
  const sections = [];
  let current = null;

  function startSection(label, text) {
    current = { label, paragraphs: text ? [text] : [] };
    sections.push(current);
  }

  lines.forEach((line) => {
    const labeled = line.match(/^([^:]{2,30})\s*:\s*(.*)$/);
    const normalizedLabel = labeled?.[1]?.trim().toLowerCase();
    if (labeled && DESCRIPTION_LABELS.has(normalizedLabel)) {
      startSection(DESCRIPTION_LABELS.get(normalizedLabel), labeled[2].trim());
      return;
    }

    const application = line.match(/^For Application\s+(.+?):?$/i);
    if (application) {
      startSection('Application', application[1].replace(/:$/, '').trim());
      return;
    }

    const condition = line.match(/^\d+\)\s*(.+?)(?:\s+Baseline Condition)?$/i);
    if (condition) {
      startSection('Condition', condition[1].trim());
      return;
    }

    if (!current) startSection(null, line);
    else current.paragraphs.push(line);
  });

  return sections;
}

export function formatOperatorTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatOperatorTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
  }).format(date);
}

export function sourceActionLabel(sourceSystem) {
  const normalized = String(sourceSystem || '').replace(/[^a-z]/gi, '').toLowerCase();
  return SOURCE_ACTION_LABELS[normalized] || 'Open source';
}

export function validOperationsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

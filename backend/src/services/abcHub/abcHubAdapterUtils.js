const SOURCE_TOOL = 'ABC Hub';
const DEFAULT_BASE_URL = 'https://abc-hub.example.com';

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toIso(date) {
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
}

function normalizeStatus(value) {
  const normalized = String(value || '').toLowerCase();

  if (['ok', 'healthy', 'running', 'success', 'passed', 'online', 'active'].includes(normalized)) {
    return 'ok';
  }

  if (['warning', 'degraded', 'slow', 'late', 'idle'].includes(normalized)) {
    return 'warning';
  }

  if (['critical', 'failed', 'down', 'stopped', 'error', 'locked'].includes(normalized)) {
    return 'critical';
  }

  return normalized || 'unknown';
}

function severityFromStatus(status) {
  if (status === 'critical') return 'critical';
  if (status === 'warning') return 'warning';
  if (status === 'unknown') return 'medium';
  return 'low';
}

function buildDeepLink(path, config = {}) {
  const baseUrl = String(config.baseUrl || process.env.ABC_HUB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  return `${baseUrl}${path}`;
}

function mapRecord(base, config) {
  const status = normalizeStatus(base.status);

  return {
    sourceTool: SOURCE_TOOL,
    environment: base.environment || 'production',
    applicationName: base.applicationName,
    entityType: base.entityType,
    entityId: base.entityId,
    entityName: base.entityName,
    status,
    severity: base.severity || severityFromStatus(status),
    summary: base.summary,
    details: base.details,
    acknowledged: Boolean(base.acknowledged),
    lastCheck: base.timestamp,
    updatedAt: base.lastUpdatedAt || base.timestamp,
    rawPayload: base.rawPayload || base,
    deepLink: base.deepLink || buildDeepLink(base.deepLinkPath || '/', config),
    customProperties: {
      moduleKey: base.moduleKey,
      moduleName: base.applicationName,
      entityName: base.entityName,
      timestamp: base.timestamp,
      lastUpdatedAt: base.lastUpdatedAt || base.timestamp,
      ...base.customProperties,
    },
  };
}

module.exports = {
  SOURCE_TOOL,
  addMinutes,
  buildDeepLink,
  mapRecord,
  slug,
  toIso,
};

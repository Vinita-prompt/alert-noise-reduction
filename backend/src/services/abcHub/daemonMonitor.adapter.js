const {
  addMinutes,
  mapRecord,
  slug,
  toIso,
} = require('./abcHubAdapterUtils');

const definition = {
  key: 'daemon-monitor',
  label: 'Daemon Monitor',
  entityType: 'module',
  primaryEntityType: 'daemon_job',
  eventEntityType: 'daemon_job_event',
  description: 'Daemon health, status changes, and platform worker timeline.',
  replaceSnapshot: true,
};

const BROKEN_JOBS_PATH = '/abcHub/api/v1/daemon-monitors/broken-jobs';

function shouldUseLiveApi(config) {
  return !/^true$/i.test(process.env.ABC_HUB_USE_MOCK || '') &&
    config?.baseUrl &&
    !String(config.baseUrl).includes('abc-hub.example.com');
}

function buildHeaders(config) {
  const headers = {
    Accept: 'application/json',
  };

  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
    headers['X-API-Key'] = config.token;
  }

  return headers;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = String(value || '').toLowerCase();

  if (['true', 'yes', 'y', '1', 'active', 'running'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'inactive', 'stopped'].includes(normalized)) return false;

  return Boolean(value);
}

function normalizeTimestamp(value, fallback) {
  if (!value) return fallback;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();

  return text || null;
}

function secondsBetween(start, end) {
  if (!start || !end) return null;

  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return null;
  }

  return Math.max(0, Math.round((endTime - startTime) / 1000));
}

function secondsFromNow(timestamp, now = new Date()) {
  if (!timestamp) return null;

  const time = new Date(timestamp).getTime();

  if (!Number.isFinite(time)) {
    return null;
  }

  return Math.round((time - now.getTime()) / 1000);
}

function getJobState({ active, running }) {
  if (active === null && running === null) return 'Unknown';
  if (!active) return 'Disabled';
  if (running) return 'Running';
  return 'Idle';
}

function getScheduleState({ active, running, nextRunDate }, now = new Date()) {
  if (!active) return 'Disabled';
  if (running) return 'Running';

  const timeUntilNextRun = secondsFromNow(nextRunDate, now);

  if (timeUntilNextRun === null) return 'Healthy';
  if (timeUntilNextRun < -3600) return 'Missed Schedule';
  if (timeUntilNextRun < 0) return 'Delayed';
  return 'Healthy';
}

function statusFromScheduleState(scheduleState) {
  if (scheduleState === 'Missed Schedule') return 'critical';
  if (scheduleState === 'Delayed') return 'unknown';
  if (scheduleState === 'Running') return 'warning';
  if (scheduleState === 'Disabled') return 'pending';
  return 'ok';
}

function getBusinessUnit(item = {}) {
  return normalizeString(
    item.VPD
      ?? item.vpd
      ?? item.businessUnit
      ?? item.business_unit
      ?? item.daemonJobCompanyId
      ?? item.companyId,
  );
}

function buildAiFeatures({
  executionDurationSeconds,
  missedSchedule,
  delayed,
  active,
  running,
  timeSinceLastRunSeconds,
  timeUntilNextRunSeconds,
}) {
  const knownDuration = Number.isFinite(Number(executionDurationSeconds))
    ? Number(executionDurationSeconds)
    : null;
  const runningDuration = running && Number.isFinite(Number(timeSinceLastRunSeconds))
    ? Math.max(0, Number(timeSinceLastRunSeconds))
    : null;
  const downtimeScore = active === false ? 0.8 : missedSchedule ? 0.7 : delayed ? 0.35 : 0;
  const stabilityScore = Math.max(0, Math.min(1, 1 - downtimeScore - (running ? 0.05 : 0)));

  return {
    executionDuration: knownDuration,
    averageExecutionDuration: knownDuration,
    maximumExecutionDuration: knownDuration,
    minimumExecutionDuration: knownDuration,
    missedScheduleCount: missedSchedule ? 1 : 0,
    lateExecutionCount: delayed || missedSchedule ? 1 : 0,
    recurrenceCount: delayed || missedSchedule ? 1 : 0,
    stabilityScore,
    executionFrequency: Number.isFinite(Number(timeUntilNextRunSeconds)) && timeUntilNextRunSeconds > 0
      ? Number((86400 / Math.max(1, Number(timeUntilNextRunSeconds))).toFixed(4))
      : null,
    downtimeScore,
    runningDuration,
    historicalFailureCount: missedSchedule || active === false ? 1 : 0,
    historicalSuccessCount: !missedSchedule && active !== false ? 1 : 0,
    anomalyScore: null,
    noiseProbability: null,
    incidentProbability: null,
  };
}

function getStatus(item) {
  const rawActive = item.Active ?? item.active;
  const rawRunning = item['Currently Running'] ?? item.running;
  const active = rawActive === null || rawActive === undefined ? null : normalizeBoolean(rawActive);
  const running = rawRunning === null || rawRunning === undefined ? null : normalizeBoolean(rawRunning);
  const nextRunDate = normalizeTimestamp(item['Next Run Date'] ?? item.nextRunDate, null);
  const scheduleState = getScheduleState({ active, running, nextRunDate });

  return statusFromScheduleState(scheduleState);
}

function mapBrokenJob(item, config, index = 0, sourceMode = 'live', fullPayload = null) {
  const id = item.Id ?? item.id ?? item.daemonJobCompanyId ?? item.Name ?? item.name ?? index;
  const name = item.Name ?? item.name ?? `Daemon job ${id}`;
  const businessUnit = getBusinessUnit(item);
  const companyContext = normalizeString(item.daemonJobCompanyId) || businessUnit || index;
  const entityId = `${definition.key}:${id}:${companyContext}`;
  const lastEndDate = normalizeTimestamp(item['Last End Date'] ?? item.lastEndDate, null);
  const lastStartDate = normalizeTimestamp(item['Last Start Date'] ?? item.lastStartDate, null);
  const nextRunDate = normalizeTimestamp(item['Next Run Date'] ?? item.nextRunDate, null);
  const timestamp = lastEndDate || lastStartDate || nextRunDate || new Date().toISOString();
  const rawActive = item.Active ?? item.active;
  const rawRunning = item['Currently Running'] ?? item.running;
  const active = rawActive === null || rawActive === undefined ? null : normalizeBoolean(rawActive);
  const running = rawRunning === null || rawRunning === undefined ? null : normalizeBoolean(rawRunning);
  const hasInsight = normalizeBoolean(item.hasInsight);
  const status = getStatus(item);
  const now = new Date();
  const executionDurationSeconds = secondsBetween(lastStartDate, lastEndDate);
  const timeSinceLastRunSeconds = secondsFromNow(lastEndDate || lastStartDate, now);
  const timeUntilNextRunSeconds = secondsFromNow(nextRunDate, now);
  const jobState = getJobState({ active, running });
  const scheduleState = getScheduleState({ active, running, nextRunDate }, now);
  const missedSchedule = scheduleState === 'Missed Schedule';
  const delayed = scheduleState === 'Delayed';
  const aiFeatures = buildAiFeatures({
    executionDurationSeconds,
    missedSchedule,
    delayed,
    active,
    running,
    timeSinceLastRunSeconds: timeSinceLastRunSeconds === null ? null : Math.abs(timeSinceLastRunSeconds),
    timeUntilNextRunSeconds,
  });

  return mapRecord({
    applicationName: definition.label,
    entityType: definition.primaryEntityType,
    entityId,
    moduleKey: definition.key,
    entityName: name,
    status,
    summary: `${name} is ${scheduleState.toLowerCase()}`,
    details: `VPD ${businessUnit || 'unknown'} · server ${item.Server || item.server || 'unknown'} · active ${active ? 'yes' : 'no'} · running ${running ? 'yes' : 'no'}.`,
    timestamp,
    lastUpdatedAt: timestamp,
    deepLinkPath: `/daemon-monitor/${encodeURIComponent(id)}`,
    customProperties: {
      id,
      VPD: businessUnit,
      vpd: businessUnit,
      businessUnit,
      business_unit: businessUnit,
      daemonJobCompanyId: item.daemonJobCompanyId ?? null,
      daemon_job_company_id: item.daemonJobCompanyId ?? null,
      daemonName: name,
      entity_name: name,
      entityName: name,
      active,
      running,
      currentlyRunning: running,
      currently_running: running,
      server: item.Server || item.server || null,
      nextRunDate,
      next_run_date: nextRunDate,
      lastStartDate,
      last_start_date: lastStartDate,
      lastEndDate,
      last_end_date: lastEndDate,
      executionDurationSeconds,
      execution_duration: executionDurationSeconds,
      timeSinceLastRunSeconds: timeSinceLastRunSeconds === null ? null : Math.abs(timeSinceLastRunSeconds),
      time_since_last_run: timeSinceLastRunSeconds === null ? null : Math.abs(timeSinceLastRunSeconds),
      timeUntilNextRunSeconds,
      time_until_next_run: timeUntilNextRunSeconds,
      jobState,
      job_state: jobState,
      scheduleState,
      schedule_state: scheduleState,
      missedSchedule,
      missed_schedule: missedSchedule,
      delayed,
      hasInsight,
      has_insight: hasInsight,
      sourceMode,
      health: scheduleState,
      aiFeatures,
      recentEvents: [
        `${scheduleState} state observed on ${item.Server || item.server || 'unknown server'}`,
        lastEndDate ? `Last ended ${lastEndDate}` : 'Last end time not available',
      ],
    },
    rawPayload: fullPayload
      ? { job: item, fullPayload }
      : item,
  }, config);
}

function mapBrokenJobEvent(record) {
  return {
    ...record,
    entityType: definition.eventEntityType,
    entityId: `${record.entityId}:event:${record.customProperties.lastEndDate || record.customProperties.lastStartDate || record.customProperties.nextRunDate || 'latest'}`,
    summary: `${record.customProperties.daemonName} daemon monitor event`,
  };
}

function extractItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function fetchLiveRecords(range, config) {
  const url = new URL(BROKEN_JOBS_PATH.replace(/^\/+/, ''), `${config.baseUrl.replace(/\/+$/, '')}/`);

  const response = await fetch(url, {
    headers: buildHeaders(config),
  });

  if (!response.ok) {
    const error = new Error(`ABC Hub Daemon Monitor returned HTTP ${response.status}.`);
    error.status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw error;
  }

  const payload = await response.json();
  const jobs = extractItems(payload);
  const jobRecords = jobs.map((item, index) => mapBrokenJob(item, config, index, 'live', payload));
  const eventRecords = jobRecords.map(mapBrokenJobEvent);
  const records = [...jobRecords, ...eventRecords];

  records.sourceMode = 'live';

  return records;
}

function mapImportedPayload(payload, config) {
  const jobs = extractItems(payload);

  if (!jobs.length) {
    const error = new Error('ABC Hub daemon monitor JSON did not contain any daemon job records.');
    error.status = 400;
    throw error;
  }

  if (!jobs.every((job) => job && typeof job === 'object' && !Array.isArray(job))) {
    const error = new Error('ABC Hub daemon monitor JSON contains invalid job records.');
    error.status = 400;
    throw error;
  }

  const jobRecords = jobs.map((item, index) => mapBrokenJob(item, config, index, 'browser_import', payload));
  const eventRecords = jobRecords.map(mapBrokenJobEvent);
  const records = [...jobRecords, ...eventRecords];

  records.sourceMode = 'browser_import';

  return records;
}

function buildMockRecords(range, config) {
  const now = range.to;
  const daemons = [
    {
      name: 'Command Center Event Worker',
      status: 'ok',
      health: 'Healthy',
      summary: 'Event worker is processing ABC Hub daemon jobs normally.',
      offset: -4,
    },
    {
      name: 'Report Dispatch Daemon',
      status: 'warning',
      health: 'Degraded',
      summary: 'Report dispatch queue is slightly delayed but still processing.',
      offset: -11,
    },
    {
      name: 'Integration Sync Daemon',
      status: 'ok',
      health: 'Healthy',
      summary: 'Integration sync daemon completed the last cycle successfully.',
      offset: -18,
    },
    {
      name: 'Notification Relay Daemon',
      status: 'ok',
      health: 'Healthy',
      summary: 'Notification relay is online and heartbeat is current.',
      offset: -27,
    },
  ];
  const records = [];

  daemons.forEach((daemon) => {
    const timestamp = addMinutes(now, daemon.offset);
    const entityId = `${definition.key}:${slug(daemon.name)}`;

    records.push(mapRecord({
      applicationName: definition.label,
      entityType: definition.primaryEntityType,
      entityId,
      moduleKey: definition.key,
      entityName: daemon.name,
      status: daemon.status,
      summary: daemon.summary,
      details: `${daemon.name} reported ${daemon.health.toLowerCase()} at ${toIso(timestamp)}.`,
      timestamp: toIso(timestamp),
      lastUpdatedAt: toIso(timestamp),
      deepLinkPath: `/daemon-monitor/${slug(daemon.name)}`,
      customProperties: {
        id: entityId,
        daemonJobCompanyId: null,
        VPD: 'ABC',
        vpd: 'ABC',
        businessUnit: 'ABC',
        business_unit: 'ABC',
        daemonName: daemon.name,
        entityName: daemon.name,
        active: daemon.status !== 'critical',
        running: false,
        currentlyRunning: false,
        currently_running: false,
        server: 'mock-abc-hub',
        nextRunDate: toIso(addMinutes(timestamp, 15)),
        lastStartDate: toIso(addMinutes(timestamp, -5)),
        lastEndDate: toIso(timestamp),
        executionDurationSeconds: 300,
        execution_duration: 300,
        timeSinceLastRunSeconds: Math.abs(daemon.offset * 60),
        time_since_last_run: Math.abs(daemon.offset * 60),
        timeUntilNextRunSeconds: 900,
        time_until_next_run: 900,
        jobState: 'Idle',
        job_state: 'Idle',
        scheduleState: daemon.status === 'warning' ? 'Delayed' : 'Healthy',
        schedule_state: daemon.status === 'warning' ? 'Delayed' : 'Healthy',
        missedSchedule: false,
        missed_schedule: false,
        hasInsight: daemon.status !== 'ok',
        sourceMode: 'mock',
        health: daemon.health,
        aiFeatures: buildAiFeatures({
          executionDurationSeconds: 300,
          missedSchedule: false,
          delayed: daemon.status === 'warning',
          active: daemon.status !== 'critical',
          running: false,
          timeSinceLastRunSeconds: Math.abs(daemon.offset * 60),
          timeUntilNextRunSeconds: 900,
        }),
        recentEvents: [
          `${daemon.health} heartbeat received`,
          daemon.status === 'warning' ? 'Queue delay threshold crossed' : 'No active daemon alarms',
        ],
      },
      rawPayload: { source: 'mock', daemon },
    }, config));

    records.push(mapRecord({
      applicationName: definition.label,
      entityType: definition.eventEntityType,
      entityId: `${entityId}:event:${Math.abs(daemon.offset)}`,
      moduleKey: definition.key,
      entityName: daemon.name,
      status: daemon.status,
      summary: `${daemon.name} status event`,
      details: daemon.summary,
      timestamp: toIso(timestamp),
      lastUpdatedAt: toIso(timestamp),
      deepLinkPath: `/daemon-monitor/${slug(daemon.name)}/history`,
      customProperties: {
        daemonName: daemon.name,
        health: daemon.health,
        eventType: daemon.status === 'warning' ? 'threshold' : 'heartbeat',
        sourceMode: 'mock',
      },
      rawPayload: { source: 'mock-history', daemon },
    }, config));
  });

  records.sourceMode = 'mock';

  return records;
}

async function fetchRecords(range, config) {
  if (shouldUseLiveApi(config)) {
    try {
      return await fetchLiveRecords(range, config);
    } catch (error) {
      console.warn(`ABC Hub Daemon Monitor live fetch failed; using fallback data. ${error.message}`);
      const fallbackRecords = buildMockRecords(range, config);

      fallbackRecords.liveAttempted = true;
      fallbackRecords.liveError = error.message;

      return fallbackRecords;
    }
  }

  return buildMockRecords(range, config);
}

function buildKeyMetrics(records) {
  const daemons = records.filter((record) => record.entityType === definition.primaryEntityType);
  const durations = daemons
    .map((record) => Number(record.customProperties?.executionDurationSeconds))
    .filter((value) => Number.isFinite(value));
  const averageRuntime = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;

  return [
    { label: 'Total Daemon Jobs', value: daemons.length },
    { label: 'Active Jobs', value: daemons.filter((record) => record.customProperties?.active).length },
    { label: 'Running Jobs', value: daemons.filter((record) => record.customProperties?.currentlyRunning || record.customProperties?.running).length },
    { label: 'Disabled Jobs', value: daemons.filter((record) => record.customProperties?.active === false).length },
    { label: 'Jobs Missed Schedule', value: daemons.filter((record) => record.customProperties?.missedSchedule).length },
    { label: 'Average Runtime', value: averageRuntime === null ? 'N/A' : `${averageRuntime}s` },
  ];
}

module.exports = {
  buildKeyMetrics,
  buildMockRecords,
  definition,
  fetchRecords,
  mapImportedPayload,
};

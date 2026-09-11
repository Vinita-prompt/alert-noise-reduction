const db = require('../config/db');
const integrationService = require('./integration.service');
const daemonMonitorAdapter = require('./abcHub/daemonMonitor.adapter');
const dataTrakUserMonitoringAdapter = require('./abcHub/datatrakUserMonitoring.adapter');
const {
  SOURCE_TOOL,
  addMinutes,
  buildDeepLink,
} = require('./abcHub/abcHubAdapterUtils');

const DEFAULT_BASE_URL = 'https://abc-hub.example.com';
const ADAPTERS = [
  daemonMonitorAdapter,
  dataTrakUserMonitoringAdapter,
];
const ADAPTER_BY_KEY = new Map(ADAPTERS.map((adapter) => [adapter.definition.key, adapter]));

function resolveDate(value, fallback) {
  if (!value) return fallback;

  const text = String(value);
  const relative = text.match(/^now-(\d+)(m|h|d)$/i);

  if (text === 'now') return new Date();

  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const minutes = unit === 'm' ? amount : unit === 'h' ? amount * 60 : amount * 24 * 60;

    return addMinutes(new Date(), -minutes);
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? fallback : date;
}

function resolveRange(options = {}) {
  const to = resolveDate(options.to, new Date());
  const from = resolveDate(options.from, addMinutes(to, -60));

  return { from, to };
}

async function getRuntimeConfig() {
  try {
    const config = await integrationService.getIntegrationRuntimeConfig('abc-hub');
    const token = config.credentials.token || config.credentials.apiKey || config.credentials.password;

    return {
      baseUrl: String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
      token,
      source: token ? 'integration' : 'mock',
    };
  } catch {
    const token = process.env.ABC_HUB_API_KEY || process.env.ABC_HUB_TOKEN || null;
    const baseUrl = String(process.env.ABC_HUB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

    return {
      baseUrl,
      token,
      source: baseUrl.includes('abc-hub.example.com') ? 'mock' : 'environment',
    };
  }
}

async function getOptionalRuntimeConfig() {
  try {
    return await getRuntimeConfig();
  } catch {
    return {
      baseUrl: DEFAULT_BASE_URL,
      token: null,
      source: 'browser_import',
    };
  }
}

async function ensureMonitoringStorage(client = db) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS monitoring_records (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'unknown',
      application_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      severity TEXT NOT NULL DEFAULT 'low',
      summary TEXT NOT NULL,
      details TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN,
      running BOOLEAN,
      server TEXT,
      business_unit TEXT,
      currently_running BOOLEAN,
      next_run_date TIMESTAMPTZ,
      last_start_date TIMESTAMPTZ,
      last_end_date TIMESTAMPTZ,
      execution_duration_seconds INTEGER,
      time_since_last_run_seconds INTEGER,
      time_until_next_run_seconds INTEGER,
      job_state TEXT,
      has_insight BOOLEAN,
      last_check TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      deep_link TEXT,
      custom_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, entity_type, entity_id)
    );

    ALTER TABLE monitoring_records
      ADD COLUMN IF NOT EXISTS entity_name TEXT,
      ADD COLUMN IF NOT EXISTS active BOOLEAN,
      ADD COLUMN IF NOT EXISTS running BOOLEAN,
      ADD COLUMN IF NOT EXISTS server TEXT,
      ADD COLUMN IF NOT EXISTS business_unit TEXT,
      ADD COLUMN IF NOT EXISTS currently_running BOOLEAN,
      ADD COLUMN IF NOT EXISTS next_run_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_start_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_end_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS execution_duration_seconds INTEGER,
      ADD COLUMN IF NOT EXISTS time_since_last_run_seconds INTEGER,
      ADD COLUMN IF NOT EXISTS time_until_next_run_seconds INTEGER,
      ADD COLUMN IF NOT EXISTS job_state TEXT,
      ADD COLUMN IF NOT EXISTS has_insight BOOLEAN;

    CREATE TABLE IF NOT EXISTS abc_hub_daemon_ai_features (
      source_tool TEXT NOT NULL DEFAULT 'ABC Hub',
      module TEXT NOT NULL DEFAULT 'Daemon Monitor',
      entity_type TEXT NOT NULL DEFAULT 'daemon_job',
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      business_unit TEXT,
      server TEXT,
      feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_duration_seconds INTEGER,
      average_execution_duration_seconds NUMERIC,
      maximum_execution_duration_seconds INTEGER,
      minimum_execution_duration_seconds INTEGER,
      missed_schedule_count INTEGER NOT NULL DEFAULT 0,
      late_execution_count INTEGER NOT NULL DEFAULT 0,
      recurrence_count INTEGER NOT NULL DEFAULT 0,
      stability_score NUMERIC,
      execution_frequency NUMERIC,
      downtime_score NUMERIC,
      running_duration_seconds INTEGER,
      historical_failure_count INTEGER NOT NULL DEFAULT 0,
      historical_success_count INTEGER NOT NULL DEFAULT 0,
      anomaly_score NUMERIC,
      noise_probability NUMERIC,
      incident_probability NUMERIC,
      ai_label TEXT NOT NULL DEFAULT 'unknown',
      ai_reason TEXT,
      raw_payload_reference TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_tool, module, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_monitoring_records_tool_app
      ON monitoring_records(source_tool, application_name);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_status
      ON monitoring_records(source_tool, status);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_updated
      ON monitoring_records(source_tool, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_abc_hub_daemon_ai_features_state
      ON abc_hub_daemon_ai_features(module, stability_score, feature_timestamp DESC);
  `);
}

async function upsertRecords(records) {
  await ensureMonitoringStorage();
  let inserted = 0;
  let updated = 0;

  for (const record of records) {
    const result = await db.query(
      `
        INSERT INTO monitoring_records (
          source_tool,
          environment,
          application_name,
          entity_type,
          entity_id,
          entity_name,
          status,
          severity,
          summary,
          details,
          acknowledged,
          active,
          running,
          server,
          business_unit,
          currently_running,
          next_run_date,
          last_start_date,
          last_end_date,
          execution_duration_seconds,
          time_since_last_run_seconds,
          time_until_next_run_seconds,
          job_state,
          has_insight,
          last_check,
          updated_at,
          raw_payload,
          deep_link,
          custom_properties
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,COALESCE($26,NOW()),$27::jsonb,$28,$29::jsonb)
        ON CONFLICT (source_tool, entity_type, entity_id)
        DO UPDATE SET
          environment = EXCLUDED.environment,
          application_name = EXCLUDED.application_name,
          entity_name = EXCLUDED.entity_name,
          status = EXCLUDED.status,
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          acknowledged = EXCLUDED.acknowledged,
          active = EXCLUDED.active,
          running = EXCLUDED.running,
          server = EXCLUDED.server,
          business_unit = EXCLUDED.business_unit,
          currently_running = EXCLUDED.currently_running,
          next_run_date = EXCLUDED.next_run_date,
          last_start_date = EXCLUDED.last_start_date,
          last_end_date = EXCLUDED.last_end_date,
          execution_duration_seconds = EXCLUDED.execution_duration_seconds,
          time_since_last_run_seconds = EXCLUDED.time_since_last_run_seconds,
          time_until_next_run_seconds = EXCLUDED.time_until_next_run_seconds,
          job_state = EXCLUDED.job_state,
          has_insight = EXCLUDED.has_insight,
          last_check = EXCLUDED.last_check,
          updated_at = COALESCE(EXCLUDED.updated_at, NOW()),
          raw_payload = EXCLUDED.raw_payload,
          deep_link = EXCLUDED.deep_link,
          custom_properties = EXCLUDED.custom_properties
        RETURNING (xmax = 0) AS inserted
      `,
      [
        record.sourceTool,
        record.environment || 'production',
        record.applicationName,
        record.entityType,
        record.entityId,
        record.entityName || record.customProperties?.entityName || record.customProperties?.daemonName || record.summary,
        record.status,
        record.severity,
        record.summary,
        record.details,
        Boolean(record.acknowledged),
        record.customProperties?.active ?? null,
        record.customProperties?.running ?? null,
        record.customProperties?.server ?? null,
        record.customProperties?.businessUnit || record.customProperties?.business_unit || record.customProperties?.VPD || null,
        record.customProperties?.currentlyRunning ?? record.customProperties?.currently_running ?? record.customProperties?.running ?? null,
        record.customProperties?.nextRunDate || record.customProperties?.next_run_date || null,
        record.customProperties?.lastStartDate || record.customProperties?.last_start_date || null,
        record.customProperties?.lastEndDate || record.customProperties?.last_end_date || null,
        record.customProperties?.executionDurationSeconds ?? record.customProperties?.execution_duration ?? null,
        record.customProperties?.timeSinceLastRunSeconds ?? record.customProperties?.time_since_last_run ?? null,
        record.customProperties?.timeUntilNextRunSeconds ?? record.customProperties?.time_until_next_run ?? null,
        record.customProperties?.jobState || record.customProperties?.job_state || null,
        record.customProperties?.hasInsight ?? record.customProperties?.has_insight ?? null,
        record.lastCheck,
        record.updatedAt,
        JSON.stringify(record.rawPayload || {}),
        record.deepLink,
        JSON.stringify(record.customProperties || {}),
      ],
    );

    if (result.rows[0]?.inserted) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated };
}

async function upsertDaemonAiFeatures(records = []) {
  await ensureMonitoringStorage();
  const daemonRecords = records.filter((record) => (
    record.sourceTool === SOURCE_TOOL &&
    record.entityType === daemonMonitorAdapter.definition.primaryEntityType &&
    record.customProperties?.moduleKey === daemonMonitorAdapter.definition.key
  ));
  const daemonEntityIds = daemonRecords.map((record) => record.entityId);

  if (daemonEntityIds.length) {
    await db.query(
      `
        DELETE FROM abc_hub_daemon_ai_features
        WHERE source_tool = $1
          AND module = $2
          AND NOT (entity_id = ANY($3::text[]))
      `,
      [SOURCE_TOOL, daemonMonitorAdapter.definition.label, daemonEntityIds],
    );
  }

  for (const record of daemonRecords) {
    const features = record.customProperties?.aiFeatures || {};

    await db.query(
      `
        INSERT INTO abc_hub_daemon_ai_features (
          source_tool,
          module,
          entity_type,
          entity_id,
          entity_name,
          business_unit,
          server,
          feature_timestamp,
          execution_duration_seconds,
          average_execution_duration_seconds,
          maximum_execution_duration_seconds,
          minimum_execution_duration_seconds,
          missed_schedule_count,
          late_execution_count,
          recurrence_count,
          stability_score,
          execution_frequency,
          downtime_score,
          running_duration_seconds,
          historical_failure_count,
          historical_success_count,
          anomaly_score,
          noise_probability,
          incident_probability,
          ai_label,
          ai_reason,
          raw_payload_reference,
          raw_payload,
          updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'unknown',$24,$25,$26::jsonb,NOW()
        )
        ON CONFLICT (source_tool, module, entity_id)
        DO UPDATE SET
          entity_type = EXCLUDED.entity_type,
          entity_name = EXCLUDED.entity_name,
          business_unit = EXCLUDED.business_unit,
          server = EXCLUDED.server,
          feature_timestamp = NOW(),
          execution_duration_seconds = EXCLUDED.execution_duration_seconds,
          average_execution_duration_seconds = EXCLUDED.average_execution_duration_seconds,
          maximum_execution_duration_seconds = EXCLUDED.maximum_execution_duration_seconds,
          minimum_execution_duration_seconds = EXCLUDED.minimum_execution_duration_seconds,
          missed_schedule_count = EXCLUDED.missed_schedule_count,
          late_execution_count = EXCLUDED.late_execution_count,
          recurrence_count = EXCLUDED.recurrence_count,
          stability_score = EXCLUDED.stability_score,
          execution_frequency = EXCLUDED.execution_frequency,
          downtime_score = EXCLUDED.downtime_score,
          running_duration_seconds = EXCLUDED.running_duration_seconds,
          historical_failure_count = EXCLUDED.historical_failure_count,
          historical_success_count = EXCLUDED.historical_success_count,
          anomaly_score = EXCLUDED.anomaly_score,
          noise_probability = EXCLUDED.noise_probability,
          incident_probability = EXCLUDED.incident_probability,
          ai_label = EXCLUDED.ai_label,
          ai_reason = EXCLUDED.ai_reason,
          raw_payload_reference = EXCLUDED.raw_payload_reference,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        SOURCE_TOOL,
        daemonMonitorAdapter.definition.label,
        daemonMonitorAdapter.definition.primaryEntityType,
        record.entityId,
        record.entityName,
        record.customProperties?.businessUnit || record.customProperties?.business_unit || record.customProperties?.VPD || null,
        record.customProperties?.server || null,
        features.executionDuration ?? record.customProperties?.executionDurationSeconds ?? null,
        features.averageExecutionDuration ?? null,
        features.maximumExecutionDuration ?? null,
        features.minimumExecutionDuration ?? null,
        features.missedScheduleCount ?? 0,
        features.lateExecutionCount ?? 0,
        features.recurrenceCount ?? 0,
        features.stabilityScore ?? null,
        features.executionFrequency ?? null,
        features.downtimeScore ?? null,
        features.runningDuration ?? null,
        features.historicalFailureCount ?? 0,
        features.historicalSuccessCount ?? 0,
        features.anomalyScore ?? null,
        features.noiseProbability ?? null,
        features.incidentProbability ?? null,
        'AI model is not enabled yet. ABC Hub daemon features are prepared for future noise vs incident evaluation.',
        `${SOURCE_TOOL}:Daemon Monitor:${record.entityId}`,
        JSON.stringify(record.rawPayload || {}),
      ],
    );
  }

  return daemonRecords.length;
}

async function pruneSnapshotRecords(adapter, records) {
  if (
    !adapter.definition.replaceSnapshot ||
    !['live', 'browser_import'].includes(records.sourceMode)
  ) {
    return;
  }

  await ensureMonitoringStorage();

  const entityTypes = [
    adapter.definition.primaryEntityType,
    adapter.definition.eventEntityType,
  ].filter(Boolean);
  const entityIds = records
    .filter((record) => entityTypes.includes(record.entityType))
    .map((record) => record.entityId);

  if (!entityTypes.length) {
    return;
  }

  if (!entityIds.length) {
    await db.query(
      `
        DELETE FROM monitoring_records
        WHERE source_tool = $1
          AND custom_properties->>'moduleKey' = $2
          AND entity_type = ANY($3::text[])
      `,
      [SOURCE_TOOL, adapter.definition.key, entityTypes],
    );
    return;
  }

  await db.query(
    `
      DELETE FROM monitoring_records
      WHERE source_tool = $1
        AND custom_properties->>'moduleKey' = $2
        AND entity_type = ANY($3::text[])
        AND NOT (entity_id = ANY($4::text[]))
    `,
    [SOURCE_TOOL, adapter.definition.key, entityTypes, entityIds],
  );
}

async function repairLatestDaemonImportIfNeeded() {
  await ensureMonitoringStorage();

  const result = await db.query(
    `
      SELECT raw_payload, custom_properties
      FROM monitoring_records
      WHERE source_tool = $1
        AND entity_type = $2
        AND custom_properties->>'moduleKey' = $3
        AND custom_properties->>'sourceMode' = 'browser_import'
        AND raw_payload ? 'fullPayload'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [SOURCE_TOOL, daemonMonitorAdapter.definition.primaryEntityType, daemonMonitorAdapter.definition.key],
  );
  const row = result.rows[0];
  const payload = row?.raw_payload?.fullPayload;
  const jobs = Array.isArray(payload?.data) ? payload.data : [];

  if (!jobs.length) {
    return { repaired: false, reason: 'no_import_payload' };
  }

  const countResult = await db.query(
    `
      SELECT COUNT(*)::int AS count
      FROM monitoring_records
      WHERE source_tool = $1
        AND entity_type = $2
        AND custom_properties->>'moduleKey' = $3
        AND custom_properties->>'sourceMode' = 'browser_import'
    `,
    [SOURCE_TOOL, daemonMonitorAdapter.definition.primaryEntityType, daemonMonitorAdapter.definition.key],
  );
  const existingCount = Number(countResult.rows[0]?.count || 0);

  if (existingCount >= jobs.length && row.custom_properties?.businessUnit) {
    return { repaired: false, reason: 'already_current' };
  }

  const config = await getOptionalRuntimeConfig();
  const records = daemonMonitorAdapter.mapImportedPayload(payload, {
    ...config,
    source: 'browser_import_repair',
  });

  await pruneSnapshotRecords(daemonMonitorAdapter, records);
  const stored = await upsertRecords(records);
  const aiFeatureCount = await upsertDaemonAiFeatures(records);

  return {
    repaired: true,
    records: records.length,
    inserted: stored.inserted,
    updated: stored.updated,
    aiFeatureCount,
  };
}

function getAdapter(moduleKey) {
  const adapter = ADAPTER_BY_KEY.get(moduleKey);

  if (!adapter) {
    const error = new Error(`Unsupported ABC Hub module: ${moduleKey}`);
    error.status = 404;
    throw error;
  }

  return adapter;
}

async function syncAbcHubData(options = {}) {
  const config = await getRuntimeConfig();
  const range = resolveRange(options);
  const adapters = options.moduleKey ? [getAdapter(options.moduleKey)] : ADAPTERS;
  const recordGroups = await Promise.all(
    adapters.map(async (adapter) => {
      const records = adapter.fetchRecords
        ? await adapter.fetchRecords(range, config)
        : adapter.buildMockRecords(range, config);

      await pruneSnapshotRecords(adapter, records);

      return records;
    }),
  );
  const liveErrors = recordGroups
    .map((records) => records.liveError)
    .filter(Boolean);
  const liveAttempted = recordGroups.some((records) => records.liveAttempted);
  const records = recordGroups.flat();
  const stored = await upsertRecords(records);
  const aiFeatureCount = await upsertDaemonAiFeatures(records);
  const primaryRecords = records.filter((record) => (
    adapters.some((adapter) => record.entityType === adapter.definition.primaryEntityType)
  ));
  const daemonJobsFetched = records.filter((record) => (
    record.entityType === daemonMonitorAdapter.definition.primaryEntityType
  )).length;
  const eventRecordsFetched = records.filter((record) => (
    adapters.some((adapter) => record.entityType === adapter.definition.eventEntityType)
  )).length;
  const fetched = primaryRecords.length || records.length;
  const isDaemonOnlySync = adapters.length === 1 && adapters[0].definition.key === daemonMonitorAdapter.definition.key;

  return {
    fetched,
    recordsStored: records.length,
    daemonJobsFetched,
    eventRecordsFetched,
    aiFeatureCount,
    inserted: stored.inserted,
    updated: stored.updated,
    source: liveAttempted && liveErrors.length ? 'mock_fallback' : config.source,
    warning: liveErrors.length
      ? `Live ABC Hub Daemon Monitor did not return JSON data. ${liveErrors.join(' ')}`
      : null,
    message: liveErrors.length
      ? `ABC Hub Daemon Monitor live sync failed, so mock fallback data was shown instead. ${liveErrors.join(' ')}`
      : isDaemonOnlySync
      ? `ABC Hub Daemon Monitor sync complete: ${daemonJobsFetched} daemon jobs fetched, ${records.length} records stored.`
      : `ABC Hub sync complete: ${fetched} entities fetched, ${records.length} records stored.`,
  };
}

function normalizeRecordRow(row) {
  return {
    id: row.id,
    sourceTool: row.source_tool,
    environment: row.environment,
    applicationName: row.application_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: row.entity_name,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    details: row.details,
    acknowledged: row.acknowledged,
    active: row.active,
    running: row.running,
    server: row.server,
    businessUnit: row.business_unit,
    currentlyRunning: row.currently_running,
    nextRunDate: row.next_run_date,
    lastStartDate: row.last_start_date,
    lastEndDate: row.last_end_date,
    executionDurationSeconds: row.execution_duration_seconds,
    timeSinceLastRunSeconds: row.time_since_last_run_seconds,
    timeUntilNextRunSeconds: row.time_until_next_run_seconds,
    jobState: row.job_state,
    hasInsight: row.has_insight,
    lastCheck: row.last_check,
    updatedAt: row.updated_at,
    rawPayload: row.raw_payload || {},
    deepLink: row.deep_link,
    customProperties: row.custom_properties || {},
  };
}

function mapDaemonAiFeatureRow(row) {
  return {
    sourceTool: row.source_tool,
    module: row.module,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: row.entity_name,
    businessUnit: row.business_unit,
    server: row.server,
    featureTimestamp: row.feature_timestamp,
    executionDuration: row.execution_duration_seconds,
    averageExecutionDuration: row.average_execution_duration_seconds,
    maximumExecutionDuration: row.maximum_execution_duration_seconds,
    minimumExecutionDuration: row.minimum_execution_duration_seconds,
    missedScheduleCount: row.missed_schedule_count,
    lateExecutionCount: row.late_execution_count,
    recurrenceCount: row.recurrence_count,
    stabilityScore: row.stability_score,
    executionFrequency: row.execution_frequency,
    downtimeScore: row.downtime_score,
    runningDuration: row.running_duration_seconds,
    historicalFailureCount: row.historical_failure_count,
    historicalSuccessCount: row.historical_success_count,
    anomalyScore: row.anomaly_score,
    noiseProbability: row.noise_probability,
    incidentProbability: row.incident_probability,
    aiLabel: row.ai_label,
    aiReason: row.ai_reason,
    rawPayloadReference: row.raw_payload_reference,
    rawPayload: row.raw_payload || {},
    updatedAt: row.updated_at,
  };
}

function preferCurrentRecords(records) {
  const preferredModes = ['live', 'browser_import'];
  const availableMode = preferredModes.find((mode) => (
    records.some((record) => record.customProperties?.sourceMode === mode)
  ));

  return availableMode
    ? records.filter((record) => record.customProperties?.sourceMode === availableMode)
    : records;
}

function buildStatusCounts(records) {
  return records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] || 0) + 1;
    return counts;
  }, {});
}

function worstStatus(records) {
  const rank = { critical: 4, warning: 3, unknown: 2, pending: 1, ok: 0 };

  return records.reduce((current, record) => (
    (rank[record.status] || 0) > (rank[current] || 0) ? record.status : current
  ), records.length ? records[0].status : 'pending');
}

function buildSummary(records) {
  return {
    total: records.length,
    status: worstStatus(records),
    statusCounts: buildStatusCounts(records),
    severityCounts: records.reduce((counts, record) => {
      counts[record.severity] = (counts[record.severity] || 0) + 1;
      return counts;
    }, {}),
    acknowledged: records.filter((record) => record.acknowledged).length,
    inDowntime: 0,
    problems: records.filter((record) => !['ok', 'up', 'pending'].includes(record.status)).length,
    lastCheck: records.map((record) => record.lastCheck).filter(Boolean).sort().at(-1) || null,
  };
}

async function listModules() {
  await syncAbcHubData();
  await ensureMonitoringStorage();
  await repairLatestDaemonImportIfNeeded();
  const result = await db.query(
    `
      SELECT application_name, COUNT(*)::int AS record_count, MAX(updated_at) AS last_updated_at
      FROM monitoring_records
      WHERE source_tool = $1
        AND custom_properties->>'moduleKey' = ANY($2::text[])
        AND entity_type = ANY($3::text[])
      GROUP BY application_name
    `,
    [
      SOURCE_TOOL,
      ADAPTERS.map((adapter) => adapter.definition.key),
      ADAPTERS.map((adapter) => adapter.definition.primaryEntityType),
    ],
  );
  const byName = new Map(result.rows.map((row) => [row.application_name, row]));

  return ADAPTERS.map((adapter) => {
    const row = byName.get(adapter.definition.label) || {};

    return {
      id: adapter.definition.key,
      label: adapter.definition.label,
      entityType: 'module',
      recordCount: row.record_count || 0,
      status: 'ok',
      statusCounts: {},
      lastUpdatedAt: row.last_updated_at || null,
      metadata: {
        description: adapter.definition.description,
        moduleKey: adapter.definition.key,
      },
    };
  });
}

async function getModuleDetails(moduleKey, options = {}) {
  const adapter = getAdapter(moduleKey);
  const range = resolveRange(options);
  await syncAbcHubData({ ...options, moduleKey });
  await ensureMonitoringStorage();
  if (moduleKey === daemonMonitorAdapter.definition.key) {
    await repairLatestDaemonImportIfNeeded();
  }
  const result = await db.query(
    `
      SELECT *
      FROM monitoring_records
      WHERE source_tool = $1
        AND custom_properties->>'moduleKey' = $2
        AND (
          entity_type = $5
          OR COALESCE(last_check, updated_at) BETWEEN $3 AND $4
        )
      ORDER BY
        CASE entity_type WHEN $5 THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1000
    `,
    [
      SOURCE_TOOL,
      moduleKey,
      range.from.toISOString(),
      range.to.toISOString(),
      adapter.definition.primaryEntityType,
    ],
  );
  const records = preferCurrentRecords(result.rows.map(normalizeRecordRow));
  const aiFeatureResult = moduleKey === daemonMonitorAdapter.definition.key
    ? await db.query(
      `
        SELECT *
        FROM abc_hub_daemon_ai_features
        WHERE source_tool = $1
          AND module = $2
        ORDER BY stability_score ASC NULLS LAST, feature_timestamp DESC
        LIMIT 1000
      `,
      [SOURCE_TOOL, daemonMonitorAdapter.definition.label],
    )
    : { rows: [] };
  const primaryRecords = records.filter((record) => record.entityType === adapter.definition.primaryEntityType);
  const summaryRecords = primaryRecords.length ? primaryRecords : records;
  const aiFeatures = aiFeatureResult.rows.map(mapDaemonAiFeatureRow);

  return {
    tool: {
      key: 'abc-hub',
      label: 'ABC Hub',
      adapterName: 'ABC Hub Adapter',
    },
    application: {
      id: adapter.definition.key,
      label: adapter.definition.label,
      entityType: 'module',
    },
    kind: 'abc_hub_module',
    summary: buildSummary(summaryRecords),
    keyMetrics: adapter.buildKeyMetrics(records),
    aiFeatures,
    entities: records,
    activeProblems: summaryRecords.filter((record) => !['ok', 'pending'].includes(record.status)),
    recentEvents: records.filter((record) => record.entityType === adapter.definition.eventEntityType).slice(0, 50),
    deepLink: records[0]?.deepLink || buildDeepLink(`/${adapter.definition.key}`, await getRuntimeConfig()),
    lastUpdatedAt: records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
    timeRange: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
  };
}

async function getDaemonMonitor(options = {}) {
  return getModuleDetails(daemonMonitorAdapter.definition.key, options);
}

async function importDaemonMonitorPayload(payload) {
  const config = await getOptionalRuntimeConfig();
  const records = daemonMonitorAdapter.mapImportedPayload(payload, {
    ...config,
    source: 'browser_import',
  });

  await pruneSnapshotRecords(daemonMonitorAdapter, records);
  const stored = await upsertRecords(records);
  const aiFeatureCount = await upsertDaemonAiFeatures(records);
  const daemonJobsFetched = records.filter((record) => (
    record.entityType === daemonMonitorAdapter.definition.primaryEntityType
  )).length;
  const now = new Date().toISOString();

  return {
    fetched: daemonJobsFetched,
    recordsStored: records.length,
    daemonJobsFetched,
    eventRecordsFetched: records.length - daemonJobsFetched,
    aiFeatureCount,
    inserted: stored.inserted,
    updated: stored.updated,
    source: 'browser_import',
    importedAt: now,
    message: `ABC Hub Daemon Monitor JSON import complete: ${daemonJobsFetched} daemon jobs imported, ${records.length} records stored.`,
  };
}

async function getDaemonHistory(options = {}) {
  const details = await getDaemonMonitor(options);
  return details.recentEvents;
}

async function getDataTrakUserMonitoring(options = {}) {
  return getModuleDetails(dataTrakUserMonitoringAdapter.definition.key, options);
}

async function getDataTrakUserDetails(userId, options = {}) {
  const details = await getDataTrakUserMonitoring(options);
  const user = details.entities.find((record) => (
    record.entityType === dataTrakUserMonitoringAdapter.definition.primaryEntityType &&
    (record.customProperties?.userId === userId || record.entityId.endsWith(userId))
  ));

  if (!user) {
    const error = new Error(`ABC Hub DataTrak user ${userId} was not found.`);
    error.status = 404;
    throw error;
  }

  return {
    ...details,
    application: {
      id: user.customProperties?.userId || userId,
      label: user.customProperties?.userName || user.summary,
      entityType: dataTrakUserMonitoringAdapter.definition.primaryEntityType,
    },
    selectedUser: user,
    entities: details.entities.filter((record) => record.customProperties?.userId === user.customProperties?.userId),
  };
}

async function getDataTrakUserHistory(options = {}) {
  const details = await getDataTrakUserMonitoring(options);
  return details.recentEvents;
}

module.exports = {
  getDaemonHistory,
  getDaemonMonitor,
  getDataTrakUserDetails,
  getDataTrakUserHistory,
  getDataTrakUserMonitoring,
  getModuleDetails,
  importDaemonMonitorPayload,
  listModules,
  syncAbcHubData,
};

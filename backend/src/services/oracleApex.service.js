const crypto = require('crypto');
const db = require('../config/db');
const integrationService = require('./integration.service');

const SOURCE_TOOL = 'oracle-apex';
const APPLICATION_NAME = 'PF & ETL Dashboard';
const DASHBOARD_ID = 'pf-etl-dashboard';
const DEFAULT_BASE_URL = 'https://apex.example.com';
const DEFAULT_AJAX_PATH = '/ords/wwv_flow.ajax';
const DEFAULT_FLOW_ID = '102';
const DEFAULT_REGION_ID = '1654121344282841';
const DEFAULT_MAX_ROWS = 100;
const APEX_REPORT_VALUE_COLUMNS = [
  { columnKey: 'job_name', columnName: 'job_name', columnLabel: 'Job Name', columnType: 'string' },
  { columnKey: 'start_time', columnName: 'start_time', columnLabel: 'Start Time', columnType: 'datetime' },
  { columnKey: 'finish_time', columnName: 'finish_time', columnLabel: 'Finish Time', columnType: 'datetime' },
  { columnKey: 'past_finish_times', columnName: 'past_finish_times', columnLabel: 'Past Finish-Times', columnType: 'string' },
  { columnKey: 'status_flag', columnName: 'status_flag', columnLabel: 'Status Flag', columnType: 'string' },
  { columnKey: 'job_step', columnName: 'job_step', columnLabel: 'Job Step', columnType: 'string' },
  { columnKey: 'status_icon', columnName: 'status_icon', columnLabel: 'Status Icon', columnType: 'string' },
  { columnKey: 'completed_steps', columnName: 'completed_steps', columnLabel: 'Completed Steps', columnType: 'string' },
  { columnKey: 'detail_link', columnName: 'detail_link', columnLabel: 'Detail Link', columnType: 'string' },
  { columnKey: 'exception_flag', columnName: 'exception_flag', columnLabel: 'Exception Flag', columnType: 'string' },
  { columnKey: 'active_flag', columnName: 'active_flag', columnLabel: 'Active Flag', columnType: 'string' },
  { columnKey: 'complete_flag', columnName: 'complete_flag', columnLabel: 'Complete Flag', columnType: 'string' },
];

function hash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function stableHash(value) {
  return hash(JSON.stringify(value || {}));
}

function normalizeKey(value, fallback = 'column') {
  const key = String(value || fallback)
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  return key || fallback;
}

function titleize(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1000000000) {
    return new Date(numeric > 100000000000 ? numeric : numeric * 1000).toISOString();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, Math.round(numeric));

  const text = String(value).toLowerCase();
  let total = 0;
  const patterns = [
    [/(\d+(?:\.\d+)?)\s*d/g, 86400],
    [/(\d+(?:\.\d+)?)\s*h/g, 3600],
    [/(\d+(?:\.\d+)?)\s*m/g, 60],
    [/(\d+(?:\.\d+)?)\s*s/g, 1],
  ];

  patterns.forEach(([pattern, multiplier]) => {
    let match = pattern.exec(text);
    while (match) {
      total += Number(match[1]) * multiplier;
      match = pattern.exec(text);
    }
  });

  return total ? Math.round(total) : null;
}

function parseStepCounts(value) {
  const match = String(value || '').match(/(\d+)\s*\/\s*(\d+)/);

  if (!match) {
    return {
      completedStepCount: null,
      totalStepCount: null,
      completionRate: null,
    };
  }

  const completedStepCount = Number(match[1]);
  const totalStepCount = Number(match[2]);

  return {
    completedStepCount,
    totalStepCount,
    completionRate: totalStepCount > 0 ? completedStepCount / totalStepCount : null,
  };
}

function durationBetween(startTime, endTime) {
  const start = startTime ? new Date(startTime).getTime() : NaN;
  const end = endTime ? new Date(endTime).getTime() : NaN;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return Math.round((end - start) / 1000);
}

function deriveWorkflowGroup(jobName, row) {
  const explicitGroup = firstValue(row, ['workflow_group', 'group_name', 'category', 'section']);

  if (explicitGroup) {
    return String(explicitGroup).trim();
  }

  const name = String(jobName || '').trim().toUpperCase();
  const numberedGroupMatch = name.match(/^(.+?)_GROUP\d+$/);

  if (numberedGroupMatch) {
    return `${numberedGroupMatch[1].replace(/_ETL$/i, '').replace(/_/g, ' ')} GROUPS`;
  }

  const tokens = name.split('_').filter(Boolean);
  if (tokens.length >= 2 && tokens[1] === 'SNAPSHOT') {
    return `${tokens[0]} SNAPSHOT`;
  }

  const prefixMatch = name.match(/^([A-Z0-9]+)_/);

  if (prefixMatch) {
    return prefixMatch[1].replace(/_/g, ' ');
  }

  return 'WORKFLOWS';
}

function firstValue(row, keys) {
  const normalized = Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [normalizeKey(key), value]),
  );

  for (const key of keys) {
    const value = normalized[normalizeKey(key)];
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function collectArrays(node, path = '$', arrays = []) {
  if (Array.isArray(node)) {
    arrays.push({ path, rows: node });
    node.slice(0, 5).forEach((item, index) => collectArrays(item, `${path}[${index}]`, arrays));
    return arrays;
  }

  if (isPlainObject(node)) {
    Object.entries(node).forEach(([key, value]) => collectArrays(value, `${path}.${key}`, arrays));
  }

  return arrays;
}

function looksLikeColumn(row = {}) {
  const keys = Object.keys(row).map(normalizeKey);

  return keys.some((key) => ['name', 'column_name', 'label', 'heading', 'data_type', 'type', 'hidden'].includes(key));
}

function looksLikeDataRow(row = {}) {
  if (!isPlainObject(row)) return false;

  const keys = Object.keys(row);
  if (!keys.length || looksLikeColumn(row)) return false;

  return keys.some((key) => {
    const value = row[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;
  });
}

function extractRows(payload) {
  const candidates = collectArrays(payload)
    .filter((candidate) => candidate.rows.length)
    .map((candidate) => {
      const objectRows = candidate.rows.filter(looksLikeDataRow);
      const arrayRows = candidate.rows.filter(Array.isArray);
      const score = objectRows.length * 10 + arrayRows.length * 6 + candidate.rows.length;

      return { ...candidate, objectRows, arrayRows, score };
    })
    .filter((candidate) => candidate.objectRows.length || candidate.arrayRows.length)
    .sort((left, right) => right.score - left.score);

  const best = candidates[0];

  if (!best) return [];

  return best.objectRows.length >= best.arrayRows.length ? best.objectRows : best.arrayRows;
}

function collectColumnMetadata(payload) {
  const arrays = collectArrays(payload);
  const metadataRows = arrays
    .flatMap((candidate) => candidate.rows)
    .filter(isPlainObject)
    .filter(looksLikeColumn);

  return metadataRows.map((column, index) => {
    const name = column.name || column.columnName || column.column_name || column.id || column.field || column.key || `column_${index + 1}`;
    const label = column.label || column.heading || column.header || column.displayName || column.display_name || name;

    return {
      columnKey: normalizeKey(name || label, `column_${index + 1}`),
      columnName: String(name || label),
      columnLabel: String(label || name),
      columnType: column.type || column.dataType || column.data_type || typeof column.value || 'unknown',
      displayOrder: Number.isFinite(Number(column.displayOrder ?? column.display_order ?? column.seq ?? column.sequence))
        ? Number(column.displayOrder ?? column.display_order ?? column.seq ?? column.sequence)
        : index + 1,
      hidden: Boolean(column.hidden || column.isHidden || column.visible === false),
      visible: !(column.hidden || column.isHidden || column.visible === false),
      sortInfo: column.sort || column.sortInfo || {},
      formatting: column.format || column.formatting || {},
      metadata: column,
    };
  });
}

function discoverColumns(payload, rows) {
  const fromMetadata = collectColumnMetadata(payload);
  const byKey = new Map(fromMetadata.map((column) => [column.columnKey, column]));

  if (!fromMetadata.length && rows.some(Array.isArray)) {
    const maxLength = Math.max(...rows.filter(Array.isArray).map((row) => row.length), 0);

    for (let index = 0; index < maxLength; index += 1) {
      const defaultColumn = APEX_REPORT_VALUE_COLUMNS[index] || {
        columnKey: `column_${index + 1}`,
        columnName: `column_${index + 1}`,
        columnLabel: titleize(`column_${index + 1}`),
        columnType: 'unknown',
      };

      byKey.set(defaultColumn.columnKey, {
        ...defaultColumn,
        displayOrder: index + 1,
        hidden: false,
        visible: defaultColumn.columnKey !== 'status_icon',
        sortInfo: {},
        formatting: {},
        metadata: { inferredFromApexValuesArray: true, sourceIndex: index },
      });
    }
  }

  rows.forEach((row) => {
    if (Array.isArray(row)) {
      row.forEach((value, index) => {
        const defaultColumn = APEX_REPORT_VALUE_COLUMNS[index];
        const fallbackKey = defaultColumn?.columnKey || `column_${index + 1}`;
        if (!byKey.has(fallbackKey)) {
          byKey.set(fallbackKey, {
            columnKey: fallbackKey,
            columnName: defaultColumn?.columnName || fallbackKey,
            columnLabel: defaultColumn?.columnLabel || titleize(fallbackKey),
            columnType: defaultColumn?.columnType || (value === null ? 'unknown' : typeof value),
            displayOrder: index + 1,
            hidden: false,
            visible: fallbackKey !== 'status_icon',
            sortInfo: {},
            formatting: {},
            metadata: defaultColumn ? { inferredFromApexValuesArray: true, sourceIndex: index } : {},
          });
        }
      });
      return;
    }

    Object.entries(row || {}).forEach(([name, value], index) => {
      const columnKey = normalizeKey(name, `column_${index + 1}`);
      if (!byKey.has(columnKey)) {
        byKey.set(columnKey, {
          columnKey,
          columnName: name,
          columnLabel: titleize(name),
          columnType: value === null ? 'unknown' : Array.isArray(value) ? 'array' : typeof value,
          displayOrder: byKey.size + 1,
          hidden: false,
          visible: true,
          sortInfo: {},
          formatting: {},
          metadata: {},
        });
      }
    });
  });

  return Array.from(byKey.values()).sort((left, right) => left.displayOrder - right.displayOrder);
}

function rowToObject(row, columns) {
  if (isPlainObject(row)) {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [normalizeKey(key), value]),
    );
  }

  if (Array.isArray(row)) {
    return Object.fromEntries(
      columns.map((column, index) => [column.columnKey, row[index] ?? null]),
    );
  }

  return {};
}

function normalizeStatus(value) {
  const text = String(value || '').trim().toLowerCase();

  if (!text || text === 'n' || text === 'normal' || text === 'ok') return 'completed';
  if (text === 'y') return 'completed';
  if (/queue/.test(text)) return 'queued';
  if (/warn/.test(text)) return 'delayed';
  if (/fail|error|abort|critical|broken/.test(text)) return 'failed';
  if (/run|process|execut/.test(text)) return 'running';
  if (/wait|queue|pending|hold|sched/.test(text)) return 'waiting';
  if (/delay|late|miss/.test(text)) return 'delayed';
  if (/complete|success|done|finish|ok/.test(text)) return 'completed';
  if (/cancel|disable|inactive/.test(text)) return 'unknown';

  return text || 'unknown';
}

function severityFromStatus(status) {
  if (status === 'failed') return 'critical';
  if (status === 'delayed') return 'warning';
  if (status === 'running') return 'medium';
  if (status === 'queued') return 'low';
  if (status === 'waiting') return 'low';
  if (status === 'completed') return 'low';
  return 'medium';
}

function monitoringStatusFromApex(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'critical';
  if (status === 'delayed') return 'warning';
  if (status === 'running') return 'warning';
  if (status === 'queued') return 'pending';
  if (status === 'waiting') return 'pending';
  return 'unknown';
}

function normalizeRow(rawRow, columns, index, runtimeConfig) {
  const row = rowToObject(rawRow, columns);
  const jobId = firstValue(row, ['job id', 'job_id', 'jobid', 'id', 'job number', 'execution id']);
  const jobName = firstValue(row, ['job name', 'job_name', 'name', 'process', 'program', 'report name']) || `APEX Row ${index + 1}`;
  const status = normalizeStatus(firstValue(row, ['status', 'status_flag', 'current state', 'current_state', 'state', 'completion', 'result']));
  const environment = String(firstValue(row, ['environment', 'env']) || 'production').toLowerCase();
  const server = firstValue(row, ['server', 'host', 'node']);
  const owner = firstValue(row, ['owner', 'team']);
  const startTime = toIsoDate(firstValue(row, ['start time', 'start_time', 'started_at', 'execution date', 'execution_date']));
  const endTime = toIsoDate(firstValue(row, ['end time', 'end_time', 'finish time', 'finish_time', 'ended_at', 'completed_at']));
  const executionDate = toIsoDate(firstValue(row, ['execution date', 'execution_date', 'business date', 'business_date']));
  const timestamp = endTime || startTime || executionDate || new Date().toISOString();
  const completedSteps = firstValue(row, ['completed_steps', 'completed steps']);
  const stepCounts = parseStepCounts(completedSteps);
  const durationSeconds = parseDurationSeconds(firstValue(row, ['duration', 'runtime', 'elapsed', 'elapsed time', 'execution duration']))
    ?? durationBetween(startTime, endTime);
  const entityId = String(jobId || hash(`${jobName}:${server || ''}:${owner || ''}`).slice(0, 16));
  const entityName = String(jobName || entityId);
  const detailLink = firstValue(row, ['detail_link', 'link', 'url']);
  const deepLink = detailLink && !String(detailLink).startsWith('#')
    ? new URL(String(detailLink), runtimeConfig.baseUrl || DEFAULT_BASE_URL).toString()
    : runtimeConfig.deepLink || runtimeConfig.baseUrl || null;
  const jobStep = firstValue(row, ['job_step', 'step', 'current step']);
  const workflowGroup = deriveWorkflowGroup(entityName, row);
  row.workflow_group = workflowGroup;
  row.completed_step_count = stepCounts.completedStepCount;
  row.total_step_count = stepCounts.totalStepCount;
  row.completion_rate = stepCounts.completionRate;
  row.execution_duration_seconds = durationSeconds;
  const summary = jobStep ? `${entityName}: ${jobStep}` : `${entityName} is ${status}`;

  return {
    sourceTool: SOURCE_TOOL,
    applicationName: APPLICATION_NAME,
    environment,
    entityType: 'apex_job',
    entityId,
    entityName,
    status,
    monitoringStatus: monitoringStatusFromApex(status),
    severity: severityFromStatus(status),
    summary,
    timestamp,
    lastUpdated: timestamp,
    deepLink,
    rawRow,
    rowValues: row,
    server,
    owner,
    startTime,
    endTime,
    durationSeconds,
    jobStep,
    workflowGroup,
    completedStepCount: stepCounts.completedStepCount,
    totalStepCount: stepCounts.totalStepCount,
    completionRate: stepCounts.completionRate,
    entityHash: stableHash(row),
  };
}

async function getRuntimeConfig() {
  try {
    const config = await integrationService.getIntegrationRuntimeConfig('oracle-apex');
    const credentials = config.credentials || {};
    const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

    return {
      baseUrl,
      ajaxPath: credentials.ajaxPath || DEFAULT_AJAX_PATH,
      flowId: credentials.flowId || DEFAULT_FLOW_ID,
      pageId: credentials.pageId || '',
      regionId: credentials.regionId || DEFAULT_REGION_ID,
      requestName: credentials.requestName || '',
      ajaxIdentifier: credentials.ajaxIdentifier || '',
      maxRows: Number(credentials.maxRows || DEFAULT_MAX_ROWS),
      deepLink: credentials.dashboardPath
        ? new URL(credentials.dashboardPath, baseUrl).toString()
        : baseUrl,
    };
  } catch {
    return {
      baseUrl: DEFAULT_BASE_URL,
      ajaxPath: DEFAULT_AJAX_PATH,
      flowId: DEFAULT_FLOW_ID,
      pageId: '',
      regionId: DEFAULT_REGION_ID,
      requestName: '',
      ajaxIdentifier: '',
      maxRows: DEFAULT_MAX_ROWS,
      deepLink: DEFAULT_BASE_URL,
    };
  }
}

async function ensureStorage(client = db) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS apex_jobs (
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      environment TEXT NOT NULL DEFAULT 'production',
      entity_type TEXT NOT NULL DEFAULT 'apex_job',
      status TEXT NOT NULL DEFAULT 'unknown',
      severity TEXT NOT NULL DEFAULT 'medium',
      summary TEXT,
      timestamp TIMESTAMPTZ,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      row_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      entity_hash TEXT,
      deep_link TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_tool, application_name, entity_id)
    );

    CREATE TABLE IF NOT EXISTS apex_history (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      status TEXT,
      severity TEXT,
      snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      timestamp TIMESTAMPTZ,
      execution_duration_seconds INTEGER,
      row_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS apex_sync_history (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      result TEXT NOT NULL DEFAULT 'running',
      failure_stage TEXT,
      failure_type TEXT,
      failure_reason TEXT,
      response_time_ms INTEGER,
      records_retrieved INTEGER NOT NULL DEFAULT 0,
      records_inserted INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      records_skipped INTEGER NOT NULL DEFAULT 0,
      raw_payload_id BIGINT
    );

    CREATE TABLE IF NOT EXISTS apex_dynamic_columns (
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      column_key TEXT NOT NULL,
      column_name TEXT,
      column_label TEXT,
      column_type TEXT,
      display_order INTEGER,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      visible BOOLEAN NOT NULL DEFAULT TRUE,
      sort_info JSONB NOT NULL DEFAULT '{}'::jsonb,
      formatting JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_tool, application_name, column_key)
    );

    CREATE TABLE IF NOT EXISTS apex_ai_features (
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_duration_seconds INTEGER,
      average_runtime_seconds NUMERIC,
      minimum_runtime_seconds INTEGER,
      maximum_runtime_seconds INTEGER,
      runtime_variance NUMERIC,
      runtime_stddev NUMERIC,
      execution_frequency NUMERIC,
      execution_trend TEXT,
      schedule_delay_seconds INTEGER,
      schedule_compliance_score NUMERIC,
      missed_schedule_count INTEGER NOT NULL DEFAULT 0,
      consecutive_successes INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      failure_rate NUMERIC,
      success_rate NUMERIC,
      historical_failure_count INTEGER NOT NULL DEFAULT 0,
      historical_success_count INTEGER NOT NULL DEFAULT 0,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      recovery_time_seconds INTEGER,
      running_time_seconds INTEGER,
      current_runtime_seconds INTEGER,
      queue_wait_time_seconds INTEGER,
      dependency_count INTEGER NOT NULL DEFAULT 0,
      dependency_delay_seconds INTEGER,
      business_impact_score NUMERIC,
      job_stability_score NUMERIC,
      runtime_stability_score NUMERIC,
      historical_trend TEXT,
      alert_frequency NUMERIC,
      alert_density NUMERIC,
      recurrence_count INTEGER NOT NULL DEFAULT 0,
      execution_volatility NUMERIC,
      execution_anomaly_score NUMERIC,
      historical_percentile NUMERIC,
      runtime_percentile NUMERIC,
      failure_percentile NUMERIC,
      noise_probability NUMERIC,
      incident_probability NUMERIC,
      risk_score NUMERIC,
      root_cause_confidence NUMERIC,
      prediction_confidence NUMERIC,
      correlation_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
      ai_label TEXT NOT NULL DEFAULT 'unknown',
      ai_reason TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_tool, application_name, entity_id)
    );

    CREATE TABLE IF NOT EXISTS apex_raw_payloads (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      payload_hash TEXT NOT NULL,
      page_number INTEGER,
      first_row INTEGER,
      max_rows INTEGER,
      record_count INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS apex_workflows (LIKE apex_jobs INCLUDING ALL);
    CREATE TABLE IF NOT EXISTS apex_workflow_history (LIKE apex_history INCLUDING ALL);

    CREATE TABLE IF NOT EXISTS apex_correlation_links (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
      application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
      workflow_entity_id TEXT NOT NULL,
      workflow_name TEXT,
      related_source_tool TEXT NOT NULL,
      related_entity_id TEXT,
      related_entity_name TEXT,
      relationship_type TEXT NOT NULL DEFAULT 'context',
      correlation_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
      correlation_confidence NUMERIC,
      dependency_impact_score NUMERIC,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, application_name, workflow_entity_id, related_source_tool, related_entity_id)
    );

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
      last_check TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      deep_link TEXT,
      custom_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, entity_type, entity_id)
    );

    ALTER TABLE monitoring_records ADD COLUMN IF NOT EXISTS entity_name TEXT;

    CREATE INDEX IF NOT EXISTS idx_apex_jobs_status ON apex_jobs(status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apex_jobs_entity ON apex_jobs(entity_name);
    CREATE INDEX IF NOT EXISTS idx_apex_history_entity ON apex_history(entity_id, snapshot_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apex_sync_history_started ON apex_sync_history(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apex_ai_features_risk ON apex_ai_features(risk_score, feature_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_apex_correlation_links_workflow ON apex_correlation_links(workflow_entity_id, related_source_tool);
  `);
}

function classifyPayloadFailure(payload) {
  const text = JSON.stringify(payload || {}).slice(0, 2000).toLowerCase();

  if (!payload || (typeof payload === 'object' && !Object.keys(payload).length)) {
    return 'Empty Oracle APEX response.';
  }

  if (/session.*expired|invalid.*session|authentication required|login|sign in|not authenticated/.test(text)) {
    return 'Oracle APEX session expired or authentication is required.';
  }

  if (
    /invalid.{0,120}(ajax|plugin|region|identifier)/.test(text) ||
    /ajaxidentifier.{0,120}(invalid|rejected|not found|does not match)/.test(text)
  ) {
    return 'Oracle APEX rejected the ajaxIdentifier for this region. Copy the actual wwv_flow.ajax Response JSON from DevTools and use the Pasted APEX AJAX JSON import instead.';
  }

  if (/ora-\d+|apex\.error|error/.test(text)) {
    return 'Oracle APEX returned an error payload.';
  }

  return null;
}

async function registerColumns(columns) {
  await ensureStorage();

  for (const column of columns) {
    await db.query(
      `
        INSERT INTO apex_dynamic_columns (
          column_key, column_name, column_label, column_type, display_order,
          hidden, visible, sort_info, formatting, metadata, last_seen_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,NOW())
        ON CONFLICT (source_tool, application_name, column_key)
        DO UPDATE SET
          column_name = EXCLUDED.column_name,
          column_label = EXCLUDED.column_label,
          column_type = EXCLUDED.column_type,
          display_order = EXCLUDED.display_order,
          hidden = EXCLUDED.hidden,
          visible = EXCLUDED.visible,
          sort_info = EXCLUDED.sort_info,
          formatting = EXCLUDED.formatting,
          metadata = apex_dynamic_columns.metadata || EXCLUDED.metadata,
          last_seen_at = NOW()
      `,
      [
        column.columnKey,
        column.columnName,
        column.columnLabel,
        column.columnType,
        column.displayOrder,
        Boolean(column.hidden),
        column.visible !== false,
        JSON.stringify(column.sortInfo || {}),
        JSON.stringify(column.formatting || {}),
        JSON.stringify(column.metadata || {}),
      ],
    );
  }
}

async function upsertMonitoringRecord(job) {
  await db.query(
    `
      INSERT INTO monitoring_records (
        source_tool, environment, application_name, entity_type, entity_id, entity_name,
        status, severity, summary, details, acknowledged, last_check, updated_at,
        raw_payload, deep_link, custom_properties
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,COALESCE($12,NOW()),$13::jsonb,$14,$15::jsonb)
      ON CONFLICT (source_tool, entity_type, entity_id)
      DO UPDATE SET
        environment = EXCLUDED.environment,
        application_name = EXCLUDED.application_name,
        entity_name = EXCLUDED.entity_name,
        status = EXCLUDED.status,
        severity = EXCLUDED.severity,
        summary = EXCLUDED.summary,
        details = EXCLUDED.details,
        last_check = EXCLUDED.last_check,
        updated_at = EXCLUDED.updated_at,
        raw_payload = EXCLUDED.raw_payload,
        deep_link = EXCLUDED.deep_link,
        custom_properties = EXCLUDED.custom_properties
    `,
    [
      SOURCE_TOOL,
      job.environment,
      APPLICATION_NAME,
      'apex_job',
      job.entityId,
      job.entityName,
      job.monitoringStatus,
      job.severity,
      job.summary,
      JSON.stringify(job.rowValues),
      job.timestamp,
      job.lastUpdated,
      JSON.stringify(job.rawRow || {}),
      job.deepLink,
      JSON.stringify({
        rowValues: job.rowValues,
        apexStatus: job.status,
        server: job.server,
        owner: job.owner,
        startTime: job.startTime,
        endTime: job.endTime,
        durationSeconds: job.durationSeconds,
        jobStep: job.jobStep,
        workflowGroup: job.workflowGroup,
        completedStepCount: job.completedStepCount,
        totalStepCount: job.totalStepCount,
        completionRate: job.completionRate,
      }),
    ],
  );
}

async function upsertJob(job, payloadId) {
  const result = await db.query(
    `
      INSERT INTO apex_jobs (
        entity_id, entity_name, environment, entity_type, status, severity,
        summary, timestamp, last_updated, first_seen_at, last_seen_at,
        row_values, raw_payload, entity_hash, deep_link, updated_at
      )
      VALUES ($1,$2,$3,'apex_job',$4,$5,$6,$7,$8,NOW(),NOW(),$9::jsonb,$10::jsonb,$11,$12,NOW())
      ON CONFLICT (source_tool, application_name, entity_id)
      DO UPDATE SET
        entity_name = EXCLUDED.entity_name,
        environment = EXCLUDED.environment,
        status = EXCLUDED.status,
        severity = EXCLUDED.severity,
        summary = EXCLUDED.summary,
        timestamp = EXCLUDED.timestamp,
        last_updated = EXCLUDED.last_updated,
        last_seen_at = NOW(),
        row_values = EXCLUDED.row_values,
        raw_payload = EXCLUDED.raw_payload,
        entity_hash = EXCLUDED.entity_hash,
        deep_link = EXCLUDED.deep_link,
        updated_at = NOW()
      RETURNING (xmax = 0) AS inserted, entity_hash
    `,
    [
      job.entityId,
      job.entityName,
      job.environment,
      job.status,
      job.severity,
      job.summary,
      job.timestamp,
      job.lastUpdated,
      JSON.stringify(job.rowValues || {}),
      JSON.stringify({ payloadId, row: job.rawRow || {} }),
      job.entityHash,
      job.deepLink,
    ],
  );

  await db.query(
    `
      INSERT INTO apex_workflows (
        entity_id, entity_name, environment, entity_type, status, severity,
        summary, timestamp, last_updated, first_seen_at, last_seen_at,
        row_values, raw_payload, entity_hash, deep_link, updated_at
      )
      VALUES ($1,$2,$3,'apex_job',$4,$5,$6,$7,$8,NOW(),NOW(),$9::jsonb,$10::jsonb,$11,$12,NOW())
      ON CONFLICT (source_tool, application_name, entity_id)
      DO UPDATE SET
        entity_name = EXCLUDED.entity_name,
        environment = EXCLUDED.environment,
        status = EXCLUDED.status,
        severity = EXCLUDED.severity,
        summary = EXCLUDED.summary,
        timestamp = EXCLUDED.timestamp,
        last_updated = EXCLUDED.last_updated,
        last_seen_at = NOW(),
        row_values = EXCLUDED.row_values,
        raw_payload = EXCLUDED.raw_payload,
        entity_hash = EXCLUDED.entity_hash,
        deep_link = EXCLUDED.deep_link,
        updated_at = NOW()
    `,
    [
      job.entityId,
      job.entityName,
      job.environment,
      job.status,
      job.severity,
      job.summary,
      job.timestamp,
      job.lastUpdated,
      JSON.stringify(job.rowValues || {}),
      JSON.stringify({ payloadId, row: job.rawRow || {} }),
      job.entityHash,
      job.deepLink,
    ],
  );

  await db.query(
    `
      INSERT INTO apex_history (
        entity_id, entity_name, status, severity, timestamp,
        execution_duration_seconds, row_values, raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
    `,
    [
      job.entityId,
      job.entityName,
      job.status,
      job.severity,
      job.timestamp,
      job.durationSeconds,
      JSON.stringify(job.rowValues || {}),
      JSON.stringify({ payloadId, row: job.rawRow || {} }),
    ],
  );

  await db.query(
    `
      INSERT INTO apex_workflow_history (
        entity_id, entity_name, status, severity, timestamp,
        execution_duration_seconds, row_values, raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
    `,
    [
      job.entityId,
      job.entityName,
      job.status,
      job.severity,
      job.timestamp,
      job.durationSeconds,
      JSON.stringify(job.rowValues || {}),
      JSON.stringify({ payloadId, row: job.rawRow || {} }),
    ],
  );

  await upsertMonitoringRecord(job);

  return result.rows[0]?.inserted ? 'inserted' : 'updated';
}

function calculateVariance(values, average) {
  if (!values.length) return null;

  return values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
}

async function upsertAiFeature(job) {
  const history = await db.query(
    `
      SELECT status, execution_duration_seconds, snapshot_at
      FROM apex_history
      WHERE source_tool = $1 AND application_name = $2 AND entity_id = $3
      ORDER BY snapshot_at DESC
      LIMIT 200
    `,
    [SOURCE_TOOL, APPLICATION_NAME, job.entityId],
  );
  const rows = history.rows;
  const durations = rows.map((row) => Number(row.execution_duration_seconds)).filter(Number.isFinite);
  const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
  const variance = average === null ? null : calculateVariance(durations, average);
  const failures = rows.filter((row) => row.status === 'failed').length;
  const successes = rows.filter((row) => row.status === 'completed').length;
  const recurrenceCount = rows.length;
  const failureRate = rows.length ? failures / rows.length : 0;
  const successRate = rows.length ? successes / rows.length : 0;
  const stabilityScore = Math.max(0, Math.min(1, 1 - failureRate));
  const runtimeStability = variance === null ? null : Math.max(0, Math.min(1, 1 - (Math.sqrt(variance) / Math.max(1, average || 1))));
  const riskScore = Math.max(0, Math.min(1, failureRate + (job.status === 'failed' ? 0.4 : 0) + (job.status === 'delayed' ? 0.2 : 0)));

  await db.query(
    `
      INSERT INTO apex_ai_features (
        entity_id, entity_name, execution_duration_seconds, average_runtime_seconds,
        minimum_runtime_seconds, maximum_runtime_seconds, runtime_variance, runtime_stddev,
        execution_frequency, execution_trend, schedule_delay_seconds, schedule_compliance_score,
        missed_schedule_count, consecutive_successes, consecutive_failures, failure_rate,
        success_rate, historical_failure_count, historical_success_count, recovery_count,
        recovery_time_seconds, running_time_seconds, current_runtime_seconds, queue_wait_time_seconds,
        dependency_count, dependency_delay_seconds, business_impact_score, job_stability_score,
        runtime_stability_score, historical_trend, alert_frequency, alert_density,
        recurrence_count, execution_volatility, execution_anomaly_score, historical_percentile,
        runtime_percentile, failure_percentile, noise_probability, incident_probability,
        risk_score, root_cause_confidence, prediction_confidence, correlation_keys,
        ai_label, ai_reason, raw_payload, updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44::jsonb,
        'unknown',$45,$46::jsonb,NOW()
      )
      ON CONFLICT (source_tool, application_name, entity_id)
      DO UPDATE SET
        entity_name = EXCLUDED.entity_name,
        feature_timestamp = NOW(),
        execution_duration_seconds = EXCLUDED.execution_duration_seconds,
        average_runtime_seconds = EXCLUDED.average_runtime_seconds,
        minimum_runtime_seconds = EXCLUDED.minimum_runtime_seconds,
        maximum_runtime_seconds = EXCLUDED.maximum_runtime_seconds,
        runtime_variance = EXCLUDED.runtime_variance,
        runtime_stddev = EXCLUDED.runtime_stddev,
        failure_rate = EXCLUDED.failure_rate,
        success_rate = EXCLUDED.success_rate,
        historical_failure_count = EXCLUDED.historical_failure_count,
        historical_success_count = EXCLUDED.historical_success_count,
        recurrence_count = EXCLUDED.recurrence_count,
        job_stability_score = EXCLUDED.job_stability_score,
        runtime_stability_score = EXCLUDED.runtime_stability_score,
        risk_score = EXCLUDED.risk_score,
        correlation_keys = EXCLUDED.correlation_keys,
        ai_reason = EXCLUDED.ai_reason,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `,
    [
      job.entityId,
      job.entityName,
      job.durationSeconds,
      average,
      durations.length ? Math.min(...durations) : null,
      durations.length ? Math.max(...durations) : null,
      variance,
      variance === null ? null : Math.sqrt(variance),
      rows.length,
      job.status === 'failed' ? 'worsening' : job.status === 'completed' ? 'stable' : 'active',
      null,
      job.status === 'delayed' ? 0.4 : 1,
      job.status === 'delayed' ? 1 : 0,
      job.status === 'completed' ? successes : 0,
      job.status === 'failed' ? failures : 0,
      failureRate,
      successRate,
      failures,
      successes,
      0,
      null,
      job.status === 'running' ? job.durationSeconds : null,
      job.durationSeconds,
      null,
      firstValue(job.rowValues, ['dependencies']) ? String(firstValue(job.rowValues, ['dependencies'])).split(',').length : 0,
      null,
      riskScore,
      stabilityScore,
      runtimeStability,
      failureRate > 0.25 ? 'failure_prone' : 'stable',
      failureRate,
      rows.length,
      recurrenceCount,
      variance,
      null,
      null,
      null,
      failureRate,
      null,
      null,
      riskScore,
      null,
      null,
      JSON.stringify({
        entityName: job.entityName,
        server: job.server,
        environment: job.environment,
        application: APPLICATION_NAME,
        sourceTool: SOURCE_TOOL,
      }),
      'AI model is not enabled yet. Oracle APEX job features are prepared for future prediction.',
      JSON.stringify(job.rowValues || {}),
    ],
  );
}

async function importApexPayload(payload, options = {}) {
  await ensureStorage();
  const startedAt = Date.now();
  const failure = classifyPayloadFailure(payload);

  if (failure) {
    const error = new Error(failure);
    error.status = 400;
    throw error;
  }

  const rawRows = extractRows(payload);

  if (!rawRows.length) {
    const error = new Error('Oracle APEX response did not contain report rows.');
    error.status = 400;
    throw error;
  }

  const columns = discoverColumns(payload, rawRows);
  const runtimeConfig = await getRuntimeConfig();
  const payloadHash = stableHash(payload);
  const rawResult = await db.query(
    `
      INSERT INTO apex_raw_payloads (payload_hash, page_number, first_row, max_rows, record_count, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      RETURNING id
    `,
    [
      payloadHash,
      Number(options.pageNumber || 1),
      Number(options.firstRow || 1),
      Number(options.maxRows || rawRows.length),
      rawRows.length,
      JSON.stringify(payload || {}),
    ],
  );
  const rawPayloadId = rawResult.rows[0]?.id;

  await registerColumns(columns);

  const jobs = rawRows.map((row, index) => normalizeRow(row, columns, index, runtimeConfig));
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const job of jobs) {
    const existing = await db.query(
      'SELECT entity_hash FROM apex_jobs WHERE source_tool = $1 AND application_name = $2 AND entity_id = $3',
      [SOURCE_TOOL, APPLICATION_NAME, job.entityId],
    );

    if (existing.rows[0]?.entity_hash === job.entityHash) {
      skipped += 1;
    }

    const result = await upsertJob(job, rawPayloadId);
    if (result === 'inserted') inserted += 1;
    else if (existing.rows[0]?.entity_hash !== job.entityHash) updated += 1;

    await upsertAiFeature(job);
  }

  const finishedAt = Date.now();
  await db.query(
    `
      INSERT INTO apex_sync_history (
        finished_at, duration_ms, result, records_retrieved, records_inserted,
        records_updated, records_skipped, raw_payload_id
      )
      VALUES (NOW(),$1,'success',$2,$3,$4,$5,$6)
    `,
    [
      finishedAt - startedAt,
      jobs.length,
      inserted,
      updated,
      skipped,
      rawPayloadId,
    ],
  );

  return {
    sourceTool: SOURCE_TOOL,
    applicationName: APPLICATION_NAME,
    recordsRetrieved: jobs.length,
    inserted,
    updated,
    skipped,
    columnsDiscovered: columns.length,
    rawPayloadId,
    message: `Oracle APEX import complete: ${jobs.length} rows, ${columns.length} columns, ${inserted} inserted, ${updated} updated, ${skipped} unchanged.`,
  };
}

function mapColumn(row) {
  return {
    key: row.column_key,
    name: row.column_name,
    label: row.column_label,
    type: row.column_type,
    displayOrder: row.display_order,
    hidden: row.hidden,
    visible: row.visible,
    sortInfo: row.sort_info || {},
    formatting: row.formatting || {},
    metadata: row.metadata || {},
    lastSeenAt: row.last_seen_at,
  };
}

function mapJob(row) {
  return {
    sourceTool: row.source_tool,
    applicationName: row.application_name,
    entityId: row.entity_id,
    entityName: row.entity_name,
    environment: row.environment,
    entityType: row.entity_type,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    timestamp: row.timestamp,
    lastUpdated: row.last_updated,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    rowValues: row.row_values || {},
    rawPayload: row.raw_payload || {},
    deepLink: row.deep_link,
  };
}

function mapAi(row) {
  return {
    entityId: row.entity_id,
    entityName: row.entity_name,
    executionDurationSeconds: row.execution_duration_seconds,
    averageRuntimeSeconds: row.average_runtime_seconds,
    minimumRuntimeSeconds: row.minimum_runtime_seconds,
    maximumRuntimeSeconds: row.maximum_runtime_seconds,
    runtimeVariance: row.runtime_variance,
    runtimeStddev: row.runtime_stddev,
    failureRate: row.failure_rate,
    successRate: row.success_rate,
    recurrenceCount: row.recurrence_count,
    jobStabilityScore: row.job_stability_score,
    runtimeStabilityScore: row.runtime_stability_score,
    riskScore: row.risk_score,
    aiLabel: row.ai_label,
    aiReason: row.ai_reason,
    updatedAt: row.updated_at,
  };
}

function buildSummary(jobs) {
  const counts = jobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});
  const completed = counts.completed || 0;
  const failed = counts.failed || 0;
  const durations = jobs
    .map((job) => {
      const explicitDuration = toNumber(job.rowValues.duration_seconds ?? job.rawPayload?.durationSeconds);

      return explicitDuration ?? parseDurationSeconds(firstValue(job.rowValues, ['duration', 'runtime', 'elapsed', 'elapsed_time', 'execution_duration']));
    })
    .filter(Number.isFinite);

  return {
    totalJobs: jobs.length,
    completed,
    running: counts.running || 0,
    waiting: counts.waiting || 0,
    queued: counts.queued || 0,
    failed,
    delayed: counts.delayed || 0,
    unknown: counts.unknown || 0,
    successRate: jobs.length ? Math.round((completed / jobs.length) * 1000) / 10 : 0,
    averageRuntimeSeconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    averageDelaySeconds: null,
    jobsMissedSchedule: counts.delayed || 0,
    lastUpdated: jobs.map((job) => job.lastUpdated).filter(Boolean).sort().at(-1) || null,
    statusCounts: counts,
  };
}

async function listApplications() {
  await ensureStorage();
  const result = await db.query(
    `
      SELECT
        COALESCE(SUM(status_count), 0)::int AS count,
        (SELECT MAX(last_updated) FROM apex_jobs) AS last_updated,
        COALESCE(
          jsonb_object_agg(status, status_count) FILTER (WHERE status IS NOT NULL),
          '{}'::jsonb
        ) AS status_counts
      FROM (
        SELECT status, COUNT(*)::int AS status_count
        FROM apex_jobs
        GROUP BY status
      ) status_rows
    `,
  );
  const row = result.rows[0] || {};
  const statusCounts = row.status_counts || {};

  return [{
    id: DASHBOARD_ID,
    label: APPLICATION_NAME,
    entityType: 'apex_dashboard',
    recordCount: Number(row.count || 0),
    status: Number(statusCounts.failed || 0) > 0 ? 'critical' : Number(statusCounts.delayed || 0) > 0 ? 'warning' : 'ok',
    statusCounts,
    lastUpdatedAt: row.last_updated || null,
    metadata: {
      description: 'Oracle APEX PF & ETL Dashboard dynamic report.',
    },
  }];
}

async function getDashboardDetails(options = {}) {
  await ensureStorage();
  const [columnsResult, jobsResult, syncResult, aiResult] = await Promise.all([
    db.query('SELECT * FROM apex_dynamic_columns ORDER BY display_order NULLS LAST, column_label'),
    db.query('SELECT * FROM apex_jobs ORDER BY last_seen_at DESC, entity_name LIMIT 5000'),
    db.query('SELECT * FROM apex_sync_history ORDER BY started_at DESC LIMIT 25'),
    db.query('SELECT * FROM apex_ai_features ORDER BY risk_score DESC NULLS LAST, entity_name LIMIT 500'),
  ]);
  const columns = columnsResult.rows.map(mapColumn);
  const jobs = jobsResult.rows.map(mapJob);
  const aiFeatures = aiResult.rows.map(mapAi);
  const runtimeConfig = await getRuntimeConfig();

  return {
    tool: {
      key: SOURCE_TOOL,
      label: 'Oracle APEX',
      adapterName: 'Oracle APEX Adapter',
    },
    application: {
      id: DASHBOARD_ID,
      label: APPLICATION_NAME,
      entityType: 'apex_dashboard',
    },
    kind: 'oracle_apex_dashboard',
    summary: buildSummary(jobs),
    keyMetrics: [],
    columns,
    jobs,
    aiFeatures,
    syncHistory: syncResult.rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      result: row.result,
      failureStage: row.failure_stage,
      failureType: row.failure_type,
      failureReason: row.failure_reason,
      recordsRetrieved: row.records_retrieved,
      recordsInserted: row.records_inserted,
      recordsUpdated: row.records_updated,
      recordsSkipped: row.records_skipped,
    })),
    importConfig: {
      baseUrl: runtimeConfig.baseUrl,
      ajaxPath: runtimeConfig.ajaxPath,
      flowId: runtimeConfig.flowId,
      pageId: runtimeConfig.pageId,
      regionId: runtimeConfig.regionId,
      requestName: runtimeConfig.requestName,
      maxRows: runtimeConfig.maxRows,
      ajaxIdentifierConfigured: Boolean(runtimeConfig.ajaxIdentifier),
    },
    deepLink: runtimeConfig.deepLink,
    lastUpdatedAt: jobs.map((job) => job.lastUpdated).filter(Boolean).sort().at(-1) || null,
    timeRange: {
      from: options.from || 'now-6h',
      to: options.to || 'now',
    },
  };
}

async function testConnectionReadiness() {
  const config = await getRuntimeConfig();
  const missing = [];

  if (!config.baseUrl || config.baseUrl.includes('apex.example.com')) missing.push('baseUrl');
  if (!config.ajaxPath) missing.push('ajaxPath');
  if (!config.flowId) missing.push('flowId');
  if (!config.regionId) missing.push('regionId');

  return {
    ok: missing.length === 0,
    status: missing.length ? 'authentication_required' : 'connected',
    mode: 'browser_session',
    message: missing.length
      ? `Oracle APEX requires configuration fields: ${missing.join(', ')}. Browser-authenticated import also requires a valid APEX session.`
      : 'Oracle APEX connector is configured for browser-authenticated AJAX import. Live server-side auth is not used.',
  };
}

async function syncFromSettings() {
  const error = new Error('Oracle APEX uses browser-authenticated AJAX import. Open Monitoring > Oracle APEX and use Import from Browser Session or paste the APEX JSON response.');
  error.status = 400;
  throw error;
}

module.exports = {
  APPLICATION_NAME,
  DASHBOARD_ID,
  SOURCE_TOOL,
  getDashboardDetails,
  importApexPayload,
  listApplications,
  syncFromSettings,
  testConnectionReadiness,
};

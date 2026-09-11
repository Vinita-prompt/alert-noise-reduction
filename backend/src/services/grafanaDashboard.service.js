const crypto = require('crypto');
const db = require('../config/db');
const integrationService = require('./integration.service');

const REQUEST_TIMEOUT_MS = Number(process.env.GRAFANA_TIMEOUT_MS || 10000);
const PANEL_RENDER_TIMEOUT_MS = Number(process.env.GRAFANA_PANEL_RENDER_TIMEOUT_MS || 30000);
const METRIC_PANEL_LIMIT = Number(process.env.GRAFANA_METRIC_PANEL_LIMIT || 100);
const WORKSPACE_METADATA_CACHE_MS = Number(process.env.GRAFANA_WORKSPACE_CACHE_MS || 60000);
const WORKSPACE_RULE_CACHE_MS = Number(process.env.GRAFANA_RULE_CACHE_MS || 120000);
const WORKSPACE_PANEL_RENDER_CACHE_MS = Number(process.env.GRAFANA_PANEL_RENDER_CACHE_MS || 30000);
const WORKSPACE_PANEL_RENDER_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.GRAFANA_PANEL_RENDER_CONCURRENCY || 4)));
const WORKSPACE_INVENTORY_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.GRAFANA_INVENTORY_CONCURRENCY || 6)));
const WORKSPACE_PAGE_SIZE = 20;
const WORKSPACE_MAX_PAGE_SIZE = 50;
const WORKSPACE_DASHBOARD_COUNT_LIMIT = 5000;
const WORKSPACE_PANEL_RENDER_CACHE_LIMIT = 48;
const WORKSPACE_RENDER_RANGES = new Set(['15m', '30m', '1h', '4h', '24h', '7d', '30d', '90d', '6mo', '1y']);
const GRAFANA_ALERT_STATE_HISTORY_DATASOURCE_UID = String(
  process.env.GRAFANA_ALERT_STATE_HISTORY_UID || 'grafanacloud-alert-state-history',
).trim();
let grafanaStorageReady = false;
let grafanaStorageReadyPromise = null;
const grafanaWorkspaceCache = new Map();
const grafanaPanelRenderCache = new Map();
const grafanaPanelRenderQueue = [];
let activeGrafanaPanelRenders = 0;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function buildGrafanaUrl(baseUrl, path, params = {}) {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function fetchGrafanaJson(url, token, requestOptions = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(requestOptions.timeoutMs || REQUEST_TIMEOUT_MS);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const abortFromExternalSignal = () => controller.abort();

  if (requestOptions.signal?.aborted) {
    controller.abort();
  } else {
    requestOptions.signal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      method: requestOptions.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(requestOptions.headers || {}),
      },
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const responseTimeMs = Date.now() - startedAt;
    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(
        response.status === 401 || response.status === 403
          ? 'Grafana rejected the token while loading dashboards.'
          : `Grafana dashboard API returned HTTP ${response.status}.`,
      );
      error.status = 502;
      error.responseStatus = response.status;
      throw error;
    }

    return { payload, responseTimeMs };
  } finally {
    clearTimeout(timeoutId);
    requestOptions.signal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

async function fetchGrafanaBinary(url, token, externalSignal = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PANEL_RENDER_TIMEOUT_MS);
  const abortFromExternalSignal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const error = new Error(
        response.status === 401 || response.status === 403
          ? 'Grafana rejected the token while rendering the panel.'
          : `Grafana panel render API returned HTTP ${response.status}.`,
      );
      error.status = 502;
      error.responseStatus = response.status;
      throw error;
    }

    return { buffer, contentType };
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

function getGrafanaEnvironmentConfig() {
  const envBaseUrl = normalizeBaseUrl(process.env.GRAFANA_BASE_URL);
  const envToken = String(process.env.GRAFANA_API_TOKEN || '').trim();
  const hasBaseUrl = Boolean(envBaseUrl);
  const hasToken = Boolean(envToken);

  if (!hasBaseUrl && !hasToken) {
    return null;
  }

  if (!hasBaseUrl || !hasToken) {
    const error = new Error(
      'Grafana environment configuration is incomplete. Set both GRAFANA_BASE_URL and GRAFANA_API_TOKEN.',
    );
    error.status = 400;
    throw error;
  }

  return {
    baseUrl: envBaseUrl,
    token: envToken,
    source: 'environment',
  };
}

async function getGrafanaRuntimeConfig(options = {}) {
  const envEnabled = String(process.env.GRAFANA_ENABLED || '').trim().toLowerCase();

  if (envEnabled && ['0', 'false', 'no', 'off'].includes(envEnabled)) {
    const error = new Error('Grafana integration is disabled by GRAFANA_ENABLED=false.');
    error.status = 400;
    throw error;
  }

  const environmentConfig = getGrafanaEnvironmentConfig();

  if (environmentConfig) {
    return environmentConfig;
  }

  if (options.requireEnvironment) {
    const error = new Error(
      'Grafana workspace requires GRAFANA_BASE_URL and GRAFANA_API_TOKEN in the backend environment.',
    );
    error.status = 400;
    error.code = 'GRAFANA_ENVIRONMENT_REQUIRED';
    throw error;
  }

  let config = { baseUrl: '', credentials: {} };

  try {
    config = await integrationService.getIntegrationRuntimeConfig('grafana');
  } catch {
    config = { baseUrl: '', credentials: {} };
  }

  const token = config.credentials.token || config.credentials.apiKey || config.credentials.apiToken;
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  if (!baseUrl || !token) {
    const error = new Error('Grafana URL or token is missing.');
    error.status = 400;
    throw error;
  }

  return {
    baseUrl,
    token,
    source: 'encrypted_integration_configuration',
  };
}

async function runGrafanaDashboardStorageSetup(client = db) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS grafana_dashboards (
      uid TEXT PRIMARY KEY,
      dashboard_id TEXT,
      title TEXT NOT NULL,
      slug TEXT,
      uri TEXT,
      dashboard_url TEXT,
      folder_uid TEXT,
      folder_title TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      refresh_interval TEXT,
      dashboard_type TEXT,
      is_starred BOOLEAN NOT NULL DEFAULT FALSE,
      panel_count INTEGER NOT NULL DEFAULT 0,
      datasource_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      dashboard_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE grafana_dashboards
      ALTER COLUMN dashboard_id TYPE TEXT USING dashboard_id::text;

    ALTER TABLE grafana_dashboards
      ADD COLUMN IF NOT EXISTS refresh_interval TEXT;

    CREATE INDEX IF NOT EXISTS idx_grafana_dashboards_folder ON grafana_dashboards(folder_title);
    CREATE INDEX IF NOT EXISTS idx_grafana_dashboards_updated ON grafana_dashboards(updated_at DESC);

    CREATE TABLE IF NOT EXISTS grafana_folders (
      uid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT,
      dashboard_count INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_folders_title ON grafana_folders(title);

    CREATE TABLE IF NOT EXISTS grafana_panels (
      id BIGSERIAL PRIMARY KEY,
      dashboard_uid TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      panel_uid TEXT,
      panel_title TEXT NOT NULL,
      panel_type TEXT,
      panel_order INTEGER NOT NULL DEFAULT 0,
      folder_uid TEXT,
      folder_name TEXT,
      dashboard_title TEXT,
      datasource_name TEXT,
      query_summary TEXT,
      grid_pos JSONB NOT NULL DEFAULT '{}'::jsonb,
      targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      deep_link TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dashboard_uid, panel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_panels_dashboard ON grafana_panels(dashboard_uid, panel_order);
    CREATE INDEX IF NOT EXISTS idx_grafana_panels_title ON grafana_panels(panel_title);

    CREATE TABLE IF NOT EXISTS grafana_alert_rules (
      uid TEXT PRIMARY KEY,
      rule_id TEXT,
      title TEXT NOT NULL,
      folder_uid TEXT,
      folder_name TEXT,
      dashboard_uid TEXT,
      panel_id TEXT,
      condition TEXT,
      state TEXT,
      severity TEXT,
      labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
      data JSONB NOT NULL DEFAULT '[]'::jsonb,
      deep_link TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_alert_rules_dashboard ON grafana_alert_rules(dashboard_uid);
    CREATE INDEX IF NOT EXISTS idx_grafana_alert_rules_state ON grafana_alert_rules(state);

    CREATE TABLE IF NOT EXISTS grafana_alert_states (
      fingerprint TEXT PRIMARY KEY,
      rule_uid TEXT,
      rule_title TEXT,
      state TEXT,
      severity TEXT,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
      deep_link TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_alert_states_rule ON grafana_alert_states(rule_uid);
    CREATE INDEX IF NOT EXISTS idx_grafana_alert_states_state ON grafana_alert_states(state);

    CREATE TABLE IF NOT EXISTS grafana_ai_features (
      source_tool TEXT NOT NULL DEFAULT 'Grafana',
      source_module TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_uid TEXT,
      entity_name TEXT NOT NULL,
      dashboard_uid TEXT,
      dashboard_category TEXT,
      panel_title TEXT,
      metric_name TEXT,
      alert_rule_state TEXT,
      threshold TEXT,
      severity TEXT,
      timestamp TIMESTAMPTZ,
      recurrence_count INTEGER NOT NULL DEFAULT 0,
      ai_label TEXT NOT NULL DEFAULT 'unknown',
      ai_confidence NUMERIC,
      ai_reason TEXT,
      ai_features JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_tool, source_module, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_ai_features_dashboard ON grafana_ai_features(dashboard_uid);
    CREATE INDEX IF NOT EXISTS idx_grafana_ai_features_label ON grafana_ai_features(ai_label);

    CREATE TABLE IF NOT EXISTS monitoring_dashboards (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      application_name TEXT NOT NULL,
      dashboard_name TEXT NOT NULL,
      dashboard_subname TEXT,
      dashboard_uid TEXT NOT NULL,
      panel_count INTEGER NOT NULL DEFAULT 0,
      panel_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_updated_at TIMESTAMPTZ,
      last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deep_link TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, dashboard_uid)
    );

    CREATE INDEX IF NOT EXISTS idx_monitoring_dashboards_source
      ON monitoring_dashboards(source_tool, dashboard_subname, dashboard_name);
    CREATE INDEX IF NOT EXISTS idx_monitoring_dashboards_updated
      ON monitoring_dashboards(source_tool, last_updated_at DESC);
  `);

  await client.query(`
    ALTER TABLE grafana_folders
      ADD COLUMN IF NOT EXISTS folder_id TEXT,
      ADD COLUMN IF NOT EXISTS parent_uid TEXT,
      ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS grafana_created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS grafana_updated_at TIMESTAMPTZ;

    ALTER TABLE grafana_dashboards
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS timezone TEXT,
      ADD COLUMN IF NOT EXISTS editable BOOLEAN,
      ADD COLUMN IF NOT EXISTS version INTEGER,
      ADD COLUMN IF NOT EXISTS schema_version INTEGER,
      ADD COLUMN IF NOT EXISTS created_by TEXT,
      ADD COLUMN IF NOT EXISTS updated_by TEXT,
      ADD COLUMN IF NOT EXISTS grafana_created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS grafana_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS templating_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS dashboard_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS entity_hash TEXT;

    ALTER TABLE grafana_panels
      ADD COLUMN IF NOT EXISTS panel_description TEXT,
      ADD COLUMN IF NOT EXISTS visualization_type TEXT,
      ADD COLUMN IF NOT EXISTS datasource_uid TEXT,
      ADD COLUMN IF NOT EXISTS queries JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS expressions JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS transformations JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS thresholds JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS field_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS legend TEXT,
      ADD COLUMN IF NOT EXISTS unit TEXT,
      ADD COLUMN IF NOT EXISTS decimals INTEGER,
      ADD COLUMN IF NOT EXISTS color_scheme TEXT,
      ADD COLUMN IF NOT EXISTS display_mode TEXT,
      ADD COLUMN IF NOT EXISTS min_value NUMERIC,
      ADD COLUMN IF NOT EXISTS max_value NUMERIC,
      ADD COLUMN IF NOT EXISTS current_value NUMERIC,
      ADD COLUMN IF NOT EXISTS metric_stats JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE grafana_alert_rules
      ADD COLUMN IF NOT EXISTS threshold TEXT,
      ADD COLUMN IF NOT EXISTS reducer TEXT,
      ADD COLUMN IF NOT EXISTS operator TEXT,
      ADD COLUMN IF NOT EXISTS health TEXT,
      ADD COLUMN IF NOT EXISTS no_data_state TEXT,
      ADD COLUMN IF NOT EXISTS exec_error_state TEXT,
      ADD COLUMN IF NOT EXISTS rule_group TEXT,
      ADD COLUMN IF NOT EXISTS evaluation_interval TEXT,
      ADD COLUMN IF NOT EXISTS summary TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS last_evaluation_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_evaluation_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS silenced BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE grafana_ai_features
      ADD COLUMN IF NOT EXISTS computed_features JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS correlation_features JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS prediction_placeholder TEXT,
      ADD COLUMN IF NOT EXISTS confidence_placeholder NUMERIC,
      ADD COLUMN IF NOT EXISTS explanation_placeholder TEXT;

    CREATE TABLE IF NOT EXISTS grafana_alert_state_history (
      id BIGSERIAL PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      rule_uid TEXT,
      rule_title TEXT,
      previous_state TEXT,
      state TEXT NOT NULL,
      severity TEXT,
      transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_alert_state_history_fingerprint
      ON grafana_alert_state_history(fingerprint, transitioned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_grafana_alert_state_history_rule
      ON grafana_alert_state_history(rule_uid, transitioned_at DESC);

    CREATE TABLE IF NOT EXISTS grafana_annotations (
      annotation_id TEXT PRIMARY KEY,
      dashboard_uid TEXT,
      panel_id TEXT,
      text TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      annotation_time TIMESTAMPTZ,
      created_by TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_annotations_dashboard
      ON grafana_annotations(dashboard_uid, annotation_time DESC);

    CREATE TABLE IF NOT EXISTS grafana_variables (
      id BIGSERIAL PRIMARY KEY,
      dashboard_uid TEXT NOT NULL,
      variable_name TEXT NOT NULL,
      variable_type TEXT,
      datasource_uid TEXT,
      current_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      refresh_mode TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dashboard_uid, variable_name)
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_variables_dashboard
      ON grafana_variables(dashboard_uid, variable_name);

    CREATE TABLE IF NOT EXISTS grafana_datasources (
      uid TEXT PRIMARY KEY,
      datasource_id TEXT,
      name TEXT NOT NULL,
      type TEXT,
      url TEXT,
      access TEXT,
      is_default BOOLEAN,
      json_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS grafana_panel_metric_points (
      id BIGSERIAL PRIMARY KEY,
      dashboard_uid TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      datasource_uid TEXT,
      series_name TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      metric_timestamp TIMESTAMPTZ NOT NULL,
      value NUMERIC,
      value_type TEXT,
      unit TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dashboard_uid, panel_id, series_name, metric_name, metric_timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_panel_metric_points_panel
      ON grafana_panel_metric_points(dashboard_uid, panel_id, metric_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_grafana_panel_metric_points_metric
      ON grafana_panel_metric_points(metric_name, metric_timestamp DESC);

    CREATE TABLE IF NOT EXISTS grafana_panel_metric_summaries (
      dashboard_uid TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      series_name TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      datasource_uid TEXT,
      current_value NUMERIC,
      min_value NUMERIC,
      max_value NUMERIC,
      average_value NUMERIC,
      median_value NUMERIC,
      p95_value NUMERIC,
      p99_value NUMERIC,
      stddev_value NUMERIC,
      sample_count INTEGER NOT NULL DEFAULT 0,
      first_timestamp TIMESTAMPTZ,
      last_timestamp TIMESTAMPTZ,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (dashboard_uid, panel_id, series_name, metric_name)
    );

    CREATE TABLE IF NOT EXISTS grafana_correlation_features (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL DEFAULT 'Grafana',
      entity_a TEXT NOT NULL,
      entity_b TEXT NOT NULL,
      dashboard_uid_a TEXT,
      dashboard_uid_b TEXT,
      correlation_scope TEXT NOT NULL,
      shared_datasource BOOLEAN NOT NULL DEFAULT FALSE,
      shared_alert_rules INTEGER NOT NULL DEFAULT 0,
      shared_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      shared_folder BOOLEAN NOT NULL DEFAULT FALSE,
      temporal_correlation NUMERIC,
      dependency_score NUMERIC,
      potential_root_cause_score NUMERIC,
      correlation_confidence NUMERIC,
      correlation_features JSONB NOT NULL DEFAULT '{}'::jsonb,
      feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, entity_a, entity_b, correlation_scope)
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_correlation_features_dashboard
      ON grafana_correlation_features(dashboard_uid_a, dashboard_uid_b);

    CREATE TABLE IF NOT EXISTS grafana_raw_payload_archive (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      entity_uid TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_type, entity_uid, payload_hash)
    );

    CREATE TABLE IF NOT EXISTS grafana_sync_logs (
      id BIGSERIAL PRIMARY KEY,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_message TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_grafana_raw_payload_archive_entity
      ON grafana_raw_payload_archive(source_type, entity_uid, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_grafana_sync_logs_started
      ON grafana_sync_logs(sync_type, started_at DESC);
  `);
}

async function ensureGrafanaDashboardStorage(client = db) {
  if (client !== db) {
    await runGrafanaDashboardStorageSetup(client);
    return;
  }

  if (grafanaStorageReady) {
    return;
  }

  if (!grafanaStorageReadyPromise) {
    grafanaStorageReadyPromise = runGrafanaDashboardStorageSetup(db)
      .then(() => {
        grafanaStorageReady = true;
      })
      .finally(() => {
        grafanaStorageReadyPromise = null;
      });
  }

  await grafanaStorageReadyPromise;
}

function getAbsoluteUrl(baseUrl, value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    return value;
  }
}

function flattenPanels(panels = []) {
  const result = [];

  panels.forEach((panel) => {
    if (!panel || typeof panel !== 'object') {
      return;
    }

    result.push(panel);

    if (Array.isArray(panel.panels)) {
      result.push(...flattenPanels(panel.panels));
    }
  });

  return result;
}

function getDatasourceName(datasource) {
  if (!datasource) {
    return null;
  }

  if (typeof datasource === 'string') {
    return datasource;
  }

  return datasource.name || datasource.uid || datasource.type || null;
}

function getDashboardDatasources(dashboard) {
  const names = new Set();

  flattenPanels(dashboard?.panels || []).forEach((panel) => {
    const datasourceName = getDatasourceName(panel.datasource);

    if (datasourceName) {
      names.add(datasourceName);
    }

    (panel.targets || []).forEach((target) => {
      const targetDatasourceName = getDatasourceName(target.datasource);

      if (targetDatasourceName) {
        names.add(targetDatasourceName);
      }
    });
  });

  return [...names].sort();
}

function isRenderablePanel(panel) {
  return panel && typeof panel === 'object' && panel.type !== 'row';
}

function getPanelDatasource(panel) {
  const datasource = panel.datasource || panel.targets?.find((target) => target.datasource)?.datasource;

  return getDatasourceName(datasource) || 'Default datasource';
}

function getPanelQuerySummary(panel) {
  const target = panel.targets?.[0];

  if (!target) {
    return 'No query metadata stored';
  }

  return target.queryType || target.expr || target.metric || target.refId || target.measurement || 'Query metadata stored';
}

function getPanelMetadata(dashboard) {
  return flattenPanels(dashboard?.panels || [])
    .filter(isRenderablePanel)
    .map((panel, index) => ({
      id: panel.id,
      uid: panel.uid || null,
      title: panel.title || `Panel ${panel.id || index + 1}`,
      type: panel.type || 'panel',
      order: index + 1,
      datasource: getPanelDatasource(panel),
      querySummary: getPanelQuerySummary(panel),
      gridPos: panel.gridPos || null,
      targets: panel.targets || [],
    }));
}

function stablePanelId(panel, index) {
  return String(panel?.id ?? panel?.uid ?? `panel-${index + 1}`);
}

function getPanelDeepLink(dashboardUrl, panel) {
  if (!dashboardUrl || !panel?.id) {
    return dashboardUrl || null;
  }

  try {
    const url = new URL(dashboardUrl);
    url.searchParams.set('viewPanel', String(panel.id));
    return url.toString();
  } catch {
    return dashboardUrl;
  }
}

function findThreshold(panel) {
  const thresholds = panel?.fieldConfig?.defaults?.thresholds?.steps;

  if (Array.isArray(thresholds) && thresholds.length) {
    return thresholds
      .map((step) => step.value ?? step.color)
      .filter((value) => value !== null && value !== undefined && value !== '')
      .join(', ');
  }

  return panel?.options?.threshold || panel?.threshold || null;
}

function toIsoTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hashPayload(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

async function archiveRawPayload(client, sourceType, entityUid, payload) {
  await client.query(
    `
      INSERT INTO grafana_raw_payload_archive (
        source_type,
        entity_uid,
        payload_hash,
        raw_payload
      )
      VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (source_type, entity_uid, payload_hash) DO NOTHING
    `,
    [
      sourceType,
      String(entityUid || 'unknown'),
      hashPayload(payload),
      JSON.stringify(payload || {}),
    ],
  );
}

async function startSyncLog(syncType, rawPayload = {}) {
  await ensureGrafanaDashboardStorage();
  const result = await db.query(
    `
      INSERT INTO grafana_sync_logs (sync_type, raw_payload)
      VALUES ($1,$2::jsonb)
      RETURNING id
    `,
    [syncType, JSON.stringify(rawPayload || {})],
  );

  return result.rows[0]?.id;
}

async function finishSyncLog(id, status, details = {}) {
  if (!id) {
    return;
  }

  await db.query(
    `
      UPDATE grafana_sync_logs
      SET
        status = $2,
        finished_at = NOW(),
        duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000))::int,
        counts = $3::jsonb,
        warnings = $4::jsonb,
        error_message = $5,
        raw_payload = raw_payload || $6::jsonb
      WHERE id = $1
    `,
    [
      id,
      status,
      JSON.stringify(details.counts || {}),
      JSON.stringify(details.warnings || []),
      details.errorMessage || null,
      JSON.stringify(details.rawPayload || {}),
    ],
  );
}

function grafanaTimeToEpochMs(value, fallback = Date.now()) {
  if (!value || value === 'now') {
    return Date.now();
  }

  const relative = String(value).match(/^now-(\d+)(m|h|d)$/i);

  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit === 'm' ? 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return Date.now() - amount * multiplier;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? fallback : date.getTime();
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;

  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }

  return sortedValues[base];
}

function computeNumericStats(points = []) {
  const numeric = points
    .map((point) => Number(point.value))
    .filter((value) => Number.isFinite(value));

  if (!numeric.length) {
    return {
      currentValue: null,
      min: null,
      max: null,
      average: null,
      median: null,
      p95: null,
      p99: null,
      stddev: null,
      sampleCount: 0,
      slope: null,
      rateOfChange: null,
    };
  }

  const sorted = [...numeric].sort((a, b) => a - b);
  const sum = numeric.reduce((total, value) => total + value, 0);
  const average = sum / numeric.length;
  const variance = numeric.reduce((total, value) => total + ((value - average) ** 2), 0) / numeric.length;
  const first = numeric[0];
  const last = numeric[numeric.length - 1];
  const slope = numeric.length > 1 ? (last - first) / (numeric.length - 1) : 0;

  return {
    currentValue: last,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    average,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    stddev: Math.sqrt(variance),
    sampleCount: numeric.length,
    slope,
    rateOfChange: first !== 0 ? (last - first) / Math.abs(first) : null,
  };
}

function getDatasourceUid(datasource) {
  if (!datasource) return null;
  if (typeof datasource === 'string') return datasource;
  return datasource.uid || datasource.name || datasource.type || null;
}

function deriveMetricName(panel) {
  const target = panel?.targets?.find((item) => item?.expr || item?.metric || item?.query || item?.refId) || {};

  return target.metric || target.expr || target.query || target.refId || panel?.title || 'unknown_metric';
}

function derivePanelAiFeatures({ dashboardUid, dashboardTitle, folderTitle, panel, panelOrder, dashboardUpdatedAt, dashboardTags = [] }) {
  const alertState = panel?.alert?.state || panel?.alertState || null;
  const threshold = findThreshold(panel);
  const metricName = deriveMetricName(panel);
  const recurrenceInputs = [dashboardUid, panel?.id, metricName, alertState, threshold]
    .filter(Boolean)
    .join('|');

  return {
    sourceTool: 'Grafana',
    sourceModule: 'panel',
    entityId: `${dashboardUid}:panel:${stablePanelId(panel, panelOrder - 1)}`,
    entityUid: panel?.uid || stablePanelId(panel, panelOrder - 1),
    entityName: panel?.title || `Panel ${panel?.id || panelOrder}`,
    dashboardUid,
    dashboardCategory: folderTitle || 'General',
    panelTitle: panel?.title || `Panel ${panel?.id || panelOrder}`,
    metricName,
    alertRuleState: alertState,
    threshold: threshold ? String(threshold) : null,
    severity: alertState && alertState !== 'ok' ? 'warning' : 'low',
    timestamp: dashboardUpdatedAt,
    recurrenceCount: recurrenceInputs ? 1 : 0,
    aiLabel: 'unknown',
    aiConfidence: null,
    aiReason: 'AI classification is not enabled yet. Features are prepared for later noise vs incident evaluation.',
    aiFeatures: {
      metricName,
      dashboardCategory: folderTitle || 'General',
      dashboardTitle,
      panelTitle: panel?.title || null,
      panelType: panel?.type || null,
      datasource: getPanelDatasource(panel),
      querySummary: getPanelQuerySummary(panel),
      alertRuleState: alertState,
      threshold,
      severity: alertState && alertState !== 'ok' ? 'warning' : 'low',
      tags: dashboardTags,
      panelOrder,
      hasTargets: Array.isArray(panel?.targets) && panel.targets.length > 0,
      dashboardChangePattern: 'last_synced_snapshot',
      frequencyOfRecurrence: recurrenceInputs ? 1 : 0,
    },
    computedFeatures: {
      metricVolatility: null,
      rollingMean: null,
      rollingMedian: null,
      rollingStddev: null,
      movingAverage: null,
      movingMax: null,
      movingMin: null,
      anomalyScorePlaceholder: null,
      slope: null,
      gradient: null,
      rateOfChange: null,
      thresholdDistance: null,
      thresholdCrossCount: 0,
      stateChangeCount: 0,
      timeSinceLastAlert: null,
      timeBetweenAlerts: null,
      averageAlertDuration: null,
      maximumAlertDuration: null,
      minimumAlertDuration: null,
      alertFrequency: 0,
      alertDensity: 0,
      recurrenceCount: recurrenceInputs ? 1 : 0,
      alertBurstCount: 0,
      flappingScore: 0,
      recoveryCount: 0,
      recoveryTime: null,
      alertStabilityScore: null,
      metricStabilityScore: null,
      panelHealthScore: alertState && alertState !== 'ok' ? 65 : 100,
      dashboardHealthScore: null,
      datasourceReliabilityScore: null,
    },
    correlationFeatures: {
      sharedDatasource: null,
      sharedAlertRules: 0,
      sharedTags: [],
      sharedFolders: null,
      temporalCorrelation: null,
      dependencyScore: null,
      potentialRootCauseScore: null,
      correlationConfidence: null,
    },
    rawPayload: panel || {},
  };
}

async function upsertGrafanaAiFeature(client, feature) {
  await client.query(
    `
      INSERT INTO grafana_ai_features (
        source_tool,
        source_module,
        entity_id,
        entity_uid,
        entity_name,
        dashboard_uid,
        dashboard_category,
        panel_title,
        metric_name,
        alert_rule_state,
        threshold,
        severity,
        timestamp,
        recurrence_count,
        ai_label,
        ai_confidence,
        ai_reason,
        ai_features,
        computed_features,
        correlation_features,
        prediction_placeholder,
        confidence_placeholder,
        explanation_placeholder,
        raw_payload,
        last_synced_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24::jsonb,NOW(),NOW())
      ON CONFLICT (source_tool, source_module, entity_id)
      DO UPDATE SET
        entity_uid = EXCLUDED.entity_uid,
        entity_name = EXCLUDED.entity_name,
        dashboard_uid = EXCLUDED.dashboard_uid,
        dashboard_category = EXCLUDED.dashboard_category,
        panel_title = EXCLUDED.panel_title,
        metric_name = EXCLUDED.metric_name,
        alert_rule_state = EXCLUDED.alert_rule_state,
        threshold = EXCLUDED.threshold,
        severity = EXCLUDED.severity,
        timestamp = EXCLUDED.timestamp,
        recurrence_count = EXCLUDED.recurrence_count,
        ai_label = EXCLUDED.ai_label,
        ai_confidence = EXCLUDED.ai_confidence,
        ai_reason = EXCLUDED.ai_reason,
        ai_features = EXCLUDED.ai_features,
        computed_features = EXCLUDED.computed_features,
        correlation_features = EXCLUDED.correlation_features,
        prediction_placeholder = EXCLUDED.prediction_placeholder,
        confidence_placeholder = EXCLUDED.confidence_placeholder,
        explanation_placeholder = EXCLUDED.explanation_placeholder,
        raw_payload = EXCLUDED.raw_payload,
        last_synced_at = NOW(),
        updated_at = NOW()
    `,
    [
      feature.sourceTool,
      feature.sourceModule,
      feature.entityId,
      feature.entityUid,
      feature.entityName,
      feature.dashboardUid,
      feature.dashboardCategory,
      feature.panelTitle,
      feature.metricName,
      feature.alertRuleState,
      feature.threshold,
      feature.severity,
      feature.timestamp,
      feature.recurrenceCount,
      feature.aiLabel,
      feature.aiConfidence,
      feature.aiReason,
      JSON.stringify(feature.aiFeatures || {}),
      JSON.stringify(feature.computedFeatures || {}),
      JSON.stringify(feature.correlationFeatures || {}),
      feature.predictionPlaceholder || 'future_model_not_enabled',
      feature.confidencePlaceholder ?? null,
      feature.explanationPlaceholder || 'Prediction placeholders are reserved for future AI models.',
      JSON.stringify(feature.rawPayload || {}),
    ],
  );
}

function getDashboardUpdatedAt(rowOrMeta) {
  const value = rowOrMeta?.updated || rowOrMeta?.updated_at || rowOrMeta?.last_synced_at;
  const date = value ? new Date(value) : null;

  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function mapDashboardRow(row) {
  const dashboard = row.dashboard_json || {};
  const meta = row.meta_json || {};
  const panels = getPanelMetadata(dashboard);
  const folderTitle = row.folder_title || meta.folderTitle || 'General';
  const folderUid = row.folder_uid || meta.folderUid || 'general';

  return {
    sourceTool: 'Grafana',
    source_tool: 'Grafana',
    uid: row.uid,
    dashboardId: row.dashboard_id,
    dashboardUid: row.uid,
    dashboard_uid: row.uid,
    dashboardName: row.title,
    dashboard_name: row.title,
    dashboardTitle: row.title,
    dashboard_title: row.title,
    dashboardSubname: folderTitle,
    dashboard_subname: folderTitle,
    applicationName: folderTitle,
    application_name: folderTitle,
    title: row.title,
    slug: row.slug,
    uri: row.uri,
    dashboardUrl: row.dashboard_url,
    deepLink: row.dashboard_url,
    deep_link: row.dashboard_url,
    folderUid,
    folder_uid: folderUid,
    folderTitle,
    folder_title: folderTitle,
    folderName: folderTitle,
    folder_name: folderTitle,
    tags: row.tags || [],
    refreshInterval: row.refresh_interval || dashboard.refresh || null,
    refresh_interval: row.refresh_interval || dashboard.refresh || null,
    description: row.description || dashboard.description || '',
    timezone: row.timezone || dashboard.timezone || '',
    editable: row.editable,
    version: row.version || dashboard.version,
    schemaVersion: row.schema_version || dashboard.schemaVersion,
    createdBy: row.created_by || meta.createdBy,
    updatedBy: row.updated_by || meta.updatedBy,
    grafanaCreatedAt: row.grafana_created_at || meta.created,
    grafanaUpdatedAt: row.grafana_updated_at || meta.updated,
    templatingVariables: row.templating_variables || dashboard.templating?.list || [],
    annotations: row.annotations || dashboard.annotations?.list || [],
    dashboardLinks: row.dashboard_links || dashboard.links || [],
    entityHash: row.entity_hash,
    type: row.dashboard_type,
    isStarred: row.is_starred,
    panelCount: panels.length || row.panel_count,
    panel_count: panels.length || row.panel_count,
    panelTitles: panels.map((panel) => panel.title),
    panel_titles: panels.map((panel) => panel.title),
    panels,
    datasourceNames: row.datasource_names || [],
    dashboard: row.dashboard_json,
    meta: row.meta_json,
    lastSyncedAt: row.last_synced_at,
    lastRefreshedAt: row.last_synced_at,
    last_refreshed_at: row.last_synced_at,
    lastUpdatedAt: getDashboardUpdatedAt(meta) || row.updated_at,
    last_updated_at: getDashboardUpdatedAt(meta) || row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rawPayload: {
      dashboard: row.dashboard_json,
      meta: row.meta_json,
    },
    raw_dashboard_json: row.dashboard_json,
  };
}

function normalizeSearchItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.dashboards)) {
    return payload.dashboards;
  }

  return [];
}

async function upsertFolder(client, baseUrl, folder = {}) {
  const uid = folder.uid || folder.folderUid || 'general';
  const title = folder.title || folder.folderTitle || 'General';
  const url = getAbsoluteUrl(baseUrl, folder.url);

  await client.query(
    `
      INSERT INTO grafana_folders (
        uid,
        folder_id,
        title,
        url,
        parent_uid,
        permissions,
        grafana_created_at,
        grafana_updated_at,
        raw_payload,
        last_synced_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz,$9::jsonb,NOW(),NOW())
      ON CONFLICT (uid)
      DO UPDATE SET
        folder_id = EXCLUDED.folder_id,
        title = EXCLUDED.title,
        url = EXCLUDED.url,
        parent_uid = EXCLUDED.parent_uid,
        permissions = EXCLUDED.permissions,
        grafana_created_at = EXCLUDED.grafana_created_at,
        grafana_updated_at = EXCLUDED.grafana_updated_at,
        raw_payload = EXCLUDED.raw_payload,
        last_synced_at = NOW(),
        updated_at = NOW()
    `,
    [
      uid,
      folder.id !== undefined && folder.id !== null ? String(folder.id) : null,
      title,
      url,
      folder.parentUid || folder.parentUID || folder.parent_uid || null,
      JSON.stringify(folder.permissions || []),
      toIsoTimestamp(folder.created || folder.createdAt),
      toIsoTimestamp(folder.updated || folder.updatedAt),
      JSON.stringify(folder || {}),
    ],
  );

  await archiveRawPayload(client, 'folder', uid, folder || {});
}

async function updateFolderCounts(client) {
  await client.query(`
    UPDATE grafana_folders folders
    SET
      dashboard_count = counts.dashboard_count,
      updated_at = NOW()
    FROM (
      SELECT COALESCE(NULLIF(folder_uid, ''), 'general') AS folder_uid, COUNT(*)::int AS dashboard_count
      FROM grafana_dashboards
      GROUP BY COALESCE(NULLIF(folder_uid, ''), 'general')
    ) counts
    WHERE folders.uid = counts.folder_uid
  `);
}

async function upsertPanels(client, dashboardContext) {
  const {
    dashboardUid,
    dashboardTitle,
    dashboardUrl,
    folderUid,
    folderTitle,
    dashboardUpdatedAt,
    dashboardTags,
    dashboard,
  } = dashboardContext;
  const panels = flattenPanels(dashboard?.panels || []).filter(isRenderablePanel);

  for (const [index, panel] of panels.entries()) {
    const panelId = stablePanelId(panel, index);
    const panelTitle = panel.title || `Panel ${panel.id || index + 1}`;
    const panelDeepLink = getPanelDeepLink(dashboardUrl, panel);
    const fieldDefaults = panel.fieldConfig?.defaults || {};
    const thresholds = fieldDefaults.thresholds?.steps || [];
    const overrides = panel.fieldConfig?.overrides || [];
    const expressions = (panel.targets || []).filter((target) => target.type === '__expr__' || target.datasource?.type === '__expr__');
    const legend = panel.options?.legend?.displayMode || panel.legend?.show;
    const colorScheme = fieldDefaults.color?.mode || panel.options?.colorMode || null;
    const displayMode = panel.options?.displayMode || panel.options?.legend?.displayMode || null;

    await client.query(
      `
        INSERT INTO grafana_panels (
          dashboard_uid,
          panel_id,
          panel_uid,
          panel_title,
          panel_description,
          panel_type,
          visualization_type,
          panel_order,
          folder_uid,
          folder_name,
          dashboard_title,
          datasource_name,
          datasource_uid,
          query_summary,
          queries,
          expressions,
          transformations,
          thresholds,
          overrides,
          field_config,
          legend,
          unit,
          decimals,
          color_scheme,
          display_mode,
          min_value,
          max_value,
          grid_pos,
          targets,
          tags,
          deep_link,
          raw_payload,
          last_synced_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30::jsonb,$31,$32::jsonb,NOW(),NOW())
        ON CONFLICT (dashboard_uid, panel_id)
        DO UPDATE SET
          panel_uid = EXCLUDED.panel_uid,
          panel_title = EXCLUDED.panel_title,
          panel_description = EXCLUDED.panel_description,
          panel_type = EXCLUDED.panel_type,
          visualization_type = EXCLUDED.visualization_type,
          panel_order = EXCLUDED.panel_order,
          folder_uid = EXCLUDED.folder_uid,
          folder_name = EXCLUDED.folder_name,
          dashboard_title = EXCLUDED.dashboard_title,
          datasource_name = EXCLUDED.datasource_name,
          datasource_uid = EXCLUDED.datasource_uid,
          query_summary = EXCLUDED.query_summary,
          queries = EXCLUDED.queries,
          expressions = EXCLUDED.expressions,
          transformations = EXCLUDED.transformations,
          thresholds = EXCLUDED.thresholds,
          overrides = EXCLUDED.overrides,
          field_config = EXCLUDED.field_config,
          legend = EXCLUDED.legend,
          unit = EXCLUDED.unit,
          decimals = EXCLUDED.decimals,
          color_scheme = EXCLUDED.color_scheme,
          display_mode = EXCLUDED.display_mode,
          min_value = EXCLUDED.min_value,
          max_value = EXCLUDED.max_value,
          grid_pos = EXCLUDED.grid_pos,
          targets = EXCLUDED.targets,
          tags = EXCLUDED.tags,
          deep_link = EXCLUDED.deep_link,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        dashboardUid,
        panelId,
        panel.uid || null,
        panelTitle,
        panel.description || null,
        panel.type || 'panel',
        panel.pluginVersion ? panel.type || 'panel' : panel.type || 'panel',
        index + 1,
        folderUid,
        folderTitle,
        dashboardTitle,
        getPanelDatasource(panel),
        getDatasourceUid(panel.datasource || panel.targets?.find((target) => target.datasource)?.datasource),
        getPanelQuerySummary(panel),
        JSON.stringify(panel.targets || []),
        JSON.stringify(expressions || []),
        JSON.stringify(panel.transformations || []),
        JSON.stringify(thresholds || []),
        JSON.stringify(overrides || []),
        JSON.stringify(panel.fieldConfig || {}),
        legend === undefined || legend === null ? null : String(legend),
        fieldDefaults.unit || null,
        Number.isFinite(Number(fieldDefaults.decimals)) ? Number(fieldDefaults.decimals) : null,
        colorScheme,
        displayMode,
        Number.isFinite(Number(fieldDefaults.min)) ? Number(fieldDefaults.min) : null,
        Number.isFinite(Number(fieldDefaults.max)) ? Number(fieldDefaults.max) : null,
        JSON.stringify(panel.gridPos || {}),
        JSON.stringify(panel.targets || []),
        JSON.stringify(dashboardTags || []),
        panelDeepLink,
        JSON.stringify(panel || {}),
      ],
    );

    await archiveRawPayload(client, 'panel', `${dashboardUid}:panel:${panelId}`, panel || {});

    await upsertGrafanaAiFeature(client, derivePanelAiFeatures({
      dashboardUid,
      dashboardTitle,
      folderTitle,
      panel,
      panelOrder: index + 1,
      dashboardUpdatedAt,
      dashboardTags,
    }));
  }

  if (panels.length) {
    const panelIds = panels.map((panel, index) => stablePanelId(panel, index));
    await client.query(
      `
        DELETE FROM grafana_panels
        WHERE dashboard_uid = $1
          AND NOT (panel_id = ANY($2::text[]))
      `,
      [dashboardUid, panelIds],
    );
  }
}

function getVariableDatasourceUid(variable) {
  const datasource = variable?.datasource;

  if (!datasource) return null;
  if (typeof datasource === 'string') return datasource;
  return datasource.uid || datasource.name || datasource.type || null;
}

async function upsertDashboardVariables(client, dashboardUid, variables = []) {
  for (const variable of variables) {
    const variableName = variable.name || variable.query || variable.label;

    if (!variableName) {
      continue;
    }

    await client.query(
      `
        INSERT INTO grafana_variables (
          dashboard_uid,
          variable_name,
          variable_type,
          datasource_uid,
          current_value,
          options,
          refresh_mode,
          raw_payload,
          last_synced_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,NOW(),NOW())
        ON CONFLICT (dashboard_uid, variable_name)
        DO UPDATE SET
          variable_type = EXCLUDED.variable_type,
          datasource_uid = EXCLUDED.datasource_uid,
          current_value = EXCLUDED.current_value,
          options = EXCLUDED.options,
          refresh_mode = EXCLUDED.refresh_mode,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        dashboardUid,
        variableName,
        variable.type || null,
        getVariableDatasourceUid(variable),
        JSON.stringify(variable.current || {}),
        JSON.stringify(variable.options || []),
        variable.refresh !== undefined ? String(variable.refresh) : null,
        JSON.stringify(variable || {}),
      ],
    );
  }
}

async function upsertDashboardAnnotations(client, dashboardUid, annotations = []) {
  for (const [index, annotation] of annotations.entries()) {
    const annotationId = annotation.id || `${dashboardUid}:annotation:${index + 1}`;

    await client.query(
      `
        INSERT INTO grafana_annotations (
          annotation_id,
          dashboard_uid,
          panel_id,
          text,
          tags,
          annotation_time,
          created_by,
          raw_payload,
          last_synced_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7,$8::jsonb,NOW(),NOW())
        ON CONFLICT (annotation_id)
        DO UPDATE SET
          dashboard_uid = EXCLUDED.dashboard_uid,
          panel_id = EXCLUDED.panel_id,
          text = EXCLUDED.text,
          tags = EXCLUDED.tags,
          annotation_time = EXCLUDED.annotation_time,
          created_by = EXCLUDED.created_by,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        String(annotationId),
        dashboardUid,
        annotation.panelId ? String(annotation.panelId) : null,
        annotation.text || annotation.name || annotation.title || '',
        JSON.stringify(annotation.tags || []),
        toIsoTimestamp(annotation.time || annotation.created),
        annotation.login || annotation.createdBy || null,
        JSON.stringify(annotation || {}),
      ],
    );
  }
}

async function upsertDashboard(client, baseUrl, item, detailPayload = {}) {
  const dashboard = detailPayload.dashboard || {};
  const meta = detailPayload.meta || {};
  const uid = item.uid || dashboard.uid;

  if (!uid) {
    return null;
  }

  const panels = flattenPanels(dashboard.panels || []);
  const panelMetadata = getPanelMetadata(dashboard);
  const datasourceNames = getDashboardDatasources(dashboard);
  const dashboardUrl = getAbsoluteUrl(baseUrl, meta.url || item.url);
  const dashboardTitle = dashboard.title || item.title || 'Untitled dashboard';
  const folderTitle = item.folderTitle || meta.folderTitle || 'General';
  const folderUid = item.folderUid || meta.folderUid || 'general';
  const dashboardUpdatedAt = getDashboardUpdatedAt(meta);
  const refreshInterval = dashboard.refresh || meta.refresh || null;
  const templatingVariables = dashboard.templating?.list || [];
  const dashboardAnnotations = dashboard.annotations?.list || [];
  const dashboardLinks = dashboard.links || [];
  const dashboardHash = hashPayload({ dashboard, meta });

  await upsertFolder(client, baseUrl, {
    ...item,
    uid: folderUid || 'general',
    title: folderTitle || 'General',
    url: meta.folderUrl || item.folderUrl || null,
  });

  const result = await client.query(
    `
      INSERT INTO grafana_dashboards (
        uid,
        dashboard_id,
        title,
        slug,
        uri,
        dashboard_url,
        folder_uid,
        folder_title,
        tags,
        refresh_interval,
        description,
        timezone,
        editable,
        version,
        schema_version,
        created_by,
        updated_by,
        grafana_created_at,
        grafana_updated_at,
        templating_variables,
        annotations,
        dashboard_links,
        dashboard_type,
        is_starred,
        panel_count,
        datasource_names,
        dashboard_json,
        meta_json,
        entity_hash,
        last_synced_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18::timestamptz,$19::timestamptz,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26::jsonb,$27::jsonb,$28::jsonb,$29,NOW(),NOW())
      ON CONFLICT (uid)
      DO UPDATE SET
        dashboard_id = EXCLUDED.dashboard_id,
        title = EXCLUDED.title,
        slug = EXCLUDED.slug,
        uri = EXCLUDED.uri,
        dashboard_url = EXCLUDED.dashboard_url,
        folder_uid = EXCLUDED.folder_uid,
        folder_title = EXCLUDED.folder_title,
        tags = EXCLUDED.tags,
        refresh_interval = EXCLUDED.refresh_interval,
        description = EXCLUDED.description,
        timezone = EXCLUDED.timezone,
        editable = EXCLUDED.editable,
        version = EXCLUDED.version,
        schema_version = EXCLUDED.schema_version,
        created_by = EXCLUDED.created_by,
        updated_by = EXCLUDED.updated_by,
        grafana_created_at = EXCLUDED.grafana_created_at,
        grafana_updated_at = EXCLUDED.grafana_updated_at,
        templating_variables = EXCLUDED.templating_variables,
        annotations = EXCLUDED.annotations,
        dashboard_links = EXCLUDED.dashboard_links,
        dashboard_type = EXCLUDED.dashboard_type,
        is_starred = EXCLUDED.is_starred,
        panel_count = EXCLUDED.panel_count,
        datasource_names = EXCLUDED.datasource_names,
        dashboard_json = EXCLUDED.dashboard_json,
        meta_json = EXCLUDED.meta_json,
        entity_hash = EXCLUDED.entity_hash,
        last_synced_at = NOW(),
        updated_at = NOW()
      RETURNING uid, (xmax = 0) AS inserted
    `,
    [
      uid,
      item.id !== undefined && item.id !== null ? String(item.id) : dashboard.id !== undefined && dashboard.id !== null ? String(dashboard.id) : null,
      dashboardTitle,
      item.slug || meta.slug || null,
      item.uri || null,
      dashboardUrl,
      folderUid,
      folderTitle,
      JSON.stringify(dashboard.tags || item.tags || []),
      refreshInterval,
      dashboard.description || null,
      dashboard.timezone || null,
      dashboard.editable === undefined ? null : Boolean(dashboard.editable),
      Number.isFinite(Number(dashboard.version)) ? Number(dashboard.version) : null,
      Number.isFinite(Number(dashboard.schemaVersion)) ? Number(dashboard.schemaVersion) : null,
      meta.createdBy || null,
      meta.updatedBy || null,
      toIsoTimestamp(meta.created),
      toIsoTimestamp(meta.updated),
      JSON.stringify(templatingVariables),
      JSON.stringify(dashboardAnnotations),
      JSON.stringify(dashboardLinks),
      item.type || 'dash-db',
      Boolean(item.isStarred || meta.isStarred),
      panelMetadata.length || panels.length,
      JSON.stringify(datasourceNames),
      JSON.stringify(dashboard || {}),
      JSON.stringify(meta || {}),
      dashboardHash,
    ],
  );

  await client.query(
    `
      INSERT INTO monitoring_dashboards (
        source_tool,
        application_name,
        dashboard_name,
        dashboard_subname,
        dashboard_uid,
        panel_count,
        panel_titles,
        last_updated_at,
        last_refreshed_at,
        deep_link,
        raw_payload,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,NOW(),$9,$10::jsonb,NOW())
      ON CONFLICT (source_tool, dashboard_uid)
      DO UPDATE SET
        application_name = EXCLUDED.application_name,
        dashboard_name = EXCLUDED.dashboard_name,
        dashboard_subname = EXCLUDED.dashboard_subname,
        panel_count = EXCLUDED.panel_count,
        panel_titles = EXCLUDED.panel_titles,
        last_updated_at = EXCLUDED.last_updated_at,
        last_refreshed_at = NOW(),
        deep_link = EXCLUDED.deep_link,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `,
    [
      'Grafana',
      folderTitle,
      dashboardTitle,
      folderTitle,
      uid,
      panelMetadata.length || panels.length,
      JSON.stringify(panelMetadata.map((panel) => panel.title)),
      dashboardUpdatedAt,
      dashboardUrl,
      JSON.stringify({ dashboard: dashboard || {}, meta: meta || {} }),
    ],
  );

  await archiveRawPayload(client, 'dashboard', uid, { dashboard: dashboard || {}, meta: meta || {} });
  await upsertDashboardVariables(client, uid, templatingVariables);
  await upsertDashboardAnnotations(client, uid, dashboardAnnotations);
  await upsertPanels(client, {
    dashboardUid: uid,
    dashboardTitle,
    dashboardUrl,
    folderUid,
    folderTitle,
    dashboardUpdatedAt,
    dashboardTags: dashboard.tags || item.tags || [],
    dashboard,
  });

  return result.rows[0];
}

function normalizeAlertRuleItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const rules = [];

  if (payload && typeof payload === 'object') {
    Object.entries(payload).forEach(([namespace, groups]) => {
      (Array.isArray(groups) ? groups : []).forEach((group) => {
        (group.rules || []).forEach((rule) => {
          rules.push({
            ...rule,
            namespace,
            groupName: group.name,
            folderTitle: namespace,
          });
        });
      });
    });
  }

  return rules;
}

function normalizeAlertStateItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.alerts)) {
    return payload.alerts;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

function getRuleUid(rule) {
  return rule.uid || rule.id || rule.alert || rule.fingerprint || rule.title || rule.name;
}

function getRuleTitle(rule) {
  return rule.title || rule.name || rule.alert || rule.annotations?.summary || 'Untitled alert rule';
}

function getRuleDashboardUid(rule) {
  return rule.dashboardUid || rule.dashboardUID || rule.annotations?.__dashboardUid__ || rule.labels?.dashboard_uid || null;
}

function getRulePanelId(rule) {
  return rule.panelId || rule.panelID || rule.annotations?.__panelId__ || rule.labels?.panel_id || null;
}

function getRuleSeverity(rule) {
  return rule.labels?.severity || rule.labels?.priority || rule.severity || (rule.state && rule.state !== 'normal' ? 'warning' : 'low');
}

function getRuleThreshold(rule) {
  return rule.condition
    || rule.threshold
    || rule.annotations?.threshold
    || rule.labels?.threshold
    || null;
}

async function upsertAlertRule(client, rule) {
  const uid = String(getRuleUid(rule) || '').trim();

  if (!uid) {
    return false;
  }

  const title = getRuleTitle(rule);
  const dashboardUid = getRuleDashboardUid(rule);
  const panelId = getRulePanelId(rule);
  const feature = {
    sourceTool: 'Grafana',
    sourceModule: 'alert_rule',
    entityId: uid,
    entityUid: uid,
    entityName: title,
    dashboardUid,
    dashboardCategory: rule.folderTitle || rule.namespace || 'Grafana alerts',
    panelTitle: panelId ? `Panel ${panelId}` : null,
    metricName: title,
    alertRuleState: rule.state || rule.execErrState || null,
    threshold: rule.condition || null,
    severity: getRuleSeverity(rule),
    timestamp: toIsoTimestamp(rule.updated || rule.updatedAt || rule.created || rule.createdAt),
    recurrenceCount: 1,
    aiLabel: 'unknown',
    aiConfidence: null,
    aiReason: 'AI classification is not enabled yet. Grafana alert rule features are stored for later evaluation.',
    aiFeatures: {
      metricName: title,
      dashboardCategory: rule.folderTitle || rule.namespace || 'Grafana alerts',
      panelTitle: panelId ? `Panel ${panelId}` : null,
      alertRuleState: rule.state || rule.execErrState || null,
      threshold: rule.condition || null,
      severity: getRuleSeverity(rule),
      labels: rule.labels || {},
      annotations: rule.annotations || {},
      frequencyOfRecurrence: 1,
      dashboardChangePattern: 'alert_rule_snapshot',
    },
    rawPayload: rule,
  };

  await client.query(
    `
      INSERT INTO grafana_alert_rules (
        uid,
        rule_id,
        title,
        folder_uid,
        folder_name,
        dashboard_uid,
        panel_id,
        condition,
        threshold,
        reducer,
        operator,
        state,
        severity,
        health,
        no_data_state,
        exec_error_state,
        rule_group,
        evaluation_interval,
        summary,
        description,
        last_evaluation_at,
        next_evaluation_at,
        silenced,
        paused,
        labels,
        annotations,
        data,
        deep_link,
        raw_payload,
        last_synced_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::timestamptz,$22::timestamptz,$23,$24,$25::jsonb,$26::jsonb,$27::jsonb,$28,$29::jsonb,NOW(),NOW())
      ON CONFLICT (uid)
      DO UPDATE SET
        rule_id = EXCLUDED.rule_id,
        title = EXCLUDED.title,
        folder_uid = EXCLUDED.folder_uid,
        folder_name = EXCLUDED.folder_name,
        dashboard_uid = EXCLUDED.dashboard_uid,
        panel_id = EXCLUDED.panel_id,
        condition = EXCLUDED.condition,
        threshold = EXCLUDED.threshold,
        reducer = EXCLUDED.reducer,
        operator = EXCLUDED.operator,
        state = EXCLUDED.state,
        severity = EXCLUDED.severity,
        health = EXCLUDED.health,
        no_data_state = EXCLUDED.no_data_state,
        exec_error_state = EXCLUDED.exec_error_state,
        rule_group = EXCLUDED.rule_group,
        evaluation_interval = EXCLUDED.evaluation_interval,
        summary = EXCLUDED.summary,
        description = EXCLUDED.description,
        last_evaluation_at = EXCLUDED.last_evaluation_at,
        next_evaluation_at = EXCLUDED.next_evaluation_at,
        silenced = EXCLUDED.silenced,
        paused = EXCLUDED.paused,
        labels = EXCLUDED.labels,
        annotations = EXCLUDED.annotations,
        data = EXCLUDED.data,
        deep_link = EXCLUDED.deep_link,
        raw_payload = EXCLUDED.raw_payload,
        last_synced_at = NOW(),
        updated_at = NOW()
    `,
    [
      uid,
      rule.id ? String(rule.id) : null,
      title,
      rule.folderUid || rule.namespace || null,
      rule.folderTitle || rule.namespace || null,
      dashboardUid,
      panelId ? String(panelId) : null,
      rule.condition || null,
      getRuleThreshold(rule),
      rule.reducer || rule.reduce || null,
      rule.operator || rule.evaluator?.type || null,
      rule.state || rule.execErrState || null,
      getRuleSeverity(rule),
      rule.health || null,
      rule.noDataState || rule.no_data_state || null,
      rule.execErrState || rule.executionErrorState || null,
      rule.groupName || rule.ruleGroup || null,
      rule.interval || rule.evaluateEvery || rule.for || null,
      rule.annotations?.summary || rule.summary || null,
      rule.annotations?.description || rule.description || null,
      toIsoTimestamp(rule.lastEvaluation || rule.lastEvaluationTime || rule.updated),
      toIsoTimestamp(rule.nextEvaluation || rule.nextEvaluationTime),
      Boolean(rule.silenced || rule.muted),
      Boolean(rule.isPaused || rule.paused),
      JSON.stringify(rule.labels || {}),
      JSON.stringify(rule.annotations || {}),
      JSON.stringify(rule.data || []),
      rule.url || rule.annotations?.runbook_url || null,
      JSON.stringify(rule || {}),
    ],
  );

  await archiveRawPayload(client, 'alert_rule', uid, rule || {});
  await upsertGrafanaAiFeature(client, feature);

  return true;
}

async function upsertAlertState(client, alert) {
  const labels = alert.labels || {};
  const annotations = alert.annotations || {};
  const fingerprint = alert.fingerprint
    || labels.alertname
    || labels.rule_uid
    || `${labels.grafana_folder || 'grafana'}:${annotations.summary || alert.status?.state || Date.now()}`;
  const ruleUid = labels.rule_uid || labels.alert_rule_uid || annotations.__alertRuleUid__ || null;
  const state = alert.status?.state || alert.state || alert.status || 'unknown';
  const severity = labels.severity || labels.priority || (state === 'active' || state === 'firing' ? 'warning' : 'low');
  const previous = await client.query(
    'SELECT state FROM grafana_alert_states WHERE fingerprint = $1',
    [String(fingerprint)],
  );
  const previousState = previous.rows[0]?.state || null;
  const startsAt = toIsoTimestamp(alert.startsAt || alert.starts_at);
  const endsAt = toIsoTimestamp(alert.endsAt || alert.ends_at);

  await client.query(
    `
      INSERT INTO grafana_alert_states (
        fingerprint,
        rule_uid,
        rule_title,
        state,
        severity,
        starts_at,
        ends_at,
        labels,
        annotations,
        deep_link,
        raw_payload,
        last_synced_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::jsonb,$9::jsonb,$10,$11::jsonb,NOW(),NOW())
      ON CONFLICT (fingerprint)
      DO UPDATE SET
        rule_uid = EXCLUDED.rule_uid,
        rule_title = EXCLUDED.rule_title,
        state = EXCLUDED.state,
        severity = EXCLUDED.severity,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        labels = EXCLUDED.labels,
        annotations = EXCLUDED.annotations,
        deep_link = EXCLUDED.deep_link,
        raw_payload = EXCLUDED.raw_payload,
        last_synced_at = NOW(),
        updated_at = NOW()
    `,
    [
      String(fingerprint),
      ruleUid,
      labels.alertname || annotations.summary || alert.generatorURL || 'Grafana alert',
      state,
      severity,
      startsAt,
      endsAt,
      JSON.stringify(labels || {}),
      JSON.stringify(annotations || {}),
      alert.generatorURL || alert.url || null,
      JSON.stringify(alert || {}),
    ],
  );

  if (previousState !== state) {
    await client.query(
      `
        INSERT INTO grafana_alert_state_history (
          fingerprint,
          rule_uid,
          rule_title,
          previous_state,
          state,
          severity,
          transitioned_at,
          starts_at,
          ends_at,
          raw_payload
        )
        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW()),$8::timestamptz,$9::timestamptz,$10::jsonb)
      `,
      [
        String(fingerprint),
        ruleUid,
        labels.alertname || annotations.summary || alert.generatorURL || 'Grafana alert',
        previousState,
        state,
        severity,
        startsAt || new Date().toISOString(),
        startsAt,
        endsAt,
        JSON.stringify(alert || {}),
      ],
    );
  }

  await archiveRawPayload(client, 'alert_state', String(fingerprint), alert || {});
}

async function syncAlertRulesAndStates(config) {
  await ensureGrafanaDashboardStorage();
  const runtimeConfig = config || await getGrafanaRuntimeConfig();
  const summary = {
    alertRulesFetched: 0,
    alertRulesStored: 0,
    alertStatesFetched: 0,
    alertStatesStored: 0,
    warnings: [],
  };
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    try {
      const rulesResponse = await fetchGrafanaJson(
        buildGrafanaUrl(runtimeConfig.baseUrl, '/api/v1/provisioning/alert-rules'),
        runtimeConfig.token,
      );
      const rules = normalizeAlertRuleItems(rulesResponse.payload);
      summary.alertRulesFetched = rules.length;

      for (const rule of rules) {
        if (await upsertAlertRule(client, rule)) {
          summary.alertRulesStored += 1;
        }
      }
    } catch (error) {
      summary.warnings.push(`Alert rules unavailable: ${error.message}`);
    }

    if (!summary.alertRulesStored) {
      try {
        const rulerResponse = await fetchGrafanaJson(
          buildGrafanaUrl(runtimeConfig.baseUrl, '/api/ruler/grafana/api/v1/rules'),
          runtimeConfig.token,
        );
        const rulerRules = normalizeAlertRuleItems(rulerResponse.payload);
        summary.alertRulesFetched = Math.max(summary.alertRulesFetched, rulerRules.length);

        for (const rule of rulerRules) {
          if (await upsertAlertRule(client, rule)) {
            summary.alertRulesStored += 1;
          }
        }
      } catch (error) {
        summary.warnings.push(`Ruler alert rules unavailable: ${error.message}`);
      }
    }

    try {
      const alertResponse = await fetchGrafanaJson(
        buildGrafanaUrl(runtimeConfig.baseUrl, '/api/alertmanager/grafana/api/v2/alerts'),
        runtimeConfig.token,
      );
      const alerts = normalizeAlertStateItems(alertResponse.payload);
      summary.alertStatesFetched = alerts.length;

      for (const alert of alerts) {
        await upsertAlertState(client, alert);
        summary.alertStatesStored += 1;
      }
    } catch (error) {
      summary.warnings.push(`Alert states unavailable: ${error.message}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return summary;
}

async function upsertDatasource(client, datasource) {
  const uid = datasource.uid || datasource.name || datasource.id;

  if (!uid) {
    return false;
  }

  await client.query(
    `
      INSERT INTO grafana_datasources (
        uid,
        datasource_id,
        name,
        type,
        url,
        access,
        is_default,
        json_data,
        raw_payload,
        last_synced_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,NOW(),NOW())
      ON CONFLICT (uid)
      DO UPDATE SET
        datasource_id = EXCLUDED.datasource_id,
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        url = EXCLUDED.url,
        access = EXCLUDED.access,
        is_default = EXCLUDED.is_default,
        json_data = EXCLUDED.json_data,
        raw_payload = EXCLUDED.raw_payload,
        last_synced_at = NOW(),
        updated_at = NOW()
    `,
    [
      String(uid),
      datasource.id !== undefined && datasource.id !== null ? String(datasource.id) : null,
      datasource.name || String(uid),
      datasource.type || null,
      datasource.url || null,
      datasource.access || null,
      datasource.isDefault === undefined ? null : Boolean(datasource.isDefault),
      JSON.stringify(datasource.jsonData || {}),
      JSON.stringify(datasource || {}),
    ],
  );

  await archiveRawPayload(client, 'datasource', String(uid), datasource || {});

  return true;
}

async function syncDatasources(config, client) {
  try {
    const response = await fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/datasources'), config.token);
    const datasources = Array.isArray(response.payload) ? response.payload : [];
    let stored = 0;

    for (const datasource of datasources) {
      if (await upsertDatasource(client, datasource)) {
        stored += 1;
      }
    }

    return { fetched: datasources.length, stored };
  } catch (error) {
    return { fetched: 0, stored: 0, warning: `Datasources unavailable: ${error.message}` };
  }
}

async function syncGrafanaAnnotations(config, client, options = {}) {
  try {
    const from = grafanaTimeToEpochMs(options.from || 'now-24h');
    const to = grafanaTimeToEpochMs(options.to || 'now');
    const response = await fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/annotations', {
      from,
      to,
      limit: options.annotationLimit || 1000,
    }), config.token);
    const annotations = Array.isArray(response.payload) ? response.payload : [];

    for (const annotation of annotations) {
      const annotationId = annotation.id || `${annotation.dashboardUID || annotation.dashboardId || 'global'}:${annotation.time || Date.now()}`;
      await client.query(
        `
          INSERT INTO grafana_annotations (
            annotation_id,
            dashboard_uid,
            panel_id,
            text,
            tags,
            annotation_time,
            created_by,
            raw_payload,
            last_synced_at,
            updated_at
          )
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7,$8::jsonb,NOW(),NOW())
          ON CONFLICT (annotation_id)
          DO UPDATE SET
            dashboard_uid = EXCLUDED.dashboard_uid,
            panel_id = EXCLUDED.panel_id,
            text = EXCLUDED.text,
            tags = EXCLUDED.tags,
            annotation_time = EXCLUDED.annotation_time,
            created_by = EXCLUDED.created_by,
            raw_payload = EXCLUDED.raw_payload,
            last_synced_at = NOW(),
            updated_at = NOW()
        `,
        [
          String(annotationId),
          annotation.dashboardUID || annotation.dashboardUid || null,
          annotation.panelId ? String(annotation.panelId) : null,
          annotation.text || '',
          JSON.stringify(annotation.tags || []),
          annotation.time ? new Date(Number(annotation.time)).toISOString() : toIsoTimestamp(annotation.created),
          annotation.login || annotation.createdBy || null,
          JSON.stringify(annotation || {}),
        ],
      );
      await archiveRawPayload(client, 'annotation', String(annotationId), annotation || {});
    }

    return { fetched: annotations.length, stored: annotations.length };
  } catch (error) {
    return { fetched: 0, stored: 0, warning: `Annotations unavailable: ${error.message}` };
  }
}

function buildPanelQueryTargets(panel, from, to) {
  const datasource = panel.datasource || panel.targets?.find((target) => target.datasource)?.datasource;
  const targets = (panel.targets || []).filter((target) => !target.hide && target.datasource?.type !== '__expr__');

  return targets.map((target, index) => ({
    ...target,
    refId: target.refId || String.fromCharCode(65 + index),
    datasource: target.datasource || datasource,
    intervalMs: target.intervalMs || 60000,
    maxDataPoints: target.maxDataPoints || 600,
    queryType: target.queryType,
  })).filter((target) => target.datasource && (target.expr || target.query || target.rawSql || target.metric || target.target || target.refId));
}

function extractFrameMetricPoints(frame, fallback = {}) {
  const fields = frame?.schema?.fields || [];
  const values = frame?.data?.values || [];
  const timeIndex = fields.findIndex((field) => field.type === 'time' || /time/i.test(field.name || ''));
  const points = [];

  fields.forEach((field, fieldIndex) => {
    if (fieldIndex === timeIndex || field.type === 'time') {
      return;
    }

    const fieldValues = values[fieldIndex] || [];
    const timeValues = timeIndex >= 0 ? values[timeIndex] || [] : [];
    const labels = field.labels || frame.schema?.meta?.custom || {};
    const seriesName = field.config?.displayNameFromDS || field.name || fallback.seriesName || fallback.metricName || 'series';
    const unit = field.config?.unit || fallback.unit || null;

    fieldValues.forEach((value, valueIndex) => {
      const numeric = Number(value);

      if (!Number.isFinite(numeric)) {
        return;
      }

      const rawTimestamp = timeValues[valueIndex] || Date.now();
      const timestamp = Number.isFinite(Number(rawTimestamp))
        ? new Date(Number(rawTimestamp)).toISOString()
        : toIsoTimestamp(rawTimestamp);

      if (!timestamp) {
        return;
      }

      points.push({
        seriesName,
        metricName: fallback.metricName || seriesName,
        labels,
        timestamp,
        value: numeric,
        valueType: field.type || 'number',
        unit,
        rawPayload: {
          field,
          value,
          timestamp: rawTimestamp,
        },
      });
    });
  });

  return points;
}

function extractMetricPointsFromQueryResponse(payload, panel, dashboardUid, panelIndex = 0) {
  const points = [];
  const results = payload?.results || {};

  Object.entries(results).forEach(([refId, result]) => {
    (result.frames || []).forEach((frame) => {
      points.push(...extractFrameMetricPoints(frame, {
        seriesName: frame.schema?.name || refId,
        metricName: deriveMetricName(panel),
        unit: panel.fieldConfig?.defaults?.unit,
      }));
    });
  });

  return points.map((point) => ({
    ...point,
    dashboardUid,
    panelId: stablePanelId(panel, panelIndex),
    datasourceUid: getDatasourceUid(panel.datasource || panel.targets?.find((target) => target.datasource)?.datasource),
  }));
}

async function storePanelMetricPoints(client, dashboardUid, panel, points, rawPayload, panelIndex = 0) {
  const panelId = stablePanelId(panel, panelIndex);
  const grouped = new Map();

  for (const point of points) {
    await client.query(
      `
        INSERT INTO grafana_panel_metric_points (
          dashboard_uid,
          panel_id,
          datasource_uid,
          series_name,
          metric_name,
          metric_labels,
          metric_timestamp,
          value,
          value_type,
          unit,
          raw_payload
        )
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8,$9,$10,$11::jsonb)
        ON CONFLICT (dashboard_uid, panel_id, series_name, metric_name, metric_timestamp)
        DO UPDATE SET
          datasource_uid = EXCLUDED.datasource_uid,
          metric_labels = EXCLUDED.metric_labels,
          value = EXCLUDED.value,
          value_type = EXCLUDED.value_type,
          unit = EXCLUDED.unit,
          raw_payload = EXCLUDED.raw_payload
      `,
      [
        dashboardUid,
        panelId,
        point.datasourceUid,
        point.seriesName,
        point.metricName,
        JSON.stringify(point.labels || {}),
        point.timestamp,
        point.value,
        point.valueType,
        point.unit,
        JSON.stringify(point.rawPayload || {}),
      ],
    );

    const key = `${point.seriesName}::${point.metricName}`;
    grouped.set(key, [...(grouped.get(key) || []), point]);
  }

  let latestStats = null;

  for (const [key, groupPoints] of grouped.entries()) {
    const [seriesName, metricName] = key.split('::');
    const ordered = groupPoints.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
    const stats = computeNumericStats(ordered);
    latestStats = latestStats || stats;

    await client.query(
      `
        INSERT INTO grafana_panel_metric_summaries (
          dashboard_uid,
          panel_id,
          series_name,
          metric_name,
          datasource_uid,
          current_value,
          min_value,
          max_value,
          average_value,
          median_value,
          p95_value,
          p99_value,
          stddev_value,
          sample_count,
          first_timestamp,
          last_timestamp,
          raw_payload,
          last_synced_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17::jsonb,NOW(),NOW())
        ON CONFLICT (dashboard_uid, panel_id, series_name, metric_name)
        DO UPDATE SET
          datasource_uid = EXCLUDED.datasource_uid,
          current_value = EXCLUDED.current_value,
          min_value = EXCLUDED.min_value,
          max_value = EXCLUDED.max_value,
          average_value = EXCLUDED.average_value,
          median_value = EXCLUDED.median_value,
          p95_value = EXCLUDED.p95_value,
          p99_value = EXCLUDED.p99_value,
          stddev_value = EXCLUDED.stddev_value,
          sample_count = EXCLUDED.sample_count,
          first_timestamp = EXCLUDED.first_timestamp,
          last_timestamp = EXCLUDED.last_timestamp,
          raw_payload = EXCLUDED.raw_payload,
          last_synced_at = NOW(),
          updated_at = NOW()
      `,
      [
        dashboardUid,
        panelId,
        seriesName,
        metricName,
        groupPoints[0]?.datasourceUid || null,
        stats.currentValue,
        stats.min,
        stats.max,
        stats.average,
        stats.median,
        stats.p95,
        stats.p99,
        stats.stddev,
        stats.sampleCount,
        ordered[0]?.timestamp || null,
        ordered.at(-1)?.timestamp || null,
        JSON.stringify(rawPayload || {}),
      ],
    );
  }

  if (latestStats) {
    await client.query(
      `
        UPDATE grafana_panels
        SET current_value = $3, metric_stats = $4::jsonb, updated_at = NOW()
        WHERE dashboard_uid = $1 AND panel_id = $2
      `,
      [
        dashboardUid,
        panelId,
        latestStats.currentValue,
        JSON.stringify(latestStats),
      ],
    );
  }

  return { points: points.length, series: grouped.size };
}

async function collectPanelMetrics(client, config, dashboardUid, dashboard, options = {}) {
  const panels = flattenPanels(dashboard?.panels || []).filter(isRenderablePanel);
  const from = options.from || 'now-6h';
  const to = options.to || 'now';
  const panelLimit = options.metricPanelLimit ?? METRIC_PANEL_LIMIT;
  const limitedPanels = panels.slice(0, Math.max(0, Number(panelLimit)));
  const summary = {
    panelsAttempted: 0,
    panelsWithMetrics: 0,
    metricPointsStored: 0,
    metricSeriesStored: 0,
    warnings: [],
  };

  for (const [panelIndex, panel] of limitedPanels.entries()) {
    const queries = buildPanelQueryTargets(panel, from, to);

    if (!queries.length) {
      continue;
    }

    summary.panelsAttempted += 1;

    try {
      const response = await fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/ds/query'), config.token, {
        method: 'POST',
        body: {
          queries,
          from,
          to,
        },
      });
      const points = extractMetricPointsFromQueryResponse(response.payload, panel, dashboardUid, panelIndex);
      const stored = await storePanelMetricPoints(client, dashboardUid, panel, points, response.payload, panelIndex);

      await archiveRawPayload(client, 'panel_metric_response', `${dashboardUid}:panel:${stablePanelId(panel, panelIndex)}`, response.payload || {});

      summary.panelsWithMetrics += stored.points ? 1 : 0;
      summary.metricPointsStored += stored.points;
      summary.metricSeriesStored += stored.series;
    } catch (error) {
      summary.warnings.push(`Panel ${panel.title || panel.id} metrics unavailable: ${error.message}`);
    }
  }

  return summary;
}

async function shouldFetchDashboardDetail(client, item, options = {}) {
  if (options.force || options.fullRefresh || options.incremental === false) {
    return true;
  }

  const uid = item.uid;

  if (!uid) {
    return false;
  }

  const result = await client.query(
    `
      SELECT
        dashboards.uid,
        dashboards.version,
        dashboards.grafana_updated_at,
        dashboards.entity_hash,
        COUNT(panels.id)::int AS panel_rows
      FROM grafana_dashboards dashboards
      LEFT JOIN grafana_panels panels ON panels.dashboard_uid = dashboards.uid
      WHERE dashboards.uid = $1
      GROUP BY dashboards.uid, dashboards.version, dashboards.grafana_updated_at, dashboards.entity_hash
    `,
    [uid],
  );
  const row = result.rows[0];

  if (!row || !row.entity_hash || Number(row.panel_rows || 0) === 0) {
    return true;
  }

  if (item.version && Number(item.version) !== Number(row.version)) {
    return true;
  }

  const itemUpdated = toIsoTimestamp(item.updated || item.updatedAt);
  const rowUpdated = toIsoTimestamp(row.grafana_updated_at);

  if (itemUpdated && rowUpdated && new Date(itemUpdated) > new Date(rowUpdated)) {
    return true;
  }

  return false;
}

async function computeDashboardCorrelations(client, dashboardUid) {
  const result = await client.query(
    `
      SELECT
        panel_id,
        panel_title,
        datasource_uid,
        folder_uid,
        tags,
        metric_stats
      FROM grafana_panels
      WHERE dashboard_uid = $1
      ORDER BY panel_order
      LIMIT 100
    `,
    [dashboardUid],
  );
  const panels = result.rows;
  let stored = 0;

  for (let leftIndex = 0; leftIndex < panels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < panels.length; rightIndex += 1) {
      const left = panels[leftIndex];
      const right = panels[rightIndex];
      const leftTags = new Set(left.tags || []);
      const sharedTags = (right.tags || []).filter((tag) => leftTags.has(tag));
      const sharedDatasource = Boolean(left.datasource_uid && right.datasource_uid && left.datasource_uid === right.datasource_uid);
      const sharedFolder = Boolean(left.folder_uid && right.folder_uid && left.folder_uid === right.folder_uid);
      const leftCurrent = Number(left.metric_stats?.currentValue ?? left.metric_stats?.current_value);
      const rightCurrent = Number(right.metric_stats?.currentValue ?? right.metric_stats?.current_value);
      const temporalCorrelation = Number.isFinite(leftCurrent) && Number.isFinite(rightCurrent)
        ? Math.max(-1, Math.min(1, (Math.sign(leftCurrent) === Math.sign(rightCurrent) ? 0.5 : -0.2)))
        : null;
      const dependencyScore = Number(([
        sharedDatasource ? 0.35 : 0,
        sharedFolder ? 0.25 : 0,
        sharedTags.length ? 0.25 : 0,
        temporalCorrelation !== null ? 0.15 : 0,
      ].reduce((sum, value) => sum + value, 0)).toFixed(2));
      const confidence = Number(Math.min(0.95, 0.3 + dependencyScore).toFixed(2));

      if (!sharedDatasource && !sharedFolder && !sharedTags.length && temporalCorrelation === null) {
        continue;
      }

      await client.query(
        `
          INSERT INTO grafana_correlation_features (
            entity_a,
            entity_b,
            dashboard_uid_a,
            dashboard_uid_b,
            correlation_scope,
            shared_datasource,
            shared_tags,
            shared_folder,
            temporal_correlation,
            dependency_score,
            potential_root_cause_score,
            correlation_confidence,
            correlation_features,
            feature_timestamp,
            updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,NOW(),NOW())
          ON CONFLICT (source_tool, entity_a, entity_b, correlation_scope)
          DO UPDATE SET
            shared_datasource = EXCLUDED.shared_datasource,
            shared_tags = EXCLUDED.shared_tags,
            shared_folder = EXCLUDED.shared_folder,
            temporal_correlation = EXCLUDED.temporal_correlation,
            dependency_score = EXCLUDED.dependency_score,
            potential_root_cause_score = EXCLUDED.potential_root_cause_score,
            correlation_confidence = EXCLUDED.correlation_confidence,
            correlation_features = EXCLUDED.correlation_features,
            feature_timestamp = NOW(),
            updated_at = NOW()
        `,
        [
          `${dashboardUid}:panel:${left.panel_id}`,
          `${dashboardUid}:panel:${right.panel_id}`,
          dashboardUid,
          dashboardUid,
          'dashboard_panels',
          sharedDatasource,
          JSON.stringify(sharedTags),
          sharedFolder,
          temporalCorrelation,
          dependencyScore,
          dependencyScore,
          confidence,
          JSON.stringify({
            leftPanel: left.panel_title,
            rightPanel: right.panel_title,
            sharedDatasource,
            sharedTags,
            sharedFolder,
            temporalCorrelation,
            dependencyScore,
            potentialRootCauseScore: dependencyScore,
            correlationConfidence: confidence,
          }),
        ],
      );
      stored += 1;
    }
  }

  return stored;
}

async function syncDashboards(options = {}) {
  await ensureGrafanaDashboardStorage();
  const config = await getGrafanaRuntimeConfig();
  const syncLogId = await startSyncLog('grafana_dashboard_sync', {
    query: options.query || '',
    limit: options.limit || 500,
    from: options.from || 'now-6h',
    to: options.to || 'now',
    incremental: options.incremental !== false,
    collectMetrics: options.collectMetrics !== false,
    metricPanelLimit: options.metricPanelLimit ?? METRIC_PANEL_LIMIT,
  });
  const limit = Math.min(Number(options.limit || 500), 2000);
  const query = options.query || '';
  const searchUrl = buildGrafanaUrl(config.baseUrl, '/api/search', {
    type: 'dash-db',
    limit,
    query,
  });
  let folders = [];

  try {
    const folderResponse = await fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/folders'), config.token);
    folders = Array.isArray(folderResponse.payload) ? folderResponse.payload : [];
  } catch {
    folders = [];
  }

  const searchResponse = await fetchGrafanaJson(searchUrl, config.token);
  const items = normalizeSearchItems(searchResponse.payload);
  const summary = {
    fetched: items.length,
    foldersFetched: folders.length,
    datasourcesFetched: 0,
    datasourcesStored: 0,
    annotationsFetched: 0,
    annotationsStored: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    skippedUnchanged: 0,
    metricPanelsAttempted: 0,
    metricPanelsWithMetrics: 0,
    metricPointsStored: 0,
    metricSeriesStored: 0,
    correlationFeaturesStored: 0,
    responseTimeMs: searchResponse.responseTimeMs,
    dashboards: [],
    alertRulesFetched: 0,
    alertRulesStored: 0,
    alertStatesFetched: 0,
    alertStatesStored: 0,
    warnings: [],
  };
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    const datasourceSummary = await syncDatasources(config, client);
    summary.datasourcesFetched = datasourceSummary.fetched;
    summary.datasourcesStored = datasourceSummary.stored;
    if (datasourceSummary.warning) {
      summary.warnings.push(datasourceSummary.warning);
    }

    const annotationSummary = await syncGrafanaAnnotations(config, client, options);
    summary.annotationsFetched = annotationSummary.fetched;
    summary.annotationsStored = annotationSummary.stored;
    if (annotationSummary.warning) {
      summary.warnings.push(annotationSummary.warning);
    }

    await upsertFolder(client, config.baseUrl, { uid: 'general', title: 'General' });

    for (const folder of folders) {
      await upsertFolder(client, config.baseUrl, folder);
    }

    await client.query("DELETE FROM grafana_folders WHERE raw_payload->>'type' = 'dash-db'");

    for (const item of items) {
      if (!item.uid) {
        summary.skipped += 1;
        continue;
      }

      if (!(await shouldFetchDashboardDetail(client, item, options))) {
        summary.skippedUnchanged += 1;
        summary.skipped += 1;
        summary.dashboards.push(item.uid);
        if (options.collectMetrics !== false) {
          const cachedDashboard = await client.query('SELECT dashboard_json FROM grafana_dashboards WHERE uid = $1', [item.uid]);
          const metricSummary = await collectPanelMetrics(client, config, item.uid, cachedDashboard.rows[0]?.dashboard_json || {}, options);
          summary.metricPanelsAttempted += metricSummary.panelsAttempted;
          summary.metricPanelsWithMetrics += metricSummary.panelsWithMetrics;
          summary.metricPointsStored += metricSummary.metricPointsStored;
          summary.metricSeriesStored += metricSummary.metricSeriesStored;
          summary.warnings.push(...metricSummary.warnings);
        }
        summary.correlationFeaturesStored += await computeDashboardCorrelations(client, item.uid);
        continue;
      }

      let detailPayload = {};
      try {
        const detailUrl = buildGrafanaUrl(config.baseUrl, `/api/dashboards/uid/${encodeURIComponent(item.uid)}`);
        const detailResponse = await fetchGrafanaJson(detailUrl, config.token);
        detailPayload = detailResponse.payload || {};
        summary.responseTimeMs = Math.max(summary.responseTimeMs || 0, detailResponse.responseTimeMs || 0);
      } catch {
        detailPayload = {
          dashboard: {
            uid: item.uid,
            id: item.id,
            title: item.title,
            tags: item.tags || [],
            panels: [],
          },
          meta: {
            url: item.url,
            folderUid: item.folderUid,
            folderTitle: item.folderTitle,
          },
        };
      }

      const row = await upsertDashboard(client, config.baseUrl, item, detailPayload);

      if (!row) {
        summary.skipped += 1;
        continue;
      }

      if (row.inserted) {
        summary.inserted += 1;
      } else {
        summary.updated += 1;
      }

      summary.dashboards.push(row.uid);

      if (options.collectMetrics !== false) {
        const metricSummary = await collectPanelMetrics(client, config, row.uid, detailPayload.dashboard || {}, options);
        summary.metricPanelsAttempted += metricSummary.panelsAttempted;
        summary.metricPanelsWithMetrics += metricSummary.panelsWithMetrics;
        summary.metricPointsStored += metricSummary.metricPointsStored;
        summary.metricSeriesStored += metricSummary.metricSeriesStored;
        summary.warnings.push(...metricSummary.warnings);
      }

      summary.correlationFeaturesStored += await computeDashboardCorrelations(client, row.uid);
    }

    await updateFolderCounts(client);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await finishSyncLog(syncLogId, 'failed', {
      counts: summary,
      warnings: summary.warnings,
      errorMessage: error.message,
    });
    throw error;
  } finally {
    client.release();
  }

  try {
    const alertSummary = await syncAlertRulesAndStates(config);
    summary.alertRulesFetched = alertSummary.alertRulesFetched;
    summary.alertRulesStored = alertSummary.alertRulesStored;
    summary.alertStatesFetched = alertSummary.alertStatesFetched;
    summary.alertStatesStored = alertSummary.alertStatesStored;
    summary.warnings.push(...(alertSummary.warnings || []));
  } catch (error) {
    summary.warnings.push(`Grafana alert metadata sync failed: ${error.message}`);
  }

  await finishSyncLog(syncLogId, 'success', {
    counts: summary,
    warnings: summary.warnings,
    rawPayload: {
      dashboards: summary.dashboards,
    },
  });

  return {
    ...summary,
    message: `Grafana sync complete: ${summary.foldersFetched} folders, ${summary.fetched} dashboards discovered, ${summary.inserted} new, ${summary.updated} updated, ${summary.skippedUnchanged} unchanged, ${summary.alertRulesStored} alert rules, ${summary.alertStatesStored} alert states, ${summary.metricPointsStored} metric points.`,
  };
}

function workspaceBoolean(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function workspacePage(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function workspacePageSize(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return WORKSPACE_PAGE_SIZE;
  }

  return Math.min(parsed, WORKSPACE_MAX_PAGE_SIZE);
}

function workspaceSearch(value) {
  return String(value || '').trim().slice(0, 200);
}

function workspaceDashboardSort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['name-asc', 'name-desc', 'updated-desc'].includes(normalized) ? normalized : 'name-asc';
}

function sortWorkspaceDashboards(dashboards, sort) {
  return [...dashboards].sort((left, right) => {
    if (sort === 'updated-desc') {
      const timestampDifference = (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
      if (timestampDifference) return timestampDifference;
    }

    const nameComparison = String(left.title || '').localeCompare(String(right.title || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return sort === 'name-desc' ? -nameComparison : nameComparison;
  });
}

function workspaceRenderRange(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return WORKSPACE_RENDER_RANGES.has(normalized) ? normalized : '1h';
}

function workspaceRenderDimension(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

function workspaceRenderTimezone(value) {
  const timezone = String(value || 'UTC').trim();
  return /^[A-Za-z0-9_+./-]{1,80}$/.test(timezone) ? timezone : 'UTC';
}

function workspaceRenderVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => /^[A-Za-z0-9_.-]{1,80}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof item))
      .slice(0, 20)
      .map(([key, item]) => [`var-${key}`, String(item).slice(0, 200)]),
  );
}

function workspaceAbortError() {
  const error = new Error('Grafana panel render was cancelled.');
  error.name = 'AbortError';
  return error;
}

function drainGrafanaPanelRenderQueue() {
  while (activeGrafanaPanelRenders < WORKSPACE_PANEL_RENDER_CONCURRENCY && grafanaPanelRenderQueue.length) {
    const item = grafanaPanelRenderQueue.shift();

    if (item.signal?.aborted) {
      item.reject(workspaceAbortError());
      continue;
    }

    activeGrafanaPanelRenders += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeGrafanaPanelRenders -= 1;
        drainGrafanaPanelRenderQueue();
      });
  }
}

function withGrafanaPanelRenderSlot(task, signal) {
  return new Promise((resolve, reject) => {
    grafanaPanelRenderQueue.push({ reject, resolve, signal, task });
    drainGrafanaPanelRenderQueue();
  });
}

function getCachedGrafanaPanelRender(key) {
  const cached = grafanaPanelRenderCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    grafanaPanelRenderCache.delete(key);
    return null;
  }
  return cached.value;
}

function cacheGrafanaPanelRender(key, value) {
  while (grafanaPanelRenderCache.size >= WORKSPACE_PANEL_RENDER_CACHE_LIMIT) {
    grafanaPanelRenderCache.delete(grafanaPanelRenderCache.keys().next().value);
  }
  grafanaPanelRenderCache.set(key, { expiresAt: Date.now() + WORKSPACE_PANEL_RENDER_CACHE_MS, value });
}

function workspaceMetadataObject(value, allowedKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => (
        (!allowedKeys || allowedKeys.includes(key))
        && item !== null
        && item !== undefined
        && item !== ''
        && (
          ['string', 'number', 'boolean'].includes(typeof item)
          || (Array.isArray(item) && item.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry)))
        )
      ))
      .slice(0, 50),
  );
}

function workspaceGrafanaLink(baseUrl, value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, `${normalizeBaseUrl(baseUrl)}/`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function workspaceCached(key, ttlMs, refresh, loader) {
  const existing = grafanaWorkspaceCache.get(key);
  const now = Date.now();

  if (!refresh && existing?.value && existing.expiresAt > now) {
    return existing.value;
  }

  if (!refresh && existing?.promise) {
    return existing.promise;
  }

  const pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      grafanaWorkspaceCache.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
      return value;
    })
    .catch((error) => {
      grafanaWorkspaceCache.delete(key);
      throw error;
    });

  grafanaWorkspaceCache.set(key, { promise: pending });
  return pending;
}

function clearGrafanaWorkspaceCache() {
  grafanaWorkspaceCache.clear();
  grafanaPanelRenderCache.clear();
}

async function getGrafanaWorkspaceConfig() {
  return getGrafanaRuntimeConfig({ requireEnvironment: true });
}

function normalizedGrafanaHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function workspaceCanonical(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function getGrafanaWorkspaceSourceIdentity() {
  const config = await getGrafanaWorkspaceConfig();
  return {
    host: normalizedGrafanaHost(config.baseUrl),
    credentialSource: config.source,
    readOnly: true,
  };
}

function parseGrafanaStateHistoryFrames(payload = {}) {
  const frames = Object.values(payload?.results || {}).flatMap((result) => result?.frames || []);
  const events = [];

  frames.forEach((frame) => {
    const fields = frame?.schema?.fields || [];
    const values = frame?.data?.values || [];
    const timeIndex = fields.findIndex((field) => field?.type === 'time' || /time/i.test(field?.name || ''));
    const lineIndex = fields.findIndex((field) => /line|body|message/i.test(field?.name || ''));
    const rowCount = Math.max(...values.map((column) => Array.isArray(column) ? column.length : 0), 0);

    for (let index = 0; index < rowCount; index += 1) {
      let record = {};
      const rawLine = lineIndex >= 0 ? values[lineIndex]?.[index] : null;
      if (typeof rawLine === 'string') {
        try { record = JSON.parse(rawLine); } catch { record = {}; }
      } else if (rawLine && typeof rawLine === 'object') {
        record = rawLine;
      }
      fields.forEach((field, fieldIndex) => {
        const value = values[fieldIndex]?.[index];
        if (value !== undefined && value !== null && field?.name && !/line|body|message/i.test(field.name)) {
          record[field.name] ??= value;
        }
      });
      const timestamp = toIsoTimestamp(record.timestamp || record.time || record.Time
        || (timeIndex >= 0 ? values[timeIndex]?.[index] : null));
      const ruleUid = record.ruleUID || record.ruleUid || record.rule_uid || null;
      const current = record.current || record.state || null;
      if (!timestamp || !ruleUid || !current) continue;
      let labels = record.labels || {};
      let valuesObject = record.values || {};
      try { if (typeof labels === 'string') labels = JSON.parse(labels); } catch { labels = {}; }
      try { if (typeof valuesObject === 'string') valuesObject = JSON.parse(valuesObject); } catch { valuesObject = {}; }
      events.push({
        timestamp,
        ruleUid: String(ruleUid),
        ruleId: record.ruleID || record.ruleId || null,
        ruleName: record.ruleTitle || record.alertname || labels.alertname || null,
        previousState: record.previous || null,
        state: String(current),
        condition: record.condition || null,
        dashboardUid: record.dashboardUID || record.dashboardUid || labels.__dashboardUid__ || null,
        panelId: record.panelID || record.panelId || labels.__panelId__ || null,
        fingerprint: record.fingerprint || null,
        labels: labels && typeof labels === 'object' ? labels : {},
        values: valuesObject && typeof valuesObject === 'object' ? valuesObject : {},
        schemaVersion: record.schemaVersion || null,
      });
    }
  });

  return events.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

function parseGrafanaStateHistoryLoki(payload = {}) {
  const streams = Array.isArray(payload?.data?.result) ? payload.data.result : [];
  const events = [];

  streams.forEach((stream) => {
    const streamLabels = stream?.stream && typeof stream.stream === 'object' ? stream.stream : {};
    (Array.isArray(stream?.values) ? stream.values : []).forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return;
      let record = {};
      try { record = typeof entry[1] === 'string' ? JSON.parse(entry[1]) : entry[1] || {}; } catch { record = {}; }
      const nanoseconds = String(entry[0] || '');
      const timestamp = toIsoTimestamp(record.timestamp || record.time || record.Time
        || (/^\d{13,}$/.test(nanoseconds) ? Number(BigInt(nanoseconds) / 1000000n) : nanoseconds));
      const ruleUid = record.ruleUID || record.ruleUid || record.rule_uid || streamLabels.ruleUID || null;
      const current = record.current || record.state || null;
      if (!timestamp || !ruleUid || !current) return;
      let labels = record.labels || {};
      let valuesObject = record.values || {};
      try { if (typeof labels === 'string') labels = JSON.parse(labels); } catch { labels = {}; }
      try { if (typeof valuesObject === 'string') valuesObject = JSON.parse(valuesObject); } catch { valuesObject = {}; }
      events.push({
        timestamp,
        ruleUid: String(ruleUid),
        ruleId: record.ruleID || record.ruleId || null,
        ruleName: record.ruleTitle || record.alertname || labels.alertname || null,
        previousState: record.previous || null,
        state: String(current),
        condition: record.condition || null,
        dashboardUid: record.dashboardUID || record.dashboardUid || labels.__dashboardUid__ || null,
        panelId: record.panelID || record.panelId || labels.__panelId__ || null,
        fingerprint: record.fingerprint || null,
        labels: labels && typeof labels === 'object' ? labels : {},
        values: valuesObject && typeof valuesObject === 'object' ? valuesObject : {},
        schemaVersion: record.schemaVersion || null,
      });
    });
  });

  return events.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

async function getGrafanaStateHistoryDatasource(config, refresh = false) {
  return workspaceCached('workspace:state-history-datasource', WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    // The Argus architecture has one verified lifecycle source. Keep this UID
    // explicit so the read token can be scoped to exactly this datasource and
    // can never be sent through another datasource proxy.
    return {
      uid: GRAFANA_ALERT_STATE_HISTORY_DATASOURCE_UID,
      name: 'grafanacloud-argus9000-alert-state-history',
      type: 'loki',
    };
  });
}

async function getGrafanaWorkspaceAlertStateHistory(ruleUid, options = {}) {
  const normalizedRuleUid = String(ruleUid || '').trim();
  if (!/^[a-zA-Z0-9_-]{3,160}$/.test(normalizedRuleUid)) {
    const error = new Error('A valid Grafana rule UID is required for state-history lookup.');
    error.status = 400;
    error.code = 'INVALID_GRAFANA_RULE_UID';
    throw error;
  }
  const config = await getGrafanaWorkspaceConfig();
  const configuredHost = normalizedGrafanaHost(config.baseUrl);
  const requestedHost = normalizedGrafanaHost(options.sourceUrl);
  if (requestedHost && configuredHost && requestedHost !== configuredHost) {
    const error = new Error('The exact Grafana alert belongs to a Grafana instance that is not configured in this backend.');
    error.status = 503;
    error.code = 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED';
    throw error;
  }
  const from = new Date(options.from || Date.now() - 2 * 60 * 60 * 1000).getTime();
  const to = new Date(options.to || Date.now()).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    const error = new Error('A valid bounded Grafana state-history time window is required.');
    error.status = 400;
    error.code = 'INVALID_GRAFANA_STATE_HISTORY_WINDOW';
    throw error;
  }
  const datasource = await getGrafanaStateHistoryDatasource(config, Boolean(options.refresh));
  const escapedRuleUid = normalizedRuleUid.replace(/[\\"]/g, '\\$&');
  const normalizedFingerprint = String(options.fingerprint || '').trim();
  const escapedFingerprint = normalizedFingerprint.replace(/[\\"]/g, '\\$&');
  const expression = `{from="state-history"} | json | ruleUID="${escapedRuleUid}"${
    escapedFingerprint ? ` | fingerprint="${escapedFingerprint}"` : ''
  }`;
  const response = await fetchGrafanaJson(buildGrafanaUrl(
    config.baseUrl,
    `/api/datasources/proxy/uid/${encodeURIComponent(datasource.uid)}/loki/api/v1/query_range`,
    {
      query: expression,
      start: String(BigInt(Math.trunc(from)) * 1000000n),
      end: String(BigInt(Math.trunc(to)) * 1000000n),
      limit: Math.min(1000, Math.max(50, Number(options.limit || 500))),
      direction: 'forward',
    },
  ), config.token, {
    timeoutMs: Number(process.env.GRAFANA_STATE_HISTORY_TIMEOUT_MS || 25000),
  });
  const items = parseGrafanaStateHistoryLoki(response.payload)
    .filter((item) => item.ruleUid === normalizedRuleUid
      && (!normalizedFingerprint || item.fingerprint === normalizedFingerprint)
      && new Date(item.timestamp).getTime() >= from && new Date(item.timestamp).getTime() <= to);
  return {
    items,
    total: items.length,
    datasource: { name: datasource.name, type: datasource.type, uid: datasource.uid },
    queriedAt: new Date().toISOString(),
    queryWindow: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    readOnly: true,
  };
}

async function getGrafanaWorkspaceStatus(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const refresh = workspaceBoolean(options.refresh);

  return workspaceCached('workspace:status', WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    const response = await fetchGrafanaJson(
      buildGrafanaUrl(config.baseUrl, '/api/health'),
      config.token,
    );
    const checkedAt = new Date().toISOString();

    return {
      configured: true,
      connected: true,
      authenticated: true,
      credentialSource: config.source,
      encryptedFallbackUsed: false,
      readOnly: true,
      version: response.payload?.version || null,
      lastUpdated: checkedAt,
      responseTimeMs: response.responseTimeMs,
    };
  });
}

function mapWorkspaceDashboard(item, config, detail = null) {
  const dashboard = detail?.dashboard || {};
  const meta = detail?.meta || {};
  const tags = dashboard.tags || item.tags || [];

  return {
    id: dashboard.id ?? item.id ?? null,
    uid: dashboard.uid || item.uid || null,
    title: dashboard.title || item.title || 'Untitled dashboard',
    folderUid: meta.folderUid || item.folderUid || null,
    folderTitle: meta.folderTitle || item.folderTitle || 'General',
    tags: Array.isArray(tags) ? tags.map(String) : [],
    url: workspaceGrafanaLink(config.baseUrl, meta.url || item.url),
    createdAt: toIsoTimestamp(meta.created || item.created),
    updatedAt: toIsoTimestamp(meta.updated || item.updated),
  };
}

async function getWorkspaceDashboardInventory(config, refresh = false) {
  return workspaceCached('workspace:dashboard-inventory', WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    const response = await fetchGrafanaJson(
      buildGrafanaUrl(config.baseUrl, '/api/search', {
        type: 'dash-db',
        limit: WORKSPACE_DASHBOARD_COUNT_LIMIT,
        page: 1,
      }),
      config.token,
    );

    return normalizeSearchItems(response.payload).map((item) => mapWorkspaceDashboard(item, config));
  });
}

function dashboardMatchesFilters(dashboard, filters) {
  const search = workspaceSearch(filters.search).toLowerCase();
  const tag = workspaceSearch(filters.tag).toLowerCase();
  const folderUid = workspaceSearch(filters.folderUid);

  if (folderUid && folderUid !== 'all') {
    if (folderUid === 'general') {
      if (dashboard.folderUid) return false;
    } else if (dashboard.folderUid !== folderUid) {
      return false;
    }
  }

  if (tag && !dashboard.tags.some((item) => String(item).toLowerCase() === tag)) {
    return false;
  }

  if (!search) return true;

  return [dashboard.title, dashboard.uid, dashboard.folderTitle, ...(dashboard.tags || [])]
    .some((value) => String(value || '').toLowerCase().includes(search));
}

async function listGrafanaWorkspaceDashboards(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const page = workspacePage(options.page);
  const pageSize = workspacePageSize(options.pageSize);
  const search = workspaceSearch(options.search);
  const folderUid = workspaceSearch(options.folderUid);
  const tag = workspaceSearch(options.tag);
  const sort = workspaceDashboardSort(options.sort);
  const refresh = workspaceBoolean(options.refresh);
  const inventory = await getWorkspaceDashboardInventory(config, refresh);
  const matching = sortWorkspaceDashboards(
    inventory.filter((item) => dashboardMatchesFilters(item, { folderUid, search, tag })),
    sort,
  );
  const start = (page - 1) * pageSize;
  const items = matching.slice(start, start + pageSize);
  const total = matching.length;

  return {
    items,
    lastUpdated: new Date().toISOString(),
    sort,
    pagination: {
      page,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      pageSize,
      total,
      hasNext: page * pageSize < total,
      hasPrevious: page > 1,
    },
    readOnly: true,
  };
}

async function getWorkspaceFolderInventory(config, refresh = false) {
  return workspaceCached('workspace:folder-inventory', WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    const response = await fetchGrafanaJson(
      buildGrafanaUrl(config.baseUrl, '/api/folders', {
        limit: WORKSPACE_DASHBOARD_COUNT_LIMIT,
        page: 1,
      }),
      config.token,
    );
    const folders = Array.isArray(response.payload) ? response.payload : [];
    const dashboards = await getWorkspaceDashboardInventory(config, refresh);

    return folders.map((folder) => ({
      uid: folder.uid || folder.id || null,
      title: folder.title || folder.name || 'Untitled folder',
      url: workspaceGrafanaLink(config.baseUrl, folder.url),
      dashboardCount: dashboards.filter((item) => item.folderUid === folder.uid).length,
    }));
  });
}

async function listGrafanaWorkspaceFolders(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const page = workspacePage(options.page);
  const pageSize = workspacePageSize(options.pageSize);
  const search = workspaceSearch(options.search).toLowerCase();
  const refresh = workspaceBoolean(options.refresh);
  const allFolders = await getWorkspaceFolderInventory(config, refresh);
  const matching = search
    ? allFolders.filter((folder) => [folder.title, folder.uid].some((value) => String(value || '').toLowerCase().includes(search)))
    : allFolders;
  const offset = (page - 1) * pageSize;

  return {
    items: matching.slice(offset, offset + pageSize),
    lastUpdated: new Date().toISOString(),
    pagination: {
      page,
      pageCount: Math.max(1, Math.ceil(matching.length / pageSize)),
      pageSize,
      total: matching.length,
      hasNext: offset + pageSize < matching.length,
      hasPrevious: page > 1,
    },
    readOnly: true,
  };
}

function getRuleDatasources(rule) {
  const datasources = new Map();

  (Array.isArray(rule.data) ? rule.data : []).forEach((query) => {
    const datasource = query.datasourceUid || query.model?.datasource?.uid || null;
    const type = query.model?.datasource?.type || query.queryType || null;

    if (datasource && !['__expr__', '-100'].includes(String(datasource))) {
      datasources.set(String(datasource), {
        type,
        uid: String(datasource),
      });
    }
  });

  return [...datasources.values()];
}

function getRuleThresholds(rule) {
  const thresholds = [];

  (Array.isArray(rule.data) ? rule.data : []).forEach((query) => {
    const conditions = Array.isArray(query.model?.conditions) ? query.model.conditions : [];

    conditions.forEach((condition) => {
      const values = Array.isArray(condition.evaluator?.params)
        ? condition.evaluator.params.filter((value) => value !== null && value !== undefined && value !== '')
        : [];

      if (condition.evaluator?.type || values.length) {
        thresholds.push({
          evaluator: condition.evaluator?.type || null,
          refId: query.refId || null,
          values,
        });
      }
    });
  });

  return thresholds;
}

function getRuleAnnotations(rule) {
  return workspaceMetadataObject(rule.annotations, [
    'summary',
    'description',
    'runbook',
    'runbook_url',
    'runbookUrl',
    'service',
    'environment',
    'team',
    '__dashboardUid__',
    '__panelId__',
  ]);
}

function mapWorkspaceRule(rule, context = {}, includeTechnical = false) {
  const uid = getRuleUid(rule);
  const dashboardUid = getRuleDashboardUid(rule);
  const panelId = getRulePanelId(rule);
  const folderUid = rule.folderUID || rule.folderUid || rule.namespace || null;
  const folder = context.folders?.find((item) => item.uid === folderUid) || null;
  const dashboard = context.dashboards?.find((item) => item.uid === dashboardUid) || null;
  const datasources = getRuleDatasources(rule);
  const thresholds = getRuleThresholds(rule);
  const technicalDetails = includeTechnical
    ? (Array.isArray(rule.data) ? rule.data : []).slice(0, 25).map((query) => ({
        refId: query.refId || null,
        queryType: query.queryType || null,
        datasourceUid: query.datasourceUid || query.model?.datasource?.uid || null,
        datasourceType: query.model?.datasource?.type || null,
        modelType: query.model?.type || null,
        relativeTimeRange: query.relativeTimeRange || null,
        expression: query.model?.datasource?.type === '__expr__' ? query.model?.expression || query.model?.expr || null : null,
      }))
    : undefined;

  return {
    uid: uid ? String(uid) : null,
    url: uid && context.config?.baseUrl
      ? buildGrafanaUrl(context.config.baseUrl, `/alerting/grafana/${encodeURIComponent(String(uid))}/view`)
      : null,
    title: getRuleTitle(rule),
    folderUid,
    folderTitle: folder?.title || rule.folderTitle || rule.namespace || null,
    ruleGroup: rule.ruleGroup || rule.groupName || null,
    condition: rule.condition || null,
    duration: rule.for || null,
    noDataState: rule.noDataState || rule.no_data_state || null,
    errorState: rule.execErrState || rule.executionErrorState || null,
    paused: typeof rule.isPaused === 'boolean' ? rule.isPaused : null,
    datasources,
    thresholds,
    labels: workspaceMetadataObject(rule.labels),
    annotations: getRuleAnnotations(rule),
    updatedAt: toIsoTimestamp(rule.updated || rule.updatedAt),
    dashboard: dashboardUid ? {
      panelId: panelId ? String(panelId) : null,
      title: dashboard?.title || null,
      uid: dashboardUid,
      url: dashboard?.url || null,
    } : null,
    ...(includeTechnical ? { technicalDetails } : {}),
  };
}

async function getWorkspaceRuleInventory(config, refresh = false) {
  return workspaceCached('workspace:rule-inventory', WORKSPACE_RULE_CACHE_MS, refresh, async () => {
    const response = await fetchGrafanaJson(
      buildGrafanaUrl(config.baseUrl, '/api/v1/provisioning/alert-rules'),
      config.token,
    );
    return normalizeAlertRuleItems(response.payload);
  });
}

async function workspaceRuleContext(config, refresh = false) {
  const [folders, dashboards] = await Promise.all([
    getWorkspaceFolderInventory(config, refresh),
    getWorkspaceDashboardInventory(config, refresh),
  ]);
  return { config, dashboards, folders };
}

async function listGrafanaWorkspaceAlertRules(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const page = workspacePage(options.page);
  const pageSize = workspacePageSize(options.pageSize);
  const search = workspaceSearch(options.search).toLowerCase();
  const folderUid = workspaceSearch(options.folderUid);
  const refresh = workspaceBoolean(options.refresh);
  const [rawRules, context] = await Promise.all([
    getWorkspaceRuleInventory(config, refresh),
    workspaceRuleContext(config, refresh),
  ]);
  const rules = rawRules.map((rule) => mapWorkspaceRule(rule, context));
  const matching = rules.filter((rule) => {
    if (folderUid && folderUid !== 'all' && rule.folderUid !== folderUid) return false;
    if (!search) return true;
    return [rule.title, rule.uid, rule.folderTitle, rule.ruleGroup]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });
  const offset = (page - 1) * pageSize;

  return {
    items: matching.slice(offset, offset + pageSize),
    lastUpdated: new Date().toISOString(),
    pagination: {
      page,
      pageCount: Math.max(1, Math.ceil(matching.length / pageSize)),
      pageSize,
      total: matching.length,
      hasNext: offset + pageSize < matching.length,
      hasPrevious: page > 1,
    },
    readOnly: true,
  };
}

async function getGrafanaWorkspaceRuleEvidenceInventory(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const refresh = workspaceBoolean(options.refresh);
  const [rawRules, context] = await Promise.all([
    getWorkspaceRuleInventory(config, refresh),
    workspaceRuleContext(config, refresh),
  ]);
  const rules = rawRules.map((rule) => mapWorkspaceRule(rule, context, true));
  return {
    host: normalizedGrafanaHost(config.baseUrl),
    rules,
    folders: (context.folders || []).map((folder) => ({ uid: folder.uid, title: folder.title })),
    dashboards: (context.dashboards || []).map((dashboard) => ({
      uid: dashboard.uid,
      title: dashboard.title,
      folderUid: dashboard.folderUid || null,
      folderTitle: dashboard.folderTitle || null,
      url: dashboard.url || null,
    })),
    counts: {
      folders: (context.folders || []).length,
      dashboards: (context.dashboards || []).length,
      rules: rules.length,
    },
    generatedAt: new Date().toISOString(),
    readOnly: true,
  };
}

async function getGrafanaWorkspaceAlertRule(uid, options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const refresh = workspaceBoolean(options.refresh);
  const [rawRules, context] = await Promise.all([
    getWorkspaceRuleInventory(config, refresh),
    workspaceRuleContext(config, refresh),
  ]);
  const rule = rawRules.find((item) => String(getRuleUid(item)) === String(uid));

  if (!rule) {
    const error = new Error(`Grafana alert rule ${uid} was not found.`);
    error.status = 404;
    throw error;
  }

  return {
    ...mapWorkspaceRule(rule, context, true),
    readOnly: true,
  };
}

function mapWorkspaceActiveAlert(alert, config) {
  const labels = workspaceMetadataObject(alert.labels);
  const annotations = workspaceMetadataObject(alert.annotations, [
    'summary',
    'description',
    'runbook',
    'runbook_url',
    'runbookUrl',
    'service',
    'environment',
    'team',
    '__dashboardUid__',
    '__panelId__',
  ]);

  return {
    fingerprint: alert.fingerprint || null,
    rule: labels.alertname || alert.ruleName || null,
    state: alert.status?.state || alert.state || null,
    labels,
    annotations,
    value: alert.value ?? alert.values ?? null,
    activeSince: toIsoTimestamp(alert.startsAt),
    endsAt: toIsoTimestamp(alert.endsAt),
    sourceUrl: workspaceGrafanaLink(config.baseUrl, alert.generatorURL || alert.url),
  };
}

async function getGrafanaWorkspaceActiveAlerts(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const pageSize = workspacePageSize(options.pageSize || WORKSPACE_MAX_PAGE_SIZE);
  const response = await fetchGrafanaJson(
    buildGrafanaUrl(config.baseUrl, '/api/alertmanager/grafana/api/v2/alerts', {
      active: true,
      inhibited: false,
      silenced: false,
    }),
    config.token,
  );
  const alerts = normalizeAlertStateItems(response.payload).map((alert) => mapWorkspaceActiveAlert(alert, config));

  return {
    items: alerts.slice(0, pageSize),
    total: alerts.length,
    lastChecked: new Date().toISOString(),
    readOnly: true,
  };
}

async function getGrafanaWorkspaceAlertingReadCapabilities() {
  const config = await getGrafanaWorkspaceConfig();
  const endpoints = {
    fixedAlertingRulesReader: '/api/prometheus/grafana/api/v1/rules',
    fixedAlertingInstancesReader: '/api/alertmanager/grafana/api/v2/alerts',
    alertProvisioningRead: '/api/v1/provisioning/alert-rules',
  };
  const reads = await Promise.all(Object.entries(endpoints).map(async ([permission, endpoint]) => {
    try {
      await fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, endpoint), config.token);
      return [permission, { available: true, endpoint, method: 'GET', httpStatus: 200 }];
    } catch (error) {
      return [permission, {
        available: false, endpoint, method: 'GET',
        httpStatus: Number(error?.responseStatus || 0) || null,
      }];
    }
  }));
  return {
    ...Object.fromEntries(reads),
    datasourceQuery: {
      datasourceUid: GRAFANA_ALERT_STATE_HISTORY_DATASOURCE_UID,
      method: 'GET',
      exclusivelyScoped: true,
    },
    readOnly: true,
  };
}

function workspaceObjectList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function safeContactPoint(contactPoint = {}) {
  return {
    uid: contactPoint.uid || contactPoint.id || null,
    name: contactPoint.name || null,
    type: contactPoint.type || null,
    disableResolveMessage: typeof contactPoint.disableResolveMessage === 'boolean'
      ? contactPoint.disableResolveMessage : null,
    provenance: contactPoint.provenance || null,
  };
}

function safeMuteTiming(timing = {}) {
  return {
    name: timing.name || null,
    timeIntervals: Array.isArray(timing.time_intervals) ? timing.time_intervals.slice(0, 20)
      : Array.isArray(timing.timeIntervals) ? timing.timeIntervals.slice(0, 20) : [],
    provenance: timing.provenance || null,
  };
}

function matcherMatchesLabels(matcher = {}, labels = {}) {
  const name = matcher.name || matcher.label || null;
  if (!name) return false;
  const actual = String(labels[name] ?? '');
  const expected = String(matcher.value ?? '');
  let matched = false;
  try {
    matched = matcher.isRegex || matcher.is_regex ? new RegExp(expected).test(actual) : actual === expected;
  } catch {
    matched = false;
  }
  return matcher.isEqual === false || matcher.is_equal === false ? !matched : matched;
}

function silenceOverlapsWindow(silence = {}, from, to) {
  const startsAt = new Date(silence.startsAt || silence.starts_at || 0).getTime();
  const endsAt = new Date(silence.endsAt || silence.ends_at || 0).getTime();
  return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= to && endsAt >= from;
}

function mapWorkspaceSilence(silence = {}) {
  return {
    id: silence.id || null,
    matchers: (silence.matchers || []).slice(0, 30).map((matcher) => ({
      name: matcher.name || matcher.label || null,
      value: matcher.value ?? null,
      isRegex: Boolean(matcher.isRegex || matcher.is_regex),
      isEqual: matcher.isEqual !== false && matcher.is_equal !== false,
    })),
    status: silence.status?.state || silence.status || null,
    createdAt: toIsoTimestamp(silence.createdAt || silence.created_at),
    startsAt: toIsoTimestamp(silence.startsAt || silence.starts_at),
    endsAt: toIsoTimestamp(silence.endsAt || silence.ends_at),
    createdBy: silence.createdBy || silence.created_by || null,
    comment: silence.comment || null,
  };
}

function policyMatchers(policy = {}) {
  return Array.isArray(policy.object_matchers) ? policy.object_matchers.map((matcher) => ({
    name: matcher?.[0] || null,
    isEqual: matcher?.[1] !== '!=',
    isRegex: matcher?.[1] === '=~' || matcher?.[1] === '!~',
    value: matcher?.[2] ?? null,
  })) : Array.isArray(policy.matchers) ? policy.matchers.filter((matcher) => matcher && typeof matcher === 'object') : [];
}

function findMatchingNotificationPolicy(policy = {}, labels = {}) {
  const routes = Array.isArray(policy.routes) ? policy.routes : [];
  for (const route of routes) {
    const matchers = policyMatchers(route);
    if (matchers.length && matchers.every((matcher) => matcherMatchesLabels(matcher, labels))) {
      return findMatchingNotificationPolicy(route, labels) || route;
    }
  }
  return policy;
}

function safeNotificationPolicy(policy = {}, contactPoints = [], labels = {}) {
  const selected = findMatchingNotificationPolicy(policy, labels) || {};
  const receiver = selected.receiver || policy.receiver || null;
  return {
    receiver,
    contactPoints: contactPoints.filter((item) => item.name === receiver),
    groupBy: selected.group_by || selected.groupBy || policy.group_by || policy.groupBy || [],
    groupWait: selected.group_wait || selected.groupWait || policy.group_wait || policy.groupWait || null,
    groupInterval: selected.group_interval || selected.groupInterval || policy.group_interval || policy.groupInterval || null,
    repeatInterval: selected.repeat_interval || selected.repeatInterval || policy.repeat_interval || policy.repeatInterval || null,
    muteTimeIntervals: selected.mute_time_intervals || selected.muteTimeIntervals || [],
    activeTimeIntervals: selected.active_time_intervals || selected.activeTimeIntervals || [],
    matchers: policyMatchers(selected),
  };
}

async function getGrafanaWorkspaceNotificationConfiguration(config, refresh = false) {
  return workspaceCached('workspace:alerting-notification-configuration', WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    const [contactPoints, policy, muteTimings, silences] = await Promise.allSettled([
      fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/v1/provisioning/contact-points'), config.token),
      fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/v1/provisioning/policies'), config.token),
      fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/v1/provisioning/mute-timings'), config.token),
      fetchGrafanaJson(buildGrafanaUrl(config.baseUrl, '/api/alertmanager/grafana/api/v2/silences'), config.token),
    ]);
    return {
      contactPoints: contactPoints.status === 'fulfilled'
        ? workspaceObjectList(contactPoints.value.payload).map(safeContactPoint) : [],
      policy: policy.status === 'fulfilled' && policy.value.payload && typeof policy.value.payload === 'object'
        ? policy.value.payload : {},
      muteTimings: muteTimings.status === 'fulfilled'
        ? workspaceObjectList(muteTimings.value.payload).map(safeMuteTiming) : [],
      silences: silences.status === 'fulfilled'
        ? workspaceObjectList(silences.value.payload).map(mapWorkspaceSilence) : [],
      availability: {
        contactPoints: contactPoints.status === 'fulfilled',
        policy: policy.status === 'fulfilled',
        muteTimings: muteTimings.status === 'fulfilled',
        silences: silences.status === 'fulfilled',
      },
      readOnly: true,
    };
  });
}

function assertGrafanaSourceHost(config, sourceUrl) {
  const configuredHost = normalizedGrafanaHost(config.baseUrl);
  const requestedHost = normalizedGrafanaHost(sourceUrl);
  if (requestedHost && configuredHost && requestedHost !== configuredHost) {
    const error = new Error('The exact Grafana alert belongs to a Grafana instance that is not configured in this backend.');
    error.status = 503;
    error.code = 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED';
    throw error;
  }
}

async function getGrafanaWorkspaceAlertingContext(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  assertGrafanaSourceHost(config, options.sourceUrl);
  const from = new Date(options.from || Date.now() - 2 * 60 * 60 * 1000).getTime();
  const to = new Date(options.to || Date.now()).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    const error = new Error('A valid bounded Grafana alert occurrence window is required.');
    error.status = 400;
    throw error;
  }
  const ruleUid = String(options.ruleUid || '').trim() || null;
  const labels = workspaceMetadataObject(options.labels || {});
  const [ruleResult, historyResult, activeResult, configuration] = await Promise.all([
    options.rule !== undefined ? Promise.resolve(options.rule)
      : ruleUid ? getGrafanaWorkspaceAlertRule(ruleUid, { refresh: options.refresh }) : Promise.resolve(null),
    Array.isArray(options.historyItems) ? Promise.resolve({ items: options.historyItems })
      : ruleUid ? getGrafanaWorkspaceAlertStateHistory(ruleUid, {
          from: new Date(from).toISOString(), to: new Date(to).toISOString(), sourceUrl: options.sourceUrl,
          refresh: options.refresh,
        }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    Array.isArray(options.activityItems) ? Promise.resolve({ items: options.activityItems })
      : getGrafanaWorkspaceActiveAlerts({ pageSize: WORKSPACE_MAX_PAGE_SIZE }).catch(() => ({ items: [] })),
    getGrafanaWorkspaceNotificationConfiguration(config, workspaceBoolean(options.refresh)),
  ]);
  const activity = (activeResult.items || []).filter((item) => {
    const itemUid = item.labels?.__alert_rule_uid__ || item.labels?.rule_uid || null;
    if (ruleUid && String(itemUid || '') !== ruleUid) return false;
    return Object.entries(labels).every(([key, value]) => item.labels?.[key] === undefined
      || workspaceCanonical(item.labels[key]) === workspaceCanonical(value));
  });
  const history = (historyResult.items || []).filter((item) => !ruleUid || String(item.ruleUid || '') === ruleUid);
  const combinedLabels = { ...(ruleResult?.labels || {}), ...labels, ...(activity[0]?.labels || {}) };
  const matchedSilences = configuration.silences.filter((silence) => silenceOverlapsWindow(silence, from, to)
    && silence.matchers.length > 0 && silence.matchers.every((matcher) => matcherMatchesLabels(matcher, combinedLabels)));
  const notification = safeNotificationPolicy(configuration.policy, configuration.contactPoints, combinedLabels);
  const transitions = history.map((item) => ({
    previousState: item.previousState || null,
    state: item.state || null,
    timestamp: item.timestamp || null,
    reason: item.condition || null,
    labels: workspaceMetadataObject(item.labels || {}),
    values: workspaceMetadataObject(item.values || {}),
  }));
  return {
    resolved: Boolean(ruleResult && (history.length || activity.length)),
    ruleResolved: Boolean(ruleResult?.uid),
    historyResolved: history.length > 0,
    activityResolved: activity.length > 0,
    rule: ruleResult,
    activity,
    history: transitions,
    notification,
    muteTimings: configuration.muteTimings.filter((item) => notification.muteTimeIntervals.includes(item.name)),
    silences: matchedSilences,
    silenceState: matchedSilences.length ? 'SILENCED' : 'NOT_SILENCED',
    sourceTimestamp: history[0]?.timestamp || activity[0]?.activeSince || null,
    retrievedAt: new Date().toISOString(),
    evidenceAsOf: new Date().toISOString(),
    availability: configuration.availability,
    queryWindow: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    readOnly: true,
  };
}

function irmReferenceValues(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return [];
  if (['string', 'number'].includes(typeof value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => irmReferenceValues(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).flatMap((item) => irmReferenceValues(item, depth + 1));
  return [];
}

function irmObjectMatches(item, exactReferences = []) {
  const values = irmReferenceValues(item).map((value) => value.toLowerCase());
  return exactReferences.filter(Boolean).some((reference) => {
    const normalized = String(reference).toLowerCase();
    return values.some((value) => value === normalized
      || (/^[a-z0-9_-]{3,160}$/i.test(normalized) && value.includes(`/${normalized}/`)));
  });
}

function safeIrmAlert(alert = {}, baseUrl = '') {
  return {
    id: alert.id || alert.pk || null,
    state: alert.status || alert.state || null,
    createdAt: toIsoTimestamp(alert.created_at || alert.createdAt),
    resolvedAt: toIsoTimestamp(alert.resolved_at || alert.resolvedAt),
    sourceLink: workspaceGrafanaLink(baseUrl, alert.source_link || alert.sourceLink),
    labels: workspaceMetadataObject(alert.labels || {}),
  };
}

function safeIrmGroup(group = {}, baseUrl = '') {
  const alerts = Array.isArray(group.alerts) ? group.alerts.map((item) => safeIrmAlert(item, baseUrl)) : [];
  return {
    id: group.id || group.pk || group.public_primary_key || null,
    state: group.status || group.state || null,
    groupingReason: group.grouping_reason || group.groupingReason || null,
    createdAt: toIsoTimestamp(group.created_at || group.createdAt || group.started_at),
    updatedAt: toIsoTimestamp(group.updated_at || group.updatedAt || group.last_alert_at),
    resolvedAt: toIsoTimestamp(group.resolved_at || group.resolvedAt),
    members: alerts.map((item) => item.id).filter(Boolean),
    alerts,
    incident: group.incident || group.related_incident || null,
    tasks: Array.isArray(group.tasks) ? group.tasks : [],
    escalation: group.escalation_chain || group.escalation || null,
    integration: group.alert_receive_channel || group.integration || null,
    permalink: workspaceGrafanaLink(baseUrl, group.web_permalink || group.permalink),
  };
}

function safeIrmInventoryItem(item = {}, kind) {
  return {
    id: item.id || item.pk || item.public_primary_key || null,
    name: item.name || item.title || null,
    state: item.status || item.state || null,
    kind,
  };
}

async function fetchGrafanaIrmCollection(config, path, pageSize = 100) {
  const response = await fetchGrafanaJson(buildGrafanaUrl(config.baseUrl,
    `/api/plugins/grafana-irm-app/resources/${path}`, { page: 1, perpage: pageSize, short: false }), config.token);
  return workspaceObjectList(response.payload);
}

async function getGrafanaWorkspaceIrmContext(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  assertGrafanaSourceHost(config, options.sourceUrl);
  const refresh = workspaceBoolean(options.refresh);
  const inventory = await workspaceCached('workspace:irm-operational-inventory', WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    const results = await Promise.allSettled([
      fetchGrafanaIrmCollection(config, 'alertgroups/', 100),
      fetchGrafanaIrmCollection(config, 'schedules/', 100),
      fetchGrafanaIrmCollection(config, 'escalation_chains/', 100),
      fetchGrafanaIrmCollection(config, 'alert_receive_channels/', 100),
      fetchGrafanaIrmCollection(config, 'users/', 100),
    ]);
    return {
      alertGroups: results[0].status === 'fulfilled' ? results[0].value : [],
      schedules: results[1].status === 'fulfilled' ? results[1].value : [],
      escalations: results[2].status === 'fulfilled' ? results[2].value : [],
      integrations: results[3].status === 'fulfilled' ? results[3].value : [],
      users: results[4].status === 'fulfilled' ? results[4].value : [],
      availability: {
        alertGroups: results[0].status === 'fulfilled', schedules: results[1].status === 'fulfilled',
        escalations: results[2].status === 'fulfilled', integrations: results[3].status === 'fulfilled',
        users: results[4].status === 'fulfilled',
      },
    };
  });
  const references = [options.ruleUid, options.fingerprint, options.sourceAlertId].filter(Boolean);
  const groups = inventory.alertGroups.filter((item) => irmObjectMatches(item, references))
    .map((item) => safeIrmGroup(item, config.baseUrl));
  const relatedValues = irmReferenceValues(groups);
  const related = (items) => items.filter((item) => irmObjectMatches(item, relatedValues))
    .map((item) => safeIrmInventoryItem(item, 'operational_context'));
  const incidents = groups.map((group) => group.incident).filter(Boolean).map((item) => safeIrmInventoryItem(item, 'incident'));
  const tasks = groups.flatMap((group) => group.tasks || []).map((item) => safeIrmInventoryItem(item, 'task'));
  return {
    resolved: groups.length > 0,
    alertGroups: groups,
    incidents,
    tasks,
    schedules: related(inventory.schedules),
    escalations: related(inventory.escalations),
    integrations: related(inventory.integrations),
    users: [],
    insights: groups.length ? { matchedAlertGroups: groups.length, relatedAlerts: groups.reduce((sum, group) => sum + group.alerts.length, 0) } : null,
    availability: inventory.availability,
    retrievedAt: new Date().toISOString(),
    evidenceAsOf: new Date().toISOString(),
    readOnly: true,
  };
}

async function getGrafanaWorkspaceDashboard(uid, options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const refresh = workspaceBoolean(options.refresh);

  return workspaceCached(`workspace:dashboard-detail:${uid}`, WORKSPACE_METADATA_CACHE_MS, refresh, async () => {
    const response = await getWorkspaceDashboardDefinition(config, uid, refresh);
    const mapped = mapWorkspaceDashboard({}, config, response.payload);
    const dashboard = response.payload?.dashboard || {};
    const panels = getPanelMetadata(response.payload?.dashboard || {}).map((panel) => ({
      id: panel.id ?? null,
      uid: panel.uid || null,
      title: panel.title,
      type: panel.type,
      datasource: panel.datasource,
      deepLink: getPanelDeepLink(mapped.url, panel),
      display: {
        decimals: panel.fieldConfig?.defaults?.decimals ?? null,
        max: panel.fieldConfig?.defaults?.max ?? null,
        min: panel.fieldConfig?.defaults?.min ?? null,
        thresholds: panel.fieldConfig?.defaults?.thresholds?.steps || [],
        unit: panel.fieldConfig?.defaults?.unit || null,
      },
      gridPosition: panel.gridPos || null,
      queryReferences: (panel.targets || []).map((target) => ({
        datasourceType: target.datasource?.type || null,
        datasourceUid: target.datasource?.uid || null,
        queryType: target.queryType || null,
        refId: target.refId || null,
      })),
      queryMetadataAvailable: Array.isArray(panel.targets) && panel.targets.length > 0,
    }));
    const variables = (dashboard.templating?.list || [])
      .filter((variable) => variable && variable.name && variable.hide !== 2)
      .map((variable) => {
        const currentValue = variable.current?.value;
        const currentText = variable.current?.text;
        return {
          current: Array.isArray(currentValue) ? currentValue.map(String) : currentValue ?? null,
          currentText: Array.isArray(currentText) ? currentText.map(String) : currentText ?? null,
          includeAll: Boolean(variable.includeAll),
          label: variable.label || variable.name,
          multi: Boolean(variable.multi),
          name: String(variable.name),
          options: (variable.options || [])
            .filter((option) => option && option.value !== undefined && option.value !== null)
            .slice(0, 200)
            .map((option) => ({ selected: Boolean(option.selected), text: String(option.text ?? option.value), value: String(option.value) })),
          type: variable.type || null,
        };
      });

    return {
      ...mapped,
      defaultTimeRange: {
        from: dashboard.time?.from || null,
        to: dashboard.time?.to || null,
      },
      panelCount: panels.length,
      panels,
      refreshInterval: dashboard.refresh || null,
      readOnly: true,
      variables,
    };
  });
}

async function getGrafanaWorkspaceEvidenceInventory(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const refresh = workspaceBoolean(options.refresh);
  return workspaceCached('workspace:evidence-inventory', WORKSPACE_RULE_CACHE_MS, refresh, async () => {
    const [dashboardInventory, folderInventory, rawRules, ruleContext] = await Promise.all([
      getWorkspaceDashboardInventory(config, refresh),
      getWorkspaceFolderInventory(config, refresh),
      getWorkspaceRuleInventory(config, refresh),
      workspaceRuleContext(config, refresh),
    ]);
    const dashboards = [];
    for (let index = 0; index < dashboardInventory.length; index += WORKSPACE_INVENTORY_CONCURRENCY) {
      const batch = dashboardInventory.slice(index, index + WORKSPACE_INVENTORY_CONCURRENCY);
      dashboards.push(...await Promise.all(batch.map((item) => getGrafanaWorkspaceDashboard(item.uid, { refresh }))));
    }
    const safeDashboards = dashboards.map((dashboard) => ({
      uid: dashboard.uid,
      title: dashboard.title,
      folderUid: dashboard.folderUid,
      folderTitle: dashboard.folderTitle,
      tags: dashboard.tags || [],
      url: dashboard.url,
      variables: dashboard.variables || [],
      panels: (dashboard.panels || []).map((panel) => ({
        id: panel.id === null || panel.id === undefined ? null : String(panel.id),
        title: panel.title,
        type: panel.type,
        datasource: panel.datasource,
        deepLink: panel.deepLink,
        display: panel.display || {},
        queryReferences: panel.queryReferences || [],
      })),
    }));
    const rules = rawRules.map((rule) => mapWorkspaceRule(rule, ruleContext, true));
    return {
      host: normalizedGrafanaHost(config.baseUrl),
      folders: folderInventory.map((folder) => ({
        uid: folder.uid,
        title: folder.title,
        dashboardCount: folder.dashboardCount,
      })),
      dashboards: safeDashboards,
      panels: safeDashboards.flatMap((dashboard) => dashboard.panels.map((panel) => ({
        ...panel,
        dashboardUid: dashboard.uid,
        dashboardTitle: dashboard.title,
        folderTitle: dashboard.folderTitle,
      }))),
      rules,
      counts: {
        folders: folderInventory.length,
        dashboards: safeDashboards.length,
        panels: safeDashboards.reduce((total, dashboard) => total + dashboard.panels.length, 0),
        rules: rules.length,
      },
      generatedAt: new Date().toISOString(),
      readOnly: true,
    };
  });
}

function inventoryContextCompatible(expected, actual) {
  return !expected || !actual || workspaceCanonical(expected) === workspaceCanonical(actual);
}

async function findGrafanaWorkspaceEvidenceIdentity(signals = {}, options = {}) {
  const inventory = await getGrafanaWorkspaceEvidenceInventory(options);
  const requestedHost = normalizedGrafanaHost(signals.sourceHost || signals.sourceUrl);
  const configuredHost = inventory.host;
  const exactRuleUid = signals.ruleUid
    ? inventory.rules.filter((rule) => String(rule.uid) === String(signals.ruleUid)) : [];
  const exactDashboardPanel = signals.dashboardUid && signals.panelId
    ? inventory.panels.filter((panel) => String(panel.dashboardUid) === String(signals.dashboardUid)
      && String(panel.id) === String(signals.panelId)) : [];
  const exactRuleTitle = signals.alertName ? inventory.rules.filter((rule) => (
    workspaceCanonical(rule.title) === workspaceCanonical(signals.alertName)
      && inventoryContextCompatible(signals.folder, rule.folderTitle)
      && inventoryContextCompatible(signals.dashboardUid, rule.dashboard?.uid)
      && inventoryContextCompatible(signals.panelId, rule.dashboard?.panelId)
  )) : [];
  const exactPanelTitle = signals.alertName ? inventory.panels.filter((panel) => (
    workspaceCanonical(panel.title) === workspaceCanonical(signals.alertName)
      && inventoryContextCompatible(signals.folder, panel.folderTitle)
      && inventoryContextCompatible(signals.dashboardUid, panel.dashboardUid)
      && inventoryContextCompatible(signals.panelId, panel.id)
  )) : [];
  const candidates = exactRuleUid.length === 1
    ? [{ kind: 'rule', value: exactRuleUid[0], method: 'EXACT_RULE_UID' }]
    : exactDashboardPanel.length === 1
      ? [{ kind: 'panel', value: exactDashboardPanel[0], method: 'EXACT_DASHBOARD_PANEL' }]
      : exactRuleTitle.length === 1
        ? [{ kind: 'rule', value: exactRuleTitle[0], method: 'UNIQUE_EXACT_RULE_NAME_AND_CONTEXT' }]
        : exactPanelTitle.length === 1
          ? [{ kind: 'panel', value: exactPanelTitle[0], method: 'UNIQUE_EXACT_PANEL_TITLE_AND_CONTEXT' }]
          : [];
  const selected = candidates[0] || null;
  const differentHost = Boolean(requestedHost && configuredHost && requestedHost !== configuredHost);
  const disposition = selected ? 'ACTUALLY_SAME_INSTANCE'
    : differentHost ? 'ACTUALLY_DIFFERENT_INSTANCE' : 'UNPROVEN';
  return {
    disposition,
    configuredHost,
    requestedHost,
    selected,
    proof: {
      exactRuleUidMatches: exactRuleUid.length,
      exactDashboardPanelMatches: exactDashboardPanel.length,
      exactRuleTitleMatches: exactRuleTitle.length,
      exactPanelTitleMatches: exactPanelTitle.length,
      inventoryCounts: inventory.counts,
    },
    readOnly: true,
  };
}

async function getWorkspaceDashboardDefinition(config, uid, refresh = false) {
  return workspaceCached(`workspace:dashboard-definition:${uid}`, WORKSPACE_METADATA_CACHE_MS, refresh, () => (
    fetchGrafanaJson(
      buildGrafanaUrl(config.baseUrl, `/api/dashboards/uid/${encodeURIComponent(uid)}`),
      config.token,
    )
  ));
}

function replaceWorkspaceVariables(value, variables = {}) {
  if (Array.isArray(value)) return value.map((item) => replaceWorkspaceVariables(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceWorkspaceVariables(item, variables)]));
  }
  if (typeof value !== 'string') return value;

  return Object.entries(variables).reduce((result, [name, variableValue]) => {
    const replacement = String(variableValue ?? '');
    return result
      .replaceAll(`\${${name}}`, replacement)
      .replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, 'g'), replacement);
  }, value);
}

function safeWorkspaceFrames(payload = {}) {
  return Object.entries(payload.results || {}).flatMap(([refId, result]) => (
    (result.frames || []).map((frame, frameIndex) => ({
      refId,
      name: frame.schema?.name || `${refId}-${frameIndex + 1}`,
      fields: (frame.schema?.fields || []).map((field) => ({
        name: field.name || null,
        type: field.type || null,
        labels: field.labels || {},
        unit: field.config?.unit || null,
        displayName: field.config?.displayNameFromDS || field.config?.displayName || null,
      })),
      values: Array.isArray(frame.data?.values) ? frame.data.values : [],
    }))
  ));
}

async function queryWorkspacePanelData(config, queries, from, to, signal) {
  const url = buildGrafanaUrl(config.baseUrl, '/api/ds/query');
  const request = (requestedQueries) => fetchGrafanaJson(url, config.token, {
    method: 'POST',
    body: { from, queries: requestedQueries, to },
    signal,
  });

  try {
    const response = await request(queries);
    return {
      failedTargetCount: 0,
      payload: response.payload,
      returnedTargetCount: queries.length,
    };
  } catch (batchError) {
    if (queries.length < 2) throw batchError;

    const mergedResults = {};
    let failedTargetCount = 0;
    let returnedTargetCount = 0;

    for (const query of queries) {
      try {
        const response = await request([query]);
        Object.assign(mergedResults, response.payload?.results || {});
        returnedTargetCount += 1;
      } catch {
        failedTargetCount += 1;
      }
    }

    if (!returnedTargetCount) throw batchError;
    return {
      failedTargetCount,
      payload: { results: mergedResults },
      returnedTargetCount,
    };
  }
}

async function getGrafanaWorkspacePanelData(uid, panelId, options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const response = await getWorkspaceDashboardDefinition(config, uid, workspaceBoolean(options.refresh));
  const dashboard = response.payload?.dashboard || {};
  const normalizedPanelId = String(panelId || '').trim();
  const panel = flattenPanels(dashboard.panels || []).find((item) => String(item?.id) === normalizedPanelId);

  if (!panel) {
    const error = new Error(`Grafana panel ${normalizedPanelId} was not found in dashboard ${uid}.`);
    error.status = 404;
    throw error;
  }

  const panelType = String(panel.type || 'panel').toLowerCase();
  const display = {
    decimals: panel.fieldConfig?.defaults?.decimals ?? null,
    max: panel.fieldConfig?.defaults?.max ?? null,
    min: panel.fieldConfig?.defaults?.min ?? null,
    thresholds: panel.fieldConfig?.defaults?.thresholds?.steps || [],
    unit: panel.fieldConfig?.defaults?.unit || null,
  };
  const panelContext = {
    dashboardTitle: dashboard.title || null,
    dashboardUid: dashboard.uid || uid,
    datasource: getPanelDatasource(panel),
    deepLink: getPanelDeepLink(
      workspaceGrafanaLink(config.baseUrl, response.payload?.meta?.url),
      panel,
    ),
    folderTitle: response.payload?.meta?.folderTitle || null,
    panelId: normalizedPanelId,
    panelTitle: panel.title || null,
    queryReferences: (panel.targets || []).map((target) => ({
      datasourceType: target.datasource?.type || null,
      datasourceUid: target.datasource?.uid || null,
      queryType: target.queryType || null,
      refId: target.refId || null,
    })),
  };

  if (panelType === 'text') {
    return {
      ...panelContext,
      display,
      frames: [],
      panelType,
      readOnly: true,
      strategy: 'native',
      text: String(panel.options?.content || ''),
      textMode: panel.options?.mode || 'markdown',
    };
  }

  const absoluteFrom = new Date(options.from || 0).getTime();
  const absoluteTo = new Date(options.to || 0).getTime();
  const hasAbsoluteWindow = Number.isFinite(absoluteFrom)
    && Number.isFinite(absoluteTo)
    && absoluteTo > absoluteFrom;
  const from = hasAbsoluteWindow ? String(absoluteFrom) : `now-${workspaceRenderRange(options.range)}`;
  const to = hasAbsoluteWindow ? String(absoluteTo) : 'now';
  const renderVariables = workspaceRenderVariables(options.variables);
  const variables = Object.fromEntries(
    Object.entries(renderVariables).map(([name, value]) => [name.replace(/^var-/, ''), value]),
  );
  const queries = buildPanelQueryTargets(panel, from, to)
    .map((query) => replaceWorkspaceVariables(query, variables));

  if (!queries.length) {
    return {
      ...panelContext,
      display,
      frames: [],
      panelType,
      readOnly: true,
      strategy: 'light-image',
    };
  }

  const queryResponse = await queryWorkspacePanelData(config, queries, from, to, options.signal);

  return {
    ...panelContext,
    display,
    frames: safeWorkspaceFrames(queryResponse.payload),
    partial: queryResponse.failedTargetCount > 0,
    failedTargetCount: queryResponse.failedTargetCount,
    returnedTargetCount: queryResponse.returnedTargetCount,
    panelType,
    readOnly: true,
    strategy: 'native',
  };
}

function workspaceDashboardSlug(dashboard) {
  try {
    const pathname = new URL(dashboard.url).pathname.split('/').filter(Boolean);
    return pathname.at(-1) || slugify(dashboard.title);
  } catch {
    return slugify(dashboard.title);
  }
}

async function renderGrafanaWorkspacePanel(uid, panelId, options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const dashboard = await getGrafanaWorkspaceDashboard(uid);
  const normalizedPanelId = String(panelId || '').trim();
  const panel = dashboard.panels.find((item) => String(item.id) === normalizedPanelId);

  if (!panel) {
    const error = new Error(`Grafana panel ${normalizedPanelId} was not found in dashboard ${uid}.`);
    error.status = 404;
    throw error;
  }

  const range = workspaceRenderRange(options.range);
  const width = workspaceRenderDimension(options.width, 1000, 400, 1600);
  const height = workspaceRenderDimension(options.height, 420, 220, 900);
  const timezone = workspaceRenderTimezone(options.tz);
  const variables = workspaceRenderVariables(options.variables);
  const cacheKey = JSON.stringify([uid, normalizedPanelId, range, width, height, timezone, variables]);
  const cached = workspaceBoolean(options.refresh) ? null : getCachedGrafanaPanelRender(cacheKey);
  if (cached) return cached;

  const renderUrl = buildGrafanaUrl(
    config.baseUrl,
    `/render/d-solo/${encodeURIComponent(uid)}/${encodeURIComponent(workspaceDashboardSlug(dashboard))}`,
    {
      panelId: normalizedPanelId,
      from: `now-${range}`,
      to: 'now',
      width,
      height,
      tz: timezone,
      theme: 'light',
      ...variables,
    },
  );

  const image = await withGrafanaPanelRenderSlot(
    () => fetchGrafanaBinary(renderUrl, config.token, options.signal),
    options.signal,
  );

  if (!options.signal?.aborted) cacheGrafanaPanelRender(cacheKey, image);
  return image;
}

async function getGrafanaWorkspaceOverview(options = {}) {
  const config = await getGrafanaWorkspaceConfig();
  const refresh = workspaceBoolean(options.refresh);
  const [status, dashboards, folders, rules, activeAlerts] = await Promise.all([
    getGrafanaWorkspaceStatus({ refresh }),
    getWorkspaceDashboardInventory(config, refresh),
    getWorkspaceFolderInventory(config, refresh),
    getWorkspaceRuleInventory(config, refresh),
    getGrafanaWorkspaceActiveAlerts(),
  ]);

  return {
    connection: status,
    counts: {
      activeAlerts: activeAlerts.total,
      alertRules: rules.length,
      dashboards: dashboards.length,
      folders: folders.length,
    },
    lastUpdated: new Date().toISOString(),
    readOnly: true,
  };
}

async function listDashboards(filters = {}) {
  await ensureGrafanaDashboardStorage();
  const params = [];
  const clauses = [];

  if (filters.search) {
    params.push(`%${String(filters.search).toLowerCase()}%`);
    clauses.push(`(
      LOWER(title) LIKE $${params.length}
      OR LOWER(COALESCE(folder_title, '')) LIKE $${params.length}
      OR LOWER(COALESCE(uri, '')) LIKE $${params.length}
      OR LOWER(uid) LIKE $${params.length}
      OR LOWER(tags::text) LIKE $${params.length}
    )`);
  }

  if (filters.folderUid && filters.folderUid !== 'all') {
    if (filters.folderUid === 'general') {
      clauses.push(`(folder_uid IS NULL OR folder_uid = '' OR folder_title = 'General')`);
    } else {
      params.push(filters.folderUid);
      clauses.push(`folder_uid = $${params.length}`);
    }
  }

  if (filters.folder && filters.folder !== 'all') {
    params.push(filters.folder);
    clauses.push(`folder_title = $${params.length}`);
  }

  if (filters.tag && filters.tag !== 'all') {
    params.push(JSON.stringify([filters.tag]));
    clauses.push(`tags @> $${params.length}::jsonb`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db.query(
    `
      SELECT *
      FROM grafana_dashboards
      ${whereClause}
      ORDER BY folder_title NULLS LAST, title
      LIMIT 1000
    `,
    params,
  );
  const folders = await db.query(`
    SELECT COALESCE(NULLIF(folder_uid, ''), 'general') AS folder_uid, COALESCE(folder_title, 'General') AS folder_title, COUNT(*)::int AS count
    FROM grafana_dashboards
    GROUP BY COALESCE(NULLIF(folder_uid, ''), 'general'), COALESCE(folder_title, 'General')
    ORDER BY folder_title
  `);

  return {
    dashboards: result.rows.map(mapDashboardRow),
    folders: folders.rows.map((row) => ({
      uid: row.folder_uid,
      title: row.folder_title || 'General',
      name: row.folder_title || 'General',
      count: row.count,
    })),
    total: result.rows.length,
  };
}

async function listFolders() {
  await ensureGrafanaDashboardStorage();
  const result = await db.query(`
    SELECT
      folders.uid,
      folders.title,
      folders.url,
      folders.dashboard_count,
      COALESCE(SUM(dashboards.panel_count), 0)::int AS panel_count,
      MAX(dashboards.updated_at) AS last_updated_at,
      MAX(dashboards.last_synced_at) AS last_refreshed_at,
      folders.raw_payload
    FROM grafana_folders folders
    LEFT JOIN grafana_dashboards dashboards
      ON COALESCE(NULLIF(dashboards.folder_uid, ''), 'general') = folders.uid
    GROUP BY folders.uid, folders.title, folders.url, folders.dashboard_count, folders.raw_payload
    ORDER BY folders.title
  `);
  const rows = result.rows;

  if (!rows.length) {
    const fallback = await db.query(`
      SELECT
        COALESCE(NULLIF(folder_uid, ''), 'general') AS uid,
        COALESCE(folder_title, 'General') AS title,
        COUNT(*)::int AS dashboard_count,
        SUM(panel_count)::int AS panel_count,
        MAX(updated_at) AS last_updated_at,
        MAX(last_synced_at) AS last_refreshed_at,
        '{}'::jsonb AS raw_payload
      FROM grafana_dashboards
      GROUP BY COALESCE(NULLIF(folder_uid, ''), 'general'), COALESCE(folder_title, 'General')
      ORDER BY title
    `);

    rows.push(...fallback.rows);
  }

  return rows.map((row) => ({
    sourceTool: 'Grafana',
    uid: row.uid,
    title: row.title,
    name: row.title,
    dashboardCount: row.dashboard_count,
    panelCount: row.panel_count || 0,
    deepLink: row.url,
    lastUpdatedAt: row.last_updated_at,
    lastRefreshedAt: row.last_refreshed_at,
    rawPayload: row.raw_payload || {},
  }));
}

async function listFolderDashboards(folderUid, filters = {}) {
  return listDashboards({
    ...filters,
    folderUid,
  });
}

async function getDashboard(uid) {
  await ensureGrafanaDashboardStorage();
  const result = await db.query('SELECT * FROM grafana_dashboards WHERE uid = $1', [uid]);

  if (!result.rows[0]) {
    return null;
  }

  const dashboard = mapDashboardRow(result.rows[0]);
  const [panelResult, alertRulesResult, alertStatesResult, aiFeatureResult, variableResult, annotationResult, metricSummaryResult, correlationResult, stateHistoryResult] = await Promise.all([
    db.query('SELECT * FROM grafana_panels WHERE dashboard_uid = $1 ORDER BY panel_order', [uid]),
    db.query('SELECT * FROM grafana_alert_rules WHERE dashboard_uid = $1 ORDER BY title', [uid]),
    db.query(
      `
        SELECT states.*
        FROM grafana_alert_states states
        JOIN grafana_alert_rules rules ON rules.uid = states.rule_uid
        WHERE rules.dashboard_uid = $1
        ORDER BY states.updated_at DESC
        LIMIT 200
      `,
      [uid],
    ),
    db.query(
      `
        SELECT *
        FROM grafana_ai_features
        WHERE dashboard_uid = $1
        ORDER BY source_module, entity_name
        LIMIT 500
      `,
      [uid],
    ),
    db.query('SELECT * FROM grafana_variables WHERE dashboard_uid = $1 ORDER BY variable_name', [uid]),
    db.query('SELECT * FROM grafana_annotations WHERE dashboard_uid = $1 ORDER BY annotation_time DESC NULLS LAST LIMIT 200', [uid]),
    db.query('SELECT * FROM grafana_panel_metric_summaries WHERE dashboard_uid = $1 ORDER BY panel_id, series_name LIMIT 500', [uid]),
    db.query(
      `
        SELECT *
        FROM grafana_correlation_features
        WHERE dashboard_uid_a = $1 OR dashboard_uid_b = $1
        ORDER BY correlation_confidence DESC NULLS LAST
        LIMIT 500
      `,
      [uid],
    ),
    db.query(
      `
        SELECT history.*
        FROM grafana_alert_state_history history
        JOIN grafana_alert_rules rules ON rules.uid = history.rule_uid
        WHERE rules.dashboard_uid = $1
        ORDER BY history.transitioned_at DESC
        LIMIT 300
      `,
      [uid],
    ),
  ]);

  return {
    ...dashboard,
    normalizedPanels: panelResult.rows.map(mapPanelRow),
    alertRules: alertRulesResult.rows.map(mapAlertRuleRow),
    alertStates: alertStatesResult.rows.map(mapAlertStateRow),
    aiFeatures: aiFeatureResult.rows.map(mapAiFeatureRow),
    variables: variableResult.rows.map(mapVariableRow),
    annotations: annotationResult.rows.map(mapAnnotationRow),
    metricSummaries: metricSummaryResult.rows.map(mapMetricSummaryRow),
    correlationFeatures: correlationResult.rows.map(mapCorrelationFeatureRow),
    alertStateHistory: stateHistoryResult.rows.map(mapAlertStateHistoryRow),
  };
}

function mapPanelRow(row) {
  return {
    dashboardUid: row.dashboard_uid,
    panelId: row.panel_id,
    panelUid: row.panel_uid,
    title: row.panel_title,
    panelTitle: row.panel_title,
    description: row.panel_description,
    type: row.panel_type,
    visualizationType: row.visualization_type,
    order: row.panel_order,
    folderUid: row.folder_uid,
    folderName: row.folder_name,
    dashboardTitle: row.dashboard_title,
    datasource: row.datasource_name,
    datasourceUid: row.datasource_uid,
    querySummary: row.query_summary,
    queries: row.queries || [],
    expressions: row.expressions || [],
    transformations: row.transformations || [],
    thresholds: row.thresholds || [],
    overrides: row.overrides || [],
    fieldConfig: row.field_config || {},
    legend: row.legend,
    unit: row.unit,
    decimals: row.decimals,
    colorScheme: row.color_scheme,
    displayMode: row.display_mode,
    minValue: row.min_value,
    maxValue: row.max_value,
    currentValue: row.current_value,
    metricStats: row.metric_stats || {},
    gridPos: row.grid_pos || {},
    targets: row.targets || [],
    tags: row.tags || [],
    deepLink: row.deep_link,
    rawPayload: row.raw_payload || {},
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function mapAlertRuleRow(row) {
  return {
    uid: row.uid,
    ruleId: row.rule_id,
    title: row.title,
    folderUid: row.folder_uid,
    folderName: row.folder_name,
    dashboardUid: row.dashboard_uid,
    panelId: row.panel_id,
    condition: row.condition,
    threshold: row.threshold,
    reducer: row.reducer,
    operator: row.operator,
    state: row.state,
    severity: row.severity,
    health: row.health,
    noDataState: row.no_data_state,
    execErrorState: row.exec_error_state,
    ruleGroup: row.rule_group,
    evaluationInterval: row.evaluation_interval,
    summary: row.summary,
    description: row.description,
    lastEvaluationAt: row.last_evaluation_at,
    nextEvaluationAt: row.next_evaluation_at,
    silenced: row.silenced,
    paused: row.paused,
    labels: row.labels || {},
    annotations: row.annotations || {},
    data: row.data || [],
    deepLink: row.deep_link,
    rawPayload: row.raw_payload || {},
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function mapAlertStateRow(row) {
  return {
    fingerprint: row.fingerprint,
    ruleUid: row.rule_uid,
    ruleTitle: row.rule_title,
    state: row.state,
    severity: row.severity,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    labels: row.labels || {},
    annotations: row.annotations || {},
    deepLink: row.deep_link,
    rawPayload: row.raw_payload || {},
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function mapAiFeatureRow(row) {
  return {
    sourceTool: row.source_tool,
    sourceModule: row.source_module,
    entityId: row.entity_id,
    entityUid: row.entity_uid,
    entityName: row.entity_name,
    dashboardUid: row.dashboard_uid,
    dashboardCategory: row.dashboard_category,
    panelTitle: row.panel_title,
    metricName: row.metric_name,
    alertRuleState: row.alert_rule_state,
    threshold: row.threshold,
    severity: row.severity,
    timestamp: row.timestamp,
    recurrenceCount: row.recurrence_count,
    aiLabel: row.ai_label,
    aiConfidence: row.ai_confidence,
    aiReason: row.ai_reason,
    aiFeatures: row.ai_features || {},
    computedFeatures: row.computed_features || {},
    correlationFeatures: row.correlation_features || {},
    predictionPlaceholder: row.prediction_placeholder,
    confidencePlaceholder: row.confidence_placeholder,
    explanationPlaceholder: row.explanation_placeholder,
    rawPayload: row.raw_payload || {},
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function mapVariableRow(row) {
  return {
    dashboardUid: row.dashboard_uid,
    name: row.variable_name,
    type: row.variable_type,
    datasourceUid: row.datasource_uid,
    currentValue: row.current_value || {},
    options: row.options || [],
    refreshMode: row.refresh_mode,
    rawPayload: row.raw_payload || {},
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function mapAnnotationRow(row) {
  return {
    id: row.annotation_id,
    dashboardUid: row.dashboard_uid,
    panelId: row.panel_id,
    text: row.text,
    tags: row.tags || [],
    timestamp: row.annotation_time,
    createdBy: row.created_by,
    rawPayload: row.raw_payload || {},
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function mapMetricSummaryRow(row, options = {}) {
  const mapped = {
    dashboardUid: row.dashboard_uid,
    panelId: row.panel_id,
    seriesName: row.series_name,
    metricName: row.metric_name,
    datasourceUid: row.datasource_uid,
    currentValue: row.current_value,
    min: row.min_value,
    max: row.max_value,
    average: row.average_value,
    median: row.median_value,
    p95: row.p95_value,
    p99: row.p99_value,
    stddev: row.stddev_value,
    sampleCount: row.sample_count,
    firstTimestamp: row.first_timestamp,
    lastTimestamp: row.last_timestamp,
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };

  if (options.includeRaw) {
    mapped.rawPayload = row.raw_payload || {};
  }

  return mapped;
}

function mapCorrelationFeatureRow(row) {
  return {
    id: row.id,
    sourceTool: row.source_tool,
    entityA: row.entity_a,
    entityB: row.entity_b,
    dashboardUidA: row.dashboard_uid_a,
    dashboardUidB: row.dashboard_uid_b,
    scope: row.correlation_scope,
    sharedDatasource: row.shared_datasource,
    sharedAlertRules: row.shared_alert_rules,
    sharedTags: row.shared_tags || [],
    sharedFolder: row.shared_folder,
    temporalCorrelation: row.temporal_correlation,
    dependencyScore: row.dependency_score,
    potentialRootCauseScore: row.potential_root_cause_score,
    correlationConfidence: row.correlation_confidence,
    correlationFeatures: row.correlation_features || {},
    featureTimestamp: row.feature_timestamp,
    updatedAt: row.updated_at,
  };
}

function mapAlertStateHistoryRow(row) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    ruleUid: row.rule_uid,
    ruleTitle: row.rule_title,
    previousState: row.previous_state,
    state: row.state,
    severity: row.severity,
    transitionedAt: row.transitioned_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    rawPayload: row.raw_payload || {},
  };
}

async function listDashboardPanels(uid) {
  await ensureGrafanaDashboardStorage();
  const result = await db.query(
    'SELECT * FROM grafana_panels WHERE dashboard_uid = $1 ORDER BY panel_order',
    [uid],
  );

  return {
    dashboardUid: uid,
    panels: result.rows.map(mapPanelRow),
    total: result.rows.length,
  };
}

async function listAlertRules(filters = {}) {
  await ensureGrafanaDashboardStorage();
  const params = [];
  const clauses = [];

  if (filters.dashboardUid) {
    params.push(filters.dashboardUid);
    clauses.push(`dashboard_uid = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${String(filters.search).toLowerCase()}%`);
    clauses.push(`(LOWER(title) LIKE $${params.length} OR LOWER(COALESCE(folder_name, '')) LIKE $${params.length} OR LOWER(uid) LIKE $${params.length})`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db.query(
    `
      SELECT *
      FROM grafana_alert_rules
      ${whereClause}
      ORDER BY updated_at DESC, title
      LIMIT 1000
    `,
    params,
  );

  return {
    alertRules: result.rows.map(mapAlertRuleRow),
    total: result.rows.length,
  };
}

async function listAlertStates(filters = {}) {
  await ensureGrafanaDashboardStorage();
  const params = [];
  const clauses = [];

  if (filters.state && filters.state !== 'all') {
    params.push(filters.state);
    clauses.push(`state = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${String(filters.search).toLowerCase()}%`);
    clauses.push(`(LOWER(rule_title) LIKE $${params.length} OR LOWER(labels::text) LIKE $${params.length} OR LOWER(annotations::text) LIKE $${params.length})`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db.query(
    `
      SELECT *
      FROM grafana_alert_states
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT 1000
    `,
    params,
  );

  return {
    alerts: result.rows.map(mapAlertStateRow),
    total: result.rows.length,
  };
}

async function listDashboardMetrics(uid, filters = {}) {
  await ensureGrafanaDashboardStorage();
  const limit = Math.min(Number(filters.limit || 500), 5000);
  const includeRaw = filters.includeRaw === true || filters.includeRaw === 'true';
  const [summaryResult, pointResult] = await Promise.all([
    db.query(
      `
        SELECT *
        FROM grafana_panel_metric_summaries
        WHERE dashboard_uid = $1
        ORDER BY panel_id, series_name
        LIMIT $2
      `,
      [uid, limit],
    ),
    db.query(
      `
        SELECT *
        FROM grafana_panel_metric_points
        WHERE dashboard_uid = $1
        ORDER BY metric_timestamp DESC
        LIMIT $2
      `,
      [uid, limit],
    ),
  ]);

  return {
    dashboardUid: uid,
    summaries: summaryResult.rows.map((row) => mapMetricSummaryRow(row, { includeRaw })),
    points: pointResult.rows.map((row) => ({
      dashboardUid: row.dashboard_uid,
      panelId: row.panel_id,
      datasourceUid: row.datasource_uid,
      seriesName: row.series_name,
      metricName: row.metric_name,
      labels: row.metric_labels || {},
      timestamp: row.metric_timestamp,
      value: row.value,
      valueType: row.value_type,
      unit: row.unit,
      ...(includeRaw ? { rawPayload: row.raw_payload || {} } : {}),
    })),
  };
}

async function listSyncLogs(limit = 50) {
  await ensureGrafanaDashboardStorage();
  const result = await db.query(
    `
      SELECT *
      FROM grafana_sync_logs
      ORDER BY started_at DESC
      LIMIT $1
    `,
    [Math.min(Number(limit || 50), 200)],
  );

  return result.rows.map((row) => ({
    id: row.id,
    syncType: row.sync_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    counts: row.counts || {},
    warnings: row.warnings || [],
    errorMessage: row.error_message,
    rawPayload: row.raw_payload || {},
  }));
}

function slugify(value) {
  return String(value || 'dashboard')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'dashboard';
}

async function renderPanel(uid, panelId, options = {}) {
  await ensureGrafanaDashboardStorage();
  const dashboard = await getDashboard(uid);

  if (!dashboard) {
    const error = new Error(`Grafana dashboard ${uid} was not found.`);
    error.status = 404;
    throw error;
  }

  const config = await getGrafanaRuntimeConfig();
  const slug = dashboard.slug || dashboard.meta?.slug || slugify(dashboard.title);
  const renderUrl = buildGrafanaUrl(config.baseUrl, `/render/d-solo/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}`, {
    panelId,
    from: options.from || 'now-6h',
    to: options.to || 'now',
    width: options.width || 1000,
    height: options.height || 420,
    tz: options.tz || 'UTC',
  });

  return fetchGrafanaBinary(renderUrl, config.token);
}

module.exports = {
  clearGrafanaWorkspaceCache,
  getDashboard,
  getGrafanaWorkspaceActiveAlerts,
  getGrafanaWorkspaceAlertingReadCapabilities,
  getGrafanaWorkspaceAlertingContext,
  getGrafanaWorkspaceAlertRule,
  getGrafanaWorkspaceAlertStateHistory,
  getGrafanaWorkspaceDashboard,
  getGrafanaWorkspaceEvidenceInventory,
  getGrafanaWorkspaceIrmContext,
  getGrafanaWorkspacePanelData,
  getGrafanaWorkspaceSourceIdentity,
  getGrafanaWorkspaceOverview,
  getGrafanaWorkspaceRuleEvidenceInventory,
  getGrafanaWorkspaceStatus,
  findGrafanaWorkspaceEvidenceIdentity,
  getPanelMetadata,
  listAlertRules,
  listAlertStates,
  listDashboardPanels,
  listDashboardMetrics,
  listDashboards,
  listFolderDashboards,
  listFolders,
  listGrafanaWorkspaceAlertRules,
  listGrafanaWorkspaceDashboards,
  listGrafanaWorkspaceFolders,
  listSyncLogs,
  renderGrafanaWorkspacePanel,
  renderPanel,
  syncAlertRulesAndStates,
  syncDashboards,
  _test: {
    GRAFANA_ALERT_STATE_HISTORY_DATASOURCE_UID,
    getRuleDatasources,
    getRuleThresholds,
    mapWorkspaceActiveAlert,
    mapWorkspaceSilence,
    mapWorkspaceDashboard,
    mapWorkspaceRule,
    normalizedGrafanaHost,
    parseGrafanaStateHistoryFrames,
    parseGrafanaStateHistoryLoki,
    matcherMatchesLabels,
    safeContactPoint,
    safeIrmGroup,
    safeNotificationPolicy,
    workspaceRenderRange,
    workspacePage,
    workspacePageSize,
  },
};

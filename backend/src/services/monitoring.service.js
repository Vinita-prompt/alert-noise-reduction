const db = require('../config/db');
const abcHubService = require('./abcHub.service');
const appDynamicsService = require('./appDynamics.service');
const grafanaDashboardService = require('./grafanaDashboard.service');
const nagiosService = require('./nagios.service');
const oracleApexService = require('./oracleApex.service');
const paymentGatewayService = require('./paymentGateway.service');
const thousandEyesService = require('./thousandEyes.service');

const TOOL_DEFINITIONS = [
  {
    key: 'nagios-d01',
    label: 'Nagios D01',
    adapterName: 'Nagios D01 Adapter',
    category: 'Infrastructure',
    instanceKey: 'd01',
    sourceTool: 'nagios-d01',
    status: 'active',
  },
  {
    key: 'nagios-d02',
    label: 'Nagios D02',
    adapterName: 'Nagios D02 Adapter',
    category: 'Infrastructure',
    instanceKey: 'd02',
    sourceTool: 'nagios-d02',
    status: 'active',
  },
  {
    key: 'oracle-apex',
    label: 'Oracle APEX',
    adapterName: 'Oracle APEX Adapter',
    category: 'Business Platform',
    sourceTool: 'oracle-apex',
    status: 'active',
  },
  {
    key: 'payment-gateway',
    label: 'ABC Payment Gateway',
    adapterName: 'Payment Gateway Adapter',
    category: 'Business Platform',
    sourceTool: 'payment-gateway',
    status: 'active',
  },
  {
    key: 'appdynamics',
    label: 'AppDynamics',
    adapterName: 'AppDynamics Adapter',
    category: 'Application Performance',
    sourceTool: 'appdynamics',
    status: 'active',
  },
  {
    key: 'grafana',
    label: 'Grafana',
    adapterName: 'Grafana Adapter',
    category: 'Observability',
    sourceTool: 'grafana',
    status: 'active',
  },
  {
    key: 'abc-hub',
    label: 'ABC Hub',
    adapterName: 'ABC Hub Adapter',
    category: 'Internal Platform',
    sourceTool: 'ABC Hub',
    status: 'active',
  },
];

const STATUS_RANK = {
  critical: 6,
  down: 6,
  unreachable: 6,
  warning: 5,
  unknown: 4,
  pending: 3,
  ok: 1,
  up: 1,
};

function getToolDefinition(toolKey) {
  const normalized = String(toolKey || '').toLowerCase();
  const definition = TOOL_DEFINITIONS.find((tool) => tool.key === normalized);

  if (!definition) {
    const error = new Error(`Unsupported monitoring tool: ${toolKey}`);
    error.status = 404;
    throw error;
  }

  return definition;
}

function mapSeverity(status) {
  if (['critical', 'down', 'unreachable'].includes(status)) {
    return 'critical';
  }

  if (status === 'warning') {
    return 'warning';
  }

  if (status === 'unknown') {
    return 'medium';
  }

  return 'low';
}

function worstStatus(rows) {
  return rows.reduce((current, row) => {
    const currentRank = STATUS_RANK[current] || 0;
    const rowRank = STATUS_RANK[row.status] || 0;

    return rowRank > currentRank ? row.status : current;
  }, rows.length ? rows[0].status : 'pending');
}

function buildStatusCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, {});
}

function buildSeverityCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.severity] = (counts[row.severity] || 0) + 1;
    return counts;
  }, {});
}

function normalizeRecordRow(row) {
  return {
    id: row.id,
    sourceTool: row.source_tool,
    environment: row.environment,
    applicationName: row.application_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    details: row.details,
    acknowledged: row.acknowledged,
    lastCheck: row.last_check,
    updatedAt: row.updated_at,
    rawPayload: row.raw_payload || {},
    deepLink: row.deep_link,
    customProperties: row.custom_properties || {},
  };
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

    CREATE INDEX IF NOT EXISTS idx_monitoring_records_tool_app
      ON monitoring_records(source_tool, application_name);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_status
      ON monitoring_records(source_tool, status);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_updated
      ON monitoring_records(source_tool, updated_at DESC);
  `);
}

function buildNagiosDeepLink(snapshot, hostName, serviceDescription) {
  const baseUrl = snapshot.instance?.nagiosUrl;

  if (!baseUrl) {
    return null;
  }

  const suffix = serviceDescription
    ? `/includes/components/xicore/status.php?show=services&host=${encodeURIComponent(hostName)}`
    : `/includes/components/xicore/status.php?show=hosts&host=${encodeURIComponent(hostName)}`;

  return `${String(baseUrl).replace(/\/+$/, '')}${suffix}`;
}

function mapNagiosHost(snapshot, tool, host) {
  return {
    sourceTool: tool.sourceTool,
    environment: 'production',
    applicationName: host.hostName,
    entityType: 'host',
    entityId: host.hostName,
    status: host.status,
    severity: mapSeverity(host.status),
    summary: `${host.displayName || host.hostName} host status is ${host.status}`,
    details: host.pluginOutput || '',
    acknowledged: Boolean(host.acknowledged),
    lastCheck: host.lastCheck,
    updatedAt: host.updatedAt || host.lastPolledAt || new Date().toISOString(),
    rawPayload: host.rawPayload || {},
    deepLink: buildNagiosDeepLink(snapshot, host.hostName),
    customProperties: {
      address: host.address,
      currentState: host.currentState,
      stateType: host.stateType,
      durationSeconds: host.durationSeconds,
      attemptCount: host.attemptCount,
      isFlapping: host.isFlapping,
      inDowntime: host.inDowntime,
      downtimeDepth: host.downtimeDepth,
      lastStateChange: host.lastStateChange,
      sourceInstance: tool.instanceKey,
    },
  };
}

function mapNagiosService(snapshot, tool, service) {
  return {
    sourceTool: tool.sourceTool,
    environment: 'production',
    applicationName: service.hostName,
    entityType: 'service',
    entityId: `${service.hostName}::${service.serviceDescription}`,
    status: service.status,
    severity: mapSeverity(service.status),
    summary: `${service.serviceDescription} is ${service.status}`,
    details: service.pluginOutput || '',
    acknowledged: Boolean(service.acknowledged),
    lastCheck: service.lastCheck,
    updatedAt: service.updatedAt || service.lastPolledAt || new Date().toISOString(),
    rawPayload: service.rawPayload || {},
    deepLink: buildNagiosDeepLink(snapshot, service.hostName, service.serviceDescription),
    customProperties: {
      hostName: service.hostName,
      serviceDescription: service.serviceDescription,
      currentState: service.currentState,
      stateType: service.stateType,
      durationSeconds: service.durationSeconds,
      attemptCount: service.attemptCount,
      isFlapping: service.isFlapping,
      performanceData: service.performanceData,
      inDowntime: service.inDowntime,
      downtimeDepth: service.downtimeDepth,
      lastStateChange: service.lastStateChange,
      sourceInstance: tool.instanceKey,
    },
  };
}

async function upsertMonitoringRecords(records) {
  await ensureMonitoringStorage();

  for (const record of records) {
    await db.query(
      `
        INSERT INTO monitoring_records (
          source_tool,
          environment,
          application_name,
          entity_type,
          entity_id,
          status,
          severity,
          summary,
          details,
          acknowledged,
          last_check,
          updated_at,
          raw_payload,
          deep_link,
          custom_properties
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,NOW()),$13::jsonb,$14,$15::jsonb)
        ON CONFLICT (source_tool, entity_type, entity_id)
        DO UPDATE SET
          environment = EXCLUDED.environment,
          application_name = EXCLUDED.application_name,
          status = EXCLUDED.status,
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          acknowledged = EXCLUDED.acknowledged,
          last_check = EXCLUDED.last_check,
          updated_at = COALESCE(EXCLUDED.updated_at, NOW()),
          raw_payload = EXCLUDED.raw_payload,
          deep_link = EXCLUDED.deep_link,
          custom_properties = EXCLUDED.custom_properties
      `,
      [
        record.sourceTool,
        record.environment,
        record.applicationName,
        record.entityType,
        record.entityId,
        record.status,
        record.severity,
        record.summary,
        record.details,
        record.acknowledged,
        record.lastCheck,
        record.updatedAt,
        JSON.stringify(record.rawPayload || {}),
        record.deepLink,
        JSON.stringify(record.customProperties || {}),
      ],
    );
  }
}

async function syncNagiosTool(tool) {
  const snapshot = await nagiosService.getInstanceSnapshot(tool.instanceKey);
  const records = [
    ...(snapshot.hosts || []).map((host) => mapNagiosHost(snapshot, tool, host)),
    ...(snapshot.services || []).map((service) => mapNagiosService(snapshot, tool, service)),
  ];

  await upsertMonitoringRecords(records);

  return snapshot;
}

async function listTools() {
  return TOOL_DEFINITIONS.map((tool) => ({
    key: tool.key,
    label: tool.label,
    adapterName: tool.adapterName,
    category: tool.category,
    status: tool.status,
  }));
}

async function listNagiosApplications(tool) {
  await syncNagiosTool(tool);

  const result = await db.query(
    `
      WITH app_status AS (
        SELECT application_name, status, COUNT(*)::int AS status_count
        FROM monitoring_records
        WHERE source_tool = $1
        GROUP BY application_name, status
      ),
      app_meta AS (
        SELECT
          application_name,
          COUNT(*)::int AS record_count,
          MAX(updated_at) AS last_updated_at,
          BOOL_OR(acknowledged) AS has_acknowledged
        FROM monitoring_records
        WHERE source_tool = $1
        GROUP BY application_name
      )
      SELECT
        app_meta.application_name,
        app_meta.record_count,
        app_meta.last_updated_at,
        app_meta.has_acknowledged,
        COALESCE(JSONB_OBJECT_AGG(app_status.status, app_status.status_count), '{}'::jsonb) AS status_counts
      FROM app_meta
      LEFT JOIN app_status ON app_status.application_name = app_meta.application_name
      GROUP BY app_meta.application_name, app_meta.record_count, app_meta.last_updated_at, app_meta.has_acknowledged
      ORDER BY application_name
      LIMIT 2000
    `,
    [tool.sourceTool],
  );

  return result.rows.map((row) => {
    const statusCounts = row.status_counts || {};
    const statuses = Object.keys(statusCounts);
    const status = worstStatus(statuses.map((item) => ({ status: item })));

    return {
      id: row.application_name,
      label: row.application_name,
      entityType: 'host',
      recordCount: row.record_count,
      status,
      statusCounts,
      lastUpdatedAt: row.last_updated_at,
      acknowledged: row.has_acknowledged,
    };
  });
}

async function listGrafanaApplications() {
  const data = await grafanaDashboardService.listDashboards();

  return (data.dashboards || []).map((dashboard) => ({
    id: dashboard.uid,
    label: dashboard.title,
    entityType: 'dashboard',
    recordCount: dashboard.panelCount || 0,
    status: 'ok',
    statusCounts: { ok: dashboard.panelCount || 0 },
    lastUpdatedAt: dashboard.lastUpdatedAt || dashboard.updatedAt || dashboard.lastSyncedAt,
    lastRefreshedAt: dashboard.lastRefreshedAt || dashboard.lastSyncedAt,
    deepLink: dashboard.dashboardUrl,
    dashboardName: dashboard.dashboardName || dashboard.title,
    dashboardUid: dashboard.uid,
    dashboardSubname: dashboard.folderTitle || 'General',
    panelCount: dashboard.panelCount || 0,
    panelTitles: dashboard.panelTitles || [],
    tags: dashboard.tags || [],
    metadata: {
      folderTitle: dashboard.folderTitle,
      folderUid: dashboard.folderUid,
      datasourceNames: dashboard.datasourceNames || [],
      panels: dashboard.panels || [],
    },
  }));
}

function buildThousandEyesListProperties(properties = {}) {
  const { historicalMetrics, ...summaryProperties } = properties || {};

  return summaryProperties;
}

async function listApplications(toolKey) {
  const tool = getToolDefinition(toolKey);

  if (tool.instanceKey) {
    return listNagiosApplications(tool);
  }

  if (tool.key === 'grafana') {
    return listGrafanaApplications();
  }

  if (tool.key === 'thousandeyes') {
    return listThousandEyesApplications(tool);
  }

  if (tool.key === 'appdynamics') {
    return appDynamicsService.listApplications();
  }

  if (tool.key === 'abc-hub') {
    return abcHubService.listModules();
  }

  if (tool.key === 'oracle-apex') {
    return oracleApexService.listApplications();
  }

  if (tool.key === 'payment-gateway') {
    return paymentGatewayService.listApplications();
  }

  await ensureMonitoringStorage();
  const result = await db.query(
    `
      SELECT application_name, COUNT(*)::int AS record_count, MAX(updated_at) AS last_updated_at
      FROM monitoring_records
      WHERE source_tool = $1
      GROUP BY application_name
      ORDER BY application_name
      LIMIT 1000
    `,
    [tool.sourceTool],
  );

  return result.rows.map((row) => ({
    id: row.application_name,
    label: row.application_name,
    entityType: 'application',
    recordCount: row.record_count,
    status: 'unknown',
    statusCounts: {},
    lastUpdatedAt: row.last_updated_at,
  }));
}

async function listThousandEyesApplications(tool) {
  await ensureMonitoringStorage();

  const cachedCount = await db.query(
    'SELECT COUNT(*)::int AS count FROM monitoring_records WHERE source_tool = $1',
    [tool.sourceTool],
  );

  if (Number(cachedCount.rows[0]?.count || 0) === 0) {
    try {
      await thousandEyesService.syncThousandEyesData();
    } catch {
      // Keep the Monitoring page cache-first. Connection errors should not hide
      // previously synced ThousandEyes records.
    }
  }

  const result = await db.query(
    `
      SELECT
          entity_id,
          application_name,
          1::int AS record_count,
          status,
          severity,
          last_check,
          updated_at,
          deep_link,
          custom_properties,
          acknowledged,
          jsonb_build_object(status, 1) AS status_counts
      FROM monitoring_records
      WHERE source_tool = $1
          AND entity_type = 'test'
      ORDER BY updated_at DESC NULLS LAST, application_name
      LIMIT 5000
    `,
    [tool.sourceTool],
  );

  return result.rows.map((row) => {
    const statusCounts = row.status_counts || {};

    return {
      id: row.entity_id,
      label: row.application_name,
      entityType: 'test',
      recordCount: row.record_count,
      status: row.status || 'unknown',
      severity: row.severity || 'low',
      statusCounts,
      lastUpdatedAt: row.updated_at,
      lastCheck: row.last_check,
      deepLink: row.deep_link,
      acknowledged: row.acknowledged,
      metadata: {
        entityTypes: ['test'],
        customProperties: buildThousandEyesListProperties(row.custom_properties || {}),
        latestStatus: row.status,
        latestSeverity: row.severity,
      },
    };
  });
}

function buildSummary(records) {
  return {
    total: records.length,
    status: worstStatus(records),
    statusCounts: buildStatusCounts(records),
    severityCounts: buildSeverityCounts(records),
    acknowledged: records.filter((record) => record.acknowledged).length,
    inDowntime: records.filter((record) => record.customProperties?.inDowntime).length,
    problems: records.filter((record) => !['ok', 'up', 'pending'].includes(record.status)).length,
    lastCheck: records
      .map((record) => record.lastCheck)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  };
}

function buildKeyMetrics(records, extra = {}) {
  const hostCount = records.filter((record) => record.entityType === 'host').length;
  const serviceCount = records.filter((record) => record.entityType === 'service').length;
  const problemCount = records.filter((record) => !['ok', 'up', 'pending'].includes(record.status)).length;

  return [
    { label: 'Hosts', value: hostCount },
    { label: 'Services / Panels', value: serviceCount || extra.panelCount || 0 },
    { label: 'Problem records', value: problemCount },
    { label: 'Acknowledged', value: records.filter((record) => record.acknowledged).length },
  ];
}

function buildThousandEyesKeyMetrics(records) {
  const testRecord = records.find((record) => record.entityType === 'test') || {};
  const custom = testRecord.customProperties || {};

  return [
    { label: 'Alerts', value: custom.alertCount ?? records.filter((record) => record.entityType === 'alert').length },
    { label: 'Active alerts', value: custom.activeAlerts ?? records.filter((record) => record.entityType === 'alert' && record.status !== 'ok').length },
    { label: 'Tests', value: records.filter((record) => record.entityType === 'test').length },
    { label: 'Availability', value: custom.availability !== null && custom.availability !== undefined ? `${custom.availability}%` : 'Not available' },
    { label: 'Errors', value: custom.errorCount ?? 'Not available' },
    { label: 'Response time', value: custom.responseTime !== null && custom.responseTime !== undefined ? `${custom.responseTime} ms` : 'Not available' },
    { label: 'Packet loss', value: custom.packetLoss !== null && custom.packetLoss !== undefined ? `${custom.packetLoss}%` : 'Not available' },
    { label: 'Problem records', value: records.filter((record) => !['ok', 'up', 'pending'].includes(record.status)).length },
  ];
}

async function getThousandEyesDetails(tool, entityId) {
  await ensureMonitoringStorage();
  const testResult = await db.query(
    'SELECT * FROM monitoring_records WHERE source_tool = $1 AND entity_type = $2 AND entity_id = $3 LIMIT 1',
    [tool.sourceTool, 'test', entityId],
  );
  const testRecord = testResult.rows[0] ? normalizeRecordRow(testResult.rows[0]) : null;
  const testId = testRecord?.customProperties?.testId || entityId;
  const testName = testRecord?.applicationName || entityId;
  const result = await db.query(
    `
      SELECT *
      FROM monitoring_records
      WHERE source_tool = $1
        AND (
          entity_id = $2
          OR custom_properties->>'testId' = $2
          OR application_name = $3
          OR custom_properties->>'testName' = $3
        )
      ORDER BY
        CASE entity_type WHEN 'test' THEN 0 WHEN 'alert' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 500
    `,
    [tool.sourceTool, testId, testName],
  );
  const records = result.rows.map(normalizeRecordRow);

  return {
    tool: {
      key: tool.key,
      label: tool.label,
      adapterName: tool.adapterName,
    },
    application: {
      id: entityId,
      label: testName,
      entityType: 'test',
    },
    kind: 'monitoring_records',
    summary: buildSummary(records),
    keyMetrics: buildThousandEyesKeyMetrics(records),
    entities: records,
    activeProblems: [],
    recentEvents: [],
    deepLink: testRecord?.deepLink || records[0]?.deepLink || null,
    lastUpdatedAt: records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
  };
}

async function getNagiosDetails(tool, entityId) {
  const snapshot = await syncNagiosTool(tool);
  const result = await db.query(
    `
      SELECT *
      FROM monitoring_records
      WHERE source_tool = $1 AND application_name = $2
      ORDER BY
        CASE entity_type WHEN 'host' THEN 0 ELSE 1 END,
        CASE status
          WHEN 'critical' THEN 0
          WHEN 'down' THEN 0
          WHEN 'unreachable' THEN 0
          WHEN 'warning' THEN 1
          WHEN 'unknown' THEN 2
          WHEN 'pending' THEN 3
          ELSE 4
        END,
        summary
    `,
    [tool.sourceTool, entityId],
  );
  const records = result.rows.map(normalizeRecordRow);
  const recentEvents = (snapshot.events || [])
    .filter((event) => event.hostName === entityId)
    .slice(0, 50);
  const activeProblems = (snapshot.problems || [])
    .filter((problem) => problem.hostName === entityId)
    .slice(0, 50);
  const downtime = (snapshot.downtime || [])
    .filter((entry) => entry.hostName === entityId)
    .slice(0, 50);
  const aiFeatures = (snapshot.aiFeatures || [])
    .filter((feature) => feature.entityId === `host:${entityId}` || String(feature.entityId || '').includes(`${entityId}:`) || feature.rawPayloadReference?.includes(entityId))
    .slice(0, 50);

  return {
    tool: {
      key: tool.key,
      label: tool.label,
      adapterName: tool.adapterName,
    },
    application: {
      id: entityId,
      label: entityId,
      entityType: 'host',
    },
    kind: 'monitoring_records',
    summary: buildSummary(records),
    keyMetrics: tool.key === 'thousandeyes' ? buildThousandEyesKeyMetrics(records) : buildKeyMetrics(records),
    entities: records,
    activeProblems,
    recentEvents,
    downtime,
    aiFeatures,
    connectorHealth: snapshot.connectorHealth,
    syncStatistics: snapshot.syncStatistics,
    syncLogs: snapshot.syncLogs || [],
    pollHistory: snapshot.pollHistory || [],
    deepLink: records.find((record) => record.entityType === 'host')?.deepLink || records[0]?.deepLink || snapshot.instance?.nagiosUrl,
    lastUpdatedAt: records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
  };
}

function flattenGrafanaPanels(panels = []) {
  const result = [];

  panels.forEach((panel) => {
    if (!panel || typeof panel !== 'object') {
      return;
    }

    if (panel.type !== 'row') {
      result.push(panel);
    }

    if (Array.isArray(panel.panels)) {
      result.push(...flattenGrafanaPanels(panel.panels));
    }
  });

  return result;
}

function getPanelDatasource(panel) {
  const datasource = panel.datasource || panel.targets?.find((target) => target.datasource)?.datasource;

  if (!datasource) {
    return 'Default datasource';
  }

  if (typeof datasource === 'string') {
    return datasource;
  }

  return datasource.name || datasource.uid || datasource.type || 'Datasource';
}

function getPanelQuerySummary(panel) {
  const target = panel.targets?.[0];

  if (!target) {
    return 'No query metadata stored';
  }

  return target.queryType || target.expr || target.metric || target.refId || target.measurement || 'Query metadata stored';
}

async function getGrafanaDetails(tool, dashboardUid) {
  const dashboard = await grafanaDashboardService.getDashboard(dashboardUid);

  if (!dashboard) {
    const error = new Error(`Grafana dashboard ${dashboardUid} was not found.`);
    error.status = 404;
    throw error;
  }

  const panels = dashboard.normalizedPanels?.length
    ? dashboard.normalizedPanels.map((panel) => ({
      id: panel.panelId,
      uid: panel.panelUid,
      title: panel.panelTitle || panel.title,
      type: panel.type,
      order: panel.order,
      datasource: panel.datasource,
      targets: panel.targets || [],
      gridPos: panel.gridPos || {},
      rawPayload: panel.rawPayload || {},
      querySummary: panel.querySummary,
      deepLink: panel.deepLink,
    }))
    : flattenGrafanaPanels(dashboard.dashboard?.panels || []);
  const records = panels.map((panel) => ({
    sourceTool: tool.sourceTool,
    environment: 'production',
    applicationName: dashboard.title,
    entityType: 'panel',
    entityId: String(panel.id),
    status: 'ok',
    severity: 'low',
    summary: panel.title || `Panel ${panel.id}`,
    details: panel.querySummary || getPanelQuerySummary(panel),
    acknowledged: false,
    lastCheck: dashboard.lastSyncedAt,
    updatedAt: dashboard.updatedAt || dashboard.lastSyncedAt,
    rawPayload: panel.rawPayload || panel,
    deepLink: panel.deepLink || dashboard.dashboardUrl,
    customProperties: {
      panelType: panel.type,
      datasource: panel.datasource || getPanelDatasource(panel),
    },
  }));

  return {
    tool: {
      key: tool.key,
      label: tool.label,
      adapterName: tool.adapterName,
    },
    application: {
      id: dashboard.uid,
      label: dashboard.title,
      entityType: 'dashboard',
    },
    kind: 'grafana_dashboard',
    summary: {
      ...buildSummary(records),
      status: 'ok',
    },
    keyMetrics: [
      { label: 'Panels', value: panels.length },
      { label: 'Datasources', value: dashboard.datasourceNames?.length || 0 },
      { label: 'Alert rules', value: dashboard.alertRules?.length || 0 },
      { label: 'AI feature rows', value: dashboard.aiFeatures?.length || 0 },
      { label: 'Folder', value: dashboard.folderTitle || 'General' },
      { label: 'Refresh interval', value: dashboard.refreshInterval || 'Not set' },
    ],
    entities: records,
    activeProblems: dashboard.alertStates || [],
    recentEvents: dashboard.alertRules || [],
    deepLink: dashboard.dashboardUrl,
    lastUpdatedAt: dashboard.updatedAt || dashboard.lastSyncedAt,
    dashboard,
  };
}

async function getDetails(toolKey, entityId, options = {}) {
  const tool = getToolDefinition(toolKey);

  if (!entityId) {
    const error = new Error('Application / entity is required.');
    error.status = 400;
    throw error;
  }

  if (tool.instanceKey) {
    return getNagiosDetails(tool, entityId);
  }

  if (tool.key === 'grafana') {
    const details = await getGrafanaDetails(tool, entityId);

    return {
      ...details,
      timeRange: {
        from: options.from || 'now-6h',
        to: options.to || 'now',
      },
    };
  }

  if (tool.key === 'thousandeyes') {
    return getThousandEyesDetails(tool, entityId);
  }

  if (tool.key === 'appdynamics') {
    return appDynamicsService.getApplicationDetails(entityId);
  }

  if (tool.key === 'abc-hub') {
    return abcHubService.getModuleDetails(entityId, options);
  }

  if (tool.key === 'oracle-apex') {
    return oracleApexService.getDashboardDetails(options);
  }

  if (tool.key === 'payment-gateway') {
    return paymentGatewayService.getDashboardDetails(options);
  }

  await ensureMonitoringStorage();
  const result = await db.query(
    'SELECT * FROM monitoring_records WHERE source_tool = $1 AND application_name = $2 ORDER BY updated_at DESC LIMIT 500',
    [tool.sourceTool, entityId],
  );
  const records = result.rows.map(normalizeRecordRow);

  return {
    tool: {
      key: tool.key,
      label: tool.label,
      adapterName: tool.adapterName,
    },
    application: {
      id: entityId,
      label: entityId,
      entityType: 'application',
    },
    kind: 'monitoring_records',
    summary: buildSummary(records),
    keyMetrics: tool.key === 'thousandeyes' ? buildThousandEyesKeyMetrics(records) : buildKeyMetrics(records),
    entities: records,
    activeProblems: [],
    recentEvents: [],
    deepLink: records[0]?.deepLink || null,
    lastUpdatedAt: records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
  };
}

module.exports = {
  ensureMonitoringStorage,
  getDetails,
  listApplications,
  listTools,
};

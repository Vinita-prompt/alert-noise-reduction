const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:4000/api';
let authenticatedCsrfToken = null;

export function getApiBaseUrl() {
  return API_BASE_URL;
}

async function request(path, options = {}) {
  const { returnPayload = false, ...fetchOptions } = options;
  let response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      cache: 'no-store',
      ...fetchOptions,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    });
  } catch {
    const connectionError = new Error(
      `Backend connection failed. The CommandCenter API is not reachable at ${API_BASE_URL}.`,
    );
    connectionError.code = 'BACKEND_CONNECTION_FAILED';
    throw connectionError;
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || `Request failed with status ${response.status}`;
    const requestError = new Error(message);
    requestError.status = response.status;
    requestError.code = payload?.code || null;
    requestError.details = payload?.details || null;
    throw requestError;
  }

  return returnPayload ? payload : payload?.data ?? payload;
}

export function getAlerts(params = {}) {
  const searchParams = new URLSearchParams({ feed: 'canonical' });

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/alerts${query ? `?${query}` : ''}`);
}

export async function getAlertsResponse(params = {}) {
  const searchParams = new URLSearchParams({ feed: 'canonical' });

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();
  const payload = await request(`/alerts${query ? `?${query}` : ''}`, {
    returnPayload: true,
  });

  return {
    data: payload?.items || payload?.data?.items || payload?.data || [],
    meta: payload?.meta || {
      totalCount: payload?.totalCount,
      filteredCount: payload?.filteredCount,
      totalPages: payload?.totalPages,
      currentPage: payload?.currentPage,
      pageSize: payload?.pageSize,
      updatedAt: payload?.updatedAt,
    },
  };
}

export function getAlertTrend(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/alerts/trend${query ? `?${query}` : ''}`);
}

export function getSourceDashboardSummary() {
  return request('/alerts/sources/summary');
}

export function getAlertById(id) {
  return request(`/alerts/${encodeURIComponent(id)}`);
}

export function getAlertActivity(id) {
  return request(`/alerts/${encodeURIComponent(id)}/activity`);
}

export function classifyAlerts(payload = {}) {
  return request('/alerts/classify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function processAlert(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/process`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function applyAlertAction(id, action) {
  return request(`/alerts/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export function acknowledgeAlert(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function addAlertNote(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/notes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function assignAlertResponder(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/assign`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function closeOperationsAlert(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createJiraTicketForAlert(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/jira-ticket`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function linkJiraIncident(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/link-jira`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function escalateAlert(id, payload = {}) {
  return request(`/alerts/${encodeURIComponent(id)}/escalate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function incidentPath(path = '', params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return `/incidents${path}${query ? `?${query}` : ''}`;
}

export function getIncidents(params = {}) {
  return request(incidentPath('', params), { cache: 'no-store' });
}

export function getIncidentSummary(params = {}) {
  return request(incidentPath('/summary', params), { cache: 'no-store' });
}

export function getIncidentDailyCounts(params = {}) {
  return request(incidentPath('/daily-counts', params), { cache: 'no-store' });
}

export function getIncidentByKey(key) {
  return request(`/incidents/${encodeURIComponent(key)}`);
}

function accJiraPath(path, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `/jira/acc${path}${query ? `?${query}` : ''}`;
}

export function getAccProblems(params = {}) {
  return request(accJiraPath('/problems', params), { cache: 'no-store' });
}

export function getAccIssue(key) {
  return request(accJiraPath(`/issues/${encodeURIComponent(key)}`));
}

export function getAccIssueComments(key) {
  return request(accJiraPath(`/issues/${encodeURIComponent(key)}/comments`));
}

export function getAccIssueChangelog(key) {
  return request(accJiraPath(`/issues/${encodeURIComponent(key)}/changelog`));
}

export function getRules() {
  return request('/rules');
}

export function updateRule(id, payload) {
  return request(`/rules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function getSystemHealth() {
  return request('/health');
}

export function getSettingsIntegrations() {
  return request('/settings/integrations');
}

export function updateSettingsIntegration(name, payload) {
  return request(`/settings/integrations/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function testSettingsIntegration(name) {
  return request(`/settings/integrations/${encodeURIComponent(name)}/test`, {
    method: 'POST',
  });
}

export function syncSettingsIntegration(name, payload = {}) {
  return request(`/settings/integrations/${encodeURIComponent(name)}/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function connectAppDynamics() {
  return request('/appdynamics/connect', {
    method: 'POST',
  });
}

function appDynamicsWorkspacePath(path, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `/appdynamics/workspace${path}${query ? `?${query}` : ''}`;
}

export function getAppDynamicsWorkspaceApplications(params = {}) {
  return request(appDynamicsWorkspacePath('/applications', params));
}

export function getAppDynamicsWorkspaceApplication(applicationId, params = {}) {
  return request(appDynamicsWorkspacePath(`/applications/${encodeURIComponent(applicationId)}`, params));
}

export function disconnectAppDynamics() {
  return request('/appdynamics/disconnect', {
    method: 'POST',
  });
}

export function updatePaymentGatewaySettings(payload) {
  return request('/settings/integrations/payment-gateway', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function testPaymentGatewaySettings() {
  return request('/settings/integrations/payment-gateway/test', {
    method: 'POST',
  });
}

export function syncPaymentGatewaySettings(payload = {}) {
  return request('/settings/integrations/payment-gateway/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getIntegrations() {
  return request('/integrations');
}

export function createIntegration(tool, payload) {
  return request(`/integrations/${encodeURIComponent(tool)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateIntegration(tool, payload) {
  return request(`/integrations/${encodeURIComponent(tool)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteIntegration(tool) {
  return request(`/integrations/${encodeURIComponent(tool)}`, {
    method: 'DELETE',
  });
}

export function testIntegration(tool) {
  return request(`/integrations/${encodeURIComponent(tool)}/test`, {
    method: 'POST',
  });
}

export function runIngestion(tool) {
  return request(`/ingestion/${encodeURIComponent(tool)}/run`, {
    method: 'POST',
  });
}

export function getMonitoringIntegrations() {
  return request('/ingestion/sources');
}

export function getMonitoringTools() {
  return request('/monitoring/tools');
}

export function getMonitoringEntities(tool) {
  return request(`/monitoring/${encodeURIComponent(tool)}/entities`);
}

export function getMonitoringDetails(tool, entityId, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/monitoring/${encodeURIComponent(tool)}/entities/${encodeURIComponent(entityId)}${query ? `?${query}` : ''}`);
}

function thousandEyesWorkspacePath(path, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `/thousandeyes/workspace${path}${query ? `?${query}` : ''}`;
}

export function getThousandEyesDashboard(params = {}) {
  return request(thousandEyesWorkspacePath('/dashboard', params));
}

export function getThousandEyesTest(testId, params = {}) {
  return request(thousandEyesWorkspacePath(`/tests/${encodeURIComponent(testId)}`, params));
}

export function getThousandEyesEvents(params = {}) {
  return request(thousandEyesWorkspacePath('/events', params));
}

export function getThousandEyesEvent(eventId) {
  return request(thousandEyesWorkspacePath(`/events/${encodeURIComponent(eventId)}`));
}

export function getThousandEyesAlerts(params = {}) {
  return request(thousandEyesWorkspacePath('/alerts', params));
}

export function getThousandEyesAlert(alertId, params = {}) {
  return request(thousandEyesWorkspacePath(`/alerts/${encodeURIComponent(alertId)}`, params));
}

export function getThousandEyesAgent(agentId, params = {}) {
  return request(thousandEyesWorkspacePath(`/agents/${encodeURIComponent(agentId)}`, params));
}

export function importAbcHubDaemonMonitor(payload) {
  return request('/abc-hub/import/daemon-monitor', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function importPaymentGatewayTransactions(payload) {
  return request('/import/payment-gateway', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function importOracleApexPayload(payload) {
  return request('/oracle-apex/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getPaymentGatewayTransactions(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/payment-gateway/transactions${query ? `?${query}` : ''}`, {
    returnPayload: true,
  });
}

function grafanaWorkspacePath(path, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `/grafana/workspace${path}${query ? `?${query}` : ''}`;
}

export function getGrafanaWorkspaceStatus(params = {}) {
  return request(grafanaWorkspacePath('/status', params));
}

export function getGrafanaWorkspaceOverview(params = {}) {
  return request(grafanaWorkspacePath('/overview', params));
}

export function getGrafanaWorkspaceDashboards(params = {}) {
  return request(grafanaWorkspacePath('/dashboards', params));
}

export function getGrafanaWorkspaceDashboard(uid, params = {}) {
  return request(grafanaWorkspacePath(`/dashboards/${encodeURIComponent(uid)}`, params));
}

export function getGrafanaWorkspacePanelData(uid, panelId, params = {}, options = {}) {
  const normalized = { ...params };
  const variables = normalized.variables;
  delete normalized.variables;
  if (variables && typeof variables === 'object') {
    Object.entries(variables).forEach(([name, value]) => {
      if (value !== undefined && value !== null && value !== '') normalized[`var-${name}`] = value;
    });
  }
  return request(grafanaWorkspacePath(`/dashboards/${encodeURIComponent(uid)}/panels/${encodeURIComponent(panelId)}/data`, normalized), options);
}

export function getGrafanaWorkspacePanelRenderUrl(uid, panelId, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (key === 'variables' && value && typeof value === 'object') {
      Object.entries(value).forEach(([variableName, variableValue]) => {
        if (variableValue !== undefined && variableValue !== null && variableValue !== '') {
          searchParams.set(`var-${variableName}`, String(variableValue));
        }
      });
      return;
    }

    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `${API_BASE_URL}/grafana/workspace/dashboards/${encodeURIComponent(uid)}/panels/${encodeURIComponent(panelId)}/render${query ? `?${query}` : ''}`;
}

export function getGrafanaWorkspaceFolders(params = {}) {
  return request(grafanaWorkspacePath('/folders', params));
}

export function getGrafanaWorkspaceAlertRules(params = {}) {
  return request(grafanaWorkspacePath('/alert-rules', params));
}

export function getGrafanaWorkspaceAlertRule(uid, params = {}) {
  return request(grafanaWorkspacePath(`/alert-rules/${encodeURIComponent(uid)}`, params));
}

export function getGrafanaWorkspaceActiveAlerts(params = {}) {
  return request(grafanaWorkspacePath('/active-alerts', params));
}

export function getGrafanaDashboards(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/grafana/dashboards${query ? `?${query}` : ''}`);
}

export function getGrafanaFolders() {
  return request('/grafana/folders');
}

export function getGrafanaFolderDashboards(folderUid, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/grafana/folders/${encodeURIComponent(folderUid)}/dashboards${query ? `?${query}` : ''}`);
}

export function getGrafanaDashboardPanels(uid) {
  return request(`/grafana/dashboards/${encodeURIComponent(uid)}/panels`);
}

export function getGrafanaDashboardMetrics(uid, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/grafana/dashboards/${encodeURIComponent(uid)}/metrics${query ? `?${query}` : ''}`);
}

export function getGrafanaAlerts(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/grafana/alerts${query ? `?${query}` : ''}`);
}

export function getGrafanaAlertRules(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== 'all') {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/grafana/alert-rules${query ? `?${query}` : ''}`);
}

export function syncGrafanaDashboards(payload = {}) {
  return request('/grafana/dashboards/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function syncGrafanaAlertRules(payload = {}) {
  return request('/grafana/alert-rules/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getGrafanaSyncLogs(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/grafana/sync-logs${query ? `?${query}` : ''}`);
}

export function getGrafanaPanelRenderUrl(uid, panelId, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return `${API_BASE_URL}/grafana/dashboards/${encodeURIComponent(uid)}/panels/${encodeURIComponent(panelId)}/render${query ? `?${query}` : ''}`;
}

export function getNagiosSnapshot(instance) {
  return request(`/nagios/${encodeURIComponent(instance)}`);
}

export function getNagiosWorkspace(instance, options = {}) {
  const searchParams = new URLSearchParams();

  if (options.refresh) {
    searchParams.set('refresh', '1');
  }

  const query = searchParams.toString();
  return request(`/nagios/${encodeURIComponent(instance)}/workspace${query ? `?${query}` : ''}`);
}

export function getNagiosWorkspaceRecords(instance, entityType, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return request(`/nagios/${encodeURIComponent(instance)}/workspace/records/${encodeURIComponent(entityType)}${query ? `?${query}` : ''}`);
}

export function getNagiosWorkspaceRecord(instance, entityType, recordId) {
  return request(`/nagios/${encodeURIComponent(instance)}/workspace/records/${encodeURIComponent(entityType)}/${encodeURIComponent(recordId)}`);
}

export function getNagiosHealth(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/nagios/health${query ? `?${query}` : ''}`);
}

export function pollNagiosInstance(instance) {
  return request(`/nagios/${encodeURIComponent(instance)}/poll`, {
    method: 'POST',
  });
}

export function runMonitoringBackfill(source) {
  return request(`/ingestion/${encodeURIComponent(source)}/backfill`, {
    method: 'POST',
  });
}

export function runMonitoringSync(source) {
  return request(`/ingestion/${encodeURIComponent(source)}/sync`, {
    method: 'POST',
  });
}

export function getJiraStatus() {
  return request('/integrations/jira/status');
}

export function getAtlassianStatus() {
  return request('/integrations/atlassian/status');
}

export function testAtlassianConnection() {
  return request('/integrations/atlassian/test', {
    method: 'POST',
  });
}

export function syncAtlassianOps(payload = {}) {
  return request('/integrations/atlassian/ops/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getAtlassianOpsSyncRuns(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();

  return request(`/integrations/atlassian/ops/sync-runs${query ? `?${query}` : ''}`);
}

export function importJiraAlerts(payload = {}) {
  return request('/integrations/operations/alerts/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function importJiraIncidents(payload = {}) {
  return request('/integrations/jira/incidents/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function importSlackHistory(payload = {}) {
  return request('/integrations/slack/history/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function startSlackHistoryBackfill(payload = {}) {
  return request('/integrations/slack/history/backfill', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getSlackHistoryStatus() {
  return request('/integrations/slack/history/status');
}

export function syncSlackNotifications(payload = {}) {
  return request('/integrations/slack/history/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getSlackIngestionStatus() {
  return request('/slack/status');
}

export function getSlackMessages(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return request(`/slack/messages${query ? `?${query}` : ''}`);
}

export function getSlackDerivedAlerts(params = {}) {
  const searchParams = new URLSearchParams({ feed: 'slack-live' });

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return request(`/alerts${query ? `?${query}` : ''}`);
}

export function getAlertOccurrences(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/slack/alerts${query ? `?${query}` : ''}`);
}

export function getLiveArchivedAlerts(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/alerts/live${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getOperationalOverview() {
  return request('/summary', { cache: 'no-store' });
}

export function getSummary(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/summary${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getAlertOccurrence(id) {
  return request(`/slack/alerts/${encodeURIComponent(id)}`);
}

export function getVerificationReconciliation() {
  return request('/slack/alerts/verification-reconciliation');
}

export function getLiveAlertStreamUrl() {
  return `${API_BASE_URL}/alerts/stream`;
}

export function reportLiveAlertDelivery(id, frontendDeliveredAt) {
  return request(`/alerts/live/${encodeURIComponent(id)}/delivered`, {
    method: 'POST',
    body: JSON.stringify({ frontendDeliveredAt }),
  });
}

export function getSlackDerivedAlert(id) {
  return request(`/slack/alerts/${encodeURIComponent(id)}`);
}

export function getOperationsLiveAlerts(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return request(`/operations/live-alerts${query ? `?${query}` : ''}`);
}

export function getOperationsLiveAlert(id) {
  return request(`/operations/live-alerts/${encodeURIComponent(id)}`);
}

export function getOperationsLiveAlertActivity(id, params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/operations/live-alerts/${encodeURIComponent(id)}/activity${query ? `?${query}` : ''}`);
}

export function getOperationsLiveAlertNotes(id) {
  return request(`/operations/live-alerts/${encodeURIComponent(id)}/notes`);
}

export function getOperationsLiveAlertSlackContext(id) {
  return request(`/operations/live-alerts/${encodeURIComponent(id)}/slack-context`);
}

export function getOperationsLiveAlertStatus() {
  return request('/operations/live-alerts/status');
}

export function getNoiseAnalysis(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis${query ? `?${query}` : ''}`);
}

function learningDatasetPath(path, params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return `/noise-analysis/foundation${path}${query ? `?${query}` : ''}`;
}

export function getHistoricalLearningDataset(params = {}) {
  return request(learningDatasetPath('', params));
}

export function getHistoricalLearningDatasetSummary(params = {}) {
  return request(learningDatasetPath('/summary', params));
}

export function getHistoricalLearningRecord(alertId) {
  return request(learningDatasetPath(`/${encodeURIComponent(alertId)}`));
}

export function getAppDynamicsJiraOutcomeDataset(params = {}) {
  return request(learningDatasetPath('/appdynamics-jira-outcomes', params));
}

export function getAppDynamicsJiraOutcomeSummary() {
  return request(learningDatasetPath('/appdynamics-jira-outcomes/summary'));
}

export function getAppDynamicsJiraOutcomeRecord(alertId) {
  return request(learningDatasetPath(`/appdynamics-jira-outcomes/${encodeURIComponent(alertId)}`));
}

export function getLiveEvaluationCandidates(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/evaluation${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getEvaluationEpisodeDiagnostics() {
  return request('/evaluation/episodes', { cache: 'no-store' });
}

export function getPopulationReconciliation(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/evaluation/population-reconciliation${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getLiveEvaluationConnectivity({ refresh = false } = {}) {
  return request(`/evaluation/connectivity${refresh ? '?refresh=true' : ''}`, { cache: 'no-store' });
}

export function runLiveShadowEvaluation(alertId, { refresh = false } = {}) {
  const requestId = globalThis.crypto?.randomUUID?.() || `evaluation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request(`/evaluation/${encodeURIComponent(alertId)}/run`, {
    method: 'POST',
    body: JSON.stringify({ refresh }),
    headers: { 'X-Request-Id': requestId },
  });
}

export function getLiveShadowEvaluation(alertId) {
  return request(`/evaluation/${encodeURIComponent(alertId)}`, { cache: 'no-store' });
}

export function getLiveEvaluationFeedback(alertId) {
  return request(`/evaluation/${encodeURIComponent(alertId)}/feedback`);
}

export function getIncidentVerificationReport(alertId) {
  return request(`/evaluation/${encodeURIComponent(alertId)}/incident-report`, { cache: 'no-store' });
}

export function getEvidenceCollection(alertId) {
  return request(`/evidence/alerts/${encodeURIComponent(alertId)}`, { cache: 'no-store' });
}

export function refreshEvidenceCollection(alertId, value = {}) {
  return request(`/evidence/alerts/${encodeURIComponent(alertId)}/refresh`, {
    method: 'POST', body: JSON.stringify(value),
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
}

export function getEvidenceHistory(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/evidence/history${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getEvidenceBackfillQueue(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`/evidence/backfill${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function refreshEvidenceBackfill(limit = 250) {
  return request('/evidence/backfill/refresh', {
    method: 'POST', body: JSON.stringify({ limit }),
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
}

export function selectEvidenceBackfill(alertId) {
  return request(`/evidence/backfill/${encodeURIComponent(alertId)}/select`, {
    method: 'POST', body: JSON.stringify({}),
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
}

export function getEvidenceLearningSummary() {
  return request('/evidence/learning/summary', { cache: 'no-store' });
}

export function getEvidenceLearningEvaluation() {
  return request('/evidence/learning/evaluation', { cache: 'no-store' });
}

export function runEvidencePatternRecommendation(alertId) {
  return request(`/evidence/learning/recommendations/${encodeURIComponent(alertId)}`, {
    method: 'POST', body: JSON.stringify({}),
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
}

export function submitEvidenceCollection(alertId, value, { idempotencyKey } = {}) {
  const requestKey = idempotencyKey || globalThis.crypto?.randomUUID?.()
    || `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request('/evidence/submissions', {
    method: 'POST',
    body: JSON.stringify({ ...value, alertId }),
    headers: {
      'Idempotency-Key': requestKey,
      ...(authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {}),
    },
  });
}

export function submitIncidentVerificationReport(alertId, value, { idempotencyKey } = {}) {
  const requestKey = idempotencyKey || globalThis.crypto?.randomUUID?.()
    || `incident-report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request(`/evaluation/${encodeURIComponent(alertId)}/incident-report`, {
    method: 'POST',
    body: JSON.stringify(value),
    headers: {
      'Idempotency-Key': requestKey,
      ...(authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {}),
    },
  });
}

export function recordLiveEvaluationFeedback(alertId, evaluationId, value, { idempotencyKey } = {}) {
  const requestKey = idempotencyKey || globalThis.crypto?.randomUUID?.()
    || `evaluation-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request(`/evaluation/${encodeURIComponent(alertId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ ...value, evaluationId }),
    headers: {
      'Idempotency-Key': requestKey,
      ...(authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {}),
    },
  });
}

export function getModelPerformance() {
  return request('/model/performance', { cache: 'no-store' });
}

export function getModelStatus() {
  return request('/model/status', { cache: 'no-store' });
}

export function getMlStatus() {
  return request('/ml/status', { cache: 'no-store' });
}

export function getMlModels() {
  return request('/ml/models', { cache: 'no-store' });
}

export function getMlModel(modelId) {
  return request(`/ml/models/${encodeURIComponent(modelId)}`, { cache: 'no-store' });
}

export function getMlPrediction(alertId) {
  return request(`/ml/predictions/${encodeURIComponent(alertId)}`, { cache: 'no-store' });
}

export function getMlMetrics() {
  return request('/ml/metrics', { cache: 'no-store' });
}

export function getMlTrainingDataset() {
  return request('/ml/training-dataset', { cache: 'no-store' });
}

export function getHumanVerificationSummary() {
  return request('/evaluation/feedback-summary', { cache: 'no-store' });
}

export function sendControlledSlackVerificationTest() {
  return request('/evaluation/human-verification/test', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
}

export function retryHumanVerificationDelivery(deliveryId) {
  return request(`/evaluation/human-verification/deliveries/${encodeURIComponent(deliveryId)}/retry`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
}

export function getMonitoringSourceObservability() {
  return request('/observability/sources', { cache: 'no-store' });
}

export function getDecisionDiagnostics() {
  return request('/observability/diagnostics', { cache: 'no-store' });
}

export function getDailyObservability() {
  return request('/observability/daily', { cache: 'no-store' });
}

export function getGoldEvaluationDataset(params = {}) {
  const searchParams = new URLSearchParams(params);
  const query = searchParams.toString();
  return request(`/evaluation/gold-dataset${query ? `?${query}` : ''}`);
}

export function getGoldReviewQueue(params = {}) {
  const searchParams = new URLSearchParams(params);
  const query = searchParams.toString();
  return request(`/evaluation/gold-review-queue${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getTrainingDatasetPreview(params = {}) {
  const searchParams = new URLSearchParams(params);
  const query = searchParams.toString();
  return request(`/evaluation/training-dataset-preview${query ? `?${query}` : ''}`, { cache: 'no-store' });
}

export function getHistoricalTrainingPreview(params = {}) {
  return request(learningDatasetPath('/training-preview', params));
}

export function getHistoricalFeatureAudit(params = {}) {
  return request(learningDatasetPath('/features/audit', params));
}

export function getAlertTaxonomyCorrection(alertId) {
  return request(learningDatasetPath(`/${encodeURIComponent(alertId)}/taxonomy`));
}

export function correctAlertTaxonomy(alertId, value, { method = 'POST', idempotencyKey } = {}) {
  const requestKey = idempotencyKey || globalThis.crypto?.randomUUID?.()
    || `taxonomy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request(learningDatasetPath(`/${encodeURIComponent(alertId)}/taxonomy`), {
    body: JSON.stringify(value),
    headers: {
      'Idempotency-Key': requestKey,
      ...(authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {}),
    },
    method,
  });
}

export function getOperationalOutcome(alertId) {
  return request(learningDatasetPath(`/${encodeURIComponent(alertId)}/outcome`));
}

export async function getCurrentUser() {
  const result = await request('/auth/me');
  authenticatedCsrfToken = result?.csrfToken || null;
  return result;
}

export async function loginCurrentUser(credentials) {
  const result = await request('/auth/login', {
    body: JSON.stringify(credentials),
    method: 'POST',
  });
  authenticatedCsrfToken = result?.csrfToken || null;
  return result;
}

export function signupCurrentUser(account) {
  return request('/auth/signup', {
    body: JSON.stringify(account),
    method: 'POST',
  });
}

export async function logoutCurrentUser() {
  const result = await request('/auth/logout', {
    method: 'POST',
    headers: authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {},
  });
  authenticatedCsrfToken = null;
  return result;
}

export function recordOperationalOutcome(alertId, value, { method = 'POST', idempotencyKey } = {}) {
  const requestKey = idempotencyKey || globalThis.crypto?.randomUUID?.()
    || `outcome-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request(learningDatasetPath(`/${encodeURIComponent(alertId)}/outcome`), {
    body: JSON.stringify(value),
    headers: {
      'Idempotency-Key': requestKey,
      ...(authenticatedCsrfToken ? { 'X-CSRF-Token': authenticatedCsrfToken } : {}),
    },
    method,
  });
}

export function getHistoricalLearningSample(limit = 10) {
  return request(learningDatasetPath('/sample', { limit }));
}

/*
 * RETIRED DECISION-LAYER CLIENTS
 *
 * The functions below are kept temporarily as source-level rollback reference.
 * No routed frontend page imports them, and the backend fails these legacy
 * decision/evidence-completion endpoints closed with HTTP 410. They must not be
 * treated as an available classifier API in the historical dataset phase.
 */

export function getOperationalDecisions(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/decisions${query ? `?${query}` : ''}`, options);
}

export function getEvidenceCompletionStatus(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/evidence-completion/status${query ? `?${query}` : ''}`, options);
}

export function runEvidenceCompletion(payload = {}) {
  return request('/noise-analysis/evidence-completion', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runSourceIdentityCompletion(payload = {}) {
  return request('/source-identities/completion', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getNoiseActionability(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/actionability${query ? `?${query}` : ''}`, options);
}

export function getNoiseActionabilityGroup(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/actionability${query ? `?${query}` : ''}`, options);
}

export function getNoiseOperationalSignals(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/operational-signals${query ? `?${query}` : ''}`, options);
}

export function getNoiseAppDynamicsEvidence(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/appdynamics-evidence${query ? `?${query}` : ''}`, options);
}

export function getNoiseAppDynamicsOperationalEvent(eventId, options = {}) {
  return request(`/noise-analysis/appdynamics-events/${encodeURIComponent(eventId)}`, options);
}

export function acquireNoiseAppDynamicsEvidence(payload = {}, options = {}) {
  return request('/noise-analysis/appdynamics-evidence', {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getNoiseOperationalSignalEvent(eventId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/operational-signals/${encodeURIComponent(eventId)}${query ? `?${query}` : ''}`, options);
}

export function getNoiseOperationalSignalPattern(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/operational-signals${query ? `?${query}` : ''}`, options);
}

export function getNoiseEvidenceEnrichmentStatus(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/evidence-enrichment/status${query ? `?${query}` : ''}`, options);
}

export function getNoiseEvidenceGaps(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/evidence-gaps${query ? `?${query}` : ''}`, options);
}

export function getNoiseEvidenceGapPattern(patternId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/evidence-gaps/pattern/${encodeURIComponent(patternId)}${query ? `?${query}` : ''}`, options);
}

export function getNoiseEvidenceAcquisitionStatus(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/evidence-acquisition/status${query ? `?${query}` : ''}`, options);
}

export function getNoiseEvidenceAcquisitionPattern(patternId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/evidence-acquisition/pattern/${encodeURIComponent(patternId)}${query ? `?${query}` : ''}`, options);
}

export function acquireNoiseEvidence(payload = {}, options = {}) {
  return request('/noise-analysis/evidence-acquisition', {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function cancelNoiseEvidenceAcquisition(options = {}) {
  return request('/noise-analysis/evidence-acquisition/cancel', {
    ...options,
    method: 'POST',
  });
}

export function enrichNoiseEvidence(payload = {}, options = {}) {
  return request('/noise-analysis/evidence-enrichment', {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function enrichNoiseEvidenceGroup(groupId, payload = {}, options = {}) {
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/evidence-enrichment`, {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getNoiseAnalysisGroup(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}${query ? `?${query}` : ''}`, options);
}

export function getNoiseAnalysisEvidence(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/evidence${query ? `?${query}` : ''}`, options);
}

export function getNoiseSourceValidation(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/source-validation${query ? `?${query}` : ''}`, options);
}

export function getSourceIdentity(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams({ groupId: String(groupId) });
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  return request(`/source-identities/resolve?${searchParams.toString()}`, options);
}

export function confirmSourceIdentityMapping(entityId, payload) {
  return request(`/source-identities/${encodeURIComponent(entityId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function rejectSourceIdentityMapping(entityId, payload) {
  return request(`/source-identities/${encodeURIComponent(entityId)}/reject`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getNoiseAnalysisHistory(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/history${query ? `?${query}` : ''}`, options);
}

export function getNoiseReductionImpact(params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/reduction-impact${query ? `?${query}` : ''}`, options);
}

export function getNoiseReductionGroupImpact(groupId, params = {}, options = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/reduction-impact${query ? `?${query}` : ''}`, options);
}

export function saveNoiseAnalysisFeedback(groupId, feedback) {
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ feedback }),
  });
}

export function saveNoiseEvidenceFeedback(groupId, feedback) {
  return request(`/noise-analysis/${encodeURIComponent(groupId)}/evidence/feedback`, {
    method: 'POST',
    body: JSON.stringify({ feedback }),
  });
}

export function getSlackAlertExtractionStatus() {
  return request('/slack/alerts/status');
}

export function getLiveAlertStatus() {
  return request('/alerts/status');
}

export function getSlackThread(threadTs, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return request(`/slack/threads/${encodeURIComponent(threadTs)}${query ? `?${query}` : ''}`);
}

export function getOperationsBackfillStatus() {
  return request('/integrations/operations/backfill/status');
}

export { API_BASE_URL };

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const alertService = require('./services/alert.service');
const abcHubRoutes = require('./routes/abcHub.routes');
const appDynamicsRoutes = require('./routes/appDynamics.routes');
const atlassianRoutes = require('./routes/atlassian.routes');
const authRoutes = require('./routes/auth.routes');
const alertsRoutes = require('./routes/alerts.routes');
const evaluationRoutes = require('./routes/evaluation.routes');
const evidenceRoutes = require('./routes/evidence.routes');
const grafanaRoutes = require('./routes/grafana.routes');
const healthRoutes = require('./routes/health.routes');
const incidentsRoutes = require('./routes/incidents.routes');
const ingestionRoutes = require('./routes/ingestion.routes');
const importRoutes = require('./routes/import.routes');
const integrationsRoutes = require('./routes/integrations.routes');
const jiraRoutes = require('./routes/jira.routes');
const monitoringRoutes = require('./routes/monitoring.routes');
const modelRoutes = require('./routes/model.routes');
const mlRoutes = require('./routes/ml.routes');
const nagiosRoutes = require('./routes/nagios.routes');
const noiseAnalysisRoutes = require('./routes/noiseAnalysis.routes');
const observabilityRoutes = require('./routes/observability.routes');
const oracleApexRoutes = require('./routes/oracleApex.routes');
const operationsRoutes = require('./routes/operations.routes');
const paymentGatewayRoutes = require('./routes/paymentGateway.routes');
const rulesRoutes = require('./routes/rules.routes');
const settingsRoutes = require('./routes/settings.routes');
const slackRoutes = require('./routes/slack.routes');
const sourceIdentityRoutes = require('./routes/sourceIdentity.routes');
const summaryRoutes = require('./routes/summary.routes');
const thousandEyesRoutes = require('./routes/thousandEyes.routes');
const appDynamicsService = require('./services/appDynamics.service');
const nagiosService = require('./services/nagios.service');
const slackService = require('./services/slack.service');
const slackAlertStoreService = require('./services/slackAlertStore.service');
const slackAlertPollingService = require('./services/slackAlertPolling.service');
const slackCallbackInboxService = require('./services/slackCallbackInbox.service');
const slackUserService = require('./services/slackUser.service');
const atlassianOpsIngestionService = require('./services/atlassian/opsIngestion.service');
const { service: liveMultiSourceEvaluationService } = require('./services/liveMultiSourceEvaluation.service');
const { service: humanVerificationService } = require('./services/humanVerification.service');
const { service: mlTrainingOrchestrator } = require('./services/mlTrainingOrchestrator.service');
const { service: authenticationService } = require('./services/authentication.service');
const { logCorporateCaStatus } = require('./config/corporateCa');
const { DECISION_LAYER_STATE } = require('./config/decisionLayer');
const { createRateLimiter } = require('./middleware/rateLimit');
const { requestLoggingMiddleware, write: structuredLog } = require('./utils/structuredLogger');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST
  || (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? '0.0.0.0' : '127.0.0.1');
// Keep real Slack retrieval isolated from the legacy alert-conversion pipeline
// during Phase 1. Operators can explicitly opt back into that poller.
const SLACK_SYNC_INTERVAL_MS = Number(process.env.SLACK_SYNC_INTERVAL_MS || 0);

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked origin: ${origin}`));
    },
  }),
);

app.use(requestLoggingMiddleware);
// Platform probes are available at the conventional root paths as well as
// /api/health/live and /api/health/ready.
app.get('/live', healthRoutes.live);
app.get('/ready', healthRoutes.ready);
// Slack callbacks have their own signature, timestamp, replay, idempotency,
// and asynchronous inbox controls. They must be acknowledged within 3 seconds.
app.use('/api/slack', slackRoutes);
app.use(express.json({ limit: '10mb' }));
app.use('/api', createRateLimiter());
app.use(authenticationService.middleware);

app.get('/', (request, response) => {
  response.json({
    name: 'Alert Noise Reduction API',
    status: 'running',
    architecture: DECISION_LAYER_STATE,
    endpoints: [
      '/api/health',
      '/api/auth/me',
      'POST /api/auth/login',
      'POST /api/auth/signup',
      'POST /api/auth/logout',
      '/api/alerts',
      '/api/summary',
      '/api/alerts?feed=slack-live',
      '/api/alerts/live',
      '/api/alerts/stream',
      '/api/alerts/status',
      '/api/alerts/:id',
      '/api/alerts/:id/raw',
      '/api/alerts/:id/linked-incidents',
      '/api/noise-analysis/status',
      '/api/noise-analysis/foundation',
      '/api/noise-analysis/foundation/summary',
      '/api/noise-analysis/foundation/audit',
      '/api/noise-analysis/foundation/sample',
      '/api/noise-analysis/foundation/training-preview',
      '/api/noise-analysis/foundation/features/audit',
      '/api/noise-analysis/foundation/appdynamics-jira-outcomes',
      '/api/noise-analysis/foundation/appdynamics-jira-outcomes/summary',
      '/api/noise-analysis/foundation/appdynamics-jira-outcomes/:alertId',
      '/api/evaluation',
      '/api/evaluation/connectivity',
      'POST /api/evaluation/:alertId/run',
      '/api/evaluation/:alertId',
      '/api/evaluation/:alertId/evidence',
      '/api/evaluation/:alertId/decision',
      '/api/evaluation/:alertId/feedback',
      'POST /api/evaluation/:alertId/feedback',
      '/api/model/status',
      '/api/model/performance',
      '/api/ml/status',
      '/api/ml/models',
      '/api/ml/models/:id',
      '/api/ml/predictions/:alertId',
      '/api/ml/metrics',
      '/api/observability/sources',
      '/api/observability/diagnostics',
      '/api/observability/daily',
      '/api/noise-analysis/foundation/:alertId',
      '/api/noise-analysis/foundation/:alertId/taxonomy',
      'POST /api/noise-analysis/foundation/:alertId/taxonomy',
      'PATCH /api/noise-analysis/foundation/:alertId/taxonomy',
      '/api/noise-analysis/foundation/:alertId/outcome',
      'POST /api/noise-analysis/foundation/:alertId/outcome',
      'PATCH /api/noise-analysis/foundation/:alertId/outcome',
      'POST /api/alerts/ingest',
      'POST /api/alerts/:id/acknowledge',
      'POST /api/alerts/:id/assign',
      'POST /api/alerts/:id/snooze',
      'POST /api/alerts/:id/close',
      'POST /api/alerts/:id/jira-ticket',
      'POST /api/alerts/:id/escalate',
      'POST /api/alerts/:id/notes',
      'POST /api/alerts/:id/responders',
      'POST /api/alerts/:id/link-jira',
      'POST /api/alerts/:id/actions',
      '/api/incidents',
      '/api/incidents/summary',
      '/api/incidents/daily-counts',
      '/api/incidents/:key',
      '/api/grafana/dashboards',
      'POST /api/grafana/dashboards/sync',
      '/api/grafana/dashboards/:uid',
      '/api/grafana/dashboards/:uid/panels',
      '/api/grafana/dashboards/:uid/metrics',
      '/api/grafana/folders',
      '/api/grafana/folders/:folderUid/dashboards',
      '/api/grafana/alerts',
      '/api/grafana/alert-rules',
      'POST /api/grafana/alert-rules/sync',
      '/api/grafana/sync-logs',
      '/api/grafana/dashboards/:uid/panels/:panelId/render',
      '/api/monitoring/tools',
      '/api/monitoring/:tool/entities',
      '/api/monitoring/:tool/entities/:entityId',
      '/api/operations/status',
      '/api/operations/live-alerts',
      '/api/operations/live-alerts/status',
      '/api/operations/live-alerts/:id',
      '/api/operations/live-alerts/:id/activity',
      '/api/operations/live-alerts/:id/notes',
      '/api/operations/live-alerts/:id/slack-context',
      '/api/operations/alerts',
      '/api/operations/alerts/:id',
      '/api/operations/alerts/:id/notes',
      '/api/operations/alerts/:id/logs',
      'POST /api/import/payment-gateway',
      '/api/payment-gateway/transactions',
      '/api/payment-gateway/summary',
      '/api/payment-gateway/history',
      '/api/settings/integrations',
      'PUT /api/settings/integrations/:name',
      'POST /api/settings/integrations/:name/test',
      'POST /api/settings/integrations/:name/sync',
      '/api/abc-hub/daemon-monitor',
      '/api/abc-hub/daemon-monitor/history',
      'POST /api/abc-hub/import/daemon-monitor',
      '/api/abc-hub/datatrak-user-monitoring',
      '/api/abc-hub/datatrak-user-monitoring/:id',
      '/api/abc-hub/datatrak-user-monitoring/history',
      'POST /api/appdynamics/connect',
      'POST /api/appdynamics/disconnect',
      'POST /api/appdynamics/test',
      'POST /api/appdynamics/sync',
      '/api/appdynamics/status',
      '/api/appdynamics/applications',
      '/api/appdynamics/workspace/applications',
      '/api/appdynamics/workspace/applications/:applicationId',
      '/api/appdynamics/applications/:applicationName',
      '/api/appdynamics/applications/:applicationId/dashboard',
      '/api/appdynamics/applications/:applicationId/flowmap',
      '/api/appdynamics/applications/:applicationId/business-transactions',
      '/api/appdynamics/applications/:applicationId/nodes',
      '/api/appdynamics/applications/:applicationId/servers',
      '/api/appdynamics/applications/:applicationId/events',
      '/api/appdynamics/applications/:applicationId/policies',
      '/api/appdynamics/applications/:applicationId/snapshots',
      '/api/appdynamics/applications/:applicationId/metrics',
      '/api/appdynamics/applications/:applicationId/transaction-score',
      '/api/appdynamics/data',
      '/api/nagios/d01/service-summary',
      '/api/nagios/d01/host-summary',
      '/api/nagios/d01/services',
      '/api/nagios/d01/hosts',
      '/api/nagios/d01/problems',
      '/api/nagios/d01/events',
      '/api/nagios/health',
      '/api/nagios/d02/service-summary',
      '/api/nagios/d02/host-summary',
      '/api/nagios/d02/services',
      '/api/nagios/d02/hosts',
      '/api/nagios/d02/problems',
      '/api/nagios/d02/events',
      '/api/noise-analysis',
      '/api/source-identities',
      '/api/source-identities/resolve',
      '/api/source-identities/:entityId',
      'POST /api/source-identities/:entityId/confirm',
      'POST /api/source-identities/:entityId/reject',
      '/api/oracle-apex/applications',
      '/api/oracle-apex/dashboard',
      'POST /api/oracle-apex/import',
      '/api/ingestion/sources',
      'POST /api/ingestion/:source/backfill',
      'POST /api/ingestion/:source/sync',
      'POST /api/ingestion/:source/alerts',
      'POST /api/ingestion/:tool/run',
      '/api/integrations',
      '/api/integrations/atlassian/status',
      'POST /api/integrations/atlassian/test',
      'POST /api/integrations/atlassian/ops/sync',
      '/api/integrations/atlassian/ops/sync-runs',
      '/api/integrations/atlassian/jsm/service-desks',
      '/api/integrations/atlassian/jsm/requests',
      '/api/jira/acc/problems',
      '/api/jira/acc/incidents',
      '/api/jira/acc/issues/:key',
      '/api/jira/acc/issues/:key/comments',
      '/api/jira/acc/issues/:key/changelog',
      'POST /api/jira/issues/:issueKey/comments',
      'POST /api/jira/issues/:issueKey/transitions',
      'POST /api/integrations/slack/history/import',
      'POST /api/integrations/jira/alerts/import',
      'POST /api/integrations/jira/incidents/import',
      'POST /api/integrations/operations/alerts/import',
      '/api/rules',
      'PUT /api/rules/:id',
      'PATCH /api/rules/:id/status',
      'GET /api/slack/status',
      'GET /api/slack/messages',
      'GET /api/slack/alerts/reconciliation',
      'GET /api/slack/threads/:threadTs',
      'POST /api/slack/events',
      'POST /api/slack/interactions',
      'GET /api/atlassian/oauth/callback',
    ],
  });
});

app.use('/api/atlassian', atlassianRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/abc-hub', abcHubRoutes);
app.use('/api/appdynamics', appDynamicsRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/evaluation', evaluationRoutes);
app.use('/api/evidence', evidenceRoutes);
app.use('/api/grafana', grafanaRoutes);
app.use('/api/incidents', incidentsRoutes);
app.use('/api/ingestion', ingestionRoutes);
app.use('/api/import', importRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/model', modelRoutes);
app.use('/api/ml', mlRoutes);
app.use('/api/nagios', nagiosRoutes);
app.use('/api/noise-analysis', noiseAnalysisRoutes);
app.use('/api/observability', observabilityRoutes);
app.use('/api/oracle-apex', oracleApexRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/payment-gateway', paymentGatewayRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/source-identities', sourceIdentityRoutes);
app.use('/api/summary', summaryRoutes);
app.use('/api/thousandeyes', thousandEyesRoutes);

app.use((request, response) => {
  response.status(404).json({
    error: 'Not Found',
    message: `Route ${request.method} ${request.originalUrl} does not exist.`,
  });
});

app.use((error, request, response, next) => {
  structuredLog('error', 'request_failed', {
    code: error.code,
    message: error.safeMessage || 'Unexpected server error.',
    name: error.name,
    requestId: request.requestId,
    status: error.status,
  });
  const status = Number(error.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 500;
  response.status(status).json({
    code: error.code,
    ...(error.safeDetails ? { details: error.safeDetails } : {}),
    error: status >= 500 ? 'InternalServerError' : error.name || 'RequestError',
    message: error.safeMessage || (status >= 500 ? 'Unexpected server error.' : error.message || 'Request failed.'),
    requestId: request.requestId,
    success: false,
  });
});

if (require.main === module) {
  const server = app.listen(PORT, HOST, async () => {
    logCorporateCaStatus();
    try {
      // Complete all Slack/evidence DDL before concurrent pollers and callback
      // workers begin. This makes unattended restarts deterministic.
      await humanVerificationService.ensureSchema();
      await slackAlertStoreService.ensureStorage();
      await slackCallbackInboxService.start();
      await mlTrainingOrchestrator.start();
      appDynamicsService.startAppDynamicsPolling();
      nagiosService.startNagiosPolling();
      atlassianOpsIngestionService.startPolling();
      slackAlertPollingService.startPolling();
      liveMultiSourceEvaluationService.startPolling();
    } catch (error) {
      console.error({
        code: error.code || 'BACKGROUND_WORKER_START_FAILED',
        message: error.safeMessage || 'Background workers could not start.',
      });
    }
    if (SLACK_SYNC_INTERVAL_MS > 0) {
      slackUserService.startSlackUserCacheRefresh();
    }
    console.log(`Alert Noise Reduction API running at http://${HOST}:${PORT}`);
  });

  const escalationTimer = setInterval(() => {
    alertService.escalateExpiredAlerts().catch((error) => {
      console.error('Automatic alert escalation failed', error);
    });
  }, 30 * 1000);

  if (SLACK_SYNC_INTERVAL_MS > 0) {
    const slackSyncTimer = setInterval(() => {
      slackService.syncNewSlackNotifications({ limit: 100, maxPages: 2 }).catch((error) => {
        if (!/Slack environment configuration is missing|Integration slack is not configured/i.test(error.message)) {
          console.error('Automatic Slack notification sync failed', error);
        }
      });
    }, SLACK_SYNC_INTERVAL_MS);
    if (typeof slackSyncTimer.unref === 'function') slackSyncTimer.unref();
  }

  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.once(signal, () => {
      clearInterval(escalationTimer);
      atlassianOpsIngestionService.stopPolling();
      slackAlertPollingService.stopPolling();
      slackCallbackInboxService.stop();
      mlTrainingOrchestrator.stop();
      liveMultiSourceEvaluationService.stopPolling();
      const forceExit = setTimeout(() => process.exit(1), 10_000);
      if (typeof forceExit.unref === 'function') forceExit.unref();
      const drainConnections = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, 5_000);
      if (typeof drainConnections.unref === 'function') drainConnections.unref();
      server.close(() => {
        clearTimeout(drainConnections);
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  });
}

module.exports = app;

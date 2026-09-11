const integrationService = require('../services/integration.service');
const jiraService = require('../services/jira.service');
const slackService = require('../services/slack.service');
const atlassianJsmService = require('../services/atlassian/jsm.service');
const atlassianOpsService = require('../services/atlassian/opsIngestion.service');
const liveAlertStreamService = require('../services/liveAlertStream.service');

async function getIntegrations(request, response, next) {
  try {
    const integrations = await integrationService.getIntegrations();
    response.json({ data: integrations });
  } catch (error) {
    next(error);
  }
}

async function createIntegration(request, response, next) {
  try {
    const integration = await integrationService.createIntegration(request.params.tool, request.body);
    response.status(201).json({ data: integration });
  } catch (error) {
    next(error);
  }
}

async function updateIntegration(request, response, next) {
  try {
    const integration = await integrationService.updateIntegration(request.params.tool, request.body);
    response.json({ data: integration });
  } catch (error) {
    next(error);
  }
}

async function deleteIntegration(request, response, next) {
  try {
    const deleted = await integrationService.deleteIntegration(request.params.tool);
    response.json({ data: { deleted } });
  } catch (error) {
    next(error);
  }
}

async function testIntegration(request, response, next) {
  try {
    const result = await integrationService.testIntegration(request.params.tool);
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getJiraStatus(request, response, next) {
  try {
    const status = await jiraService.getStatus();
    response.json({ data: status });
  } catch (error) {
    next(error);
  }
}

async function getOperationsBackfillStatus(request, response, next) {
  try {
    const status = await jiraService.getBackfillStatus();
    response.json({ data: status });
  } catch (error) {
    next(error);
  }
}

async function importJiraAlertIssues(request, response, next) {
  try {
    const result = await jiraService.importJiraAlertIssues({
      range: request.body?.range || 'all',
      from: request.body?.from || null,
      to: request.body?.to || null,
      query: request.body?.query || null,
      jql: request.body?.jql || null,
      incremental: Boolean(request.body?.incremental),
      updatedFrom: request.body?.updatedFrom || null,
    });

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function importJiraIncidents(request, response, next) {
  try {
    const result = await jiraService.importJiraIncidents({
      range: request.body?.range || 'all',
      from: request.body?.from || null,
      to: request.body?.to || null,
      incidentsJql: request.body?.incidentsJql || request.body?.jql || null,
      incremental: Boolean(request.body?.incremental),
      updatedFrom: request.body?.updatedFrom || null,
    });

    liveAlertStreamService.broadcast('jira-sync', {
      syncRunId: result?.runId || result?.syncRunId || null,
      updatedAt: new Date().toISOString(),
    });
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function importSlackChannelHistory(request, response, next) {
  try {
    const result = await slackService.importSlackChannelHistory({
      limit: request.body?.limit,
      maxPages: request.body?.maxPages,
    });

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function startSlackHistoryBackfill(request, response, next) {
  try {
    const result = slackService.startSlackHistoryBackfill({
      limit: request.body?.limit,
      maxPages: request.body?.maxPages || 'all',
    });

    response.status(202).json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getSlackHistoryImportStatus(request, response, next) {
  try {
    response.json({ data: slackService.getSlackHistoryImportStatus() });
  } catch (error) {
    next(error);
  }
}

async function syncNewSlackNotifications(request, response, next) {
  try {
    const result = await slackService.syncNewSlackNotifications({
      limit: request.body?.limit,
      maxPages: request.body?.maxPages,
      oldest: request.body?.oldest,
    });

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getAtlassianStatus(request, response, next) {
  try {
    const status = await atlassianOpsService.getStatus();
    response.json({ data: status });
  } catch (error) {
    next(error);
  }
}

async function testAtlassianConnection(request, response, next) {
  try {
    const result = await atlassianOpsService.testConnection();
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function syncAtlassianOps(request, response, next) {
  try {
    const result = await atlassianOpsService.syncOpsAlerts({
      from: request.body?.from || null,
      syncType: 'manual',
      to: request.body?.to || null,
    });

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getAtlassianOpsSyncRuns(request, response, next) {
  try {
    const runs = await atlassianOpsService.getSyncRuns(request.query.limit);
    response.json({ data: runs });
  } catch (error) {
    next(error);
  }
}

async function getAtlassianJsmServiceDesks(request, response, next) {
  try {
    const result = await atlassianJsmService.getServiceDesks();
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getAtlassianJsmRequests(request, response, next) {
  try {
    const result = await atlassianJsmService.getRequests({
      limit: request.query.limit,
      searchTerm: request.query.searchTerm || request.query.search,
      serviceDeskId: request.query.serviceDeskId,
    });
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createIntegration,
  deleteIntegration,
  getAtlassianJsmRequests,
  getAtlassianJsmServiceDesks,
  getAtlassianOpsSyncRuns,
  getAtlassianStatus,
  getJiraStatus,
  getSlackHistoryImportStatus,
  getOperationsBackfillStatus,
  getIntegrations,
  importJiraIncidents,
  importJiraAlertIssues,
  importSlackChannelHistory,
  startSlackHistoryBackfill,
  syncNewSlackNotifications,
  syncAtlassianOps,
  testAtlassianConnection,
  testIntegration,
  updateIntegration,
};

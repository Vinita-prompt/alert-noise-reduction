const alertService = require('../services/alert.service');
const alertActionService = require('../services/alertAction.service');
const atlassianOpsService = require('../services/atlassian/opsIngestion.service');
const jiraActionsService = require('../services/atlassian/jiraActions.service');

function sendWriteDisabled(response, message) {
  response.status(403).json({
    success: false,
    code: 'WRITE_INTEGRATION_DISABLED',
    message,
  });
}

async function getAlerts(request, response, next) {
  try {
    const filters = {
      priority: request.query.priority,
      urgency: request.query.urgency,
      severity: request.query.severity,
      status: request.query.status,
      source: request.query.source,
      sourceTool: request.query.sourceTool,
      service: request.query.service,
      environment: request.query.environment,
      classification: request.query.classification,
      acknowledged: request.query.acknowledged,
      createdFrom: request.query.createdFrom,
      createdTo: request.query.createdTo,
      updatedFrom: request.query.updatedFrom,
      updatedTo: request.query.updatedTo,
      assignee: request.query.assignee,
      team: request.query.team,
      state: request.query.state,
      sort: request.query.sort,
      limit: request.query.limit,
      offset: request.query.offset || (
        request.query.page && request.query.limit
          ? (Math.max(Number.parseInt(request.query.page, 10) || 1, 1) - 1) * (Number.parseInt(request.query.limit, 10) || 500)
          : undefined
      ),
      search: request.query.search || request.query.q,
    };
    const [alerts, totalCount] = await Promise.all([
      alertService.getAlerts(filters),
      alertService.getAlertCount(filters),
    ]);

    response.json({
      data: alerts,
      meta: {
        totalCount,
        returnedCount: alerts.length,
        limit: Number.parseInt(filters.limit, 10) || 500,
        offset: Number.parseInt(filters.offset, 10) || 0,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getAlertTrend(request, response, next) {
  try {
    const trend = await alertService.getAlertTrend({
      range: request.query.range,
      from: request.query.from,
      to: request.query.to,
      timezone: request.query.timezone,
    });

    response.json({ data: trend });
  } catch (error) {
    next(error);
  }
}

async function getSourceDashboardSummary(request, response, next) {
  try {
    const summary = await alertService.getSourceDashboardSummary();

    response.json({ data: summary });
  } catch (error) {
    next(error);
  }
}

async function getAlertById(request, response, next) {
  try {
    const alert = await alertService.getAlertById(request.params.id);

    if (!alert) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: alert });
  } catch (error) {
    next(error);
  }
}

async function ingestAlert(request, response, next) {
  try {
    const result = await alertService.ingestAlertPayload(request.body || {});

    response.status(result.result === 'inserted' ? 201 : 200).json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function acknowledgeAlert(request, response, next) {
  try {
    const result = await alertActionService.acknowledgeAlert(request.params.id, {
      acknowledgedBy: request.body?.acknowledgedBy || 'Website operator',
      source: request.body?.source || 'website',
      slackUserId: request.body?.slackUserId || null,
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result.alert, meta: result.meta });
  } catch (error) {
    next(error);
  }
}

async function escalateAlert(request, response, next) {
  try {
    const alert = await alertService.escalateAlert(request.params.id, {
      actor: request.body?.actor || 'Website operator',
      source: request.body?.source || 'website',
      reason: request.body?.reason,
      responderTeam: request.body?.responderTeam,
    });

    if (!alert) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: alert });
  } catch (error) {
    next(error);
  }
}

async function getAlertRawPayload(request, response, next) {
  try {
    const payload = await alertService.getAlertRawPayload(request.params.id);

    if (!payload) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: payload });
  } catch (error) {
    next(error);
  }
}

async function getAlertLinkedIncidents(request, response, next) {
  try {
    const incidents = await alertService.getAlertLinkedIncidents(request.params.id);
    response.json({ data: incidents });
  } catch (error) {
    next(error);
  }
}

async function getAlertActivity(request, response, next) {
  try {
    const activity = await alertService.getAlertActivity(request.params.id);
    response.json({ data: activity });
  } catch (error) {
    next(error);
  }
}

async function applyAlertAction(request, response, next) {
  try {
    const { action } = request.body;

    if (!action) {
      response.status(400).json({
        error: 'Bad Request',
        message: 'Request body must include an action.',
      });
      return;
    }

    const alert = await alertService.applyAlertAction(request.params.id, action);

    if (!alert) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: alert });
  } catch (error) {
    next(error);
  }
}

async function processAlert(request, response, next) {
  try {
    const result = await alertService.processAlert(request.params.id, {
      force: request.body?.force !== false,
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function addAlertNote(request, response, next) {
  try {
    const result = await alertActionService.addAlertNote(request.params.id, {
      note: request.body?.note,
      createdBy: request.body?.createdBy || 'Website operator',
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result.alert, meta: result.meta });
  } catch (error) {
    next(error);
  }
}

async function assignAlert(request, response, next) {
  try {
    const result = await atlassianOpsService.performOpsAlertAction(request.params.id, 'assign', {
      actor: request.body?.assignedBy || 'Website operator',
      responder: request.body?.responder,
      responders: request.body?.responders,
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result.alert, meta: result });
  } catch (error) {
    next(error);
  }
}

async function snoozeAlert(request, response, next) {
  try {
    const result = await atlassianOpsService.performOpsAlertAction(request.params.id, 'snooze', {
      actor: request.body?.actor || 'Website operator',
      reason: request.body?.reason,
      snoozedUntil: request.body?.snoozedUntil || request.body?.until,
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result.alert, meta: result });
  } catch (error) {
    next(error);
  }
}

async function closeAlert(request, response, next) {
  try {
    const result = await alertActionService.closeAlert(request.params.id, {
      actor: request.body?.actor || 'Website operator',
      reason: request.body?.reason,
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result.alert, meta: result.meta });
  } catch (error) {
    next(error);
  }
}

async function createJiraTicket(request, response, next) {
  try {
    const result = await jiraActionsService.createIssueForAlert(request.params.id, request.body || {});

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.status(201).json({ data: result });
  } catch (error) {
    if (error.code === 'WRITE_INTEGRATION_DISABLED') {
      sendWriteDisabled(response, 'Jira write actions are currently disabled.');
      return;
    }

    next(error);
  }
}

async function addAlertResponder(request, response, next) {
  try {
    const result = await alertService.addAlertResponder(request.params.id, {
      assignedBy: request.body?.assignedBy || 'Website operator',
      opsAlertId: request.body?.opsAlertId || request.body?.jsmOpsAlertId || request.body?.atlassianAlertId,
      responder: request.body?.responder,
      responders: request.body?.responders,
    });

    if (!result) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function linkJiraIncident(request, response, next) {
  try {
    const alert = await alertService.linkJiraIncident(request.params.id, {
      jiraTicketId: request.body?.jiraTicketId,
      linkedBy: request.body?.linkedBy || 'Website operator',
    });

    if (!alert) {
      response.status(404).json({
        error: 'Not Found',
        message: `Alert ${request.params.id} was not found.`,
      });
      return;
    }

    response.json({ data: alert });
  } catch (error) {
    next(error);
  }
}

async function classifyAlerts(request, response, next) {
  try {
    const result = await alertService.classifyAlerts({
      force: Boolean(request.body?.force),
      ids: Array.isArray(request.body?.ids) ? request.body.ids : [],
    });

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  acknowledgeAlert,
  addAlertNote,
  addAlertResponder,
  applyAlertAction,
  assignAlert,
  classifyAlerts,
  closeAlert,
  createJiraTicket,
  escalateAlert,
  getAlertActivity,
  getAlertLinkedIncidents,
  getAlertTrend,
  getAlerts,
  getAlertById,
  getAlertRawPayload,
  getSourceDashboardSummary,
  ingestAlert,
  linkJiraIncident,
  processAlert,
  snoozeAlert,
};

const jiraActionsService = require('../services/atlassian/jiraActions.service');
const accJiraReadService = require('../services/atlassian/accJiraRead.service');

function sendWriteDisabled(response, message = 'Jira write actions are currently disabled.') {
  response.status(403).json({
    success: false,
    code: 'WRITE_INTEGRATION_DISABLED',
    message,
  });
}

async function addIssueComment(request, response, next) {
  try {
    const result = await jiraActionsService.addIssueComment(request.params.issueKey, request.body || {});
    response.status(201).json({ data: result });
  } catch (error) {
    if (error.code === 'WRITE_INTEGRATION_DISABLED') {
      sendWriteDisabled(response);
      return;
    }

    next(error);
  }
}

async function transitionIssue(request, response, next) {
  try {
    const result = await jiraActionsService.transitionIssue(request.params.issueKey, request.body || {});
    response.json({ data: result });
  } catch (error) {
    if (error.code === 'WRITE_INTEGRATION_DISABLED') {
      sendWriteDisabled(response);
      return;
    }

    next(error);
  }
}

async function listAccProblems(request, response, next) {
  try {
    const result = await accJiraReadService.listProblems(request.query || {});
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function listAccIncidents(request, response, next) {
  try {
    const result = await accJiraReadService.listIncidents(request.query || {});
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getAccIssue(request, response, next) {
  try {
    const result = await accJiraReadService.getIssueDetail(request.params.key);
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getAccIssueComments(request, response, next) {
  try {
    const result = await accJiraReadService.getIssueComments(request.params.key);
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function getAccIssueChangelog(request, response, next) {
  try {
    const result = await accJiraReadService.getIssueChangelog(request.params.key);
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  addIssueComment,
  getAccIssue,
  getAccIssueChangelog,
  getAccIssueComments,
  listAccIncidents,
  listAccProblems,
  transitionIssue,
};

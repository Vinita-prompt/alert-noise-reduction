const nagiosService = require('../services/nagios.service');

async function getServiceSummary(request, response, next) {
  try {
    const data = await nagiosService.getServiceSummary(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getHostSummary(request, response, next) {
  try {
    const data = await nagiosService.getHostSummary(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getServices(request, response, next) {
  try {
    const data = await nagiosService.getServices(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getHosts(request, response, next) {
  try {
    const data = await nagiosService.getHosts(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getProblems(request, response, next) {
  try {
    const data = await nagiosService.getProblems(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getEvents(request, response, next) {
  try {
    const data = await nagiosService.getEvents(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDowntime(request, response, next) {
  try {
    const data = await nagiosService.getDowntime(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getAiFeatures(request, response, next) {
  try {
    const data = await nagiosService.getAiFeatures(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getSyncLogs(request, response, next) {
  try {
    const data = await nagiosService.getSyncLogs(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getHealth(request, response, next) {
  try {
    const data = await nagiosService.getNagiosHealth(request.query.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getSnapshot(request, response, next) {
  try {
    const data = await nagiosService.getInstanceSnapshot(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspace(request, response, next) {
  try {
    const forceRefresh = ['1', 'true'].includes(String(request.query.refresh || '').toLowerCase());
    const data = await nagiosService.getWorkspaceOverview(request.params.instance, { forceRefresh });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listWorkspaceRecords(request, response, next) {
  try {
    const data = await nagiosService.listWorkspaceRecords(
      request.params.instance,
      request.params.entityType,
      request.query,
    );

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceRecord(request, response, next) {
  try {
    const data = await nagiosService.getWorkspaceRecord(
      request.params.instance,
      request.params.entityType,
      request.params.recordId,
    );

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function pollInstance(request, response, next) {
  try {
    const data = await nagiosService.pollInstance(request.params.instance);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAiFeatures,
  getDowntime,
  getEvents,
  getHealth,
  getHostSummary,
  getHosts,
  getProblems,
  getServiceSummary,
  getServices,
  getSnapshot,
  getSyncLogs,
  getWorkspace,
  getWorkspaceRecord,
  listWorkspaceRecords,
  pollInstance,
};

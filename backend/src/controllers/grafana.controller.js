const grafanaDashboardService = require('../services/grafanaDashboard.service');

async function getWorkspaceStatus(request, response, next) {
  try {
    const data = await grafanaDashboardService.getGrafanaWorkspaceStatus(request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceOverview(request, response, next) {
  try {
    const data = await grafanaDashboardService.getGrafanaWorkspaceOverview(request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listWorkspaceDashboards(request, response, next) {
  try {
    const data = await grafanaDashboardService.listGrafanaWorkspaceDashboards(request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceDashboard(request, response, next) {
  try {
    const data = await grafanaDashboardService.getGrafanaWorkspaceDashboard(request.params.uid, request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspacePanelData(request, response, next) {
  const abortController = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) abortController.abort();
  });

  try {
    const variables = Object.fromEntries(
      Object.entries(request.query)
        .filter(([key, value]) => key.startsWith('var-') && ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => [key.slice(4), value]),
    );
    const data = await grafanaDashboardService.getGrafanaWorkspacePanelData(
      request.params.uid,
      request.params.panelId,
      {
        range: request.query.range,
        refresh: request.query.refresh,
        signal: abortController.signal,
        variables,
      },
    );
    response.json({ data });
  } catch (error) {
    if (!abortController.signal.aborted && !response.headersSent) next(error);
  }
}

async function renderWorkspacePanel(request, response, next) {
  const abortController = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) abortController.abort();
  });

  try {
    const variables = Object.fromEntries(
      Object.entries(request.query)
        .filter(([key, value]) => key.startsWith('var-') && ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => [key.slice(4), value]),
    );
    const image = await grafanaDashboardService.renderGrafanaWorkspacePanel(
      request.params.uid,
      request.params.panelId,
      {
        height: request.query.height,
        range: request.query.range,
        refresh: request.query.refresh,
        signal: abortController.signal,
        tz: request.query.tz,
        variables,
        width: request.query.width,
      },
    );

    response.setHeader('Content-Type', image.contentType);
    response.setHeader('Cache-Control', 'private, max-age=30');
    response.send(image.buffer);
  } catch (error) {
    if (!abortController.signal.aborted && !response.headersSent) next(error);
  }
}

async function listWorkspaceFolders(request, response, next) {
  try {
    const data = await grafanaDashboardService.listGrafanaWorkspaceFolders(request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listWorkspaceAlertRules(request, response, next) {
  try {
    const data = await grafanaDashboardService.listGrafanaWorkspaceAlertRules(request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceAlertRule(request, response, next) {
  try {
    const data = await grafanaDashboardService.getGrafanaWorkspaceAlertRule(request.params.uid, request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceActiveAlerts(request, response, next) {
  try {
    const data = await grafanaDashboardService.getGrafanaWorkspaceActiveAlerts(request.query);
    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listDashboards(request, response, next) {
  try {
    const pageSize = request.query.pageSize || request.query.limit || 50;
    let folderUid = request.query.folderUid;
    let foldersResult = null;

    if (request.query.folder && request.query.folder !== 'all') {
      foldersResult = await grafanaDashboardService.listGrafanaWorkspaceFolders({ pageSize: 50 });
      folderUid = foldersResult.items.find((folder) => folder.title === request.query.folder)?.uid || '__not_found__';
    }

    const dashboardResult = await grafanaDashboardService.listGrafanaWorkspaceDashboards({
      page: request.query.page,
      pageSize,
      refresh: request.query.refresh,
      search: request.query.search,
      folderUid,
      tag: request.query.tag,
    });
    foldersResult ||= await grafanaDashboardService.listGrafanaWorkspaceFolders({ pageSize: 50 });

    const data = {
      dashboards: dashboardResult.items,
      items: dashboardResult.items,
      folders: foldersResult.items,
      pagination: dashboardResult.pagination,
      total: dashboardResult.pagination.total,
      lastUpdated: dashboardResult.lastUpdated,
      readOnly: true,
    };

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listFolders(request, response, next) {
  try {
    const data = await grafanaDashboardService.listFolders();

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listFolderDashboards(request, response, next) {
  try {
    const data = await grafanaDashboardService.listFolderDashboards(request.params.folderUid, {
      search: request.query.search,
      tag: request.query.tag,
    });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function syncDashboards(request, response, next) {
  try {
    const data = await grafanaDashboardService.syncDashboards({
      collectMetrics: request.body?.collectMetrics,
      force: request.body?.force,
      from: request.body?.from,
      fullRefresh: request.body?.fullRefresh,
      incremental: request.body?.incremental,
      query: request.body?.query,
      limit: request.body?.limit,
      metricPanelLimit: request.body?.metricPanelLimit,
      to: request.body?.to,
    });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDashboard(request, response, next) {
  try {
    const data = await grafanaDashboardService.getDashboard(request.params.uid);

    if (!data) {
      response.status(404).json({
        error: 'NotFound',
        message: `Grafana dashboard ${request.params.uid} was not found.`,
      });
      return;
    }

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listDashboardPanels(request, response, next) {
  try {
    const data = await grafanaDashboardService.listDashboardPanels(request.params.uid);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listDashboardMetrics(request, response, next) {
  try {
    const data = await grafanaDashboardService.listDashboardMetrics(request.params.uid, {
      includeRaw: request.query.includeRaw,
      limit: request.query.limit,
    });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listSyncLogs(request, response, next) {
  try {
    const data = await grafanaDashboardService.listSyncLogs(request.query.limit);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listAlerts(request, response, next) {
  try {
    const data = await grafanaDashboardService.listAlertStates({
      search: request.query.search,
      state: request.query.state,
    });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listAlertRules(request, response, next) {
  try {
    const data = await grafanaDashboardService.listAlertRules({
      search: request.query.search,
      dashboardUid: request.query.dashboardUid,
    });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function syncAlertRules(request, response, next) {
  try {
    const data = await grafanaDashboardService.syncAlertRulesAndStates();

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function renderPanel(request, response, next) {
  try {
    const image = await grafanaDashboardService.renderPanel(request.params.uid, request.params.panelId, {
      from: request.query.from,
      to: request.query.to,
      width: request.query.width,
      height: request.query.height,
      tz: request.query.tz,
    });

    response.setHeader('Content-Type', image.contentType);
    response.setHeader('Cache-Control', 'private, max-age=30');
    response.send(image.buffer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDashboard,
  getWorkspaceActiveAlerts,
  getWorkspaceAlertRule,
  getWorkspaceDashboard,
  getWorkspacePanelData,
  getWorkspaceOverview,
  getWorkspaceStatus,
  listAlerts,
  listAlertRules,
  listDashboardMetrics,
  listDashboardPanels,
  listDashboards,
  listFolderDashboards,
  listFolders,
  listSyncLogs,
  listWorkspaceAlertRules,
  listWorkspaceDashboards,
  listWorkspaceFolders,
  renderWorkspacePanel,
  renderPanel,
  syncAlertRules,
  syncDashboards,
};

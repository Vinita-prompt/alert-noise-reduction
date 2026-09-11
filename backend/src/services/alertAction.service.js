const defaultAlertService = require('./alert.service');
const defaultAtlassianOpsService = require('./atlassian/opsIngestion.service');

function isOperationsAlert(alert) {
  return ['jsm_ops', 'atlassian_ops'].includes(alert?.source) || alert?.sourceName === 'JSM Operations';
}

function createActionMeta({ action, alert, actor, mode, upstream, upstreamStatus = null }) {
  return {
    action,
    alertId: alert.id,
    actor,
    mode,
    result: 'success',
    source: alert.source || alert.sourceName || 'unknown',
    timestamp: new Date().toISOString(),
    upstream,
    upstreamStatus,
  };
}

function createAlertActionService({
  alertService = defaultAlertService,
  atlassianOpsService = defaultAtlassianOpsService,
} = {}) {
  async function getAlert(id) {
    return alertService.getAlertById(id, { includeDetails: false });
  }

  async function execute(id, action, payload = {}) {
    const existingAlert = await getAlert(id);

    if (!existingAlert) return null;

    const actor = payload.actor
      || payload.acknowledgedBy
      || payload.createdBy
      || 'Website operator';

    if (isOperationsAlert(existingAlert)) {
      const result = await atlassianOpsService.performOpsAlertAction(id, action, {
        ...payload,
        actor,
      });

      return {
        alert: result.alert,
        meta: createActionMeta({
          action,
          actor,
          alert: existingAlert,
          mode: 'upstream_write',
          upstream: 'atlassian_operations',
          upstreamStatus: result.atlassianStatus,
        }),
      };
    }

    let alert;

    if (action === 'acknowledge') {
      alert = await alertService.acknowledgeAlert(id, {
        acknowledgedBy: actor,
        slackUserId: payload.slackUserId || null,
        source: payload.source || 'website',
      });
    } else if (action === 'note') {
      alert = await alertService.addAlertNote(id, {
        createdBy: actor,
        note: payload.note,
      });
    } else if (action === 'close') {
      alert = await alertService.applyAlertAction(id, 'close', {
        actor,
        reason: payload.reason,
        source: payload.source || 'website',
      });
    } else {
      const error = new Error(`Unsupported alert action: ${action}.`);
      error.code = 'UNSUPPORTED_ALERT_ACTION';
      error.status = 400;
      throw error;
    }

    if (!alert) return null;

    return {
      alert,
      meta: createActionMeta({
        action,
        actor,
        alert: existingAlert,
        mode: 'local_backend',
        upstream: null,
      }),
    };
  }

  return {
    acknowledgeAlert: (id, payload) => execute(id, 'acknowledge', payload),
    addAlertNote: (id, payload) => execute(id, 'note', payload),
    closeAlert: (id, payload) => execute(id, 'close', payload),
    execute,
  };
}

module.exports = {
  createAlertActionService,
  isOperationsAlert,
  ...createAlertActionService(),
};

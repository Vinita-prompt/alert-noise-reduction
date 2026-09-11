const {
  addMinutes,
  mapRecord,
  slug,
  toIso,
} = require('./abcHubAdapterUtils');

const definition = {
  key: 'datatrak-user-monitoring',
  label: 'DataTrak User Monitoring',
  entityType: 'module',
  primaryEntityType: 'datatrak_user',
  eventEntityType: 'datatrak_user_event',
  description: 'DataTrak user session status, activity history, and access monitoring timeline.',
};

function buildMockRecords(range, config) {
  const now = range.to;
  const users = [
    {
      id: 'DTU-10293',
      name: 'Operations Service Account',
      status: 'ok',
      activity: 'Authenticated and completed club lookup workflow.',
      offset: -3,
    },
    {
      id: 'DTU-11820',
      name: 'Billing Automation User',
      status: 'warning',
      activity: 'Repeated retry activity detected during invoice export.',
      offset: -14,
    },
    {
      id: 'DTU-14012',
      name: 'Club Admin User',
      status: 'ok',
      activity: 'Active DataTrak session with normal navigation events.',
      offset: -22,
    },
    {
      id: 'DTU-15177',
      name: 'Support Analyst User',
      status: 'critical',
      activity: 'Account locked after repeated failed login attempts.',
      offset: -36,
    },
  ];
  const records = [];

  users.forEach((user) => {
    const timestamp = addMinutes(now, user.offset);
    const entityId = `${definition.key}:${user.id}`;

    records.push(mapRecord({
      applicationName: definition.label,
      entityType: definition.primaryEntityType,
      entityId,
      moduleKey: definition.key,
      entityName: user.name,
      status: user.status,
      summary: `${user.name} monitoring status is ${user.status}`,
      details: user.activity,
      timestamp: toIso(timestamp),
      lastUpdatedAt: toIso(timestamp),
      deepLinkPath: `/datatrak-user-monitoring/users/${encodeURIComponent(user.id)}`,
      customProperties: {
        userName: user.name,
        userId: user.id,
        monitoringStatus: user.status,
        activity: user.activity,
        rawMonitoringDetails: {
          sessionState: user.status === 'critical' ? 'locked' : 'active',
          sourceModule: 'DataTrak',
          eventCount: user.status === 'ok' ? 3 : 7,
        },
      },
      rawPayload: { source: 'mock', user },
    }, config));

    records.push(mapRecord({
      applicationName: definition.label,
      entityType: definition.eventEntityType,
      entityId: `${entityId}:event:${Math.abs(user.offset)}`,
      moduleKey: definition.key,
      entityName: user.name,
      status: user.status,
      summary: `${user.name} activity event`,
      details: user.activity,
      timestamp: toIso(timestamp),
      lastUpdatedAt: toIso(timestamp),
      deepLinkPath: `/datatrak-user-monitoring/users/${encodeURIComponent(user.id)}/history`,
      customProperties: {
        userName: user.name,
        userId: user.id,
        monitoringStatus: user.status,
        eventType: user.status === 'critical' ? 'access_lock' : user.status === 'warning' ? 'retry_activity' : 'activity',
        activity: user.activity,
      },
      rawPayload: { source: 'mock-history', user },
    }, config));
  });

  return records;
}

function buildKeyMetrics(records) {
  const users = records.filter((record) => record.entityType === definition.primaryEntityType);

  return [
    { label: 'Users monitored', value: users.length },
    { label: 'Healthy', value: users.filter((record) => record.status === 'ok').length },
    { label: 'Warnings', value: users.filter((record) => record.status === 'warning').length },
    { label: 'Critical', value: users.filter((record) => record.status === 'critical').length },
  ];
}

module.exports = {
  buildKeyMetrics,
  buildMockRecords,
  definition,
};

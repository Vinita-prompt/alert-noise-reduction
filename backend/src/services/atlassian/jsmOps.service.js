const { opsWriteClient } = require('./clients');

function normalizeResponder(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed ? { id: trimmed, type: 'user' } : null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const id = value.id
    || value.accountId
    || value.account_id
    || value.teamId
    || value.team_id
    || value.value
    || value.name
    || value.displayName;
  const type = value.type
    || value.responderType
    || (value.teamId || value.team_id ? 'team' : 'user');

  if (!id) {
    return null;
  }

  return {
    ...value,
    id: String(id).trim(),
    type: String(type || 'user').trim().toLowerCase(),
  };
}

function normalizeResponderPayload(payload = {}) {
  const sourceResponders = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.responders)
      ? payload.responders
      : payload.responder
        ? [payload.responder]
        : [];
  const responders = sourceResponders
    .map(normalizeResponder)
    .filter(Boolean);

  if (responders.length === 0) {
    const error = new Error('At least one responder is required. Provide responders with id/accountId/teamId/name.');
    error.status = 400;
    throw error;
  }

  return {
    responders,
  };
}

async function addAlertResponder(alertId, responderPayload = {}) {
  const normalizedPayload = normalizeResponderPayload(responderPayload);
  const encodedAlertId = encodeURIComponent(alertId);
  const response = await opsWriteClient.request(
    `/v1/alerts/${encodedAlertId}/responders`,
    {
      method: 'POST',
      body: normalizedPayload,
    },
  );

  return {
    alertId,
    metadata: response.body || {},
    responders: normalizedPayload.responders,
    status: response.status,
  };
}

module.exports = {
  addAlertResponder,
  normalizeResponderPayload,
};

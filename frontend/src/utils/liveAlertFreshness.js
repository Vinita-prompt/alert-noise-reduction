export function detectNewAlertIds(previousIds, items = []) {
  if (!(previousIds instanceof Set)) return [];
  return items
    .filter((alert) => alert?.id && !previousIds.has(alert.id))
    .map((alert) => alert.id);
}

export function withNewAlertState(payload, unviewedIds) {
  const activeIds = unviewedIds instanceof Set ? unviewedIds : new Set();
  return {
    ...payload,
    items: (payload.items || []).map((alert) => ({
      ...alert,
      isNew: activeIds.has(alert.id),
    })),
  };
}

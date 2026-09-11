function normalizeFieldName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function buildFieldLookup(fields = []) {
  const byId = {};
  const byName = {};

  for (const field of fields) {
    if (!field?.id) {
      continue;
    }

    byId[field.id] = field;
    byName[normalizeFieldName(field.name || field.id)] = field.id;
  }

  return { byId, byName };
}

function mapCustomFields(fields = {}, fieldLookup = buildFieldLookup([]), toText = String) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => key.startsWith('customfield_'))
      .map(([key, value]) => {
        const metadata = fieldLookup.byId?.[key] || {};

        return [
          key,
          {
            id: key,
            name: metadata.name || key,
            schema: metadata.schema || null,
            searchable: metadata.searchable ?? null,
            navigable: metadata.navigable ?? null,
            orderable: metadata.orderable ?? null,
            clauseNames: metadata.clauseNames || [],
            text: toText(value),
            raw: value,
          },
        ];
      }),
  );
}

module.exports = {
  buildFieldLookup,
  mapCustomFields,
  normalizeFieldName,
};

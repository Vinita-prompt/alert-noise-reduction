const INTERNAL_EPISODE_KEYS = new Set([
  'episodeId',
  'episode_id',
  'episodeIds',
  'episode_ids',
]);

function redactEpisodeIdentifierText(value) {
  return value
    .replace(/\bTEST_EPISODE[_:-][A-Za-z0-9._:-]+\b/gi, 'current occurrence')
    .replace(/\bepisode-[A-Za-z0-9._:-]+\b/gi, 'current occurrence');
}

function stripInternalEpisodeIdentifiers(value) {
  if (Array.isArray(value)) return value.map(stripInternalEpisodeIdentifiers);
  if (value instanceof Date) return value;
  if (typeof value === 'string') return redactEpisodeIdentifierText(value);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !INTERNAL_EPISODE_KEYS.has(key))
    .map(([key, nested]) => [key, stripInternalEpisodeIdentifiers(nested)]));
}

module.exports = {
  INTERNAL_EPISODE_KEYS,
  redactEpisodeIdentifierText,
  stripInternalEpisodeIdentifiers,
};

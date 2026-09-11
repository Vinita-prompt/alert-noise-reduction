const db = require('../config/db');
const alertService = require('./alert.service');
const integrationService = require('./integration.service');
const slackParser = require('./slackParser.service');

const SLACK_PAGE_LIMIT = 50;
const SLACK_TIMEOUT_MS = 10000;
const MAX_HISTORY_PAGES = 1;
const MAX_BACKFILL_PAGES = 10000;
const MAX_INCREMENTAL_PAGES = 10;

const slackHistoryJob = {
  status: 'idle',
  mode: null,
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
};

function clampPositiveInteger(value, fallback, max) {
  if (value === 'all') {
    return max;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildSlackApiUrl(path, params = {}) {
  const url = new URL(path, 'https://slack.com/api/');

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function getSlackNetworkErrorMessage(error) {
  const code = error.cause?.code || error.code;

  if (error.name === 'AbortError') {
    return 'Slack history import timed out. Check VPN/network access and try again.';
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return 'Slack history import is blocked because Node.js cannot verify the corporate SSL certificate. The Slack desktop app can still work while backend Slack API calls fail.';
  }

  return `Unable to reach Slack history API from the backend.${code ? ` Error: ${code}.` : ''}`;
}

function shouldSkipSlackHistoryMessage(message = {}) {
  if (!message.text && !message.attachments?.length && !message.blocks?.length) {
    return true;
  }

  if (message.subtype === 'message_deleted' || message.subtype === 'message_changed') {
    return true;
  }

  const text = String(message.text || '').toLowerCase();

  return text.includes('alert acknowledgement required') || text.includes('investigation is now available');
}

async function fetchSlackHistoryPage(config, cursor = null, options = {}) {
  const historyOptions = typeof options === 'number' ? { limit: options } : options;
  const url = buildSlackApiUrl('conversations.history', {
    channel: config.alertChannelId,
    limit: historyOptions.limit || SLACK_PAGE_LIMIT,
    cursor,
    oldest: historyOptions.oldest,
    latest: historyOptions.latest,
    inclusive: historyOptions.inclusive === true ? 'true' : undefined,
  });

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.botToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));

    if (response.status === 429) {
      const retryAfter = clampPositiveInteger(response.headers.get('retry-after'), 1, 60);

      await sleep(retryAfter * 1000);
      return fetchSlackHistoryPage(config, cursor, historyOptions);
    }

    if (!response.ok || !payload.ok) {
      const message = payload.error
        ? `Slack history API returned: ${payload.error}.`
        : `Slack history API returned HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status || 502;
      throw error;
    }

    return payload;
  } catch (error) {
    if (error.status) {
      throw error;
    }

    const networkError = new Error(getSlackNetworkErrorMessage(error));
    networkError.status = 502;
    throw networkError;
  }
}

async function processSlackMessages(messages, config, summary, importType) {
  for (const message of messages) {
    if (shouldSkipSlackHistoryMessage(message)) {
      summary.skipped += 1;
      continue;
    }

    try {
      const event = {
        ...message,
        channel: config.alertChannelId,
      };
      const parsedAlert = slackParser.parseSlackAlertMessage(event, {
        type: importType,
        workspaceUrl: config.workspaceUrl,
        channel: config.alertChannelId,
        message,
      });
      const result = await alertService.storeSlackAlert(parsedAlert, {
        notifySlack: false,
      });

      if (result.result === 'updated') {
        summary.updated += 1;
      } else {
        summary.inserted += 1;
      }
    } catch (error) {
      summary.skipped += 1;
      summary.errors.push({
        slackMessageTs: message.ts || null,
        message: error.message,
      });
      summary.errors = summary.errors.slice(-20);
    }
  }
}

async function importSlackChannelHistory(options = {}) {
  const config = await integrationService.getSlackRuntimeConfig();
  const pageLimit = clampPositiveInteger(options.limit, SLACK_PAGE_LIMIT, 200);
  const importType = options.mode || 'slack_history_import';
  const maxPageLimit = options.maxPages === 'all' || importType.includes('backfill')
    ? MAX_BACKFILL_PAGES
    : 10;
  const maxPages = clampPositiveInteger(options.maxPages, MAX_HISTORY_PAGES, maxPageLimit);
  let cursor = null;
  let pageCount = 0;
  const summary = {
    source: 'slack_channel_history',
    channelId: config.alertChannelId,
    mode: importType,
    pageLimit,
    maxPages,
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  do {
    pageCount += 1;
    const page = await fetchSlackHistoryPage(config, cursor, {
      limit: pageLimit,
      oldest: options.oldest,
      latest: options.latest,
      inclusive: options.inclusive,
    });
    const messages = page.messages || [];

    summary.fetched += messages.length;
    await processSlackMessages(messages, config, summary, importType);

    cursor = page.response_metadata?.next_cursor || null;
    summary.pagesFetched = pageCount;
    summary.truncated = Boolean(cursor);
    summary.nextCursorAvailable = Boolean(cursor);

    if (typeof options.onProgress === 'function') {
      options.onProgress({ ...summary });
    }
  } while (cursor && pageCount < maxPages);

  summary.pagesFetched = pageCount;
  summary.truncated = Boolean(cursor);
  summary.nextCursorAvailable = Boolean(cursor);

  return summary;
}

async function getLatestSlackMessageTs(channelId) {
  const result = await db.query(
    `
      SELECT slack_message_ts
      FROM alerts
      WHERE slack_channel_id = $1
        AND slack_message_ts IS NOT NULL
      ORDER BY NULLIF(regexp_replace(slack_message_ts, '[^0-9.]', '', 'g'), '')::numeric DESC
      LIMIT 1
    `,
    [channelId],
  );

  return result.rows[0]?.slack_message_ts || null;
}

async function getOldestSlackMessageTs(channelId) {
  const result = await db.query(
    `
      SELECT slack_message_ts
      FROM alerts
      WHERE slack_channel_id = $1
        AND slack_message_ts IS NOT NULL
      ORDER BY NULLIF(regexp_replace(slack_message_ts, '[^0-9.]', '', 'g'), '')::numeric ASC
      LIMIT 1
    `,
    [channelId],
  );

  return result.rows[0]?.slack_message_ts || null;
}

async function syncNewSlackNotifications(options = {}) {
  if (slackHistoryJob.status === 'running') {
    return {
      source: 'slack_channel_history',
      mode: 'incremental_sync',
      skipped: true,
      message: 'Slack full history backfill is running. New notification sync will continue after it finishes.',
    };
  }

  const config = await integrationService.getSlackRuntimeConfig();
  const oldest = options.oldest || await getLatestSlackMessageTs(config.alertChannelId);

  return importSlackChannelHistory({
    limit: options.limit || 100,
    maxPages: options.maxPages || MAX_INCREMENTAL_PAGES,
    oldest,
    inclusive: false,
    mode: 'slack_incremental_sync',
  });
}

function getSlackHistoryImportStatus() {
  return { ...slackHistoryJob };
}

function updateSlackHistoryJob(update) {
  Object.assign(slackHistoryJob, update);
}

async function runSlackHistoryBackfill(options = {}) {
  const config = await integrationService.getSlackRuntimeConfig();
  const resumeLatest = options.latest || (
    options.resumeFromOldest === false
      ? null
      : await getOldestSlackMessageTs(config.alertChannelId)
  );

  updateSlackHistoryJob({
    status: 'running',
    mode: 'historical_backfill',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: {
      source: 'slack_channel_history',
      mode: 'historical_backfill',
      fetched: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      resumeLatest,
      pagesFetched: 0,
      truncated: false,
      nextCursorAvailable: false,
    },
    error: null,
  });

  try {
    const summary = await importSlackChannelHistory({
      limit: options.limit || 200,
      maxPages: options.maxPages || 'all',
      mode: 'slack_historical_backfill',
      latest: resumeLatest,
      inclusive: false,
      onProgress(summaryUpdate) {
        updateSlackHistoryJob({
          summary: summaryUpdate,
        });
      },
    });

    updateSlackHistoryJob({
      status: 'completed',
      finishedAt: new Date().toISOString(),
      summary,
      error: null,
    });
  } catch (error) {
    updateSlackHistoryJob({
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message,
    });
  }
}

function startSlackHistoryBackfill(options = {}) {
  if (slackHistoryJob.status === 'running') {
    return getSlackHistoryImportStatus();
  }

  setImmediate(() => {
    runSlackHistoryBackfill(options);
  });

  updateSlackHistoryJob({
    status: 'starting',
    mode: 'historical_backfill',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });

  return getSlackHistoryImportStatus();
}

module.exports = {
  getSlackHistoryImportStatus,
  importSlackChannelHistory,
  startSlackHistoryBackfill,
  syncNewSlackNotifications,
};

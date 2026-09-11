const SLACK_API_BASE_URL = 'https://slack.com/api/';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_USER_CACHE_TTL_MS = 60 * 60 * 1000;

class SlackIngestionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SlackIngestionError';
    this.code = options.code || 'SLACK_INGESTION_ERROR';
    this.status = options.status || 500;
    this.safeMessage = message;
    this.details = options.details || undefined;
    this.safeDetails = options.details || undefined;
  }
}

function getSlackConfig(env = process.env) {
  const botToken = env.SLACK_BOT_USER_OAUTH_TOKEN || env.SLACK_BOT_TOKEN || '';
  const channelId = env.SLACK_CHANNEL_ID || env.SLACK_ALERT_CHANNEL_ID || '';
  const missing = [];

  if (!botToken) missing.push('SLACK_BOT_USER_OAUTH_TOKEN');
  if (!channelId) missing.push('SLACK_CHANNEL_ID');

  if (missing.length > 0) {
    throw new SlackIngestionError(
      `Slack ingestion is not configured. Set ${missing.join(' and ')} in backend/.env.`,
      { code: 'SLACK_NOT_CONFIGURED', status: 503, details: { missing } },
    );
  }

  if (!botToken.startsWith('xoxb-')) {
    throw new SlackIngestionError(
      'Slack ingestion requires a bot user OAuth token that starts with xoxb-.',
      { code: 'SLACK_INVALID_TOKEN_TYPE', status: 503 },
    );
  }

  return {
    botToken,
    channelId,
    timeoutMs: positiveInteger(env.SLACK_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000),
    userCacheTtlMs: positiveInteger(
      env.SLACK_USER_CACHE_TTL_MS,
      DEFAULT_USER_CACHE_TTL_MS,
      60000,
      24 * 60 * 60 * 1000,
    ),
  };
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function pageCount(value, fallback = Infinity) {
  if (value === undefined || value === null || value === '' || value === 'all') return fallback;
  return positiveInteger(value, fallback, 1, 10000);
}

function slackTimestampToIso(timestamp) {
  const seconds = Number.parseFloat(timestamp);
  if (!Number.isFinite(seconds)) return null;
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

function channelCreatedToIso(timestamp) {
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function compactText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractAlertNumber(message = {}) {
  const searchableContent = [
    message.text,
    ...(message.attachments || []).flatMap((attachment) => [
      attachment.fallback,
      attachment.pretext,
      attachment.title,
      attachment.text,
      ...(attachment.fields || []).flatMap((field) => [field.title, field.value]),
    ]),
    JSON.stringify(message.blocks || []),
  ]
    .filter(Boolean)
    .join('\n');
  const match = searchableContent.match(/\bAlert\s*(?:number|no\.?\s*)?#?\s*(\d{3,})\b/i);

  return match?.[1] || null;
}

function extractLinks(message) {
  const links = new Set();
  const text = compactText(message?.text);
  const slackLinkPattern = /<(https?:\/\/[^>|]+)(?:\|[^>]+)?>/gi;
  const plainLinkPattern = /https?:\/\/[^\s<>]+/gi;

  for (const match of text.matchAll(slackLinkPattern)) links.add(match[1]);
  const textWithoutSlackLinks = text.replace(slackLinkPattern, '');
  for (const match of textWithoutSlackLinks.matchAll(plainLinkPattern)) links.add(match[0].replace(/[),.;]+$/, ''));

  (message?.attachments || []).forEach((attachment) => {
    [attachment.from_url, attachment.title_link, attachment.image_url, attachment.thumb_url]
      .filter(Boolean)
      .forEach((url) => links.add(url));
  });

  (message?.files || []).forEach((file) => {
    [file.permalink, file.url_private, file.url_private_download]
      .filter(Boolean)
      .forEach((url) => links.add(url));
  });

  return [...links];
}

function normalizeReactions(reactions = []) {
  return reactions.map((reaction) => ({
    name: reaction.name || null,
    count: Number(reaction.count || 0),
    users: Array.isArray(reaction.users) ? reaction.users : [],
  }));
}

function normalizeFiles(files = []) {
  return files.map((file) => ({
    id: file.id || null,
    name: file.name || null,
    title: file.title || null,
    mimetype: file.mimetype || null,
    filetype: file.filetype || null,
    size: file.size ?? null,
    mode: file.mode || null,
    permalink: file.permalink || null,
    url_private: file.url_private || null,
    url_private_download: file.url_private_download || null,
  }));
}

function mapSlackApiError(method, payload = {}, statusCode = 400) {
  const slackError = payload.error || 'unknown_error';
  const details = {
    method,
    slackError,
    neededScope: payload.needed || undefined,
  };

  if (['invalid_auth', 'not_authed', 'account_inactive', 'token_expired', 'token_revoked'].includes(slackError)) {
    return new SlackIngestionError(
      'Slack authentication failed. Check that the bot token is valid, active, and installed to the intended workspace.',
      { code: 'SLACK_AUTHENTICATION_FAILED', status: 401, details },
    );
  }

  if (slackError === 'missing_scope') {
    const suffix = payload.needed ? ` Required scope: ${payload.needed}.` : '';
    return new SlackIngestionError(
      `The Slack app is missing a required OAuth scope.${suffix}`,
      { code: 'SLACK_MISSING_SCOPE', status: 403, details },
    );
  }

  if (['not_in_channel', 'no_permission', 'access_denied', 'restricted_action', 'channel_not_found'].includes(slackError)) {
    const invalidChannel = slackError === 'channel_not_found';
    return new SlackIngestionError(
      invalidChannel
        ? 'The configured Slack channel was not found or is not visible to this bot. Verify the channel ID and invite the app to private channels.'
        : 'The Slack bot cannot access the configured channel. Invite the app to the channel and verify its channel history scopes.',
      {
        code: invalidChannel ? 'SLACK_CHANNEL_NOT_FOUND' : 'SLACK_CHANNEL_ACCESS_DENIED',
        status: invalidChannel ? 404 : 403,
        details,
      },
    );
  }

  if (slackError === 'not_allowed_token_type') {
    return new SlackIngestionError(
      `Slack does not allow this bot token to call ${method}. Check the method's supported token types for the configured channel.`,
      { code: 'SLACK_TOKEN_TYPE_NOT_ALLOWED', status: 403, details },
    );
  }

  return new SlackIngestionError(
    `Slack rejected the ${method} request (${slackError}).`,
    { code: 'SLACK_API_ERROR', status: statusCode >= 400 ? statusCode : 502, details },
  );
}

function createSlackIngestionService(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || global.fetch;
  const sleepImpl = dependencies.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const configProvider = dependencies.configProvider || (() => getSlackConfig());
  const now = dependencies.now || (() => Date.now());
  const userCache = new Map();
  const permalinkCache = new Map();
  const availableScopes = new Set();
  const acceptedScopes = new Set();
  let lastFetch = null;

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for Slack ingestion.');
  }

  function captureScopeHeaders(response) {
    String(response.headers.get('x-oauth-scopes') || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
      .forEach((scope) => availableScopes.add(scope));
    String(response.headers.get('x-accepted-oauth-scopes') || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
      .forEach((scope) => acceptedScopes.add(scope));
  }

  function getScopeSummary(warnings = []) {
    const missingScopes = new Set(
      warnings
        .map((warning) => warning.neededScope)
        .filter(Boolean),
    );

    return {
      available: [...availableScopes].sort(),
      acceptedForRequests: [...acceptedScopes].sort(),
      missing: [...missingScopes].sort(),
    };
  }

  async function slackApi(method, parameters = {}, requestOptions = {}) {
    const config = configProvider();
    const url = new URL(method, SLACK_API_BASE_URL);

    Object.entries(parameters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestOptions.timeoutMs || config.timeoutMs);
      let response;

      try {
        response = await fetchImpl(url, {
          method: requestOptions.httpMethod || 'GET',
          headers: {
            Authorization: `Bearer ${config.botToken}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        throw new SlackIngestionError(
          timedOut
            ? `Slack ${method} timed out. Try again after checking network access to slack.com.`
            : `Slack ${method} could not reach slack.com. Check the backend network and TLS configuration.`,
          { code: timedOut ? 'SLACK_TIMEOUT' : 'SLACK_NETWORK_ERROR', status: 502 },
        );
      } finally {
        clearTimeout(timeout);
      }

      captureScopeHeaders(response);

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const fallbackWaits = [30, 60, 120, 240];
        const retryAfterSeconds = retryAfterHeader
          ? positiveInteger(retryAfterHeader, 30, 1, 300)
          : fallbackWaits[Math.min(attempt, fallbackWaits.length - 1)];

        if (attempt < 4) {
          await sleepImpl(retryAfterSeconds * 1000);
          continue;
        }

        throw new SlackIngestionError(
          `Slack rate-limited ${method}. Retry after ${retryAfterSeconds} seconds.`,
          {
            code: 'SLACK_RATE_LIMITED',
            status: 429,
            details: { method, retryAfterSeconds },
          },
        );
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new SlackIngestionError(
          `Slack ${method} returned an unreadable response.`,
          { code: 'SLACK_INVALID_RESPONSE', status: 502 },
        );
      }

      if (!response.ok || !payload.ok) {
        throw mapSlackApiError(method, payload, response.status);
      }

      return payload;
    }

    throw new SlackIngestionError('Slack request could not be completed.', { status: 502 });
  }

  async function verifyAuthentication() {
    const payload = await slackApi('auth.test', {}, { httpMethod: 'POST' });
    return {
      authenticated: true,
      workspace: {
        id: payload.team_id || null,
        name: payload.team || null,
        url: payload.url || null,
      },
      identity: {
        userId: payload.user_id || null,
        userName: payload.user || null,
        botId: payload.bot_id || null,
      },
    };
  }

  async function getChannelMetadata() {
    const config = configProvider();
    const payload = await slackApi('conversations.info', {
      channel: config.channelId,
      include_num_members: true,
    });
    const channel = payload.channel || {};

    return {
      id: channel.id || config.channelId,
      name: channel.name || null,
      topic: channel.topic?.value || '',
      purpose: channel.purpose?.value || '',
      createdAt: channelCreatedToIso(channel.created),
      isPrivate: Boolean(channel.is_private),
      isMember: channel.is_member !== false,
      memberCount: channel.num_members ?? null,
    };
  }

  async function readPaginatedMessages(method, parameters, options = {}) {
    const messages = [];
    let cursor = '';
    let pagesFetched = 0;
    let recordsRetrieved = 0;
    const maxPages = options.maxPages === 'all' ? Infinity : pageCount(options.maxPages, 25);
    const limit = positiveInteger(options.limit, DEFAULT_PAGE_SIZE, 1, 200);

    do {
      const payload = await slackApi(method, { ...parameters, limit, cursor });
      const pageMessages = payload.messages || [];
      recordsRetrieved += pageMessages.length;
      if (options.collectMessages !== false) {
        messages.push(...pageMessages);
      }
      pagesFetched += 1;
      cursor = compactText(payload.response_metadata?.next_cursor);
      if (typeof options.onPage === 'function') {
        await options.onPage(pageMessages, {
          cursor: cursor || null,
          hasMore: Boolean(cursor),
          method,
          page: pagesFetched,
          recordsRetrieved,
        });
      }
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          method,
          pagesFetched,
          recordsRetrieved,
          hasMore: Boolean(cursor),
        });
      }
    } while (cursor && pagesFetched < maxPages);

    return {
      messages,
      pagesFetched,
      recordsRetrieved,
      truncated: Boolean(cursor),
      nextCursor: cursor || null,
    };
  }

  async function getUserProfile(userId) {
    if (!userId) return null;
    const config = configProvider();
    const cached = userCache.get(userId);

    if (cached && cached.expiresAt > now()) return cached.value;

    const payload = await slackApi('users.info', { user: userId });
    const user = payload.user || {};
    const profile = user.profile || {};
    const value = {
      id: user.id || userId,
      name: user.name || null,
      displayName: profile.display_name_normalized || profile.display_name || null,
      realName: profile.real_name_normalized || profile.real_name || user.real_name || null,
      isBot: Boolean(user.is_bot),
    };

    userCache.set(userId, { value, expiresAt: now() + config.userCacheTtlMs });
    return value;
  }

  async function getPermalink(channelId, messageTs) {
    const cacheKey = `${channelId}:${messageTs}`;
    if (permalinkCache.has(cacheKey)) return permalinkCache.get(cacheKey);

    const payload = await slackApi('chat.getPermalink', {
      channel: channelId,
      message_ts: messageTs,
    });
    const permalink = payload.permalink || null;
    permalinkCache.set(cacheKey, permalink);
    return permalink;
  }

  function createIngestionContext(options = {}) {
    const warnings = new Map();
    let userLookupEnabled = options.includeUserProfiles !== false;
    let permalinkLookupEnabled = options.includePermalinks !== false;

    function addWarning(error, context = {}) {
      const code = error.code || 'SLACK_PARTIAL_DATA';
      const globalWarningCodes = [
        'SLACK_AUTHENTICATION_FAILED',
        'SLACK_MISSING_SCOPE',
        'SLACK_TOKEN_TYPE_NOT_ALLOWED',
        'SLACK_CHANNEL_ACCESS_DENIED',
      ];
      const key = globalWarningCodes.includes(code)
        ? code
        : `${code}:${context.threadTs || context.userId || context.messageTs || ''}`;
      if (warnings.has(key)) return;
      warnings.set(key, {
        code,
        message: error.safeMessage || error.message || 'Some Slack data could not be retrieved.',
        neededScope: error.details?.neededScope,
        slackError: error.details?.slackError,
        ...context,
      });
    }

    async function safeUserProfile(userId) {
      if (!userId || !userLookupEnabled) return null;
      try {
        return await getUserProfile(userId);
      } catch (error) {
        addWarning(error, { userId });
        if (['SLACK_MISSING_SCOPE', 'SLACK_AUTHENTICATION_FAILED', 'SLACK_TOKEN_TYPE_NOT_ALLOWED'].includes(error.code)) {
          userLookupEnabled = false;
        }
        return null;
      }
    }

    async function safePermalink(channelId, messageTs) {
      if (!messageTs || !permalinkLookupEnabled) return null;
      try {
        return await getPermalink(channelId, messageTs);
      } catch (error) {
        addWarning(error, { messageTs });
        if (['SLACK_MISSING_SCOPE', 'SLACK_AUTHENTICATION_FAILED', 'SLACK_TOKEN_TYPE_NOT_ALLOWED'].includes(error.code)) {
          permalinkLookupEnabled = false;
        }
        return null;
      }
    }

    return {
      addWarning,
      safeUserProfile,
      safePermalink,
      listWarnings: () => [...warnings.values()],
    };
  }

  async function normalizeMessage(message, channel, context, relationship = {}) {
    const user = await context.safeUserProfile(message.user);
    const botName = message.bot_profile?.name || message.username || null;
    const permalink = await context.safePermalink(channel.id, message.ts);
    const parentMessageTs = relationship.parentMessageTs || null;
    const isReply = Boolean(parentMessageTs);
    const isThreadParent = !isReply && Number(message.reply_count || 0) > 0;

    return {
      alert_number: extractAlertNumber(message),
      source: 'slack',
      channel_id: channel.id,
      channel_name: channel.name,
      slack_message_id: message.client_msg_id || `${channel.id}:${message.ts}`,
      message_ts: message.ts || null,
      thread_ts: isReply ? message.thread_ts || parentMessageTs : isThreadParent ? message.ts : message.thread_ts || null,
      parent_message_ts: parentMessageTs,
      message_type: isReply ? 'reply' : isThreadParent ? 'parent' : 'message',
      subtype: message.subtype || null,
      user_id: message.user || null,
      user_name: user?.displayName || user?.realName || user?.name || botName || message.user || 'Unknown user',
      user_display_name: user?.displayName || user?.realName || botName || null,
      is_bot: Boolean(message.bot_id || message.bot_profile || user?.isBot || message.subtype === 'bot_message'),
      text: message.text || '',
      created_at: slackTimestampToIso(message.ts),
      edited_at: slackTimestampToIso(message.edited?.ts),
      reply_count: Number(message.reply_count || 0),
      reactions: normalizeReactions(message.reactions),
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      files: normalizeFiles(message.files),
      links: extractLinks(message),
      permalink,
      replies: [],
      raw_payload: message,
    };
  }

  async function readThreadRaw(channelId, threadTs, options = {}) {
    const result = await readPaginatedMessages(
      'conversations.replies',
      { channel: channelId, ts: threadTs, inclusive: true },
      options,
    );
    const unique = new Map();
    result.messages.forEach((message) => {
      if (message?.ts) unique.set(message.ts, message);
    });
    return { ...result, messages: [...unique.values()] };
  }

  async function getStatus() {
    const config = configProvider();
    const connection = await verifyAuthentication();
    const channel = await getChannelMetadata();
    await readPaginatedMessages(
      'conversations.history',
      { channel: config.channelId, inclusive: true },
      { limit: 1, maxPages: 1 },
    );
    return {
      configured: true,
      connection,
      channel: { ...channel, historyAccessible: true },
      lastFetch,
      scopes: getScopeSummary(),
    };
  }

  async function scanChannelHistory(options = {}) {
    const config = configProvider();
    const connection = options.connection || await verifyAuthentication();
    const channel = options.channel || await getChannelMetadata();
    const history = await readPaginatedMessages(
      'conversations.history',
      {
        channel: config.channelId,
        inclusive: options.inclusive !== false,
        oldest: options.oldest,
      },
      {
        ...options,
        collectMessages: options.collectMessages === true,
        onPage: typeof options.onPage === 'function'
          ? (messages, progress) => options.onPage(messages, {
            ...progress,
            channel,
            connection,
          })
          : undefined,
      },
    );

    return {
      channel,
      connection,
      history,
      scopes: getScopeSummary(),
    };
  }

  async function getMessages(options = {}) {
    const startedAt = new Date(now()).toISOString();
    const config = configProvider();
    const connection = await verifyAuthentication();
    const channel = await getChannelMetadata();
    const context = createIngestionContext(options);
    const history = await readPaginatedMessages(
      'conversations.history',
      { channel: config.channelId, inclusive: true },
      options,
    );
    const messages = [];
    let repliesRetrieved = 0;
    let threadPagesFetched = 0;
    let threadsRetrieved = 0;
    let threadsIncomplete = 0;

    for (const rawMessage of history.messages) {
      const normalized = await normalizeMessage(rawMessage, channel, context);

      if (options.includeThreads !== false && Number(rawMessage.reply_count || 0) > 0) {
        try {
          const thread = await readThreadRaw(channel.id, rawMessage.ts, options);
          const rawReplies = thread.messages.filter((reply) => reply.ts !== rawMessage.ts);
          threadPagesFetched += thread.pagesFetched;
          threadsRetrieved += 1;

          for (const rawReply of rawReplies) {
            normalized.replies.push(await normalizeMessage(rawReply, channel, context, {
              parentMessageTs: rawMessage.ts,
            }));
          }

          repliesRetrieved += normalized.replies.length;
          if (thread.truncated) {
            threadsIncomplete += 1;
            context.addWarning(
              new SlackIngestionError('A Slack thread was truncated by the requested page limit.', {
                code: 'SLACK_THREAD_TRUNCATED',
                status: 206,
              }),
              { threadTs: rawMessage.ts },
            );
          }
        } catch (error) {
          threadsIncomplete += 1;
          context.addWarning(error, { threadTs: rawMessage.ts });
        }
      }

      messages.push(normalized);
    }

    const summary = {
      messagesRetrieved: messages.length,
      parentThreads: messages.filter((message) => message.message_type === 'parent').length,
      threadsRetrieved,
      repliesRetrieved,
      totalRecords: messages.length + repliesRetrieved,
      historyPagesFetched: history.pagesFetched,
      threadPagesFetched,
      truncated: history.truncated || threadsIncomplete > 0,
      complete: !history.truncated && threadsIncomplete === 0,
    };
    const warnings = context.listWarnings();
    lastFetch = {
      startedAt,
      completedAt: new Date(now()).toISOString(),
      channelId: channel.id,
      ...summary,
      warningCount: warnings.length,
    };

    return {
      connection,
      channel,
      messages,
      scopes: getScopeSummary(warnings),
      summary,
      warnings,
      lastFetch,
    };
  }

  async function getThread(threadTs, options = {}) {
    if (!/^\d{9,}\.?\d*$/.test(String(threadTs || ''))) {
      throw new SlackIngestionError('A valid Slack thread timestamp is required.', {
        code: 'SLACK_INVALID_THREAD_TIMESTAMP',
        status: 400,
      });
    }

    const config = configProvider();
    const connection = await verifyAuthentication();
    const channel = await getChannelMetadata();
    const context = createIngestionContext(options);
    const thread = await readThreadRaw(config.channelId, threadTs, options);
    const rawParent = thread.messages.find((message) => message.ts === threadTs) || thread.messages[0];

    if (!rawParent) {
      throw new SlackIngestionError('The requested Slack thread was not found.', {
        code: 'SLACK_THREAD_NOT_FOUND',
        status: 404,
      });
    }

    const parent = await normalizeMessage(rawParent, channel, context);
    parent.message_type = 'parent';
    parent.thread_ts = threadTs;
    parent.replies = [];

    for (const rawReply of thread.messages.filter((message) => message.ts !== rawParent.ts)) {
      parent.replies.push(await normalizeMessage(rawReply, channel, context, {
        parentMessageTs: rawParent.ts,
      }));
    }

    return {
      connection,
      channel,
      parent,
      replies: parent.replies,
      scopes: getScopeSummary(context.listWarnings()),
      summary: {
        repliesRetrieved: parent.replies.length,
        pagesFetched: thread.pagesFetched,
        truncated: thread.truncated,
        complete: !thread.truncated,
      },
      warnings: context.listWarnings(),
    };
  }

  function resetCaches() {
    userCache.clear();
    permalinkCache.clear();
    lastFetch = null;
  }

  return {
    getStatus,
    getMessages,
    getThread,
    scanChannelHistory,
    verifyAuthentication,
    getChannelMetadata,
    resetCaches,
  };
}

const slackIngestionService = createSlackIngestionService();

module.exports = {
  SlackIngestionError,
  createSlackIngestionService,
  extractAlertNumber,
  getSlackConfig,
  slackTimestampToIso,
  ...slackIngestionService,
};

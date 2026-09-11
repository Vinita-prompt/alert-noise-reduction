const crypto = require('crypto');
const express = require('express');
const integrationService = require('../services/integration.service');
const slackAlertStoreService = require('../services/slackAlertStore.service');
const slackCallbackInboxService = require('../services/slackCallbackInbox.service');
const slackIngestionService = require('../services/slackIngestion.service');
const { service: humanVerificationService } = require('../services/humanVerification.service');
const { service: authenticationService } = require('../services/authentication.service');

const router = express.Router();
const slackReplayCache = new Map();
const SLACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

function parseReadOptions(query = {}) {
  const limit = Number.parseInt(query.limit, 10);
  const parsedMaxPages = Number.parseInt(query.maxPages, 10);

  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 100,
    maxPages: query.maxPages === 'all'
      ? 'all'
      : query.maxPages === undefined || !Number.isFinite(parsedMaxPages)
        ? 25
      : Math.min(Math.max(parsedMaxPages, 1), 10000),
    includeThreads: query.includeThreads !== 'false',
    includeUserProfiles: query.includeUserProfiles !== 'false',
    includePermalinks: query.includePermalinks !== 'false',
  };
}

router.get('/status', async (request, response, next) => {
  try {
    const data = await slackIngestionService.getStatus();
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/messages', async (request, response, next) => {
  try {
    const data = await slackIngestionService.getMessages(parseReadOptions(request.query));
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/status', async (request, response, next) => {
  try {
    const data = await slackAlertStoreService.getStatus();
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts', authenticationService.middleware, authenticationService.requireAuthenticated, async (request, response, next) => {
  try {
    const data = await slackAlertStoreService.getAlerts(request.query);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/reconciliation', async (request, response, next) => {
  try {
    const data = await slackAlertStoreService.getReconciliationReport();
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/verification-reconciliation', async (request, response, next) => {
  try {
    const data = await humanVerificationService.occurrenceDeliveryReconciliation();
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/:id', authenticationService.middleware, authenticationService.requireAuthenticated, async (request, response, next) => {
  try {
    const data = await slackAlertStoreService.getAlertById(request.params.id);

    if (!data) {
      response.status(404).json({
        error: 'Slack-derived alert not found.',
        message: 'The requested alert is not present in the completed Slack extraction.',
      });
      return;
    }

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/threads/:threadTs', async (request, response, next) => {
  try {
    const data = await slackIngestionService.getThread(
      request.params.threadTs,
      parseReadOptions(request.query),
    );
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifySlackSignature(request, response, next) {
  let slackConfig;

  try {
    slackConfig = await integrationService.getSlackRuntimeConfig();
  } catch (error) {
    response.status(error.status || 500).json({
      error: 'Slack configuration is not available.',
      message: 'Configure Slack in Settings or set SLACK_BOT_USER_OAUTH_TOKEN, SLACK_SIGNING_SECRET, and SLACK_CHANNEL_ID in backend/.env. Legacy aliases remain supported.',
    });
    return;
  }

  const signingSecret = slackConfig.signingSecret;

  if (!signingSecret) {
    response.status(500).json({
      error: 'Slack signing secret is not configured.',
      message: 'Configure Slack Signing Secret in Settings or backend/.env.',
    });
    return;
  }

  const timestamp = request.get('x-slack-request-timestamp');
  const slackSignature = request.get('x-slack-signature');

  if (!timestamp || !slackSignature) {
    response.status(401).json({ error: 'Missing Slack signature headers.' });
    return;
  }

  const requestAgeSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));

  if (!Number.isFinite(requestAgeSeconds) || requestAgeSeconds > 60 * 5) {
    response.status(401).json({ error: 'Slack request timestamp is too old.' });
    return;
  }

  // Slack signs the exact raw HTTP request body. Do not use express.json() before
  // this route, because re-stringifying parsed JSON can change whitespace/order
  // and break signature verification.
  const rawBody = request.body.toString('utf8');
  const signatureBase = `v0:${timestamp}:${rawBody}`;
  const computedSignature = `v0=${crypto
    .createHmac('sha256', signingSecret)
    .update(signatureBase)
    .digest('hex')}`;

  if (!safeCompare(computedSignature, slackSignature)) {
    humanVerificationService.recordSecurityEvent('INVALID_SLACK_SIGNATURE', {
      route: request.path, timestampPresent: true,
    }).catch(() => {});
    response.status(401).json({ error: 'Invalid Slack signature.' });
    return;
  }

  const replayKey = `${timestamp}:${slackSignature}`;
  const now = Date.now();
  for (const [key, seenAt] of slackReplayCache) {
    if (now - seenAt > SLACK_REPLAY_WINDOW_MS) slackReplayCache.delete(key);
  }
  if (slackReplayCache.has(replayKey)) {
    // Slack retries a callback when its acknowledgement is lost in transit. A
    // signed retry is accepted and deduplicated by the durable callback inbox;
    // an unmarked replay remains a security rejection.
    if (request.get('x-slack-retry-num') !== undefined) {
      request.slackRetry = true;
      next();
      return;
    }
    humanVerificationService.recordSecurityEvent('SLACK_REPLAY_REJECTED', {
      route: request.path, timestampPresent: true,
    }).catch(() => {});
    response.status(409).json({ error: 'Slack request replay rejected.' });
    return;
  }
  slackReplayCache.set(replayKey, now);

  request.rawBody = rawBody;
  request.slackConfig = slackConfig;
  next();
}

function getEventIgnoreReason(payload, slackConfig) {
  const event = payload.event || {};
  const alertChannelId = slackConfig?.alertChannelId;

  if (event.type !== 'message') return 'not_message';
  if (['message_changed', 'message_deleted', 'message_replied'].includes(event.subtype)) return 'message_mutation';
  if (!event.text?.trim()
    && !event.attachments?.length
    && !event.blocks?.length
    && !event.files?.length) return 'empty_message';
  if (alertChannelId && event.channel !== alertChannelId) return 'different_channel';

  return null;
}

function shouldIgnoreEvent(payload, slackConfig) {
  return Boolean(getEventIgnoreReason(payload, slackConfig));
}

function isAsynchronousEvidenceAction(payload = {}) {
  if (payload.type !== 'block_actions') return false;
  const actionId = payload.actions?.[0]?.action_id;
  return [
    'alert_evidence_overflow',
    'collect_evidence',
    'update_evidence',
    'view_evidence',
    'view_jira',
    'human_verification_refresh',
  ].includes(actionId)
    || actionId?.startsWith('evidence_');
}

function dispatchAsynchronousEvidenceAction(payload, response, handler = humanVerificationService.handleSlackInteraction) {
  response.status(200).json({ ok: true, accepted: true });
  console.info({
    code: 'SLACK_EVIDENCE_INTERACTION_ACCEPTED',
    actionId: payload.actions?.[0]?.action_id || 'unknown',
  });
  setImmediate(() => handler(payload).catch((error) => {
    console.error({
      code: error.code || 'SLACK_EVIDENCE_INTERACTION_FAILED',
      message: error.safeMessage || 'Slack evidence interaction failed.',
    });
  }));
}

router.post(
  '/events',
  express.raw({ type: 'application/json' }),
  verifySlackSignature,
  async (request, response, next) => {
    const eventReceivedAt = new Date().toISOString();
    let payload;

    try {
      payload = JSON.parse(request.rawBody);
    } catch (error) {
      response.status(400).json({ error: 'Invalid JSON payload.' });
      return;
    }

    if (payload.type === 'url_verification') {
      response.status(200).send(payload.challenge);
      return;
    }

    if (payload.type !== 'event_callback') {
      response.status(200).json({ ok: true, ignored: true });
      return;
    }

    const ignoreReason = getEventIgnoreReason(payload, request.slackConfig);
    console.info({
      code: 'SLACK_EVENT_RECEIVED',
      channelId: payload.event?.channel || null,
      eventId: payload.event_id || null,
      eventType: payload.event?.type || null,
      messageTs: payload.event?.ts || null,
      subtype: payload.event?.subtype || null,
      accepted: !ignoreReason,
      ignoreReason,
    });

    if (ignoreReason) {
      response.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Persist before acknowledgement. The worker performs normalization,
    // verification delivery, retries, and recovery after process restarts.
    try {
      const accepted = await slackCallbackInboxService.enqueue('EVENT', payload, eventReceivedAt);
      response.status(200).json({
        ok: true,
        accepted: true,
        duplicate: accepted.duplicate,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/interactions',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  verifySlackSignature,
  async (request, response, next) => {
    let payload;

    try {
      const form = new URLSearchParams(request.rawBody.toString('utf8'));
      payload = JSON.parse(form.get('payload'));
    } catch (error) {
      response.status(400).json({ error: 'Invalid Slack interaction payload.' });
      return;
    }

    const action = payload.actions?.[0];

    if (isAsynchronousEvidenceAction(payload)
      || action?.action_id === 'alert_evidence_overflow'
      || payload.type === 'view_submission'
      || action?.action_id?.startsWith('human_verify_')) {
      try {
        const accepted = await slackCallbackInboxService.enqueue('INTERACTION', payload);
        response.status(200).json({
          ok: true,
          accepted: true,
          duplicate: accepted.duplicate,
        });
      } catch (error) {
        next(error);
      }
      return;
    }

    if (action?.action_id !== 'acknowledge_alert') {
      response.status(200).json({ ok: true, ignored: true });
      return;
    }

    response.status(200).json({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'Slack is notification-only for this workflow. Open the Alert Noise Reduction website to acknowledge, investigate, classify, add notes, or link Jira.',
    });
  },
);

module.exports = router;
module.exports.shouldIgnoreEvent = shouldIgnoreEvent;
module.exports.getEventIgnoreReason = getEventIgnoreReason;
module.exports.isAsynchronousEvidenceAction = isAsynchronousEvidenceAction;
module.exports.dispatchAsynchronousEvidenceAction = dispatchAsynchronousEvidenceAction;
module.exports.verifySlackSignature = verifySlackSignature;
module.exports.slackReplayCache = slackReplayCache;

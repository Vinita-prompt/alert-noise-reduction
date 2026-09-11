require('dotenv').config();

const slackIngestionService = require('../src/services/slackIngestion.service');

async function validate() {
  const maxPages = process.env.SLACK_VALIDATION_MAX_PAGES || 25;
  let completedThreadCalls = 0;
  const onProgress = ({ method, pagesFetched, recordsRetrieved, hasMore }) => {
    if (method === 'conversations.replies' && pagesFetched === 1) completedThreadCalls += 1;
    console.error(JSON.stringify({
      phase: method === 'conversations.history' ? 'history' : 'thread',
      page: pagesFetched,
      recordsRetrieved,
      completedThreadCalls,
      hasMore,
    }));
  };
  const result = await slackIngestionService.getMessages({
    limit: 100,
    maxPages,
    includeThreads: true,
    includeUserProfiles: false,
    includePermalinks: false,
    onProgress,
  });

  const sample = await slackIngestionService.getMessages({
    limit: 5,
    maxPages: 1,
    includeThreads: true,
    includeUserProfiles: true,
    includePermalinks: true,
    onProgress,
  });
  const sampleRecords = sample.messages.flatMap((message) => [message, ...(message.replies || [])]);
  const userProfilesResolved = sampleRecords.filter((message) => (
    message.user_id
      && message.user_name
      && message.user_name !== message.user_id
      && message.user_name !== 'Unknown user'
  )).length;
  const permalinksResolved = sampleRecords.filter((message) => Boolean(message.permalink)).length;

  const requiredScopes = result.channel.isPrivate
    ? ['groups:read', 'groups:history', 'users:read']
    : ['channels:read', 'channels:history', 'users:read'];

  console.log(JSON.stringify({
    authenticated: result.connection.authenticated,
    workspace: result.connection.workspace.name,
    identity: result.connection.identity.userName,
    channelAccessed: Boolean(result.channel.id),
    channelName: result.channel.name,
    channelType: result.channel.isPrivate ? 'private' : 'public',
    messagesRetrieved: result.summary.messagesRetrieved,
    parentThreads: result.summary.parentThreads,
    threadsRetrieved: result.summary.threadsRetrieved,
    repliesRetrieved: result.summary.repliesRetrieved,
    totalRecords: result.summary.totalRecords,
    historyPagesFetched: result.summary.historyPagesFetched,
    threadPagesFetched: result.summary.threadPagesFetched,
    complete: result.summary.complete,
    metadataSampleRecords: sampleRecords.length,
    userProfilesResolved,
    permalinksResolved,
    warningCodes: [...new Set([...result.warnings, ...sample.warnings].map((warning) => warning.code))],
    requiredScopes,
  }, null, 2));
}

validate().catch((error) => {
  console.error(JSON.stringify({
    authenticated: false,
    code: error.code || 'SLACK_VALIDATION_FAILED',
    message: error.safeMessage || error.message || 'Slack validation failed.',
    details: error.details || undefined,
  }, null, 2));
  process.exitCode = 1;
});

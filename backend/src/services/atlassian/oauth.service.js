let placeholderState = {
  accessTokenAvailable: Boolean(process.env.ATLASSIAN_OAUTH_ACCESS_TOKEN),
  refreshTokenAvailable: Boolean(process.env.ATLASSIAN_OAUTH_REFRESH_TOKEN),
  cloudId: process.env.ATLASSIAN_CLOUD_ID || null,
  lastCallbackAt: null,
  lastCallbackCodeReceived: false,
};

function getOAuthPlaceholderState() {
  return {
    ...placeholderState,
    callbackUrl: 'http://localhost:4000/api/atlassian/oauth/callback',
    mode: 'stub',
    liveExchangeEnabled: false,
    message: 'OAuth callback route is ready. Token exchange is intentionally disabled until Atlassian approval is available.',
  };
}

function handleOAuthCallback(query = {}) {
  placeholderState = {
    ...placeholderState,
    lastCallbackAt: new Date().toISOString(),
    lastCallbackCodeReceived: Boolean(query.code),
    lastCallbackStateReceived: Boolean(query.state),
    lastCallbackError: query.error || null,
  };

  return getOAuthPlaceholderState();
}

module.exports = {
  getOAuthPlaceholderState,
  handleOAuthCallback,
};

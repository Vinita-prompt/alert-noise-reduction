const express = require('express');
const oauthService = require('../services/atlassian/oauth.service');

const router = express.Router();

router.get('/oauth/callback', (request, response) => {
  const state = oauthService.handleOAuthCallback(request.query || {});

  response.json({
    ok: true,
    data: state,
  });
});

router.get('/oauth/status', (request, response) => {
  response.json({
    ok: true,
    data: oauthService.getOAuthPlaceholderState(),
  });
});

module.exports = router;

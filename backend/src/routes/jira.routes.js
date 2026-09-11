const express = require('express');
const jiraController = require('../controllers/jira.controller');

const router = express.Router();

router.get('/acc/problems', jiraController.listAccProblems);
router.get('/acc/incidents', jiraController.listAccIncidents);
router.get('/acc/issues/:key/comments', jiraController.getAccIssueComments);
router.get('/acc/issues/:key/changelog', jiraController.getAccIssueChangelog);
router.get('/acc/issues/:key', jiraController.getAccIssue);

router.post('/issues/:issueKey/comments', jiraController.addIssueComment);
router.post('/issues/:issueKey/transitions', jiraController.transitionIssue);

module.exports = router;

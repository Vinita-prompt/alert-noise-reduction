const express = require('express');
const rulesController = require('../controllers/rules.controller');

const router = express.Router();

router.get('/', rulesController.getRules);
router.put('/:id', rulesController.updateRule);
router.patch('/:id/status', rulesController.updateRuleStatus);

module.exports = router;

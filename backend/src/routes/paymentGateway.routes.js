const express = require('express');
const paymentGatewayController = require('../controllers/paymentGateway.controller');

const router = express.Router();

router.get('/transactions', paymentGatewayController.getTransactions);
router.get('/summary', paymentGatewayController.getSummary);
router.get('/history', paymentGatewayController.getHistory);

module.exports = router;

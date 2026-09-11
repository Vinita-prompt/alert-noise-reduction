const express = require('express');
const paymentGatewayController = require('../controllers/paymentGateway.controller');

const router = express.Router();

router.post('/payment-gateway', paymentGatewayController.importPaymentGateway);

module.exports = router;

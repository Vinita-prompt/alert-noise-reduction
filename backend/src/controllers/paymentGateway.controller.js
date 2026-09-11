const paymentGatewayService = require('../services/paymentGateway.service');

function buildOptions(request) {
  return {
    from: request.query.from,
    to: request.query.to,
    page: request.query.page,
    size: request.query.size,
    search: request.query.search,
    status: request.query.status,
    responseCode: request.query.responseCode,
    transactionType: request.query.transactionType,
  };
}

async function importPaymentGateway(request, response, next) {
  try {
    const data = await paymentGatewayService.importPaymentGatewayPayload(request.body);

    response.status(201).json({ data });
  } catch (error) {
    next(error);
  }
}

async function getTransactions(request, response, next) {
  try {
    const result = await paymentGatewayService.getPaymentGatewayTransactions(buildOptions(request));

    response.json(result);
  } catch (error) {
    next(error);
  }
}

async function getSummary(request, response, next) {
  try {
    const data = await paymentGatewayService.getPaymentGatewaySummary(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getHistory(request, response, next) {
  try {
    const data = await paymentGatewayService.getPaymentGatewayHistory(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getHistory,
  getSummary,
  getTransactions,
  importPaymentGateway,
};

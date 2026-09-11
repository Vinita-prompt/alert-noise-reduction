const oracleApexService = require('../services/oracleApex.service');

function buildOptions(request) {
  return {
    from: request.query.from,
    to: request.query.to,
  };
}

async function importPayload(request, response, next) {
  try {
    const data = await oracleApexService.importApexPayload(request.body?.payload || request.body, {
      pageNumber: request.body?.pageNumber,
      firstRow: request.body?.firstRow,
      maxRows: request.body?.maxRows,
    });

    response.status(201).json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDashboard(request, response, next) {
  try {
    const data = await oracleApexService.getDashboardDetails(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listApplications(request, response, next) {
  try {
    const data = await oracleApexService.listApplications();

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDashboard,
  importPayload,
  listApplications,
};

const monitoringIngestionService = require('../services/monitoringIngestion.service');

async function getMonitoringSources(request, response, next) {
  try {
    const result = await monitoringIngestionService.getMonitoringSources();

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function ingestTool(request, response, next) {
  try {
    const result = await monitoringIngestionService.ingestTool(request.params.tool);

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function ingestSourcePayload(request, response, next) {
  try {
    const result = await monitoringIngestionService.ingestSourcePayload(request.params.source, request.body);

    response.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function runSourceBackfill(request, response, next) {
  try {
    const result = await monitoringIngestionService.runBackfill(request.params.source);

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

async function runSourceSync(request, response, next) {
  try {
    const result = await monitoringIngestionService.ingestTool(request.params.source);

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMonitoringSources,
  ingestSourcePayload,
  ingestTool,
  runSourceBackfill,
  runSourceSync,
};

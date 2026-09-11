const clients = new Set();

function writeEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function subscribe(request, response) {
  response.status(200);
  response.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  clients.add(response);
  writeEvent(response, 'ready', {
    connectedAt: new Date().toISOString(),
    transport: 'server_sent_events',
  });

  const close = () => clients.delete(response);
  request.once('close', close);
  request.once('aborted', close);
}

function broadcast(eventName, payload) {
  const dispatchedAt = new Date().toISOString();
  let deliveredClients = 0;

  for (const response of [...clients]) {
    if (response.destroyed || response.writableEnded) {
      clients.delete(response);
      continue;
    }
    try {
      writeEvent(response, eventName, { ...payload, dispatchedAt });
      deliveredClients += 1;
    } catch {
      clients.delete(response);
    }
  }

  return {
    connectedClients: clients.size,
    deliveredClients,
    dispatchedAt,
  };
}

function getRuntimeState() {
  return { connectedClients: clients.size };
}

const heartbeat = setInterval(() => {
  const timestamp = new Date().toISOString();
  for (const response of [...clients]) {
    if (response.destroyed || response.writableEnded) {
      clients.delete(response);
      continue;
    }
    response.write(`: heartbeat ${timestamp}\n\n`);
  }
}, 20 * 1000);
heartbeat.unref?.();

module.exports = {
  broadcast,
  getRuntimeState,
  subscribe,
};

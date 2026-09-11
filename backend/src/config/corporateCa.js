const fs = require('fs');
const path = require('path');

function getCorporateCaStatus() {
  const configuredPath = process.env.NODE_EXTRA_CA_CERTS;

  if (!configuredPath) {
    return {
      configured: false,
      message:
        'NODE_EXTRA_CA_CERTS is not set. Start the backend with npm run dev from the backend root to trust ABCFSROOTCA.pem.',
    };
  }

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      configured: false,
      message: `NODE_EXTRA_CA_CERTS points to a missing file: ${resolvedPath}`,
    };
  }

  return {
    configured: true,
    path: resolvedPath,
    message: `Using extra CA certificate: ${resolvedPath}`,
  };
}

function logCorporateCaStatus() {
  const status = getCorporateCaStatus();

  if (status.configured) {
    console.log(status.message);
    return;
  }

  console.warn(status.message);
}

module.exports = {
  getCorporateCaStatus,
  logCorporateCaStatus,
};

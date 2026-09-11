const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const SECRET_KEYS = Object.freeze([
  'DATABASE_URL',
  'INTEGRATION_ENCRYPTION_KEY',
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_USER_OAUTH_TOKEN',
  'JIRA_API_TOKEN',
  'ATLASSIAN_JIRA_READ_TOKEN',
  'ATLASSIAN_OPS_READ_TOKEN',
  'APPDYNAMICS_CREDENTIAL',
  'APPDYNAMICS_CLIENT_SECRET',
  'GRAFANA_API_TOKEN',
  'NAGIOS_D01_API_KEY',
  'NAGIOS_D02_API_KEY',
]);

const REQUIRED_TEMPLATE_KEYS = Object.freeze([
  'NODE_ENV',
  'HOST',
  'PORT',
  'BACKEND_DOMAIN',
  'ALERT_REDUCTION_WEB_URL',
  'CORS_ORIGIN',
  'DATABASE_URL',
  'DB_SSL',
  'DB_SSL_REJECT_UNAUTHORIZED',
  'SLACK_EVENTS_PUBLIC_URL',
  'SLACK_INTERACTIONS_PUBLIC_URL',
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_USER_OAUTH_TOKEN',
  'SLACK_CHANNEL_ID',
  'SLACK_ALERT_VERIFICATION_CHANNEL_ID',
  'SLACK_POLL_INTERVAL_SECONDS',
  'EVIDENCE_ATTACHMENT_STORAGE_DIR',
  'MODEL_MODE',
  'ML_ARTIFACT_STORAGE_DIR',
  'ML_AUTOMATED_RETRAINING_ENABLED',
  'EVIDENCE_COLLECTION_MODE',
  'ATLASSIAN_OPS_WRITE_ENABLED',
  'ATLASSIAN_JIRA_WRITE_ENABLED',
  'ATLASSIAN_JSM_WRITE_ENABLED',
]);

function bool(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'enabled';
}

function populated(value) {
  const normalized = String(value || '').trim();
  return Boolean(normalized)
    && !/^(?:change[-_ ]?me|replace[-_ ]?me|placeholder|example|<.+>)$/i.test(normalized);
}

function callbackUrl(value, expectedPath) {
  try {
    const parsed = new URL(String(value || ''));
    const temporaryHost = /(?:localhost|127\.0\.0\.1|\.trycloudflare\.com|\.ngrok(?:-free)?\.app)$/i
      .test(parsed.hostname);
    return parsed.protocol === 'https:'
      && parsed.pathname === expectedPath
      && !temporaryHost
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function safeAbsoluteStoragePath(value) {
  const normalized = String(value || '').trim();
  if (!normalized || !path.isAbsolute(normalized)) return false;
  return !['/', '/tmp', '/app', '/app/data'].includes(path.normalize(normalized));
}

function validateTemplate(config) {
  const checks = [];
  for (const key of REQUIRED_TEMPLATE_KEYS) {
    checks.push({ key: `template key ${key}`, passed: Object.hasOwn(config, key) });
  }
  for (const key of SECRET_KEYS) {
    if (Object.hasOwn(config, key)) {
      checks.push({ key: `template secret ${key} is empty`, passed: !String(config[key] || '').trim() });
    }
  }
  checks.push({
    key: 'template does not activate the permanent archive',
    passed: !enabled(config.EVIDENCE_COLLECTION_MODE),
  });
  return checks;
}

function validateRuntime(config) {
  const eventUrl = callbackUrl(config.SLACK_EVENTS_PUBLIC_URL, '/api/slack/events');
  const interactionUrl = callbackUrl(config.SLACK_INTERACTIONS_PUBLIC_URL, '/api/slack/interactions');
  let webUrl = null;
  let databaseUrl = null;
  try { webUrl = new URL(String(config.ALERT_REDUCTION_WEB_URL || '')); } catch {}
  try { databaseUrl = new URL(String(config.DATABASE_URL || '')); } catch {}
  const corsOrigins = String(config.CORS_ORIGIN || '').split(',').map((item) => item.trim()).filter(Boolean);
  const writeFlags = [
    config.ATLASSIAN_OPS_WRITE_ENABLED,
    config.ATLASSIAN_JIRA_WRITE_ENABLED,
    config.ATLASSIAN_JSM_WRITE_ENABLED,
  ];
  const mlEnabled = bool(config.ML_AUTOMATED_RETRAINING_ENABLED);
  const backendDomain = String(config.BACKEND_DOMAIN || '').trim().toLowerCase();

  return [
    { key: 'NODE_ENV is production', passed: String(config.NODE_ENV || '').toLowerCase() === 'production' },
    { key: 'backend listens on all container interfaces', passed: config.HOST === '0.0.0.0' },
    { key: 'backend port is 4000', passed: Number(config.PORT) === 4000 },
    { key: 'managed PostgreSQL URL is configured', passed: populated(config.DATABASE_URL) && ['postgres:', 'postgresql:'].includes(databaseUrl?.protocol) },
    { key: 'PostgreSQL TLS is enabled', passed: bool(config.DB_SSL) },
    { key: 'PostgreSQL certificate verification is enabled', passed: bool(config.DB_SSL_REJECT_UNAUTHORIZED) },
    { key: 'Slack Events callback is permanent HTTPS', passed: Boolean(eventUrl) },
    { key: 'Slack Interactions callback is permanent HTTPS', passed: Boolean(interactionUrl) },
    { key: 'Slack callbacks share one origin', passed: Boolean(eventUrl && interactionUrl && eventUrl.origin === interactionUrl.origin) },
    { key: 'public domain matches Slack callbacks', passed: Boolean(eventUrl && backendDomain && eventUrl.hostname.toLowerCase() === backendDomain) },
    { key: 'website uses the public HTTPS origin', passed: Boolean(webUrl && webUrl.protocol === 'https:' && webUrl.hostname.toLowerCase() === backendDomain) },
    { key: 'CORS allows only the website origin', passed: Boolean(webUrl && corsOrigins.includes(webUrl.origin) && !corsOrigins.includes('*')) },
    { key: 'Slack signing secret is configured', passed: populated(config.SLACK_SIGNING_SECRET) },
    { key: 'Slack bot token is configured', passed: populated(config.SLACK_BOT_USER_OAUTH_TOKEN) },
    { key: 'Slack source channel is configured', passed: populated(config.SLACK_CHANNEL_ID) },
    { key: 'Slack verification channel is configured', passed: populated(config.SLACK_ALERT_VERIFICATION_CHANNEL_ID) },
    { key: 'Slack polling fallback is 30 seconds', passed: Number(config.SLACK_POLL_INTERVAL_SECONDS) === 30 },
    { key: 'evidence attachment path is durable-path eligible', passed: safeAbsoluteStoragePath(config.EVIDENCE_ATTACHMENT_STORAGE_DIR) },
    { key: 'ML artifact path is durable-path eligible', passed: safeAbsoluteStoragePath(config.ML_ARTIFACT_STORAGE_DIR) },
    { key: 'evidence and ML storage paths are separate', passed: path.normalize(String(config.EVIDENCE_ATTACHMENT_STORAGE_DIR || '')) !== path.normalize(String(config.ML_ARTIFACT_STORAGE_DIR || '')) },
    { key: 'model mode remains SHADOW', passed: String(config.MODEL_MODE || '').toUpperCase() === 'SHADOW' },
    { key: 'ML worker has a Python executable configured', passed: !mlEnabled || populated(config.ML_PYTHON_PATH) },
    { key: 'development authentication is disabled', passed: !bool(config.AUTH_DEVELOPMENT_ENABLED) },
    { key: 'external write integrations remain disabled', passed: writeFlags.every((value) => !bool(value)) },
    { key: 'archive activation is explicit', passed: ['disabled', 'enabled'].includes(String(config.EVIDENCE_COLLECTION_MODE || '').trim().toLowerCase()) },
  ];
}

function readConfig(file) {
  return dotenv.parse(fs.readFileSync(file));
}

function parseArguments(argv) {
  const template = argv.includes('--template');
  const environmentOnly = argv.includes('--environment');
  const fileArgument = argv.find((item, index) => argv[index - 1] === '--env-file');
  return { environmentOnly, fileArgument, template };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const defaultFile = path.resolve(__dirname, '../.env.production');
  let config = { ...process.env };
  if (!args.environmentOnly) {
    const file = path.resolve(process.cwd(), args.fileArgument || (args.template
      ? path.join(__dirname, '../.env.production.example')
      : defaultFile));
    if (!fs.existsSync(file)) {
      process.stderr.write('Production configuration validation: FAIL (environment file not found)\n');
      process.exitCode = 1;
      return;
    }
    config = args.template ? readConfig(file) : { ...readConfig(file), ...process.env };
  }

  const checks = args.template ? validateTemplate(config) : validateRuntime(config);
  for (const check of checks) process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.key}\n`);
  const failed = checks.filter((check) => !check.passed);
  process.stdout.write(`Production configuration validation: ${failed.length ? 'FAIL' : 'PASS'} (${checks.length - failed.length}/${checks.length})\n`);
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  callbackUrl,
  populated,
  safeAbsoluteStoragePath,
  validateRuntime,
  validateTemplate,
};

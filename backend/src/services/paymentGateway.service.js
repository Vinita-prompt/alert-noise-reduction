const db = require('../config/db');
const integrationService = require('./integration.service');

const SOURCE_TOOL = 'payment-gateway';
const APPLICATION_NAME = 'ABC Payment Gateway';
const ENTITY_TYPE = 'payment_transaction';
const OBSERVED_TOTAL_RECORDS = 389736727;
const SYNC_SCOPE = 'all-transactions';
const PAYMENT_SCHEMA_VERSION = 'payment_gateway_transactions_v2';
const DEFAULT_BASE_URL = 'https://payment-gateway.example.com';
const DEFAULT_TRANSACTIONS_PATH = '/transactions-module/transactions/';
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_PARTITION_DAYS = 1;
const MAX_RESULT_WINDOW = 100000;
const MAX_LOCAL_SAMPLE_MINUTES = 24 * 60;
const DASHBOARD_QUERY_LIMIT = 10000;

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function resolveDate(value, fallback) {
  if (!value) return fallback;

  const text = String(value);
  const relative = text.match(/^now-(\d+)(m|h|d)$/i);

  if (text === 'now') return new Date();

  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const minutes = unit === 'm' ? amount : unit === 'h' ? amount * 60 : amount * 24 * 60;

    return addMinutes(new Date(), -minutes);
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? fallback : date;
}

function resolveRange(options = {}) {
  const to = resolveDate(options.to, new Date());
  const from = resolveDate(options.from, addMinutes(to, -60));

  if (from > to) {
    return { from: to, to: from };
  }

  return { from, to };
}

function rangeMinutes(range) {
  return Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 60000));
}

function bucketMinutes(range) {
  const minutes = rangeMinutes(range);

  if (minutes <= 30) return 1;
  if (minutes <= 120) return 5;
  if (minutes <= 360) return 10;
  return 30;
}

function localSampleRange(range) {
  if (rangeMinutes(range) <= MAX_LOCAL_SAMPLE_MINUTES) {
    return range;
  }

  return {
    from: addMinutes(range.to, -MAX_LOCAL_SAMPLE_MINUTES),
    to: range.to,
    sampled: true,
  };
}

function seededNumber(seed) {
  let hash = 2166136261;
  const text = String(seed);

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0);
}

function choose(list, seed) {
  return list[seededNumber(seed) % list.length];
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function splitConfiguredGatewayUrl(baseUrlValue, pathValue) {
  const baseUrl = normalizeBaseUrl(baseUrlValue);

  try {
    const url = new URL(baseUrl);

    if (url.pathname.includes('/transactions-module/transactions')) {
      return {
        baseUrl: url.origin,
        transactionsPath: normalizePath(url.pathname),
      };
    }
  } catch {
    return {
      baseUrl,
      transactionsPath: normalizePath(pathValue),
    };
  }

  return {
    baseUrl,
    transactionsPath: normalizePath(pathValue),
  };
}

function normalizePath(value) {
  const text = String(value || DEFAULT_TRANSACTIONS_PATH).trim();

  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeToken(value) {
  return String(value || '').trim();
}

function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;

  return Math.min(Math.floor(numeric), max);
}

async function getRuntimeConfig() {
  try {
    const config = await integrationService.getIntegrationRuntimeConfig('payment-gateway');
    const credentials = config.credentials || {};
    const gatewayUrl = splitConfiguredGatewayUrl(
      config.baseUrl || DEFAULT_BASE_URL,
      credentials.transactionsPath || process.env.PAYMENT_GATEWAY_TRANSACTIONS_PATH,
    );

    return {
      baseUrl: gatewayUrl.baseUrl,
      transactionsPath: gatewayUrl.transactionsPath,
      token: normalizeToken(credentials.token || process.env.PAYMENT_GATEWAY_TOKEN),
      apiKey: credentials.apiKey || process.env.PAYMENT_GATEWAY_API_KEY || '',
      username: credentials.username || process.env.PAYMENT_GATEWAY_USERNAME || '',
      password: credentials.password || process.env.PAYMENT_GATEWAY_PASSWORD || '',
      tenantId: config.accountIdentifier || process.env.PAYMENT_GATEWAY_TENANT_ID || '',
      databaseNumber: process.env.PAYMENT_GATEWAY_DATABASE_NUMBER || '',
      defaultSyncRange: credentials.defaultSyncRange || process.env.PAYMENT_GATEWAY_DEFAULT_SYNC_RANGE || '24h',
      liveImportMode: credentials.liveImportMode !== false && credentials.liveImportMode !== 'false',
      pageSize: parsePositiveInteger(process.env.PAYMENT_GATEWAY_PAGE_SIZE, DEFAULT_PAGE_SIZE, 2000),
      partitionDays: parsePositiveInteger(process.env.PAYMENT_GATEWAY_PARTITION_DAYS, DEFAULT_PARTITION_DAYS, 31),
      source: config.baseUrl ? 'integration' : 'mock',
    };
  } catch {
    const baseUrl = normalizeBaseUrl(process.env.PAYMENT_GATEWAY_BASE_URL || DEFAULT_BASE_URL);
    const gatewayUrl = splitConfiguredGatewayUrl(baseUrl, process.env.PAYMENT_GATEWAY_TRANSACTIONS_PATH);

    return {
      baseUrl: gatewayUrl.baseUrl,
      transactionsPath: gatewayUrl.transactionsPath,
      token: normalizeToken(process.env.PAYMENT_GATEWAY_TOKEN),
      apiKey: process.env.PAYMENT_GATEWAY_API_KEY || '',
      username: process.env.PAYMENT_GATEWAY_USERNAME || '',
      password: process.env.PAYMENT_GATEWAY_PASSWORD || '',
      tenantId: process.env.PAYMENT_GATEWAY_TENANT_ID || '',
      databaseNumber: process.env.PAYMENT_GATEWAY_DATABASE_NUMBER || '',
      defaultSyncRange: process.env.PAYMENT_GATEWAY_DEFAULT_SYNC_RANGE || '24h',
      liveImportMode: process.env.PAYMENT_GATEWAY_LIVE_IMPORT_MODE !== 'false',
      pageSize: parsePositiveInteger(process.env.PAYMENT_GATEWAY_PAGE_SIZE, DEFAULT_PAGE_SIZE, 2000),
      partitionDays: parsePositiveInteger(process.env.PAYMENT_GATEWAY_PARTITION_DAYS, DEFAULT_PARTITION_DAYS, 31),
      source: baseUrl.includes('payment-gateway.example.com') ? 'mock' : 'environment',
    };
  }
}

function hasLiveConfig(config) {
  return Boolean(
    config
      && config.baseUrl
      && !config.baseUrl.includes('payment-gateway.example.com')
      && config.tenantId
      && config.liveImportMode !== false
      && (config.token || config.apiKey || (config.username && config.password)),
  );
}

function rangeOptionsFromPreset(value) {
  const normalized = String(value || '24h').trim().toLowerCase();
  const to = new Date();
  const match = normalized.match(/^(\d+)(m|h|d)$/);

  if (!match) {
    return {
      from: addMinutes(to, -24 * 60).toISOString(),
      to: to.toISOString(),
    };
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const minutes = unit === 'm' ? amount : unit === 'h' ? amount * 60 : amount * 24 * 60;

  return {
    from: addMinutes(to, -minutes).toISOString(),
    to: to.toISOString(),
  };
}

function sampleDataEnabled() {
  return process.env.PAYMENT_GATEWAY_USE_SAMPLE_DATA === 'true';
}

function dashboardSourceModes() {
  return sampleDataEnabled() ? ['live_api', 'browser_import', 'mock'] : ['live_api', 'browser_import'];
}

async function ensureMonitoringStorage(client = db) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS monitoring_records (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'unknown',
      application_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      severity TEXT NOT NULL DEFAULT 'low',
      summary TEXT NOT NULL,
      details TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      last_check TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      deep_link TEXT,
      custom_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_monitoring_records_tool_app
      ON monitoring_records(source_tool, application_name);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_status
      ON monitoring_records(source_tool, status);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_updated
      ON monitoring_records(source_tool, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_payment_database
      ON monitoring_records ((custom_properties->>'database_number'))
      WHERE source_tool = 'payment-gateway';

    CREATE TABLE IF NOT EXISTS payment_gateway_sync_state (
      id BIGSERIAL PRIMARY KEY,
      database_number TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      page_number INTEGER NOT NULL DEFAULT 0,
      page_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      records_fetched INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (database_number, window_start, window_end, page_number)
    );

    CREATE INDEX IF NOT EXISTS idx_payment_gateway_sync_state_database_updated
      ON payment_gateway_sync_state(database_number, updated_at DESC);

    CREATE TABLE IF NOT EXISTS payment_gateway_import_batches (
      id BIGSERIAL PRIMARY KEY,
      import_source TEXT NOT NULL DEFAULT 'browser_session',
      page_number INTEGER,
      page_size INTEGER,
      total_elements BIGINT,
      total_pages INTEGER,
      number_of_elements INTEGER,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function formatTimeOnly(date) {
  return date.toISOString().slice(11, 19);
}

function parseTimestamp(dateValue, timeValue, fallback) {
  if (!dateValue && !timeValue) return fallback;

  const dateText = String(dateValue || '').trim();
  const timeText = String(timeValue || '').trim();
  const candidate = dateText.includes('T')
    ? dateText
    : `${dateText || formatDateOnly(fallback)}T${(timeText || '00:00:00').replace(/Z$/i, '')}Z`;
  const parsed = new Date(candidate);

  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function readPath(object, path) {
  return String(path)
    .split('.')
    .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), object);
}

function parseAmount(value) {
  if (value === null || value === undefined || value === '') return 0;

  const numeric = Number(String(value).replace(/[$,]/g, ''));

  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function normalizeLastFour(value) {
  const digits = String(value || '').replace(/\D/g, '');

  return digits ? digits.slice(-4).padStart(4, '0') : null;
}

function normalizePaymentStatus(value, responseCode) {
  const text = String(value || responseCode || '').trim().toUpperCase();
  const code = String(responseCode || '').trim().toUpperCase();

  if (['SUCCESS', 'SUCCEEDED', 'APPROVED', 'COMPLETED', 'SETTLED', 'CAPTURED', 'PAID', 'OK'].includes(text)
    || ['SUCCESS', 'APPROVED', '00', '000', '0'].includes(code)) {
    return 'SUCCESS';
  }

  if (['PENDING', 'PROCESSING', 'SCHEDULED', 'QUEUED', 'SUBMITTED', 'IN_PROGRESS'].includes(text)) {
    return 'PENDING';
  }

  if (text.includes('PENDING') || text.includes('PROCESS')) return 'PENDING';
  if (text.includes('SUCCESS') || text.includes('APPROV') || text.includes('COMPLETE')) return 'SUCCESS';

  return 'FAILED';
}

function monitoringStatus(paymentStatus) {
  if (paymentStatus === 'SUCCESS') return 'ok';
  if (paymentStatus === 'PENDING') return 'warning';
  return 'critical';
}

function severityForStatus(paymentStatus) {
  if (paymentStatus === 'FAILED') return 'critical';
  if (paymentStatus === 'PENDING') return 'warning';
  return 'low';
}

function normalizedField(record, candidates, fallback = null) {
  for (const key of candidates) {
    const value = key.includes('.') ? readPath(record, key) : record[key];

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return fallback;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return false;

  return ['true', '1', 'yes', 'y', 'settled', 'success'].includes(String(value).trim().toLowerCase());
}

function normalizeTransaction(rawRecord, config = {}) {
  const raw = rawRecord || {};
  const createdFallback = new Date();
  const createdAt = parseTimestamp(
    normalizedField(raw, ['createdDate', 'created_date', 'creation_date', 'creationDate', 'timestamp', 'createdAt']),
    normalizedField(raw, ['creation_time_utc', 'creationTimeUtc', 'created_time_utc', 'createdTimeUtc']),
    createdFallback,
  );
  const modifiedAt = parseTimestamp(
    normalizedField(raw, ['modifiedDate', 'modified_date', 'updatedDate', 'updated_at']),
    null,
    createdAt,
  );
  const effectiveAt = parseTimestamp(
    normalizedField(raw, ['effective_date', 'effectiveDate', 'settlementDate']),
    normalizedField(raw, ['effective_time_utc', 'effectiveTimeUtc', 'settlementTimeUtc']),
    modifiedAt,
  );
  const uniqueTransactionNumber = String(normalizedField(raw, [
    'unique_transaction_number',
    'uniqueTransactionNumber',
    'transaction_id',
    'transactionId',
    'referenceId',
    'id',
  ], `PGW-${createdAt.getTime()}`));
  const responseCode = String(normalizedField(raw, [
    'response_code',
    'responseCode',
    'transactionMetadata.responseCode',
    'transactionMetadata.processorResponseCode',
    'resultCode',
    'code',
    'status',
  ], 'UNKNOWN')).toUpperCase();
  const paymentStatus = normalizePaymentStatus(normalizedField(raw, ['status', 'paymentStatus', 'payment_status', 'result']), responseCode);
  const amount = parseAmount(normalizedField(raw, ['monetaryAmount.amount', 'amount', 'transactionAmount', 'paymentAmount'], 0));
  const currency = String(normalizedField(raw, ['monetaryAmount.currency', 'currency'], 'USD')).toUpperCase();
  const failureReason = normalizedField(raw, [
    'failure_reason',
    'failureReason',
    'transactionMetadata.failureReason',
    'transactionMetadata.errorMessage',
    'errorMessage',
    'error_message',
    'message',
  ], null);
  const merchant = String(normalizedField(raw, ['merchant', 'merchantName', 'companyName'], 'ABC Fitness'));
  const merchantNumber = String(normalizedField(raw, ['merchant_number', 'merchantNumber', 'merchantId'], 'not_available'));
  const accountHolderName = normalizedField(raw, ['account_holder_name', 'accountHolderName', 'accountName'], null);
  const lastFour = normalizeLastFour(normalizedField(raw, [
    'bankAccountNumberLastFour',
    'last_four',
    'lastFour',
    'accountLastFour',
    'cardLastFour',
  ], null));
  const transactionType = String(normalizedField(raw, ['transaction_type', 'transactionType', 'paymentType', 'type'], 'ACH')).toUpperCase();
  const source = String(normalizedField(raw, ['source', 'paymentSource'], 'ABC Payment Gateway'));
  const secCode = String(normalizedField(raw, ['sec_code', 'secCode'], 'WEB')).toUpperCase();
  const paymentAction = String(normalizedField(raw, ['payment_action', 'paymentAction', 'action'], 'SALE')).toUpperCase();
  const payerId = String(normalizedField(raw, ['payer_id', 'payerId', 'customerId'], 'not_available'));
  const memberNumber = String(normalizedField(raw, ['member_number', 'memberNumber'], 'not_available'));
  const databaseNumber = normalizedField(raw, ['database_number', 'databaseNumber'], config.databaseNumber || null);
  const settled = normalizeBoolean(normalizedField(raw, ['settled', 'isSettled'], false));
  const id = String(normalizedField(raw, ['id'], uniqueTransactionNumber));
  const referenceId = String(normalizedField(raw, ['referenceId', 'reference_id'], uniqueTransactionNumber));
  const paymentType = String(normalizedField(raw, ['paymentType', 'payment_type'], transactionType)).toUpperCase();
  const paymentTokenId = normalizedField(raw, ['paymentTokenId', 'payment_token_id'], null);
  const batchId = normalizedField(raw, ['batchId', 'batch_id'], null);
  const tokenType = normalizedField(raw, ['tokenType', 'token_type'], null);
  const processorName = normalizedField(raw, ['processorName', 'processor_name'], 'Unknown processor');
  const processorId = normalizedField(raw, ['processorId', 'processor_id'], null);
  const merchantReference = normalizedField(raw, ['merchantReference', 'merchant_reference'], null);
  const merchantId = normalizedField(raw, ['merchantId', 'merchant_id'], merchantNumber);
  const descriptor = normalizedField(raw, ['descriptor'], null);
  const countryCode = normalizedField(raw, ['countryCode', 'country_code'], null);
  const version = normalizedField(raw, ['version'], null);
  const omnitokenUsed = normalizeBoolean(normalizedField(raw, ['omnitokenUsed', 'omnitoken_used'], false));
  const merchantAccountRelated = normalizeBoolean(normalizedField(raw, ['merchantAccountRelated', 'merchant_account_related'], false));
  const isWireTransferType = normalizeBoolean(normalizedField(raw, ['transactionMetadata.isWireTransferType', 'isWireTransferType'], false));
  const routingNumberPresent = Boolean(normalizedField(raw, ['bankAccountRoutingNumber', 'bank_account_routing_number'], null));
  const deepLink = normalizedField(
    raw,
    ['deep_link', 'deepLink', 'eventLink', 'link'],
    `${config.baseUrl || DEFAULT_BASE_URL}/transactions/${encodeURIComponent(uniqueTransactionNumber)}`,
  );
  const summary = `${uniqueTransactionNumber} ${paymentStatus.toLowerCase()}`;
  const details = [
    `response ${responseCode}`,
    `amount $${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    failureReason,
  ].filter(Boolean).join(' · ');
  const commonFields = {
    databaseNumber,
    database_number: databaseNumber,
    observedTotalRecords: OBSERVED_TOTAL_RECORDS,
    observed_total_records: OBSERVED_TOTAL_RECORDS,
    syncScope: config.databaseNumber || SYNC_SCOPE,
    sync_scope: config.databaseNumber || SYNC_SCOPE,
    schemaVersion: PAYMENT_SCHEMA_VERSION,
    schema_version: PAYMENT_SCHEMA_VERSION,
    merchant,
    merchantNumber,
    merchant_number: merchantNumber,
    accountHolderName,
    account_holder_name: accountHolderName,
    lastFour,
    last_four: lastFour,
    uniqueTransactionNumber,
    unique_transaction_number: uniqueTransactionNumber,
    transactionType,
    transaction_type: transactionType,
    source,
    secCode,
    sec_code: secCode,
    amount,
    currency,
    countryCode,
    country_code: countryCode,
    paymentAction,
    payment_action: paymentAction,
    paymentType,
    payment_type: paymentType,
    paymentTokenId,
    payment_token_id: paymentTokenId,
    batchId,
    batch_id: batchId,
    tokenType,
    token_type: tokenType,
    id,
    referenceId,
    reference_id: referenceId,
    responseCode,
    response_code: responseCode,
    status: paymentStatus,
    paymentStatus,
    settled,
    processorName,
    processor_name: processorName,
    processorId,
    processor_id: processorId,
    merchantReference,
    merchant_reference: merchantReference,
    merchantId,
    merchant_id: merchantId,
    descriptor,
    version,
    omnitokenUsed,
    omnitoken_used: omnitokenUsed,
    merchantAccountRelated,
    merchant_account_related: merchantAccountRelated,
    isWireTransferType,
    is_wire_transfer_type: isWireTransferType,
    routingNumberPresent,
    routing_number_present: routingNumberPresent,
    sourceToolLabel: APPLICATION_NAME,
    source_tool_label: APPLICATION_NAME,
    success: paymentStatus === 'SUCCESS',
    failure: paymentStatus === 'FAILED',
    pending: paymentStatus === 'PENDING',
    creationDate: formatDateOnly(createdAt),
    creation_date: formatDateOnly(createdAt),
    creationTimeUtc: formatTimeOnly(createdAt),
    creation_time_utc: formatTimeOnly(createdAt),
    effectiveDate: formatDateOnly(effectiveAt),
    effective_date: formatDateOnly(effectiveAt),
    effectiveTimeUtc: formatTimeOnly(effectiveAt),
    effective_time_utc: formatTimeOnly(effectiveAt),
    createdDate: createdAt.toISOString(),
    created_date: createdAt.toISOString(),
    modifiedDate: modifiedAt.toISOString(),
    modified_date: modifiedAt.toISOString(),
    payerId,
    payer_id: payerId,
    memberNumber,
    member_number: memberNumber,
    timestamp: createdAt.toISOString(),
    lastUpdatedAt: modifiedAt.toISOString(),
    last_updated_at: modifiedAt.toISOString(),
    sourceMode: config.source === 'mock'
      ? 'mock'
      : config.source === 'live'
        ? 'live_api'
        : config.source === 'browser_import'
          ? 'browser_import'
          : 'integration_ready',
  };

  return {
    sourceTool: SOURCE_TOOL,
    environment: 'production',
    applicationName: APPLICATION_NAME,
    entityType: ENTITY_TYPE,
    entityId: uniqueTransactionNumber,
    status: monitoringStatus(paymentStatus),
    severity: severityForStatus(paymentStatus),
    summary,
    details,
    acknowledged: false,
    lastCheck: createdAt.toISOString(),
    updatedAt: modifiedAt.toISOString(),
    deepLink,
    customProperties: commonFields,
    rawPayload: raw,
  };
}

function buildMockTransaction(bucketTime, index, config) {
  const seed = `${OBSERVED_TOTAL_RECORDS}:${bucketTime.toISOString()}:${index}`;
  const random = seededNumber(seed);
  const status = random % 23 === 0 ? 'FAILED' : random % 17 === 0 ? 'PENDING' : 'SUCCESS';
  const responseCode = status === 'SUCCESS'
    ? choose(['APPROVED', '00', '000'], `${seed}:success`)
    : status === 'PENDING'
      ? choose(['PENDING', 'SUBMITTED', 'QUEUED'], `${seed}:pending`)
      : choose(['R01', 'R09', 'DECLINED', 'TIMEOUT', 'ERROR'], `${seed}:failed`);
  const amount = Number(((random % 48000) / 100 + 8.5).toFixed(2));
  const lastFour = String(1000 + (random % 8999));
  const transactionNumber = `UTN-PGW-${bucketTime.toISOString().replace(/[-:T.Z]/g, '').slice(0, 12)}-${String(index + 1).padStart(3, '0')}`;
  const raw = {
    id: transactionNumber,
    referenceId: `REF-${String(random % 10000000).padStart(7, '0')}`,
    paymentType: choose(['ACH', 'CARD', 'TOKENIZED_BANK'], `${seed}:paymentType`),
    paymentTokenId: `TOK-${String(random % 1000000).padStart(6, '0')}`,
    batchId: `BATCH-${formatDateOnly(bucketTime).replace(/-/g, '')}`,
    tokenType: choose(['BANK_ACCOUNT', 'CARD', 'ACH_TOKEN'], `${seed}:tokenType`),
    merchantName: choose(['ABC Fitness', 'ABC Club Billing', 'ABC Membership Payments'], `${seed}:merchant`),
    merchantId: `MERCH-${String(random % 10000).padStart(4, '0')}`,
    accountHolderName: choose(['Taylor Member', 'Jordan Customer', 'Morgan Account', 'Riley Profile'], `${seed}:holder`),
    bankAccountNumberLastFour: lastFour,
    bankAccountRoutingNumber: '****',
    uniqueTransactionNumber: transactionNumber,
    transactionType: choose(['ACH_DEBIT', 'CARD_PAYMENT', 'REFUND', 'REVERSAL'], `${seed}:type`),
    source: 'ABC Payment Gateway',
    secCode: choose(['WEB', 'PPD', 'CCD', 'TEL'], `${seed}:sec`),
    monetaryAmount: {
      amount,
      currency: 'USD',
    },
    paymentAction: choose(['SALE', 'REFUND', 'VOID', 'RETRY'], `${seed}:action`),
    response_code: responseCode,
    status,
    effectiveDate: addMinutes(bucketTime, 2 + (random % 12)).toISOString(),
    createdDate: bucketTime.toISOString(),
    modifiedDate: addMinutes(bucketTime, 2 + (random % 8)).toISOString(),
    settled: status === 'SUCCESS' && random % 5 !== 0,
    processorName: choose(['Fiserv', 'Worldpay', 'Stripe Processor', 'ACH Network'], `${seed}:processor`),
    processorId: `PROC-${String(random % 1000).padStart(3, '0')}`,
    merchantReference: `MERCH-REF-${String(random % 100000).padStart(5, '0')}`,
    payer_id: `PAYER-${String(random % 100000).padStart(5, '0')}`,
    member_number: `MEM-${String(random % 1000000).padStart(6, '0')}`,
    transactionMetadata: {
      responseCode,
      observedTotalRecords: OBSERVED_TOTAL_RECORDS,
    },
    descriptor: choose(['ABC FITNESS DUES', 'ABC CLUB PAYMENT', 'ABC MEMBERSHIP'], `${seed}:descriptor`),
    failure_reason: status === 'FAILED'
      ? choose(['Insufficient funds', 'Processor timeout', 'Invalid account', 'Gateway unavailable'], `${seed}:reason`)
      : null,
  };

  return normalizeTransaction(raw, config);
}

function buildMockRecords(range, config) {
  const step = bucketMinutes(range);
  const records = [];

  for (
    let cursor = new Date(range.from.getTime());
    cursor <= range.to;
    cursor = addMinutes(cursor, step)
  ) {
    const volume = 2 + (seededNumber(`${OBSERVED_TOTAL_RECORDS}:${cursor.toISOString()}`) % 8);

    for (let index = 0; index < volume; index += 1) {
      records.push(buildMockTransaction(addMinutes(cursor, index), index, config));
    }
  }

  records.sourceMode = config.source === 'mock' ? 'mock' : 'integration_ready';

  return records;
}

async function upsertRecords(records) {
  await ensureMonitoringStorage();
  let inserted = 0;
  let updated = 0;

  for (const record of records) {
    const result = await db.query(
      `
        INSERT INTO monitoring_records (
          source_tool,
          environment,
          application_name,
          entity_type,
          entity_id,
          status,
          severity,
          summary,
          details,
          acknowledged,
          last_check,
          updated_at,
          raw_payload,
          deep_link,
          custom_properties
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,NOW()),$13::jsonb,$14,$15::jsonb)
        ON CONFLICT (source_tool, entity_type, entity_id)
        DO UPDATE SET
          environment = EXCLUDED.environment,
          application_name = EXCLUDED.application_name,
          status = EXCLUDED.status,
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          acknowledged = EXCLUDED.acknowledged,
          last_check = EXCLUDED.last_check,
          updated_at = COALESCE(EXCLUDED.updated_at, NOW()),
          raw_payload = EXCLUDED.raw_payload,
          deep_link = EXCLUDED.deep_link,
          custom_properties = EXCLUDED.custom_properties
        RETURNING (xmax = 0) AS inserted
      `,
      [
        record.sourceTool,
        record.environment,
        record.applicationName,
        record.entityType,
        record.entityId,
        record.status,
        record.severity,
        record.summary,
        record.details,
        record.acknowledged,
        record.lastCheck,
        record.updatedAt,
        JSON.stringify(record.rawPayload || {}),
        record.deepLink,
        JSON.stringify(record.customProperties || {}),
      ],
    );

    if (result.rows[0]?.inserted) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated };
}

function authHeaders(config) {
  const headers = { Accept: 'application/json' };

  if (config.token) {
    headers.Authorization = /^bearer\s+/i.test(config.token)
      ? config.token
      : `Bearer ${config.token}`;
  } else if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  } else if (config.username && config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }

  if (config.tenantId) {
    headers['X-Tenant-ID'] = config.tenantId;
  }

  return headers;
}

function buildTransactionApiUrl(config, window, page, size) {
  const url = new URL(`${config.baseUrl}${config.transactionsPath}`);

  if (config.databaseNumber) {
    url.searchParams.set('databaseNumber', config.databaseNumber);
  }

  if (config.tenantId) {
    url.searchParams.set('tenantId', config.tenantId);
  }

  url.searchParams.append('createdDate', formatDateOnly(window.from));
  url.searchParams.append('createdDate', formatDateOnly(window.to));
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(size));
  url.searchParams.set('sort', 'createdDate,desc');
  url.searchParams.set('search', '');
  url.searchParams.set('tokenType', 'BANK_ACCOUNT');

  return url;
}

function extractTransactionsFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.data?.content)) return payload.data.content;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.results)) return payload.results;

  return [];
}

function extractPageMetadata(payload, page, size, items) {
  const pageable = payload?.pageable || payload?.data?.pageable || {};
  const totalPages = payload?.totalPages ?? payload?.data?.totalPages ?? null;
  const totalElements = payload?.totalElements ?? payload?.data?.totalElements ?? null;
  const numberOfElements = payload?.numberOfElements ?? payload?.data?.numberOfElements ?? items.length;

  return {
    pageNumber: Number(pageable.pageNumber ?? payload?.number ?? payload?.data?.number ?? page),
    pageSize: Number(pageable.pageSize ?? payload?.size ?? payload?.data?.size ?? size),
    totalPages: totalPages === null ? null : Number(totalPages),
    totalElements: totalElements === null ? null : Number(totalElements),
    numberOfElements: Number(numberOfElements),
    first: Boolean(payload?.first ?? payload?.data?.first ?? page === 0),
    last: Boolean(payload?.last ?? payload?.data?.last ?? items.length < size),
    empty: Boolean(payload?.empty ?? payload?.data?.empty ?? items.length === 0),
    maxResultWindow: Number(payload?.maxResultWindow ?? payload?.data?.maxResultWindow ?? MAX_RESULT_WINDOW),
  };
}

function validateImportPayload(payload) {
  const items = extractTransactionsFromResponse(payload);

  if (!items.length) {
    const error = new Error('Empty data: the Payment Gateway JSON does not contain transaction records.');
    error.status = 400;
    throw error;
  }

  const metadata = extractPageMetadata(payload, payload?.number || payload?.pageable?.pageNumber || 0, payload?.size || payload?.pageable?.pageSize || items.length, items);

  return { items, metadata };
}

async function readJsonResponse(response, vendorName = 'Payment Gateway') {
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  const trimmedBody = body.trim();

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`${vendorName} authentication failed with HTTP ${response.status}. Check the tenant ID and bearer token.`);
      error.status = response.status;
      throw error;
    }

    if (response.status === 404) {
      const error = new Error(`${vendorName} endpoint was not found. Check the Base URL and transaction API path.`);
      error.status = 404;
      throw error;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const error = new Error(`${vendorName} rate limited the request${retryAfter ? `; retry after ${retryAfter}s` : ''}.`);
      error.status = 429;
      throw error;
    }

    const error = new Error(`${vendorName} returned HTTP ${response.status}: ${trimmedBody.slice(0, 240)}`);
    error.status = response.status;
    throw error;
  }

  if (/text\/html/i.test(contentType) || /^<!doctype html/i.test(trimmedBody) || /^<html/i.test(trimmedBody)) {
    const error = new Error(`${vendorName} returned an HTML login page instead of JSON. Authentication is required, the token is missing/expired, or the Base URL points to the UI instead of the API.`);
    error.status = 401;
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error(`${vendorName} returned non-JSON content. Check the Base URL and transaction API path.`);
    error.status = 502;
    throw error;
  }
}

async function saveImportBatch(payload, metadata, stored) {
  await ensureMonitoringStorage();
  await db.query(
    `
      INSERT INTO payment_gateway_import_batches (
        import_source,
        page_number,
        page_size,
        total_elements,
        total_pages,
        number_of_elements,
        inserted_count,
        updated_count,
        raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `,
    [
      'browser_session',
      Number.isFinite(metadata.pageNumber) ? metadata.pageNumber : null,
      Number.isFinite(metadata.pageSize) ? metadata.pageSize : null,
      Number.isFinite(metadata.totalElements) ? metadata.totalElements : null,
      Number.isFinite(metadata.totalPages) ? metadata.totalPages : null,
      Number.isFinite(metadata.numberOfElements) ? metadata.numberOfElements : null,
      stored.inserted,
      stored.updated,
      JSON.stringify(payload || {}),
    ],
  );
}

async function importPaymentGatewayPayload(payload) {
  const { items, metadata } = validateImportPayload(payload);
  const config = await getRuntimeConfig();
  const records = items.map((item) => normalizeTransaction(item, { ...config, source: 'browser_import' }));
  const stored = await upsertRecords(records);

  await saveImportBatch(payload, metadata, stored);

  return {
    fetched: items.length,
    inserted: stored.inserted,
    updated: stored.updated,
    skipped: 0,
    pageNumber: metadata.pageNumber,
    pageSize: metadata.pageSize,
    totalElements: metadata.totalElements,
    totalPages: metadata.totalPages,
    numberOfElements: metadata.numberOfElements,
    message: `Payment Gateway import complete: ${stored.inserted} imported, ${stored.updated} updated from ${items.length} fetched.`,
  };
}

async function fetchTransactionPage(config, window, page, size) {
  const response = await fetch(buildTransactionApiUrl(config, window, page, size), {
    headers: authHeaders(config),
  });
  const payload = await readJsonResponse(response);
  const items = extractTransactionsFromResponse(payload);

  return {
    payload,
    items,
    metadata: extractPageMetadata(payload, page, size, items),
  };
}

function dateWindows(range, partitionDays) {
  const windows = [];
  let cursor = new Date(range.from.getTime());

  while (cursor < range.to) {
    const next = addDays(cursor, partitionDays);
    const end = next < range.to ? next : new Date(range.to.getTime());

    windows.push({ from: new Date(cursor.getTime()), to: end });
    cursor = end;
  }

  return windows;
}

async function upsertSyncProgress(config, window, page, size, status, recordsFetched = 0, errorMessage = null) {
  await ensureMonitoringStorage();
  await db.query(
    `
      INSERT INTO payment_gateway_sync_state (
        database_number,
        window_start,
        window_end,
        page_number,
        page_size,
        status,
        records_fetched,
        last_error,
        completed_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $6 IN ('complete','failed') THEN NOW() ELSE NULL END,NOW())
      ON CONFLICT (database_number, window_start, window_end, page_number)
      DO UPDATE SET
        page_size = EXCLUDED.page_size,
        status = EXCLUDED.status,
        records_fetched = EXCLUDED.records_fetched,
        last_error = EXCLUDED.last_error,
        completed_at = EXCLUDED.completed_at,
        updated_at = NOW()
    `,
    [
      config.databaseNumber || config.tenantId || SYNC_SCOPE,
      window.from.toISOString(),
      window.to.toISOString(),
      page,
      size,
      status,
      recordsFetched,
      errorMessage,
    ],
  );
}

async function syncLivePaymentGatewayTransactions(options = {}, config) {
  const range = resolveRange(options);
  const pageSize = parsePositiveInteger(options.pageSize || config.pageSize, DEFAULT_PAGE_SIZE, 2000);
  const partitionDays = parsePositiveInteger(options.partitionDays || config.partitionDays, DEFAULT_PARTITION_DAYS, 31);
  const windows = dateWindows(range, partitionDays);
  let fetched = 0;
  let inserted = 0;
  let updated = 0;

  for (const window of windows) {
    let page = 0;
    let done = false;

    while (!done) {
      if (page * pageSize >= MAX_RESULT_WINDOW) {
        const errorMessage = `Date window ${window.from.toISOString()} - ${window.to.toISOString()} exceeded maxResultWindow ${MAX_RESULT_WINDOW}; reduce PAYMENT_GATEWAY_PARTITION_DAYS.`;
        await upsertSyncProgress(config, window, page, pageSize, 'failed', 0, errorMessage);
        throw new Error(errorMessage);
      }

      await upsertSyncProgress(config, window, page, pageSize, 'running');
      let result;
      let stored;

      try {
        result = await fetchTransactionPage(config, window, page, pageSize);
        const records = result.items.map((item) => normalizeTransaction(item, { ...config, source: 'live' }));
        stored = await upsertRecords(records);
      } catch (error) {
        await upsertSyncProgress(config, window, page, pageSize, 'failed', 0, error.message);
        throw error;
      }

      fetched += result.items.length;
      inserted += stored.inserted;
      updated += stored.updated;
      await upsertSyncProgress(config, window, page, pageSize, 'complete', result.items.length);

      done = result.metadata.last
        || result.metadata.empty
        || result.items.length === 0
        || (Number.isFinite(result.metadata.totalPages) && page + 1 >= result.metadata.totalPages);
      page += 1;
    }
  }

  return {
    fetched,
    inserted,
    updated,
    source: 'live',
    message: `ABC Payment Gateway sync complete: ${fetched} transactions fetched from ${OBSERVED_TOTAL_RECORDS.toLocaleString()} available records.`,
    range: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
  };
}

async function syncMockPaymentGatewayTransactions(options = {}, config) {
  const range = resolveRange(options);
  const sampleRange = localSampleRange(range);
  const records = buildMockRecords(sampleRange, { ...config, source: config.source || 'mock' });
  const stored = await upsertRecords(records);

  return {
    fetched: records.length,
    inserted: stored.inserted,
    updated: stored.updated,
    source: 'mock',
    message: `ABC Payment Gateway local sample ready: ${records.length} operational transactions loaded${sampleRange.sampled ? ' from a capped 24-hour local sample' : ' for this range'}. Source total is ${OBSERVED_TOTAL_RECORDS.toLocaleString()} records.`,
    range: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
    sampledRange: sampleRange.sampled ? {
      from: sampleRange.from.toISOString(),
      to: sampleRange.to.toISOString(),
    } : null,
  };
}

async function syncPaymentGatewayData(options = {}) {
  const config = await getRuntimeConfig();
  const range = resolveRange(options);

  if (hasLiveConfig(config) && options.live !== false) {
    try {
      return await syncLivePaymentGatewayTransactions(options, config);
    } catch (error) {
      const allowMockFallback = options.allowFallback === true || process.env.PAYMENT_GATEWAY_ALLOW_MOCK_FALLBACK === 'true';

      if (!allowMockFallback) {
        throw error;
      }

      const fallback = await syncMockPaymentGatewayTransactions(options, { ...config, source: 'mock' });

      return {
        ...fallback,
        source: 'mock_after_live_failure',
        warning: error.message,
        message: `ABC Payment Gateway live sync failed, so local operational data was shown instead. ${error.message}`,
      };
    }
  }

  if (sampleDataEnabled()) {
    return syncMockPaymentGatewayTransactions(options, config);
  }

  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    source: 'not_configured',
    message: `Payment Gateway live API is not connected. No transaction rows are shown because generated sample records are disabled. Source total is ${OBSERVED_TOTAL_RECORDS.toLocaleString()} records.`,
    range: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
  };
}

function getPaymentGatewayNetworkErrorMessage(error) {
  const code = error.cause?.code || error.code;
  const detail = error.cause?.message || error.message;

  if (error.name === 'AbortError') {
    return 'Payment Gateway connection timed out. Check VPN/network access and confirm the API URL is reachable.';
  }

  if (code === 'ENOTFOUND') {
    return 'Payment Gateway host could not be found. Check the Base URL hostname.';
  }

  if (code === 'ECONNREFUSED') {
    return 'Payment Gateway refused the connection. Check the Base URL and network access.';
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'Payment Gateway connection timed out. Check VPN/network access and firewall rules.';
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return 'Payment Gateway SSL certificate could not be verified. Add the corporate CA certificate to NODE_EXTRA_CA_CERTS before testing live sync.';
  }

  return `Unable to reach Payment Gateway from the backend. ${code ? `Error: ${code}.` : `Detail: ${detail}`}`;
}

async function updateIntegrationConnectionStatus(status) {
  await db.query(
    `
      UPDATE integrations
      SET status = $2, last_tested_at = NOW(), updated_at = NOW()
      WHERE tool_name = $1
    `,
    [SOURCE_TOOL, status],
  );
}

async function testPaymentGatewayConnection() {
  const config = await getRuntimeConfig();

  if (!config.liveImportMode) {
    await updateIntegrationConnectionStatus('not_connected');

    return {
      ok: false,
      mode: 'mock',
      status: 'mock_mode',
      message: 'Mock mode is enabled. Turn on Live import mode to test the Payment Gateway API.',
    };
  }

  if (!config.baseUrl || config.baseUrl.includes('payment-gateway.example.com')) {
    await updateIntegrationConnectionStatus('not_connected');

    return {
      ok: false,
      mode: 'blocked_by_auth',
      status: 'authentication_required',
      message: 'Payment Gateway Base URL is not configured.',
    };
  }

  if (!config.tenantId) {
    await updateIntegrationConnectionStatus('not_connected');

    return {
      ok: false,
      mode: 'blocked_by_auth',
      status: 'authentication_required',
      message: 'Payment Gateway Tenant ID is required before testing the live API.',
    };
  }

  if (!config.token) {
    await updateIntegrationConnectionStatus('not_connected');

    return {
      ok: false,
      mode: 'blocked_by_auth',
      status: 'authentication_required',
      message: 'Payment Gateway Bearer Token is required before testing the live API.',
    };
  }

  const range = resolveRange(rangeOptionsFromPreset('1d'));

  try {
    const result = await fetchTransactionPage(config, range, 0, 1);

    await updateIntegrationConnectionStatus('connected');

    return {
      ok: true,
      mode: 'live',
      status: 'connected',
      fetched: result.items.length,
      pageNumber: result.metadata.pageNumber,
      totalElements: result.metadata.totalElements,
      message: `Payment Gateway connection successful. The API returned ${result.items.length} transaction record${result.items.length === 1 ? '' : 's'} on the test page.`,
    };
  } catch (error) {
    await updateIntegrationConnectionStatus('error');

    return {
      ok: false,
      mode: error.status === 401 || error.status === 403 ? 'blocked_by_auth' : 'connection_failed',
      status: error.status === 401 || error.status === 403 ? 'authentication_required' : 'connection_failed',
      message: error.status ? error.message : getPaymentGatewayNetworkErrorMessage(error),
    };
  }
}

async function syncPaymentGatewayFromSettings(options = {}) {
  const config = await getRuntimeConfig();

  if (!config.liveImportMode) {
    const error = new Error('Mock mode is enabled. Turn on Live import mode before running live Payment Gateway sync.');
    error.status = 400;
    throw error;
  }

  if (!hasLiveConfig(config)) {
    const error = new Error('Payment Gateway live sync requires Base URL, Tenant ID, and Bearer Token.');
    error.status = 400;
    throw error;
  }

  const rangeOptions = options.from && options.to
    ? { from: options.from, to: options.to }
    : rangeOptionsFromPreset(config.defaultSyncRange);

  try {
    const result = await syncPaymentGatewayData({
      ...rangeOptions,
      live: true,
      allowFallback: false,
    });

    await updateIntegrationConnectionStatus('connected');

    return result;
  } catch (error) {
    await updateIntegrationConnectionStatus('error');
    throw error;
  }
}

function normalizeRecordRow(row) {
  return {
    id: row.id,
    sourceTool: row.source_tool,
    environment: row.environment,
    applicationName: row.application_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    details: row.details,
    acknowledged: row.acknowledged,
    lastCheck: row.last_check,
    updatedAt: row.updated_at,
    rawPayload: row.raw_payload || {},
    deepLink: row.deep_link,
    customProperties: row.custom_properties || {},
  };
}

function sanitizePaymentRecordForUi(record) {
  return {
    ...record,
    rawPayload: {
      stored: true,
      hidden: true,
      reason: 'Sensitive payment source payload is retained in PostgreSQL and not returned to the browser.',
    },
  };
}

function buildStatusCounts(records) {
  return records.reduce((counts, record) => {
    const status = record.customProperties?.status || 'UNKNOWN';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function buildResponseCodeCounts(records) {
  return records.reduce((counts, record) => {
    const responseCode = record.customProperties?.responseCode || record.customProperties?.response_code || 'UNKNOWN';
    counts[responseCode] = (counts[responseCode] || 0) + 1;
    return counts;
  }, {});
}

function buildDistribution(records, key, fallback = 'Unknown') {
  return records.reduce((counts, record) => {
    const value = record.customProperties?.[key] || fallback;

    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function buildProcessorPerformance(records) {
  return records.reduce((items, record) => {
    const processorName = record.customProperties?.processorName || 'Unknown processor';
    const item = items[processorName] || {
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      amount: 0,
    };
    const status = record.customProperties?.status;

    item.total += 1;
    item.success += status === 'SUCCESS' ? 1 : 0;
    item.failed += status === 'FAILED' ? 1 : 0;
    item.pending += status === 'PENDING' ? 1 : 0;
    item.amount += Number(record.customProperties?.amount || 0);
    items[processorName] = item;

    return items;
  }, {});
}

function buildPaymentAnalytics(records) {
  const total = records.length;
  const success = records.filter((record) => record.customProperties?.status === 'SUCCESS').length;
  const failures = records.filter((record) => record.customProperties?.status === 'FAILED').length;
  const pending = records.filter((record) => record.customProperties?.status === 'PENDING').length;
  const settled = records.filter((record) => record.customProperties?.settled).length;
  const amounts = records
    .map((record) => Number(record.customProperties?.amount))
    .filter((value) => Number.isFinite(value));
  const amountTotal = Number(amounts.reduce((sum, value) => sum + value, 0).toFixed(2));
  const averageAmount = amounts.length ? Number((amountTotal / amounts.length).toFixed(2)) : 0;
  const successRate = total ? Number(((success / total) * 100).toFixed(1)) : 0;

  return {
    observedTotalRecords: OBSERVED_TOTAL_RECORDS,
    total,
    successRate,
    successCount: success,
    failureCount: failures,
    pendingCount: pending,
    settledCount: settled,
    amountTotal,
    averageAmount,
    statusCounts: buildStatusCounts(records),
    responseCodeCounts: buildResponseCodeCounts(records),
    merchantDistribution: buildDistribution(records, 'merchant'),
    processorPerformance: buildProcessorPerformance(records),
    transactionTypeDistribution: buildDistribution(records, 'transactionType'),
    paymentActionDistribution: buildDistribution(records, 'paymentAction'),
  };
}

function paymentRecordToTransaction(row) {
  const record = normalizeRecordRow(row);

  return sanitizePaymentRecordForUi({
    ...record,
    payment: record.customProperties || {},
  });
}

function buildPaymentFilters(options = {}) {
  const range = resolveRange(options);
  const values = [
    SOURCE_TOOL,
    APPLICATION_NAME,
    ENTITY_TYPE,
    PAYMENT_SCHEMA_VERSION,
    dashboardSourceModes(),
    range.from.toISOString(),
    range.to.toISOString(),
  ];
  const clauses = [
    'source_tool = $1',
    'application_name = $2',
    'entity_type = $3',
    "custom_properties->>'schema_version' = $4",
    "custom_properties->>'sourceMode' = ANY($5::text[])",
    'COALESCE(last_check, updated_at) BETWEEN $6 AND $7',
  ];

  if (options.status && options.status !== 'all') {
    values.push(String(options.status).toUpperCase());
    clauses.push(`custom_properties->>'status' = $${values.length}`);
  }

  if (options.responseCode && options.responseCode !== 'all') {
    values.push(String(options.responseCode).toUpperCase());
    clauses.push(`custom_properties->>'responseCode' = $${values.length}`);
  }

  if (options.transactionType && options.transactionType !== 'all') {
    values.push(String(options.transactionType).toUpperCase());
    clauses.push(`custom_properties->>'transactionType' = $${values.length}`);
  }

  if (options.search) {
    values.push(`%${String(options.search).toLowerCase()}%`);
    clauses.push(`(
      LOWER(COALESCE(custom_properties->>'uniqueTransactionNumber', '')) LIKE $${values.length}
      OR LOWER(COALESCE(custom_properties->>'merchant', '')) LIKE $${values.length}
      OR LOWER(COALESCE(custom_properties->>'merchantNumber', '')) LIKE $${values.length}
      OR LOWER(COALESCE(custom_properties->>'merchantId', '')) LIKE $${values.length}
      OR LOWER(COALESCE(custom_properties->>'accountHolderName', '')) LIKE $${values.length}
      OR LOWER(COALESCE(custom_properties->>'payerId', '')) LIKE $${values.length}
      OR LOWER(COALESCE(custom_properties->>'memberNumber', '')) LIKE $${values.length}
    )`);
  }

  return {
    clauses,
    range,
    values,
  };
}

async function getPaymentGatewayTransactions(options = {}) {
  await ensureMonitoringStorage();
  const page = Math.max(1, parsePositiveInteger(options.page, 1, 1000000));
  const size = parsePositiveInteger(options.size, 100, 10000);
  const offset = (page - 1) * size;
  const filters = buildPaymentFilters(options);
  const values = [...filters.values, size, offset];
  const sizeIndex = values.length - 1;
  const offsetIndex = values.length;
  const result = await db.query(
    `
      SELECT *, COUNT(*) OVER()::int AS filtered_count
      FROM monitoring_records
      WHERE ${filters.clauses.join(' AND ')}
      ORDER BY COALESCE(last_check, updated_at) DESC
      LIMIT $${sizeIndex} OFFSET $${offsetIndex}
    `,
    values,
  );
  const total = result.rows[0]?.filtered_count || 0;

  return {
    data: result.rows.map(paymentRecordToTransaction),
    meta: {
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      sourceTotal: OBSERVED_TOTAL_RECORDS,
      from: filters.range.from.toISOString(),
      to: filters.range.to.toISOString(),
    },
  };
}

async function getPaymentGatewaySummary(options = {}) {
  await ensureMonitoringStorage();
  const filters = buildPaymentFilters(options);
  const result = await db.query(
    `
      SELECT *
      FROM monitoring_records
      WHERE ${filters.clauses.join(' AND ')}
    `,
    filters.values,
  );
  const records = result.rows.map(normalizeRecordRow);

  return {
    ...buildPaymentAnalytics(records),
    loadedForRange: records.length,
    sourceTotal: OBSERVED_TOTAL_RECORDS,
    from: filters.range.from.toISOString(),
    to: filters.range.to.toISOString(),
  };
}

async function getPaymentGatewayHistory(options = {}) {
  await ensureMonitoringStorage();
  const filters = buildPaymentFilters(options);
  const result = await db.query(
    `
      SELECT
        DATE_TRUNC('hour', COALESCE(last_check, updated_at)) AS bucket,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE custom_properties->>'status' = 'SUCCESS')::int AS success,
        COUNT(*) FILTER (WHERE custom_properties->>'status' = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE custom_properties->>'status' = 'PENDING')::int AS pending,
        COALESCE(SUM((custom_properties->>'amount')::numeric), 0)::float AS amount
      FROM monitoring_records
      WHERE ${filters.clauses.join(' AND ')}
      GROUP BY bucket
      ORDER BY bucket
    `,
    filters.values,
  );

  return {
    sourceTotal: OBSERVED_TOTAL_RECORDS,
    from: filters.range.from.toISOString(),
    to: filters.range.to.toISOString(),
    data: result.rows.map((row) => ({
      timestamp: row.bucket,
      total: row.total,
      success: row.success,
      failed: row.failed,
      pending: row.pending,
      amount: Number(row.amount || 0),
    })),
  };
}

async function listApplications() {
  await syncPaymentGatewayData({ from: 'now-6h', to: 'now' });
  await ensureMonitoringStorage();
  const sourceModes = dashboardSourceModes();
  const result = await db.query(
    `
      SELECT COUNT(*)::int AS record_count, MAX(updated_at) AS last_updated_at
      FROM monitoring_records
      WHERE source_tool = $1
        AND application_name = $2
        AND entity_type = $3
        AND custom_properties->>'schema_version' = $4
        AND custom_properties->>'sourceMode' = ANY($5::text[])
    `,
    [SOURCE_TOOL, APPLICATION_NAME, ENTITY_TYPE, PAYMENT_SCHEMA_VERSION, sourceModes],
  );
  const row = result.rows[0] || {};

  return [{
    id: APPLICATION_NAME,
    label: `${APPLICATION_NAME} · ${OBSERVED_TOTAL_RECORDS.toLocaleString()} records`,
    entityType: 'payment_gateway_dashboard',
    recordCount: OBSERVED_TOTAL_RECORDS,
    status: 'ok',
    statusCounts: {},
    lastUpdatedAt: row.last_updated_at || null,
    metadata: {
      observedTotalRecords: OBSERVED_TOTAL_RECORDS,
      loadedRecordCount: row.record_count || 0,
      entityTypes: [ENTITY_TYPE],
      operationalOnly: true,
      maxResultWindow: MAX_RESULT_WINDOW,
    },
  }];
}

async function getDashboardDetails(options = {}) {
  const range = resolveRange(options);
  const syncResult = await syncPaymentGatewayData(options);
  await ensureMonitoringStorage();
  const sourceModes = dashboardSourceModes();

  const result = await db.query(
    `
      SELECT *
      FROM monitoring_records
      WHERE source_tool = $1
        AND application_name = $2
        AND entity_type = $3
        AND custom_properties->>'schema_version' = $4
        AND custom_properties->>'sourceMode' = ANY($5::text[])
        AND COALESCE(last_check, updated_at) BETWEEN $6 AND $7
      ORDER BY COALESCE(last_check, updated_at) DESC
      LIMIT $8
    `,
    [
      SOURCE_TOOL,
      APPLICATION_NAME,
      ENTITY_TYPE,
      PAYMENT_SCHEMA_VERSION,
      sourceModes,
      range.from.toISOString(),
      range.to.toISOString(),
      DASHBOARD_QUERY_LIMIT,
    ],
  );
  const records = result.rows.map(normalizeRecordRow);
  const uiRecords = records.map(sanitizePaymentRecordForUi);
  const analytics = buildPaymentAnalytics(records);
  const latestRecord = uiRecords[0];

  return {
    tool: {
      key: 'payment-gateway',
      label: APPLICATION_NAME,
      adapterName: 'Payment Gateway Adapter',
    },
    application: {
      id: APPLICATION_NAME,
      label: `${APPLICATION_NAME} · ${OBSERVED_TOTAL_RECORDS.toLocaleString()} records`,
      entityType: 'payment_gateway_dashboard',
    },
    kind: 'payment_gateway_dashboard',
    summary: {
      total: records.length,
      loadedForRange: records.length,
      sourceTotal: OBSERVED_TOTAL_RECORDS,
      status: analytics.failureCount ? 'warning' : 'ok',
      statusCounts: records.reduce((counts, record) => {
        counts[record.status] = (counts[record.status] || 0) + 1;
        return counts;
      }, {}),
      severityCounts: records.reduce((counts, record) => {
        counts[record.severity] = (counts[record.severity] || 0) + 1;
        return counts;
      }, {}),
      acknowledged: 0,
      inDowntime: 0,
      problems: analytics.failureCount,
      lastCheck: records.map((record) => record.lastCheck).filter(Boolean).sort().at(-1) || null,
    },
    keyMetrics: [
      { label: 'Success rate', value: `${analytics.successRate}%` },
      { label: 'Failures', value: analytics.failureCount },
      { label: 'Pending', value: analytics.pendingCount },
      { label: 'Settled', value: analytics.settledCount },
      { label: 'Amount volume', value: `$${analytics.amountTotal.toLocaleString()}` },
    ],
    entities: uiRecords,
    activeProblems: uiRecords.filter((record) => record.status === 'critical').slice(0, 50),
    recentEvents: uiRecords.slice(0, 80),
    deepLink: latestRecord?.deepLink || `${normalizeBaseUrl((await getRuntimeConfig()).baseUrl)}/transactions`,
    lastUpdatedAt: records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
    paymentGateway: {
      ...analytics,
      loadedForRange: records.length,
      observedTotalRecords: OBSERVED_TOTAL_RECORDS,
      dashboardQueryLimit: DASHBOARD_QUERY_LIMIT,
      dashboardResultTruncated: records.length >= DASHBOARD_QUERY_LIMIT,
      sync: syncResult,
      maxResultWindow: MAX_RESULT_WINDOW,
    },
    timeRange: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
  };
}

module.exports = {
  OBSERVED_TOTAL_RECORDS,
  getDashboardDetails,
  getPaymentGatewayHistory,
  getPaymentGatewaySummary,
  getPaymentGatewayTransactions,
  importPaymentGatewayPayload,
  listApplications,
  syncPaymentGatewayData,
  syncPaymentGatewayFromSettings,
  syncLivePaymentGatewayTransactions,
  testPaymentGatewayConnection,
};

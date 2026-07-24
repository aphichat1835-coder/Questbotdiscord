import { config } from './config.js';

const recentlyReported = new Map();
const DEDUPE_MS = 10 * 60_000;
const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_MAX_ATTEMPTS = 2;
const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email|webhook/i;
const DISCORD_WEBHOOK_URL = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]+/gi;
const ALWAYS_EMERGENCY_SOURCES = new Set([
  'Client startup',
  'Database backup',
  'Discord login',
  'Discord session invalidated',
  'Health server',
  'Runtime lease',
  'Uncaught exception',
  'Unhandled rejection',
]);

// Kept as a compatibility hook for existing startup code. Webhook delivery does
// not depend on the Discord client being connected or having channel permissions.
export function setErrorReporterClient(client) {
  void client;
}

function sanitizeValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 5) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, seen, depth + 1));
  }

  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeValue(item, seen, depth + 1);
  }
  return output;
}

function printable(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sanitizeValue(value));
  } catch {
    return String(value);
  }
}

export function redactSensitive(value) {
  return printable(value)
    .replace(DISCORD_WEBHOOK_URL, '[REDACTED_WEBHOOK]')
    .replace(
      /((?:authorization|token|secret|cookie|captcha(?:_[a-z0-9_]+)?|email|webhook(?:_url)?)['"]?\s*[:=]\s*['"]?)([^"',}\s]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{15,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 3500);
}

export function safeErrorMessage(error) {
  return redactSensitive(error?.message ?? error ?? 'Unknown error');
}

function emergencyCompatibilityFailure(message) {
  return /endpoints unavailable|schema changed|could not be parsed|missing a valid id/i.test(message);
}

function emergencyRestoreFailure(message) {
  return /decrypt|cipher|authenticate data|runner token secret|token secret/i.test(message);
}

export function isEmergencyIncident(source, error) {
  const safeSource = String(source ?? 'Unknown source');
  const message = safeErrorMessage(error);
  if (ALWAYS_EMERGENCY_SOURCES.has(safeSource)) return true;
  if (safeSource === 'Quest API compatibility') return emergencyCompatibilityFailure(message);
  if (safeSource.startsWith('Restore Scheduled Runner')) return emergencyRestoreFailure(message);
  return false;
}

function canDeliverEmergencyWebhook() {
  return process.env.NODE_TEST_WORKER_ID == null
    || process.env.ALLOW_TEST_WEBHOOK === 'true';
}

function incidentCategory(source) {
  if (source.startsWith('Restore Scheduled Runner')) return 'Restore Scheduled Runner';
  if (source.startsWith('Discord shard ')) return 'Discord shard';
  return source;
}

function removeExpiredReports(now) {
  for (const [reportedKey, reservation] of recentlyReported) {
    if (now - reservation.reservedAt >= DEDUPE_MS) recentlyReported.delete(reportedKey);
  }
}

function reserveCriticalErrorReport(source, safeMessage, now = Date.now()) {
  removeExpiredReports(now);
  const key = `${incidentCategory(source)}:${safeMessage.slice(0, 250)}`;
  const previous = recentlyReported.get(key);
  if (previous && now - previous.reservedAt < DEDUPE_MS) return null;

  const reservation = { key, reservedAt: now };
  recentlyReported.set(key, reservation);
  return reservation;
}

function releaseCriticalErrorReport(reservation) {
  if (recentlyReported.get(reservation.key) === reservation) {
    recentlyReported.delete(reservation.key);
  }
}

function codeBlock(value, limit) {
  const safe = String(value).replaceAll('```', '`\u200b``').slice(0, limit);
  return `\`\`\`\n${safe}\n\`\`\``;
}

function runtimeField() {
  const service = redactSensitive(process.env.RENDER_SERVICE_NAME || 'NeverDie Quest Bot');
  const region = redactSensitive(process.env.RENDER_REGION || 'unknown');
  return `${service}\nNode ${process.version} · PID ${process.pid}\nRegion: ${region}`.slice(0, 1024);
}

function deployField() {
  const commit = redactSensitive(process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 12);
  const instance = redactSensitive(process.env.RENDER_INSTANCE_ID || 'unknown');
  return `Commit: ${commit}\nInstance: ${instance}`.slice(0, 1024);
}

function contextField(context) {
  if (!context || (typeof context === 'object' && Object.keys(context).length === 0)) return null;
  return codeBlock(redactSensitive(context), 900);
}

export function buildEmergencyWebhookPayload(source, error, context = {}) {
  const safeSource = redactSensitive(source).slice(0, 256);
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  const fields = [
    { name: 'Source', value: safeSource || 'Unknown', inline: true },
    { name: 'Severity', value: 'CRITICAL', inline: true },
    { name: 'Uptime', value: `${Math.floor(process.uptime())} seconds`, inline: true },
    { name: 'Runtime', value: runtimeField(), inline: false },
    { name: 'Deployment', value: deployField(), inline: false },
  ];
  const safeContext = contextField(context);
  if (safeContext) fields.push({ name: 'Context', value: safeContext, inline: false });

  return {
    username: 'Quest Bot Emergency',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '🚨 SYSTEM EMERGENCY',
      description: codeBlock(safeMessage, 3200),
      color: 0xED4245,
      fields,
      footer: { text: 'NeverDie Quest Bot · Backend Emergency Log' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function retryableWebhookStatus(status) {
  return status === 429 || status >= 500;
}

function retryDelay(attempt, response = null) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(5000, Math.ceil(retryAfter * 1000))
    : attempt * 750;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function logWebhookDeliveryFailure(error) {
  console.error(
    '❌ [ErrorReporter] Emergency webhook delivery failed:',
    safeErrorMessage(error),
  );
}

async function postEmergencyWebhook(payload) {
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(config.logWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (reportError) {
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        await retryDelay(attempt);
        continue;
      }
      logWebhookDeliveryFailure(reportError);
      return false;
    }

    if (response.ok) return true;
    if (attempt < WEBHOOK_MAX_ATTEMPTS && retryableWebhookStatus(response.status)) {
      await retryDelay(attempt, response);
      continue;
    }

    logWebhookDeliveryFailure(new Error(`Discord webhook returned HTTP ${response.status}`));
    return false;
  }
  return false;
}

export async function reportCriticalError(
  source,
  error,
  { notify = true, emergency = undefined, context = {} } = {},
) {
  const safeSource = redactSensitive(source);
  const safeMessage = redactSensitive(error?.stack || error?.message || error);

  // Render/console logging remains the complete source of truth for every error.
  console.error(`❌ [${safeSource}]`, safeMessage);

  const shouldNotify = emergency ?? isEmergencyIncident(safeSource, error);
  if (!notify || !shouldNotify || !canDeliverEmergencyWebhook()) return;

  const reservation = reserveCriticalErrorReport(safeSource, safeMessage);
  if (!reservation) return;

  const delivered = await postEmergencyWebhook(
    buildEmergencyWebhookPayload(safeSource, error, context),
  );
  if (!delivered) releaseCriticalErrorReport(reservation);
}
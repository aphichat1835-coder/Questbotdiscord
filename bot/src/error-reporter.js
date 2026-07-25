import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  allowlistedIncidentContext,
  getIncidentDefinition,
  INCIDENT,
} from './incident-catalog.js';
import { executeDiscordWebhook } from './webhook-delivery.js';

const incidentState = new Map();
const DEDUPE_MS = 10 * 60_000;
const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email|webhook|cipher|password/i;
const DISCORD_WEBHOOK_URL = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]+/gi;
const LEGACY_SOURCE_CODES = new Map([
  ['Client startup', INCIDENT.CLIENT_STARTUP_FAILED],
  ['Database backup', INCIDENT.BACKUP_PROTECTION_LOST],
  ['Discord login', INCIDENT.DISCORD_LOGIN_FAILED],
  ['Discord session invalidated', INCIDENT.DISCORD_SESSION_INVALIDATED],
  ['Health server', INCIDENT.HEALTH_SERVER_BIND_FAILED],
  ['Runtime lease', INCIDENT.RUNTIME_LEASE_LOST],
  ['Uncaught exception', INCIDENT.UNCAUGHT_EXCEPTION],
  ['Unhandled rejection', INCIDENT.UNHANDLED_REJECTION],
]);

const reporterStatus = {
  lastDeliveryAt: null,
  lastDeliveryState: 'never',
  suppressedIncidents: 0,
};

// Retained temporarily so existing startup code can migrate without a breaking import.
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
      /((?:authorization|token|secret|cookie|captcha(?:_[a-z0-9_]+)?|email|webhook(?:_url)?|cipher|password)['"]?\s*[:=]\s*['"]?)([^"',}\s]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{15,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 8000);
}

export function safeErrorMessage(error) {
  return redactSensitive(error?.message ?? error ?? 'Unknown error').slice(0, 1200);
}

function safeErrorStack(error) {
  const stack = redactSensitive(error?.stack ?? '');
  if (!stack) return '';
  return stack.split('\n').slice(0, 4).join('\n').slice(0, 1800);
}

function codeBlock(value, limit) {
  const safe = String(value || 'No additional detail')
    .replaceAll('```', '`\u200b``')
    .slice(0, limit);
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

function incidentIdentity(code, scope) {
  return `${code}:${String(scope || 'system').slice(0, 120)}`;
}

function createIncidentId() {
  return `NQB-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function canDeliverEmergencyWebhook() {
  if (process.env.QUESTBOT_TEST_MODE === 'true') return false;
  return process.env.NODE_TEST_WORKER_ID == null
    || process.env.ALLOW_TEST_WEBHOOK === 'true';
}

function contextField(code, context) {
  const allowed = allowlistedIncidentContext(code, context);
  if (Object.keys(allowed).length === 0) return null;
  return codeBlock(redactSensitive(allowed), 900);
}

function incidentFields({ code, incidentId, status, context, occurrences }) {
  const definition = getIncidentDefinition(code);
  const fields = [
    { name: 'สถานะ', value: status === 'RECOVERED' ? 'RECOVERED' : 'CRITICAL · DETECTED', inline: true },
    { name: 'เหตุการณ์', value: code, inline: true },
    { name: 'Incident ID', value: incidentId, inline: true },
    { name: 'ผลกระทบ', value: definition.impact.slice(0, 1024), inline: false },
    { name: 'สิ่งที่ควรทำ', value: definition.action.slice(0, 1024), inline: false },
    { name: 'Runtime', value: runtimeField(), inline: false },
    { name: 'Deployment', value: deployField(), inline: false },
  ];
  if (occurrences > 1) {
    fields.push({ name: 'เกิดซ้ำ', value: `${occurrences} ครั้ง`, inline: true });
  }
  const safeContext = contextField(code, context);
  if (safeContext) fields.push({ name: 'Context', value: safeContext, inline: false });
  return fields;
}

export function buildIncidentWebhookPayload({
  code,
  error = null,
  context = {},
  incidentId = createIncidentId(),
  status = 'DETECTED',
  occurrences = 1,
} = {}) {
  const definition = getIncidentDefinition(code);
  const details = status === 'RECOVERED'
    ? 'ระบบกลับมาทำงานภายในเกณฑ์ที่กำหนดแล้ว'
    : [safeErrorMessage(error), safeErrorStack(error)].filter(Boolean).join('\n');

  return {
    username: 'Quest Bot Backend',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${status === 'RECOVERED' ? '✅' : '🚨'} ${definition.title}`,
      description: codeBlock(details, 2200),
      color: status === 'RECOVERED' ? 0x57F287 : 0xED4245,
      fields: incidentFields({ code, incidentId, status, context, occurrences }),
      footer: { text: 'NeverDie Quest Bot · Backend Incident Log' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function logWebhookDeliveryFailure(code, incidentId, result) {
  console.error(
    `❌ [Incident delivery ${code} ${incidentId}]`,
    redactSensitive(result),
  );
}

export function reportError(source, error, { context = {} } = {}) {
  const safeSource = redactSensitive(source || 'Unknown source').slice(0, 256);
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  const safeContext = redactSensitive(sanitizeValue(context));
  console.error(`❌ [${safeSource}]`, safeMessage, safeContext === '{}' ? '' : safeContext);
  return { state: 'logged' };
}

export async function reportIncident({
  code,
  error,
  context = {},
  scope = 'system',
  source = code,
  now = Date.now(),
  notify = true,
} = {}) {
  getIncidentDefinition(code);
  reportError(source, error, { context: allowlistedIncidentContext(code, context) });

  if (!notify || !canDeliverEmergencyWebhook()) {
    return { state: 'logged_only', code };
  }

  const key = incidentIdentity(code, scope);
  let incident = incidentState.get(key);
  if (incident?.state === 'open' && now - incident.lastSentAt < DEDUPE_MS) {
    incident.occurrences++;
    reporterStatus.suppressedIncidents++;
    return {
      state: 'suppressed',
      code,
      incidentId: incident.incidentId,
      occurrences: incident.occurrences,
    };
  }

  if (!incident || incident.state === 'recovered') {
    incident = {
      incidentId: createIncidentId(),
      code,
      scope,
      occurrences: 0,
      firstSeenAt: now,
      lastSentAt: 0,
      state: 'open',
    };
  }
  incident.occurrences++;
  incident.lastSeenAt = now;

  const payload = buildIncidentWebhookPayload({
    code,
    error,
    context,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  });
  const delivery = await executeDiscordWebhook({
    url: config.logWebhookUrl,
    payload,
  });

  incident.lastSentAt = now;
  incident.delivery = delivery;
  incident.state = 'open';
  incidentState.set(key, incident);
  reporterStatus.lastDeliveryState = delivery.state;
  if (delivery.state === 'delivered') {
    reporterStatus.lastDeliveryAt = new Date(now).toISOString();
  } else {
    logWebhookDeliveryFailure(code, incident.incidentId, delivery);
  }

  return {
    state: delivery.state,
    code,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  };
}

export async function reportRecovery({
  code,
  context = {},
  scope = 'system',
  now = Date.now(),
} = {}) {
  getIncidentDefinition(code);
  const key = incidentIdentity(code, scope);
  const incident = incidentState.get(key);
  if (!incident || incident.state === 'recovered') return { state: 'not_open', code };
  if (!canDeliverEmergencyWebhook()) {
    incident.state = 'recovered';
    incident.recoveredAt = now;
    return { state: 'logged_only', code, incidentId: incident.incidentId };
  }

  const payload = buildIncidentWebhookPayload({
    code,
    context,
    incidentId: incident.incidentId,
    status: 'RECOVERED',
    occurrences: incident.occurrences,
  });
  const delivery = await executeDiscordWebhook({ url: config.logWebhookUrl, payload });
  incident.recoveryDelivery = delivery;
  incident.recoveredAt = now;
  incident.state = delivery.state === 'delivered' ? 'recovered' : 'recovery_pending';
  incidentState.set(key, incident);
  reporterStatus.lastDeliveryState = delivery.state;
  if (delivery.state === 'delivered') {
    reporterStatus.lastDeliveryAt = new Date(now).toISOString();
  } else {
    logWebhookDeliveryFailure(code, incident.incidentId, delivery);
  }
  return { state: delivery.state, code, incidentId: incident.incidentId };
}

function legacyIncidentCode(source, error, emergency) {
  if (emergency === true) return INCIDENT.SYSTEM_FAILURE;
  if (LEGACY_SOURCE_CODES.has(source)) return LEGACY_SOURCE_CODES.get(source);
  if (String(source).startsWith('Restore Scheduled Runner')) {
    return INCIDENT.RUNNER_RESTORE_SYSTEM_FAILED;
  }
  if (source === 'Quest API compatibility') {
    const message = safeErrorMessage(error);
    if (/unknown events/i.test(message)) return null;
    if (error?.name === 'QuestCompatibilityError'
      || /schema changed|could not be parsed|missing a valid id/i.test(message)) {
      return INCIDENT.QUEST_API_SCHEMA_INCOMPATIBLE;
    }
  }
  return null;
}

export function isEmergencyIncident(source, error) {
  return Boolean(legacyIncidentCode(source, error, undefined));
}

export function buildEmergencyWebhookPayload(source, error, context = {}) {
  return buildIncidentWebhookPayload({
    code: legacyIncidentCode(source, error, true),
    error,
    context,
  });
}

export async function reportCriticalError(
  source,
  error,
  { notify = true, emergency = undefined, context = {}, incidentCode = null, scope = 'system' } = {},
) {
  const code = incidentCode || legacyIncidentCode(source, error, emergency);
  if (!code) return reportError(source, error, { context });
  return reportIncident({ code, error, context, scope, source, notify });
}

export function getIncidentReporterStatus() {
  return {
    webhookConfigured: Boolean(config.logWebhookUrl),
    lastDeliveryAt: reporterStatus.lastDeliveryAt,
    lastDeliveryState: reporterStatus.lastDeliveryState,
    suppressedIncidents: reporterStatus.suppressedIncidents,
    openIncidents: [...incidentState.values()].filter((item) => item.state !== 'recovered').length,
  };
}

export function resetIncidentReporterStateForTests() {
  incidentState.clear();
  reporterStatus.lastDeliveryAt = null;
  reporterStatus.lastDeliveryState = 'never';
  reporterStatus.suppressedIncidents = 0;
}

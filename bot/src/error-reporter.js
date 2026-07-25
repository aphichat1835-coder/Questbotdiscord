import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  allowlistedIncidentContext,
  getIncidentDefinition,
} from './incident-catalog.js';
import {
  accumulateLegacyContext,
  classifyLegacyIncident,
} from './legacy-incident-policy.js';
import { executeDiscordWebhook } from './webhook-delivery.js';

const incidentState = new Map();
const legacyCounters = new Map();
const LEGACY_WINDOW_MS = 10 * 60_000;
const FAILED_DELIVERY_RETRY_MS = 60_000;
const CLOSED_INCIDENT_RETENTION_MS = 24 * 60 * 60_000;
const OPEN_INCIDENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email|webhook|cipher|password/i;
const DISCORD_WEBHOOK_URL = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[a-z0-9._-]+/gi;
const SENSITIVE_ASSIGNMENT = /((?:["']?[\w.-]*(?:authorization|token|secret|cookie|captcha|email|webhook|cipher|password)[\w.-]*["']?)\s*[:=]\s*["']?)([^"',}\s]+)/gi;

const reporterStatus = {
  lastDeliveryAt: null,
  lastDeliveryState: 'never',
  suppressedIncidents: 0,
};

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
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
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
  const allowTestWebhook = process.env.ALLOW_TEST_WEBHOOK === 'true';
  if (process.env.QUESTBOT_TEST_MODE === 'true') return allowTestWebhook;
  return process.env.NODE_TEST_WORKER_ID == null || allowTestWebhook;
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

function pruneReporterState(now) {
  for (const [key, incident] of incidentState) {
    const reference = incident.recoveredAt
      ?? incident.lastSeenAt
      ?? incident.firstSeenAt
      ?? now;
    const active = ['delivering', 'open', 'recovering', 'recovery_pending'].includes(incident.state);
    const retention = active ? OPEN_INCIDENT_RETENTION_MS : CLOSED_INCIDENT_RETENTION_MS;
    if (now - reference >= retention) incidentState.delete(key);
  }

  for (const [key, counter] of legacyCounters) {
    if (now - (counter.lastSeenAt ?? counter.firstSeenAt ?? now) >= LEGACY_WINDOW_MS) {
      legacyCounters.delete(key);
    }
  }
}

function suppressIncident(incident, code, now, state = 'suppressed') {
  incident.occurrences++;
  incident.lastSeenAt = now;
  reporterStatus.suppressedIncidents++;
  return {
    state,
    code,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  };
}

function newIncident(code, scope, now) {
  return {
    incidentId: createIncidentId(),
    code,
    scope,
    occurrences: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastDeliveredAt: null,
    nextRetryAt: null,
    state: 'new',
  };
}

export async function reportIncident({
  code,
  error,
  context = {},
  scope = 'system',
  source = code,
  now = Date.now(),
  notify = true,
  log = true,
} = {}) {
  getIncidentDefinition(code);
  if (log) reportError(source, error, { context: allowlistedIncidentContext(code, context) });

  if (!notify || !canDeliverEmergencyWebhook()) {
    return { state: 'logged_only', code };
  }

  pruneReporterState(now);
  const key = incidentIdentity(code, scope);
  let incident = incidentState.get(key);

  if (incident?.state === 'delivering' || incident?.state === 'recovering') {
    return suppressIncident(incident, code, now);
  }
  if (incident?.state === 'open') {
    return suppressIncident(incident, code, now);
  }
  if (
    ['delivery_failed', 'delivery_unknown'].includes(incident?.state)
    && now < (incident.nextRetryAt ?? 0)
  ) {
    return suppressIncident(incident, code, now, 'retry_deferred');
  }
  if (!incident || ['recovered', 'recovery_pending'].includes(incident.state)) {
    incident = newIncident(code, scope, now);
  }

  incident.occurrences++;
  incident.lastSeenAt = now;
  incident.lastAttemptAt = now;
  incident.state = 'delivering';
  incidentState.set(key, incident);

  const payload = buildIncidentWebhookPayload({
    code,
    error,
    context,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  });

  let delivery;
  try {
    delivery = await executeDiscordWebhook({
      url: config.logWebhookUrl,
      payload,
    });
  } catch (deliveryError) {
    delivery = {
      state: 'delivery_unknown',
      attempts: 0,
      reason: deliveryError?.name || 'unexpected delivery failure',
    };
  }

  incident.delivery = delivery;
  if (delivery.state === 'delivered') {
    incident.state = 'open';
    incident.lastDeliveredAt = now;
    incident.nextRetryAt = null;
  } else {
    incident.state = delivery.state === 'permanent_failure'
      ? 'delivery_failed'
      : 'delivery_unknown';
    incident.nextRetryAt = now + FAILED_DELIVERY_RETRY_MS;
  }
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
  pruneReporterState(now);
  const key = incidentIdentity(code, scope);
  const incident = incidentState.get(key);

  if (!incident || incident.state === 'recovered') return { state: 'not_open', code };
  if (incident.state === 'recovering') {
    return suppressIncident(incident, code, now, 'recovery_in_progress');
  }
  if (incident.state === 'recovery_pending' && now < (incident.nextRecoveryRetryAt ?? 0)) {
    return { state: 'retry_deferred', code, incidentId: incident.incidentId };
  }
  if (!canDeliverEmergencyWebhook()) {
    incident.state = 'recovered';
    incident.recoveredAt = now;
    incidentState.set(key, incident);
    return { state: 'logged_only', code, incidentId: incident.incidentId };
  }

  incident.state = 'recovering';
  incident.recoveryAttemptAt = now;
  incidentState.set(key, incident);

  const payload = buildIncidentWebhookPayload({
    code,
    context,
    incidentId: incident.incidentId,
    status: 'RECOVERED',
    occurrences: incident.occurrences,
  });

  let delivery;
  try {
    delivery = await executeDiscordWebhook({ url: config.logWebhookUrl, payload });
  } catch (deliveryError) {
    delivery = {
      state: 'delivery_unknown',
      attempts: 0,
      reason: deliveryError?.name || 'unexpected recovery delivery failure',
    };
  }

  incident.recoveryDelivery = delivery;
  if (delivery.state === 'delivered') {
    incident.recoveredAt = now;
    incident.state = 'recovered';
    incident.nextRecoveryRetryAt = null;
  } else {
    incident.state = 'recovery_pending';
    incident.nextRecoveryRetryAt = now + FAILED_DELIVERY_RETRY_MS;
  }
  incidentState.set(key, incident);

  reporterStatus.lastDeliveryState = delivery.state;
  if (delivery.state === 'delivered') {
    reporterStatus.lastDeliveryAt = new Date(now).toISOString();
  } else {
    logWebhookDeliveryFailure(code, incident.incidentId, delivery);
  }
  return { state: delivery.state, code, incidentId: incident.incidentId };
}

function legacyCounterKey(policy) {
  return `${policy.code}:${policy.scope}`;
}

function collectLegacyEvidence(policy, now) {
  pruneReporterState(now);
  const key = legacyCounterKey(policy);
  let counter = legacyCounters.get(key);
  if (!counter || now - counter.firstSeenAt >= LEGACY_WINDOW_MS) {
    counter = { firstSeenAt: now, contexts: [], count: 0 };
  }
  counter.count++;
  counter.contexts.push(policy.context);
  if (counter.contexts.length > 50) counter.contexts.shift();
  counter.lastSeenAt = now;
  legacyCounters.set(key, counter);
  return { key, counter };
}

export function isEmergencyIncident(source, error) {
  return Boolean(classifyLegacyIncident(source, error, undefined));
}

export function buildEmergencyWebhookPayload(source, error, context = {}) {
  const policy = classifyLegacyIncident(source, error, true);
  return buildIncidentWebhookPayload({
    code: policy.code,
    error,
    context,
  });
}

export async function reportCriticalError(
  source,
  error,
  {
    notify = true,
    emergency = undefined,
    context = {},
    incidentCode = null,
    scope = 'system',
    now = Date.now(),
  } = {},
) {
  if (incidentCode) {
    return reportIncident({
      code: incidentCode,
      error,
      context,
      scope,
      source,
      notify,
      now,
    });
  }

  const policy = classifyLegacyIncident(source, error, emergency);
  if (!policy) return reportError(source, error, { context });
  if (policy.threshold <= 1) {
    return reportIncident({
      code: policy.code,
      error,
      context: { ...policy.context, ...context },
      scope: policy.scope,
      source,
      notify,
      now,
    });
  }

  reportError(source, error, { context: policy.context });
  const { key, counter } = collectLegacyEvidence(policy, now);
  if (counter.count < policy.threshold) {
    return {
      state: 'logged_threshold',
      code: policy.code,
      count: counter.count,
      threshold: policy.threshold,
    };
  }

  legacyCounters.delete(key);
  return reportIncident({
    code: policy.code,
    error,
    context: accumulateLegacyContext(policy.code, counter.contexts),
    scope: policy.scope,
    source,
    notify,
    now,
    log: false,
  });
}

export function getIncidentReporterStatus() {
  pruneReporterState(Date.now());
  const incidents = [...incidentState.values()];
  return {
    webhookConfigured: Boolean(config.logWebhookUrl),
    lastDeliveryAt: reporterStatus.lastDeliveryAt,
    lastDeliveryState: reporterStatus.lastDeliveryState,
    suppressedIncidents: reporterStatus.suppressedIncidents,
    openIncidents: incidents.filter((item) => item.state !== 'recovered').length,
    pendingRecoveries: incidents.filter((item) => item.state === 'recovery_pending').length,
    pendingThresholds: [...legacyCounters.values()].filter((item) => item.count > 0).length,
  };
}

export function resetIncidentReporterStateForTests() {
  incidentState.clear();
  legacyCounters.clear();
  reporterStatus.lastDeliveryAt = null;
  reporterStatus.lastDeliveryState = 'never';
  reporterStatus.suppressedIncidents = 0;
}

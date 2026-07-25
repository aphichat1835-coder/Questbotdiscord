import { randomUUID } from 'node:crypto';
import {
  allowlistedIncidentContext,
  getIncidentDefinition,
} from './incident-catalog.js';
import {
  executeDiscordWebhook,
  validateDiscordWebhookUrl,
} from './webhook-delivery.js';

const REDACTION_SCAN_LIMIT = 10_000;
const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email|webhook|cipher|password/i;
const DISCORD_WEBHOOK_URL = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[a-z0-9._-]+/gi;
const ASSIGNMENT = /((?:["']?[\w.-]+["']?)\s*[:=]\s*["']?)([^"',}\s]+)/g;

function assignmentKey(prefix) {
  const colonIndex = prefix.indexOf(':');
  const equalsIndex = prefix.indexOf('=');
  let delimiterIndex = colonIndex;
  if (delimiterIndex === -1 || (equalsIndex !== -1 && equalsIndex < delimiterIndex)) {
    delimiterIndex = equalsIndex;
  }
  return prefix
    .slice(0, delimiterIndex)
    .trim()
    .replaceAll('"', '')
    .replaceAll("'", '');
}

function redactAssignments(value) {
  return value.replace(ASSIGNMENT, (match, prefix) => (
    SENSITIVE_KEY.test(assignmentKey(prefix))
      ? `${prefix}[REDACTED]`
      : match
  ));
}

function redactBootstrapValue(value) {
  const bounded = String(value ?? 'Unknown error').slice(0, REDACTION_SCAN_LIMIT);
  return redactAssignments(bounded.replace(DISCORD_WEBHOOK_URL, '[REDACTED_WEBHOOK]'))
    .replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{15,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 2500);
}

function incidentId() {
  return `NQB-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function codeBlock(value, limit) {
  const safe = redactBootstrapValue(value).replaceAll('```', '`\u200b``').slice(0, limit);
  return `\`\`\`\n${safe}\n\`\`\``;
}

export function buildBootstrapIncidentPayload({ code, error, context = {}, id = incidentId() }) {
  const definition = getIncidentDefinition(code);
  const allowedContext = allowlistedIncidentContext(code, context);
  const fields = [
    { name: 'สถานะ', value: 'CRITICAL · STARTUP', inline: true },
    { name: 'เหตุการณ์', value: code, inline: true },
    { name: 'Incident ID', value: id, inline: true },
    { name: 'ผลกระทบ', value: definition.impact.slice(0, 1024), inline: false },
    { name: 'สิ่งที่ควรทำ', value: definition.action.slice(0, 1024), inline: false },
  ];
  if (Object.keys(allowedContext).length) {
    fields.push({
      name: 'Context',
      value: codeBlock(JSON.stringify(allowedContext), 900),
      inline: false,
    });
  }

  return {
    username: 'Quest Bot Bootstrap',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `🚨 ${definition.title}`,
      description: codeBlock(error?.stack || error?.message || error, 2200),
      color: 0xED4245,
      fields,
      footer: { text: 'NeverDie Quest Bot · Safe Bootstrap' },
      timestamp: new Date().toISOString(),
    }],
  };
}

export async function reportBootstrapIncident({
  code,
  error,
  context = {},
  env = process.env,
  fetchFn = globalThis.fetch,
} = {}) {
  const id = incidentId();
  const safeMessage = redactBootstrapValue(error?.stack || error?.message || error);
  console.error(`❌ [Bootstrap ${code} ${id}]`, safeMessage);

  const rawWebhook = env.LOG_WEBHOOK_URL?.trim();
  if (!rawWebhook || env.QUESTBOT_TEST_MODE === 'true') {
    return { state: 'logged_only', code, incidentId: id };
  }

  let url;
  try {
    url = validateDiscordWebhookUrl('LOG_WEBHOOK_URL', rawWebhook);
  } catch (validationError) {
    console.error('❌ [Bootstrap webhook unavailable]', redactBootstrapValue(validationError.message));
    return { state: 'logged_only', code, incidentId: id };
  }

  const delivery = await executeDiscordWebhook({
    url,
    payload: buildBootstrapIncidentPayload({ code, error, context, id }),
    fetchFn,
    timeoutMs: 1800,
    maxAttempts: 2,
  });
  if (delivery.state !== 'delivered') {
    console.error(`❌ [Bootstrap delivery ${code} ${id}]`, redactBootstrapValue(JSON.stringify(delivery)));
  }
  return { ...delivery, code, incidentId: id };
}

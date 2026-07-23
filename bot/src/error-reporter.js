import { config } from './config.js';

let discordClient = null;
const recentlyReported = new Map();
const DEDUPE_MS = 60_000;
const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email/i;

export function setErrorReporterClient(client) {
  discordClient = client;
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
    .replace(
      /((?:authorization|token|secret|cookie|captcha(?:_[a-z0-9_]+)?|email)["']?\s*[:=]\s*["']?)([^"',}\s]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{15,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 1500);
}

export function safeErrorMessage(error) {
  return redactSensitive(error?.message ?? error ?? 'Unknown error');
}

function canNotifyCriticalError(notify) {
  return Boolean(notify && config.logChannelId && discordClient?.isReady?.());
}

function removeExpiredReports(now) {
  for (const [reportedKey, reportedAt] of recentlyReported) {
    if (now - reportedAt >= DEDUPE_MS) recentlyReported.delete(reportedKey);
  }
}

function reserveCriticalErrorReport(source, safeMessage, now = Date.now()) {
  removeExpiredReports(now);
  const key = `${source}:${safeMessage.slice(0, 250)}`;
  if (now - (recentlyReported.get(key) ?? 0) < DEDUPE_MS) return false;
  recentlyReported.set(key, now);
  return true;
}

async function sendCriticalErrorNotification(source, safeMessage) {
  try {
    const channel = await discordClient.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased?.()) return;
    await channel.send({
      content: [
        `🚨 **Critical Error — ${source}**`,
        '```',
        safeMessage.slice(0, 1700),
        '```',
      ].join(String.fromCharCode(10)),
    });
  } catch (reportError) {
    console.error(
      '❌ [ErrorReporter] Discord notification failed:',
      safeErrorMessage(reportError),
    );
  }
}

export async function reportCriticalError(source, error, { notify = true } = {}) {
  const safeSource = redactSensitive(source);
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  console.error(`❌ [${safeSource}]`, safeMessage);

  if (!canNotifyCriticalError(notify)) return;
  if (!reserveCriticalErrorReport(safeSource, safeMessage)) return;
  await sendCriticalErrorNotification(safeSource, safeMessage);
}

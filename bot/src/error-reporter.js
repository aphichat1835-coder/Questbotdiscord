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

export async function reportCriticalError(source, error, { notify = true } = {}) {
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  console.error(`❌ [${redactSensitive(source)}]`, safeMessage);

  if (!notify || !config.logChannelId || !discordClient?.isReady?.()) return;
  const key = `${source}:${safeMessage.slice(0, 250)}`;
  const now = Date.now();
  for (const [reportedKey, reportedAt] of recentlyReported) {
    if (now - reportedAt >= DEDUPE_MS) recentlyReported.delete(reportedKey);
  }
  if (now - (recentlyReported.get(key) ?? 0) < DEDUPE_MS) return;
  recentlyReported.set(key, now);

  try {
    const channel = await discordClient.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased?.()) return;
    await channel.send({
      content: [
        `🚨 **Critical Error — ${redactSensitive(source)}**`,
        '```',
        safeMessage.slice(0, 1700),
        '```',
      ].join('\n'),
    });
  } catch (reportError) {
    console.error(
      '❌ [ErrorReporter] Discord notification failed:',
      safeErrorMessage(reportError),
    );
  }
}

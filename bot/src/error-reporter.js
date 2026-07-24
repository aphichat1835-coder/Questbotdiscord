import { config } from './config.js';

let discordClient = null;
const recentlyReported = new Map();
const DEDUPE_MS = 60_000;
const DISCORD_MESSAGE_LIMIT = 2000;
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
  for (const [reportedKey, reservation] of recentlyReported) {
    if (now - reservation.reservedAt >= DEDUPE_MS) recentlyReported.delete(reportedKey);
  }
}

function reserveCriticalErrorReport(source, safeMessage, now = Date.now()) {
  removeExpiredReports(now);
  const key = `${source}:${safeMessage.slice(0, 250)}`;
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

function criticalErrorContent(source, safeMessage) {
  const headerStart = '🚨 **Critical Error — ';
  const headerEnd = '**\n```\n';
  const footer = '\n```';
  const fixedLength = headerStart.length + headerEnd.length + footer.length;
  const visibleSource = source.slice(0, Math.max(0, DISCORD_MESSAGE_LIMIT - fixedLength));
  const prefix = `${headerStart}${visibleSource}${headerEnd}`;
  const messageBudget = Math.max(0, DISCORD_MESSAGE_LIMIT - prefix.length - footer.length);
  return `${prefix}${safeMessage.slice(0, messageBudget)}${footer}`;
}

async function sendCriticalErrorNotification(source, safeMessage) {
  try {
    const channel = await discordClient.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased?.()) return false;
    await channel.send({ content: criticalErrorContent(source, safeMessage) });
    return true;
  } catch (reportError) {
    console.error(
      '❌ [ErrorReporter] Discord notification failed:',
      safeErrorMessage(reportError),
    );
    return false;
  }
}

export async function reportCriticalError(source, error, { notify = true } = {}) {
  const safeSource = redactSensitive(source);
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  console.error(`❌ [${safeSource}]`, safeMessage);

  if (!canNotifyCriticalError(notify)) return;
  const reservation = reserveCriticalErrorReport(safeSource, safeMessage);
  if (!reservation) return;

  const delivered = await sendCriticalErrorNotification(safeSource, safeMessage);
  if (!delivered) releaseCriticalErrorReport(reservation);
}

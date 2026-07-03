import { config } from './config.js';

let discordClient = null;
const recentlyReported = new Map();
const DEDUPE_MS = 60_000;

export function setErrorReporterClient(client) {
  discordClient = client;
}

export function redactSensitive(value) {
  return String(value ?? 'Unknown error')
    .replace(/(authorization|token|secret)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{15,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 1500);
}

export async function reportCriticalError(source, error, { notify = true } = {}) {
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  console.error(`❌ [${source}]`, safeMessage);

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
    console.error('❌ [ErrorReporter] Discord notification failed:', redactSensitive(reportError?.message));
  }
}

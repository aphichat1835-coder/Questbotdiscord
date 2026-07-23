from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text()


def write(path, content):
    (ROOT / path).write_text(content)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


text = read('bot/src/error-reporter.js')
start_index = text.find('export async function reportCriticalError(')
if start_index < 0:
    raise RuntimeError('error reporter function marker not found')
text = text[:start_index] + '''function canNotifyCriticalError(notify) {
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
'''
write('bot/src/error-reporter.js', text)

text = read('bot/src/http-retry.js')
start_index = text.find('export async function fetchWithRetry(')
if start_index < 0:
    raise RuntimeError('fetchWithRetry marker not found')
text = text[:start_index] + '''function retryBackoffMs(attempt, baseDelayMs, random) {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    baseDelayMs * (2 ** attempt) + Math.floor(random() * 250),
  );
}

async function consumeRetryableResponse(response, context) {
  const {
    attempt,
    maxRetries,
    method,
    policy,
    baseDelayMs,
    random,
    signal,
    waitFn,
  } = context;
  if (!shouldRetryResponse(response, method, policy) || attempt === maxRetries) {
    return true;
  }

  const rateLimitDelay = response.status === 429 ? await retryAfterMs(response) : null;
  await response.arrayBuffer().catch(() => {});
  await waitForRetry(
    rateLimitDelay ?? retryBackoffMs(attempt, baseDelayMs, random),
    signal,
    waitFn,
  );
  return false;
}

async function handleFetchFailure(error, context) {
  const {
    attempt,
    maxRetries,
    method,
    policy,
    baseDelayMs,
    random,
    signal,
    waitFn,
  } = context;
  if (signal?.aborted || error?.message === 'aborted') throw error;
  if (attempt === maxRetries || !mayRetryUnsafeRequest(method, policy)) throw error;
  await waitForRetry(retryBackoffMs(attempt, baseDelayMs, random), signal, waitFn);
  return error;
}

export async function fetchWithRetry(url, options = {}, policy = {}) {
  const {
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = 1000,
    random = Math.random,
    waitFn = null,
  } = policy;
  const method = String(options.method ?? 'GET').toUpperCase();
  const retryContext = {
    maxRetries,
    method,
    policy,
    baseDelayMs,
    random,
    signal: options.signal,
    waitFn,
  };

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchAttempt(fetchFn, url, options, timeoutMs);
      const done = await consumeRetryableResponse(response, { ...retryContext, attempt });
      if (done) return response;
    } catch (error) {
      lastError = await handleFetchFailure(error, { ...retryContext, attempt });
    }
  }
  throw lastError;
}
'''
write('bot/src/http-retry.js', text)

text = read('bot/test/quality-refactor.node-test.js')
text = replace_once(
    text,
    "  const db = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');\n",
    "  const db = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');\n"
    "  const errorReporter = await readFile(new URL('../src/error-reporter.js', import.meta.url), 'utf8');\n",
    'quality test error reporter read',
)
text = replace_once(
    text,
    "  assert.doesNotMatch(db, /backupLocalSlot|backupPersistentSlot|clearLocalInactiveSlots|clearPersistentInactiveSlots/);\n",
    "  assert.doesNotMatch(db, /backupLocalSlot|backupPersistentSlot|clearLocalInactiveSlots|clearPersistentInactiveSlots/);\n"
    "  assert.match(errorReporter, /function reserveCriticalErrorReport/);\n"
    "  assert.match(httpRetry, /async function consumeRetryableResponse/);\n"
    "  assert.match(httpRetry, /async function handleFetchFailure/);\n",
    'quality test complexity guards',
)
write('bot/test/quality-refactor.node-test.js', text)
print('complexity cleanup applied')

import fs from 'node:fs';

const file = new URL('../src/discord-runner.js', import.meta.url);
let source = fs.readFileSync(file, 'utf8');
let changes = 0;

function replaceOnce(oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Anchor not found: ${label}`);
  source = source.replace(oldText, newText);
  changes++;
}

function replaceRange(startText, endText, replacement, label) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end < 0) throw new Error(`Range anchor not found: ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end);
  changes++;
}

replaceOnce(
  "import 'dotenv/config';\n",
  `import 'dotenv/config';\nimport { AsyncLocalStorage } from 'node:async_hooks';\n`,
  'AsyncLocalStorage import',
);

replaceOnce(
  "import { fetchWithRetry } from './http-retry.js';\n",
  `import { fetchWithRetry } from './http-retry.js';\nimport { executeVerifiedMutation } from './mutation-retry.js';\nimport {\n  clearQuestStatuses as clearStoredQuestStatuses,\n  getQuestStatus as getStoredQuestStatus,\n  listQuestStatuses as listStoredQuestStatuses,\n  recordQuestAttempt,\n  recordQuestFailure,\n  recordQuestSuccess,\n  recordQuestVerification,\n  setQuestStatusLifecycle,\n} from './quest-status-store.js';\n`,
  'status imports',
);

replaceOnce(
`async function discordFetch(token, path, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const res = await fetchWithRetry(\`${'${DISCORD_API}'}${'${path}'}\`, {
    ...requestOptions,
    headers: { ...userHeaders(token, path), ...headers },
  });`,
`async function discordFetch(token, path, options = {}, policy = {}) {
  const { headers = {}, ...requestOptions } = options;
  const method = String(requestOptions.method ?? 'GET').toUpperCase();
  const requestPolicy = method === 'POST'
    ? { ...policy, retryRateLimits: false }
    : policy;
  const res = await fetchWithRetry(\`${'${DISCORD_API}'}${'${path}'}\`, {
    ...requestOptions,
    headers: { ...userHeaders(token, path), ...headers },
  }, requestPolicy);`,
  'discordFetch policy',
);

replaceRange(
  'const questEngineStatus = {',
  'export class QuestCompatibilityError',
  `const questStatusStorage = new AsyncLocalStorage();\n\nfunction normalizeStatusContext(context = {}) {\n  if (typeof context === 'string') return { key: context };\n  return {\n    key: context.key || context.jobKey || 'system',\n    ownerId: context.ownerId ?? null,\n    accountId: context.accountId ?? null,\n    username: context.username ?? null,\n    jobKey: context.jobKey ?? null,\n    mode: context.mode ?? null,\n    lifecycle: context.lifecycle ?? 'running',\n  };\n}\n\nfunction currentQuestStatusContext() {\n  return questStatusStorage.getStore() ?? normalizeStatusContext();\n}\n\n`,
  'global Quest status',
);

replaceOnce(
`export function getQuestEngineStatus() {
  return {
    ...questEngineStatus,
    unknownEvents: [...questEngineStatus.unknownEvents],
    schemaIssues: [...questEngineStatus.schemaIssues],
  };
}

function recordQuestError(error) {
  questEngineStatus.lastCheckAt = new Date().toISOString();
  questEngineStatus.state = error instanceof QuestCompatibilityError ? 'incompatible' : 'error';
  questEngineStatus.lastError = error.message;
}`,
`export function getQuestEngineStatus(statusKey = null) {
  return getStoredQuestStatus(statusKey);
}

export function listQuestEngineStatuses(options = {}) {
  return listStoredQuestStatuses(options);
}

export function clearQuestEngineStatuses() {
  clearStoredQuestStatuses();
}

function recordQuestError(error) {
  const context = currentQuestStatusContext();
  recordQuestFailure(
    context.key,
    error,
    error instanceof QuestCompatibilityError,
    context,
  );
}`,
  'Quest status exports',
);

replaceOnce(
  'export async function fetchQuests(token, signal) {\n  const paths = QUEST_LIST_PATHS;',
  `export async function fetchQuests(token, signal, explicitStatusContext = null) {\n  if (explicitStatusContext) {\n    const context = normalizeStatusContext(explicitStatusContext);\n    return questStatusStorage.run(context, () => fetchQuests(token, signal));\n  }\n  const statusContext = currentQuestStatusContext();\n  recordQuestAttempt(statusContext.key, statusContext);\n  const paths = QUEST_LIST_PATHS;`,
  'fetchQuests context',
);

replaceOnce(
`  Object.assign(questEngineStatus, {
    lastCheckAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    state: schemaIssues.length || unknownEvents.length ? 'degraded' : 'compatible',
    questCount: quests.length,
    excludedCount: selectedExcludedCount,
    enrollmentBlockedUntil: selectedEnrollmentBlockedUntil,
    supportedCount: quests.filter((quest) => !quest.completed && isRunnableQuest(quest)).length,
    unknownEvents,
    schemaIssues,
    questListPath: selectedPath,
    lastError: null,
  });`,
`  const statusContext = currentQuestStatusContext();
  recordQuestSuccess(statusContext.key, {
    state: schemaIssues.length || unknownEvents.length ? 'degraded' : 'compatible',
    questCount: quests.length,
    excludedCount: selectedExcludedCount,
    enrollmentBlockedUntil: selectedEnrollmentBlockedUntil,
    supportedCount: quests.filter((quest) => !quest.completed && isRunnableQuest(quest)).length,
    unknownEvents,
    schemaIssues,
    questListPath: selectedPath,
  }, statusContext);`,
  'Quest success status',
);

replaceRange(
  'async function enrollQuest(token, questId, signal) {',
  'export function normalizeQuest',
  `async function readFreshQuestForMutation(token, questId, signal) {\n  try {\n    return (await fetchQuests(token, signal)).find((quest) => quest.id === questId) ?? null;\n  } catch (error) {\n    if (isFatalAuthError(error) || isAbortFailure(error, signal)) throw error;\n    return null;\n  }\n}\n\nasync function verifiedQuestMutation({ token, questId, signal, perform, predicate }) {\n  return executeVerifiedMutation({\n    perform,\n    signal,\n    verify: async () => {\n      const fresh = await readFreshQuestForMutation(token, questId, signal);\n      return Boolean(fresh && predicate(fresh));\n    },\n  });\n}\n\nasync function enrollQuest(token, questId, signal) {\n  return verifiedQuestMutation({\n    token,\n    questId,\n    signal,\n    predicate: (fresh) => fresh.enrolled,\n    perform: () => discordFetch(token, \`/quests/\${questId}/enroll\`, {\n      method: 'POST',\n      body: JSON.stringify({\n        location: 11,\n        is_targeted: false,\n        metadata_raw: null,\n      }),\n      signal,\n    }),\n  });\n}\n\nasync function claimQuest(token, questId, platform, signal) {\n  const perform = async () => {\n    try {\n      return await discordFetch(token, \`/quests/\${questId}/claim-reward\`, {\n        method: 'POST',\n        body: JSON.stringify({ location: 11, platform }),\n        signal,\n      });\n    } catch (error) {\n      if (error?.status !== 404) throw error;\n      return discordFetch(token, \`/quests/\${questId}/claim\`, {\n        method: 'POST',\n        body: JSON.stringify({ location: 1, platform }),\n        signal,\n      });\n    }\n  };\n  return verifiedQuestMutation({\n    token,\n    questId,\n    signal,\n    perform,\n    predicate: (fresh) => fresh.claimed,\n  });\n}\n\nasync function sendVideoProgress(token, questId, timestamp, signal) {\n  const ts = Math.round(timestamp + Math.random() * 0.5);\n  return verifiedQuestMutation({\n    token,\n    questId,\n    signal,\n    predicate: (fresh) => fresh.completed || fresh.progressSecs >= Math.floor(timestamp),\n    perform: () => discordFetch(token, \`/quests/\${questId}/video-progress\`, {\n      method: 'POST',\n      body: JSON.stringify({ timestamp: ts }),\n      signal,\n    }),\n  });\n}\n\nasync function sendGameHeartbeat(token, quest, terminal, signal) {\n  const baseline = quest.progressSecs;\n  const perform = async () => {\n    try {\n      return await discordFetch(token, \`/quests/\${quest.id}/heartbeat\`, {\n        method: 'POST',\n        body: JSON.stringify({ stream_key: \`call:\${quest.id}:1\`, terminal }),\n        signal,\n      });\n    } catch (error) {\n      if (error?.status !== 400 || !quest.applicationId) throw error;\n      return discordFetch(token, \`/quests/\${quest.id}/heartbeat\`, {\n        method: 'POST',\n        body: JSON.stringify({ application_id: quest.applicationId, terminal }),\n        signal,\n      });\n    }\n  };\n  return verifiedQuestMutation({\n    token,\n    questId: quest.id,\n    signal,\n    perform,\n    predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,\n  });\n}\n\nasync function sendApplicationHeartbeat(token, quest, terminal, signal) {\n  if (!quest.applicationId) {\n    throw new QuestCompatibilityError(\`Quest \${quest.id} is missing config.application.id\`);\n  }\n  const baseline = quest.progressSecs;\n  return verifiedQuestMutation({\n    token,\n    questId: quest.id,\n    signal,\n    predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,\n    perform: () => discordFetch(token, \`/quests/\${quest.id}/heartbeat\`, {\n      method: 'POST',\n      body: JSON.stringify({ application_id: quest.applicationId, terminal }),\n      signal,\n    }),\n  });\n}\n\n`,
  'mutation functions',
);

replaceOnce(
  '        questEngineStatus.lastVerifiedClaimAt = new Date().toISOString();',
  "        recordQuestVerification(currentQuestStatusContext().key, 'claim', currentQuestStatusContext());",
  'claim verification',
);
replaceOnce(
  '        questEngineStatus.lastVerifiedProgressAt = new Date().toISOString();',
  "        recordQuestVerification(currentQuestStatusContext().key, 'progress', currentQuestStatusContext());",
  'progress verification',
);
replaceOnce(
  '    questEngineStatus.lastVerifiedCompletionAt = new Date().toISOString();',
  "    recordQuestVerification(currentQuestStatusContext().key, 'completion', currentQuestStatusContext());",
  'completion verification',
);

replaceOnce(
  '  const jobRecord = {\n    ownerId,',
  `  const runnerStatusContext = normalizeStatusContext({\n    key: \`job:\${jobKey}\`,\n    ownerId,\n    accountId,\n    username,\n    jobKey,\n    mode,\n    lifecycle: 'running',\n  });\n  setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);\n\n  const jobRecord = {\n    ownerId,`,
  'runner status context',
);

replaceOnce(
  '      scheduleId,\n      lifecycle: jobRecord.lifecycle,',
  '      scheduleId,\n      questStatusKey: runnerStatusContext.key,\n      lifecycle: jobRecord.lifecycle,',
  'job summary status key',
);

replaceOnce(
  '  const runPromise = (async () => {',
  '  const runPromise = questStatusStorage.run(runnerStatusContext, async () => {',
  'runner context execution',
);

replaceOnce(
`      const job = jobs.get(jobKey);
      if (job) job.accountId = accountId;

      addLog(\`✅ LOGIN : \${username}\`);`,
`      const job = jobs.get(jobKey);
      if (job) job.accountId = accountId;
      Object.assign(runnerStatusContext, { accountId, username });
      setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);

      addLog(\`✅ LOGIN : \${username}\`);`,
  'runner account metadata',
);

replaceOnce(
`      jobs.delete(jobKey);
    }
  })();`,
`      setQuestStatusLifecycle(runnerStatusContext.key, 'stopped', {
        ...runnerStatusContext,
        accountId,
        username,
      });
      jobs.delete(jobKey);
    }
  });`,
  'runner final lifecycle',
);

if (changes !== 15) throw new Error(`Expected 15 changes, got ${changes}`);
fs.writeFileSync(file, source);
console.log(`Applied ${changes} status/retry hardening changes`);

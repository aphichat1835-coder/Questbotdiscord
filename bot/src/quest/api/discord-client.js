import { config } from '../../config.js';
import { fetchWithRetry } from '../../http-retry.js';
import {
  FATAL_FORBIDDEN_PATHS,
  QUEST_ENDPOINT,
  QUEST_LIST_PATHS,
} from './quest-endpoints.js';
import { extractQuestArray, QuestCompatibilityError } from '../schema/compatibility.js';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_API_URL = new URL(DISCORD_API_BASE);

export class DiscordApiError extends Error {
  constructor(status, path, data) {
    super(`Discord API ${status} at ${path}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.path = path;
    this.data = data;
    this.fatalAuth = status === 401 || (status === 403 && FATAL_FORBIDDEN_PATHS.has(path));
  }
}

export function isFatalAuthError(error) {
  return error?.fatalAuth === true;
}

function userAgent(profile) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${profile.clientVersion} Chrome/${profile.chromeVersion} Electron/${profile.electronVersion} Safari/537.36`;
}

export function currentDiscordClientProfile() {
  return Object.freeze({
    clientVersion: config.discordClientVersion,
    chromeVersion: config.discordChromeVersion,
    electronVersion: config.discordElectronVersion,
    buildNumber: config.discordBuildNumber,
    nativeBuildNumber: config.discordNativeBuildNumber,
    locale: config.discordLocale,
    timezone: config.discordTimezone,
  });
}

export function buildDiscordUserHeaders(token, path = '', profile = currentDiscordClientProfile()) {
  const ua = userAgent(profile);
  const chromeMajor = profile.chromeVersion.split('.')[0];
  const superProperties = Buffer.from(JSON.stringify({
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: 'stable',
    client_version: profile.clientVersion,
    os_version: '10.0.22631',
    os_arch: 'x64',
    app_arch: 'x64',
    system_locale: profile.locale,
    browser_user_agent: ua,
    browser_version: profile.chromeVersion,
    client_build_number: profile.buildNumber,
    native_build_number: profile.nativeBuildNumber,
    client_event_source: null,
    design_id: 0,
  })).toString('base64');
  return {
    Authorization: token,
    'Content-Type': 'application/json',
    'User-Agent': ua,
    'X-Super-Properties': superProperties,
    'X-Debug-Options': 'bugReporterEnabled',
    'X-Discord-Locale': profile.locale,
    'X-Discord-Timezone': profile.timezone,
    Accept: '*/*',
    'Accept-Language': `${profile.locale},en;q=0.9`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    Referer: path.startsWith('/quests/')
      ? 'https://discord.com/quest-home'
      : 'https://discord.com/channels/@me',
    Origin: 'https://discord.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': `"Chromium";v="${chromeMajor}", "Not)A;Brand";v="8"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

function requireDiscordApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('Discord API path must start with /');
  }
  if (
    path.startsWith('//')
    || path.includes('\\')
    || path.includes('?')
    || path.includes('#')
    || /\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(path)
  ) {
    throw new TypeError('Discord API path contains an unsafe segment');
  }
  return path;
}

export function buildDiscordApiUrl(path) {
  const safePath = requireDiscordApiPath(path);
  const url = new URL(DISCORD_API_URL);
  url.pathname = `${DISCORD_API_URL.pathname}${safePath}`;
  if (url.origin !== DISCORD_API_URL.origin || !url.pathname.startsWith('/api/v10/')) {
    throw new TypeError('Discord API URL escaped the v10 boundary');
  }
  return url;
}

export async function discordFetch(token, path, options = {}, policy = {}) {
  const safePath = requireDiscordApiPath(path);
  const { headers = {}, ...requestOptions } = options;
  const method = String(requestOptions.method ?? 'GET').toUpperCase();
  const requestPolicy = method === 'POST'
    ? { ...policy, retryRateLimits: false }
    : policy;
  const response = await fetchWithRetry(buildDiscordApiUrl(safePath), {
    ...requestOptions,
    headers: { ...buildDiscordUserHeaders(token, safePath), ...headers },
  }, requestPolicy);
  if (response.status === 204) return { ok: true, status: 204 };
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) throw new DiscordApiError(response.status, safePath, data);
  return data;
}

export async function fetchCurrentUser(token, signal) {
  return discordFetch(token, QUEST_ENDPOINT.me(), { signal });
}

export async function fetchQuestPayload(token, signal) {
  let emptyCandidate = null;
  let lastError = null;
  let fatalError = null;

  for (const path of QUEST_LIST_PATHS) {
    try {
      const candidate = await discordFetch(token, path, { signal });
      const quests = extractQuestArray(candidate, path);
      const payload = {
        path,
        quests,
        excludedCount: Array.isArray(candidate?.excluded_quests)
          ? candidate.excluded_quests.length
          : 0,
        enrollmentBlockedUntil: candidate?.quest_enrollment_blocked_until ?? null,
      };
      if (quests.length > 0) return payload;
      emptyCandidate ??= payload;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.message === 'aborted') throw error;
      if (isFatalAuthError(error)) {
        fatalError = error;
        if (error.status === 401 || emptyCandidate) break;
      } else {
        lastError = error;
      }
    }
  }

  if (emptyCandidate) return emptyCandidate;
  if (fatalError) throw fatalError;
  if (lastError instanceof QuestCompatibilityError) throw lastError;
  throw new QuestCompatibilityError(
    `Quest API endpoints unavailable: ${lastError?.message ?? 'unknown error'}`,
    { code: 'QUEST_ENDPOINTS_UNAVAILABLE' },
  );
}

export function enrollQuestRequest(token, questId, signal) {
  return discordFetch(token, QUEST_ENDPOINT.enroll(questId), {
    method: 'POST',
    body: JSON.stringify({
      location: 11,
      is_targeted: false,
      metadata_raw: null,
    }),
    signal,
  });
}

export async function claimQuestRequest(token, questId, platform, signal) {
  try {
    return await discordFetch(token, QUEST_ENDPOINT.claimReward(questId), {
      method: 'POST',
      body: JSON.stringify({ location: 11, platform }),
      signal,
    });
  } catch (error) {
    if (error?.status !== 404) throw error;
    return discordFetch(token, QUEST_ENDPOINT.claim(questId), {
      method: 'POST',
      body: JSON.stringify({ location: 1, platform }),
      signal,
    });
  }
}

export function sendVideoProgressRequest(token, questId, timestamp, signal) {
  const submittedTimestamp = Math.round(Number(timestamp) + Math.random() * 0.5);
  return discordFetch(token, QUEST_ENDPOINT.videoProgress(questId), {
    method: 'POST',
    body: JSON.stringify({ timestamp: submittedTimestamp }),
    signal,
  });
}

export function sendApplicationHeartbeatRequest(token, quest, terminal, signal) {
  if (!quest?.applicationId) {
    throw new QuestCompatibilityError(
      `Quest ${quest?.id ?? '<unknown>'} is missing config.application.id`,
      { code: 'QUEST_APPLICATION_ID_MISSING' },
    );
  }
  return discordFetch(token, QUEST_ENDPOINT.heartbeat(quest.id), {
    method: 'POST',
    body: JSON.stringify({ application_id: quest.applicationId, terminal: Boolean(terminal) }),
    signal,
  });
}

export async function sendHeartbeatRequest(
  token,
  quest,
  terminal,
  useApplicationPayload,
  signal,
) {
  if (useApplicationPayload) {
    return sendApplicationHeartbeatRequest(token, quest, terminal, signal);
  }
  try {
    return await discordFetch(token, QUEST_ENDPOINT.heartbeat(quest.id), {
      method: 'POST',
      body: JSON.stringify({ stream_key: `call:${quest.id}:1`, terminal: Boolean(terminal) }),
      signal,
    });
  } catch (error) {
    if (error?.status !== 400 || !quest?.applicationId) throw error;
    return sendApplicationHeartbeatRequest(token, quest, terminal, signal);
  }
}

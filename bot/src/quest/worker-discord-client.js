import { config } from '../config.js';
import { DISCORD_API_BASE } from './discord-api-runtime.js';

export const WORKER_DISCORD_REQUEST_TIMEOUT_MS = 15_000;

function messagePayload(payload) {
  return {
    content: String(payload?.content ?? '').slice(0, 2000),
    allowed_mentions: { parse: [] },
  };
}

async function readDiscordResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const error = new Error(`Discord bot REST ${response.status}`);
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

function boundedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function createWorkerDiscordClient({
  fetchFn = null,
  botToken = config.token,
  requestTimeoutMs = WORKER_DISCORD_REQUEST_TIMEOUT_MS,
} = {}) {
  const timeoutMs = Number(requestTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Worker Discord request timeout must be a positive number');
  }
  let ready = false;

  async function request(path, options = {}) {
    const transport = fetchFn ?? globalThis.fetch;
    if (typeof transport !== 'function') throw new TypeError('Global fetch is unavailable');
    const response = await transport(`${DISCORD_API_BASE}${path}`, {
      ...options,
      signal: boundedSignal(options.signal, timeoutMs),
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    return readDiscordResponse(response);
  }

  function message(channelId, data) {
    return {
      id: data.id,
      channelId,
      async edit(payload) {
        const edited = await request(`/channels/${channelId}/messages/${data.id}`, {
          method: 'PATCH',
          body: JSON.stringify(messagePayload(payload)),
        });
        return message(channelId, edited);
      },
    };
  }

  function textChannel(channelId) {
    return {
      id: channelId,
      isTextBased: () => true,
      async send(payload) {
        const sent = await request(`/channels/${channelId}/messages`, {
          method: 'POST',
          body: JSON.stringify(messagePayload(payload)),
        });
        return message(channelId, sent);
      },
    };
  }

  return {
    ws: { ping: -1 },
    isReady: () => ready,
    markReady: () => { ready = true; },
    markNotReady: () => { ready = false; },
    channels: {
      async fetch(channelId) {
        if (!channelId) return null;
        return textChannel(String(channelId));
      },
    },
  };
}

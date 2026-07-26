import { config } from '../config.js';
import { DISCORD_API_BASE } from './discord-api-runtime.js';

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

export function createWorkerDiscordClient({
  fetchFn = null,
  botToken = config.token,
} = {}) {
  let ready = false;

  async function request(path, options = {}) {
    const transport = fetchFn ?? globalThis.fetch;
    if (typeof transport !== 'function') throw new TypeError('Global fetch is unavailable');
    const response = await transport(`${DISCORD_API_BASE}${path}`, {
      ...options,
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

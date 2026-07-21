const INSTALL_KEY = Symbol.for('neverdie.runnerStatusHeadersInstalled');
const channelProxies = new WeakMap();

/**
 * Read message content from a Discord string or message payload.
 *
 * @param {string | { content?: string }} payload Discord message payload.
 * @returns {string | undefined} Message content when present.
 */
function getPayloadContent(payload) {
  return typeof payload === 'string' ? payload : payload?.content;
}

/**
 * Return a payload with replacement content while preserving other fields.
 *
 * @param {string | object} payload Original Discord message payload.
 * @param {string} content Replacement content.
 * @returns {string | object} Updated payload in the original payload shape.
 */
function withPayloadContent(payload, content) {
  return typeof payload === 'string' ? content : { ...payload, content };
}

/**
 * Parse an unlabelled Discord code block into individual lines.
 *
 * @param {unknown} content Potential code-block content.
 * @returns {string[] | null} Parsed lines, or null for unsupported content.
 */
function readCodeBlockLines(content) {
  const text = String(content ?? '');
  if (!text.startsWith('```\n') || !text.endsWith('\n```')) return null;
  return text.slice(4, -4).split('\n');
}

/**
 * Read a verified total Quest count from the Quest Engine status snapshot.
 *
 * @param {object | null} status Quest Engine status snapshot.
 * @returns {number | null} Total Quest count when available.
 */
function readTotalQuestCount(status) {
  if (!status || status.state === 'unknown') return null;
  return Number.isInteger(status.questCount) ? status.questCount : null;
}

/**
 * Consume one Runner status line and update the persistent header state.
 *
 * @param {string} line Runner status line.
 * @param {object} state Persistent state for one Runner message.
 * @param {string[]} activityLines Mutable activity-line collection.
 * @returns {boolean} Whether the line reports that Quest discovery completed.
 */
function consumeRunnerStatusLine(line, state, activityLines) {
  if (line.startsWith('✅ LOGIN : ')) {
    state.loginLine = line;
    return false;
  }
  if (line.startsWith('🤖 AUTO DAILY ENABLED')) {
    state.modeLine = line;
    return false;
  }
  if (/^🔎 .+: พบ \d+ QUESTS$/.test(line)) return true;
  if (line) activityLines.push(line);
  return false;
}

/**
 * Build a Discord code block from pinned headers and visible activity lines.
 *
 * @param {string[]} headerLines Persistent Runner header lines.
 * @param {string[]} activityLines Current visible activity lines.
 * @returns {string} Formatted Discord message content.
 */
function buildRunnerStatusContent(headerLines, activityLines) {
  return `\`\`\`\n${[...headerLines, ...activityLines].join('\n')}\n\`\`\``;
}

/**
 * Reformat Runner status content while keeping login, mode, and Quest total pinned.
 *
 * @param {unknown} content Raw Discord message content.
 * @param {object} state Persistent state scoped to one Runner message.
 * @param {object | null} status Quest Engine status snapshot.
 * @returns {unknown} Original content or formatted Runner status content.
 */
export function formatRunnerStatusContent(content, state = {}, status = null) {
  const lines = readCodeBlockLines(content);
  if (!lines) return content;

  let receivedQuestCount = false;
  const activityLines = [];
  for (const line of lines) {
    receivedQuestCount = consumeRunnerStatusLine(line, state, activityLines)
      || receivedQuestCount;
  }

  if (!state.loginLine) return content;

  // เก็บจำนวน Quest ทั้งหมดเฉพาะตอน Runner ส่งบรรทัดจำนวนของตัวเอง
  // เพื่อไม่ให้ Runner หลาย Token นำสถานะล่าสุดของกันและกันมาเขียนทับระหว่าง Progress update
  if (receivedQuestCount) {
    const totalQuestCount = readTotalQuestCount(status);
    if (totalQuestCount != null) state.totalQuestCount = totalQuestCount;
  }

  const totalText = state.totalQuestCount ?? 'กำลังตรวจสอบ...';
  const headerLines = [
    state.loginLine,
    state.modeLine,
    `🔍 ตรวจพบ Quest ทั้งหมด : ${totalText}`,
    '────────────────────────',
  ].filter(Boolean);

  const visibleActivity = [...activityLines];
  let formatted = buildRunnerStatusContent(headerLines, visibleActivity);

  while (formatted.length > 1950 && visibleActivity.length > 1) {
    visibleActivity.shift();
    formatted = buildRunnerStatusContent(headerLines, visibleActivity);
  }

  return formatted;
}

/**
 * Wrap a Discord message so later edits preserve the Runner headers.
 *
 * @param {object} message Discord message object.
 * @param {object} state Persistent state scoped to the message.
 * @param {Function | null} getStatus Quest Engine status accessor.
 * @returns {object} Original message or wrapped message proxy.
 */
function wrapMessage(message, state, getStatus) {
  if (!message || typeof message.edit !== 'function') return message;

  return new Proxy(message, {
    /** Return a wrapped edit method and bind all other message methods. */
    get(target, property) {
      if (property === 'edit') {
        /** Reformat Runner content before forwarding an edit. */
        return async (payload) => {
          const rawContent = getPayloadContent(payload);
          const status = typeof getStatus === 'function' ? getStatus() : null;
          const content = rawContent == null
            ? rawContent
            : formatRunnerStatusContent(rawContent, state, status);
          const edited = await target.edit(
            rawContent == null ? payload : withPayloadContent(payload, content),
          );
          return wrapMessage(edited, state, getStatus);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap a Discord channel so Runner messages are formatted on send and edit.
 *
 * @param {object} channel Discord channel object.
 * @param {Function | null} getStatus Quest Engine status accessor.
 * @returns {object} Original channel or cached channel proxy.
 */
function wrapChannel(channel, getStatus) {
  if (!channel || typeof channel.send !== 'function') return channel;
  const cached = channelProxies.get(channel);
  if (cached) return cached;

  const proxy = new Proxy(channel, {
    /** Return a wrapped send method and bind all other channel methods. */
    get(target, property) {
      if (property === 'send') {
        /** Format new Runner content before sending it to Discord. */
        return async (payload) => {
          const rawContent = getPayloadContent(payload);
          if (rawContent == null) return target.send(payload);

          const state = {};
          const status = typeof getStatus === 'function' ? getStatus() : null;
          const content = formatRunnerStatusContent(rawContent, state, status);
          const message = await target.send(withPayloadContent(payload, content));
          return state.loginLine ? wrapMessage(message, state, getStatus) : message;
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  channelProxies.set(channel, proxy);
  return proxy;
}

/**
 * Install persistent Runner status formatting on Discord channel fetches once.
 *
 * @param {object} client Discord client instance.
 * @param {Function | null} getStatus Quest Engine status accessor.
 * @returns {boolean} True when installed, false when unavailable or already installed.
 */
export function installPersistentRunnerStatusHeaders(client, getStatus = null) {
  if (!client?.channels?.fetch || client[INSTALL_KEY]) return false;

  const originalFetch = client.channels.fetch.bind(client.channels);
  client.channels.fetch = async (...args) => wrapChannel(await originalFetch(...args), getStatus);
  Object.defineProperty(client, INSTALL_KEY, { value: true });
  return true;
}

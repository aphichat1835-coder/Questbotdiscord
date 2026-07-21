const INSTALL_KEY = Symbol.for('neverdie.runnerStatusHeadersInstalled');
const channelProxies = new WeakMap();

function getPayloadContent(payload) {
  return typeof payload === 'string' ? payload : payload?.content;
}

function withPayloadContent(payload, content) {
  return typeof payload === 'string' ? content : { ...payload, content };
}

function readCodeBlockLines(content) {
  const text = String(content ?? '');
  if (!text.startsWith('```\n') || !text.endsWith('\n```')) return null;
  return text.slice(4, -4).split('\n');
}

function readTotalQuestCount(status) {
  if (!status || status.state === 'unknown') return null;
  return Number.isInteger(status.questCount) ? status.questCount : null;
}

export function formatRunnerStatusContent(content, state = {}, status = null) {
  const lines = readCodeBlockLines(content);
  if (!lines) return content;

  let receivedQuestCount = false;
  const activityLines = [];
  for (const line of lines) {
    if (line.startsWith('✅ LOGIN : ')) {
      state.loginLine = line;
      continue;
    }
    if (line.startsWith('🤖 AUTO DAILY ENABLED')) {
      state.modeLine = line;
      continue;
    }
    if (/^🔎 .+: พบ \d+ QUESTS$/.test(line)) {
      receivedQuestCount = true;
      continue;
    }
    if (line) activityLines.push(line);
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
  const buildContent = () => `\`\`\`\n${[...headerLines, ...visibleActivity].join('\n')}\n\`\`\``;
  let formatted = buildContent();

  while (formatted.length > 1950 && visibleActivity.length > 1) {
    visibleActivity.shift();
    formatted = buildContent();
  }

  return formatted;
}

function wrapMessage(message, state, getStatus) {
  if (!message || typeof message.edit !== 'function') return message;

  return new Proxy(message, {
    get(target, property) {
      if (property === 'edit') {
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

function wrapChannel(channel, getStatus) {
  if (!channel || typeof channel.send !== 'function') return channel;
  const cached = channelProxies.get(channel);
  if (cached) return cached;

  const proxy = new Proxy(channel, {
    get(target, property) {
      if (property === 'send') {
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

export function installPersistentRunnerStatusHeaders(client, getStatus = null) {
  if (!client?.channels?.fetch || client[INSTALL_KEY]) return false;

  const originalFetch = client.channels.fetch.bind(client.channels);
  client.channels.fetch = async (...args) => wrapChannel(await originalFetch(...args), getStatus);
  Object.defineProperty(client, INSTALL_KEY, { value: true });
  return true;
}

const VIDEO_EVENTS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);
const DESKTOP_EVENTS = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
const UNSUPPORTED_EVENTS = new Set([
  'STREAM_ON_DESKTOP',
  'ACHIEVEMENT_IN_GAME',
  'ACHIEVEMENT_IN_ACTIVITY',
  'PLAY_ACTIVITY',
  'PLAY_ON_XBOX',
  'PLAY_ON_PLAYSTATION',
  'progress',
]);

function videoMatches(eventName) {
  return VIDEO_EVENTS.has(eventName) || /^WATCH_VIDEO(?:_|$)/.test(eventName);
}

function desktopMatches(eventName) {
  return DESKTOP_EVENTS.has(eventName) || /^PLAY_ON_DESKTOP(?:_V\d+)?$/.test(eventName);
}

export const QUEST_EXECUTORS = Object.freeze([
  Object.freeze({
    id: 'video',
    matches: videoMatches,
    supportsAutomaticProgress: true,
    mutation: 'video-progress',
  }),
  Object.freeze({
    id: 'desktop',
    matches: desktopMatches,
    supportsAutomaticProgress: true,
    mutation: 'heartbeat',
  }),
  Object.freeze({
    id: 'unsupported',
    matches: (eventName) => UNSUPPORTED_EVENTS.has(eventName),
    supportsAutomaticProgress: false,
    mutation: null,
  }),
]);

export function selectQuestExecutor(eventName) {
  return QUEST_EXECUTORS.find((executor) => executor.matches(eventName)) ?? Object.freeze({
    id: 'unknown',
    matches: () => false,
    supportsAutomaticProgress: false,
    mutation: null,
  });
}

export function isAutomaticallySupportedEvent(eventName) {
  return selectQuestExecutor(eventName).supportsAutomaticProgress;
}

export function listQuestExecutorCapabilities() {
  return QUEST_EXECUTORS.map(({ id, supportsAutomaticProgress, mutation }) => ({
    id,
    supportsAutomaticProgress,
    mutation,
  }));
}

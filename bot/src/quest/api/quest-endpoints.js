export const QUEST_LIST_PATHS = Object.freeze([
  '/quests/@me',
  '/users/@me/quests',
]);

const claimPath = (questId) => `/quests/${questId}/claim`;

export const QUEST_ENDPOINT = Object.freeze({
  me: () => '/users/@me',
  enroll: (questId) => `/quests/${questId}/enroll`,
  videoProgress: (questId) => `/quests/${questId}/video-progress`,
  heartbeat: (questId) => `/quests/${questId}/heartbeat`,
  claimReward: (questId) => `/quests/${questId}/claim-reward`,
  claim: claimPath,
  claimLegacy: claimPath,
});

export const FATAL_FORBIDDEN_PATHS = new Set([
  QUEST_ENDPOINT.me(),
  ...QUEST_LIST_PATHS,
]);

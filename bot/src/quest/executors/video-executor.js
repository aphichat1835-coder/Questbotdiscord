import { defineQuestExecutor } from './contract.js';

const VIDEO_EVENTS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);

export function matchesVideoQuest(value) {
  const eventName = typeof value === 'string' ? value : value?.eventName;
  return VIDEO_EVENTS.has(eventName) || /^WATCH_VIDEO(?:_|$)/.test(String(eventName ?? ''));
}

export const videoQuestExecutor = defineQuestExecutor({
  id: 'video',
  supportsAutomaticProgress: true,
  mutation: 'video-progress',
  matches: matchesVideoQuest,
  validate(quest) {
    const issues = [];
    if (!quest?.id) issues.push('video Quest is missing id');
    if (!Number.isFinite(Number(quest?.secondsNeeded)) || Number(quest.secondsNeeded) <= 0) {
      issues.push('video Quest has an invalid target');
    }
    return { ok: issues.length === 0, issues };
  },
  estimateDuration(quest) {
    const remaining = Math.max(0, Number(quest?.secondsNeeded ?? 0) - Number(quest?.progressSecs ?? 0));
    return remaining * 1000;
  },
  execute(context) {
    if (typeof context?.executeVideo !== 'function') {
      throw new TypeError('Video executor requires context.executeVideo()');
    }
    return context.executeVideo(context.quest, context);
  },
  verify(context, result) {
    if (typeof context?.verifyCompletion === 'function') {
      return context.verifyCompletion(context.quest, result, context);
    }
    return Boolean(result?.completed ?? result);
  },
  describeUnsupportedReason() {
    return null;
  },
});

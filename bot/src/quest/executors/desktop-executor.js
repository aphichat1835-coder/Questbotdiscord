import { defineQuestExecutor } from './contract.js';

const DESKTOP_EVENTS = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);

export function matchesDesktopQuest(value) {
  const eventName = typeof value === 'string' ? value : value?.eventName;
  return DESKTOP_EVENTS.has(eventName) || /^PLAY_ON_DESKTOP(?:_V\d+)?$/.test(String(eventName ?? ''));
}

export const desktopQuestExecutor = defineQuestExecutor({
  id: 'desktop',
  supportsAutomaticProgress: true,
  mutation: 'heartbeat',
  matches: matchesDesktopQuest,
  validate(quest) {
    const issues = [];
    if (!quest?.id) issues.push('desktop Quest is missing id');
    if (!Number.isFinite(Number(quest?.secondsNeeded)) || Number(quest.secondsNeeded) <= 0) {
      issues.push('desktop Quest has an invalid target');
    }
    return { ok: issues.length === 0, issues };
  },
  estimateDuration(quest) {
    const remaining = Math.max(0, Number(quest?.secondsNeeded ?? 0) - Number(quest?.progressSecs ?? 0));
    return remaining * 1000;
  },
  execute(context) {
    if (typeof context?.executeDesktop !== 'function') {
      throw new TypeError('Desktop executor requires context.executeDesktop()');
    }
    return context.executeDesktop(context.quest, context);
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

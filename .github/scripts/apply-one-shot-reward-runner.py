from pathlib import Path

runner_path = Path('bot/src/discord-runner.js')
source = runner_path.read_text(encoding='utf-8')

replacements = [
    (
        """  ONE_SHOT_QUEST_STATUS,\n  recordOneShotVerifiedProgress,\n} from './one-shot-quest-session.js';""",
        """  ONE_SHOT_QUEST_STATUS,\n  recordOneShotRewardClaim,\n  recordOneShotVerifiedProgress,\n} from './one-shot-quest-session.js';""",
    ),
    (
        """  async function reportOneShotTerminalState() {\n    const summary = oneShotSummary();\n    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);\n    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);\n    addLog('🧹 QUEST ACTIVITY CLEARED');\n    await flush();\n    return summary;\n  }""",
        """  async function reportOneShotTerminalState() {\n    const summary = oneShotSummary();\n    const completedCount = summary.completedByBotCount + summary.completedExternalCount;\n    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);\n    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);\n    if (completedCount > 0) {\n      addLog(`🎁 ${username}: รับรางวัลสำเร็จ ${summary.claimedRewardCount}/${completedCount} QUESTS`);\n    }\n    addLog('🧹 QUEST ACTIVITY CLEARED');\n    await flush();\n    return summary;\n  }""",
    ),
    (
        """  async function reportOneShotExternalCompletion(quest) {\n    if (mode !== 'oneshot') return null;\n    completeOneShotQuest(oneShotSession, quest.id);\n    await reportOneShotTerminalState();\n    return oneShotOutcome();\n  }\n\n  async function reportOneShotBotCompletion(quest) {\n    if (mode !== 'oneshot') return null;\n    const status = completeOneShotQuest(oneShotSession, quest.id);\n    if (status !== ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT) {\n      return reportOneShotExternalCompletion(quest);\n    }\n    await reportOneShotTerminalState();\n    return oneShotOutcome();\n  }""",
        """  async function completeAndClaimOneShotQuest(quest) {\n    const status = completeOneShotQuest(oneShotSession, quest.id);\n    const claimed = await claimSilently(quest);\n    recordOneShotRewardClaim(oneShotSession, quest.id, { claimed });\n    return status;\n  }\n\n  async function reportOneShotExternalCompletion() {\n    if (mode !== 'oneshot') return null;\n    await reportOneShotTerminalState();\n    return oneShotOutcome();\n  }\n\n  async function reportOneShotBotCompletion() {\n    if (mode !== 'oneshot') return null;\n    await reportOneShotTerminalState();\n    return oneShotOutcome();\n  }""",
    ),
    (
        """    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);\n    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);\n    addLog('🧹 QUEST ACTIVITY CLEARED');\n\n    if (summary.totalSupportedQuests === 0) {""",
        """    const completedCount = summary.completedByBotCount + summary.completedExternalCount;\n    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);\n    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);\n    if (completedCount > 0) {\n      addLog(`🎁 ${username}: รับรางวัลสำเร็จ ${summary.claimedRewardCount}/${completedCount} QUESTS`);\n    }\n    addLog('🧹 QUEST ACTIVITY CLEARED');\n\n    if (summary.totalSupportedQuests === 0) {""",
    ),
    (
        """    if (summary.issues.length === 0\n        && summary.completedByBotCount === summary.totalSupportedQuests) {\n      addLog('🎉 บอทได้เข้าไปทำ Quest ทั้งหมดเสร็จสิ้นทั้งหมดแล้ว');\n      await flush();\n      return;\n    }\n\n    addLog(summary.completedByBotCount === 0\n      ? '❌ บอทไม่สามารถดำเนินการ Quest ให้สำเร็จได้'\n      : '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ');""",
        """    if (summary.issues.length === 0\n        && summary.claimPendingCount === 0\n        && summary.completedByBotCount === summary.totalSupportedQuests) {\n      addLog('🎉 บอทได้เข้าไปทำ Quest และรับรางวัลทั้งหมดเสร็จสิ้นแล้ว');\n      await flush();\n      return;\n    }\n\n    if (summary.completedByBotCount === summary.totalSupportedQuests\n        && summary.claimPendingCount > 0) {\n      addLog('⚠️ Quest เสร็จแล้ว แต่มีรางวัลที่ยังรับไม่สำเร็จ');\n    } else {\n      addLog(summary.completedByBotCount === 0\n        ? '❌ บอทไม่สามารถดำเนินการ Quest ให้สำเร็จได้'\n        : '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ');\n    }""",
    ),
    (
        """    if (quest.completed) {\n      if (mode === 'oneshot') {\n        await claimSilently(quest);\n        return reportOneShotExternalCompletion(quest);\n      }\n      return idleQuestOutcome(selection.runnable.length);\n    }""",
        """    if (quest.completed) {\n      if (mode === 'oneshot') {\n        const status = await completeAndClaimOneShotQuest(quest);\n        return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT\n          ? reportOneShotBotCompletion()\n          : reportOneShotExternalCompletion();\n      }\n      return idleQuestOutcome(selection.runnable.length);\n    }""",
    ),
    (
        """    if (mode === 'oneshot') {\n      const status = completeOneShotQuest(oneShotSession, fresh.id);\n      await claimSilently(fresh);\n      return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT\n        ? reportOneShotBotCompletion(fresh)\n        : reportOneShotExternalCompletion(fresh);\n    }""",
        """    if (mode === 'oneshot') {\n      const status = await completeAndClaimOneShotQuest(fresh);\n      return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT\n        ? reportOneShotBotCompletion()\n        : reportOneShotExternalCompletion();\n    }""",
    ),
]

for old, new in replacements:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'expected one runner match, found {count}: {old[:80]!r}')
    source = source.replace(old, new, 1)

runner_path.write_text(source, encoding='utf-8')

ci_path = Path('.github/workflows/ci.yml')
ci = ci_path.read_text(encoding='utf-8')
export_line = '            bot/src/discord-runner.js\n'
if ci.count(export_line) != 1:
    raise SystemExit('temporary CI runner export line was not found exactly once')
ci_path.write_text(ci.replace(export_line, '', 1), encoding='utf-8')

for temporary in [
    Path('.github/workflows/export-runner-source.yml'),
    Path('.github/workflows/apply-one-shot-reward-runner.yml'),
    Path('.github/scripts/apply-one-shot-reward-runner.py'),
]:
    temporary.unlink(missing_ok=True)

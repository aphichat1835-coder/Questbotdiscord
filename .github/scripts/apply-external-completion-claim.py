from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


runner_path = Path('bot/src/discord-runner.js')
runner = runner_path.read_text()
runner = replace_once(
    runner,
    """    if (quest.completed) {
      if (mode === 'oneshot') return reportOneShotExternalCompletion(quest);
      return { attempted: false, progressed: false, supportedCount: runnable.length };
    }
""",
    """    if (quest.completed) {
      if (mode === 'oneshot') {
        await claimSilently(quest);
        return reportOneShotExternalCompletion(quest);
      }
      return { attempted: false, progressed: false, supportedCount: runnable.length };
    }
""",
    'fresh external completion claim',
)
runner = replace_once(
    runner,
    """    if (mode === 'oneshot') {
      const status = completeOneShotQuest(oneShotSession, fresh.id);
      if (status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT) {
        await claimSilently(fresh);
        return reportOneShotBotCompletion(fresh);
      }
      return reportOneShotExternalCompletion(fresh);
    }
""",
    """    if (mode === 'oneshot') {
      const status = completeOneShotQuest(oneShotSession, fresh.id);
      await claimSilently(fresh);
      if (status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT) {
        return reportOneShotBotCompletion(fresh);
      }
      return reportOneShotExternalCompletion(fresh);
    }
""",
    'completed manifest quest claim',
)
runner_path.write_text(runner)


test_path = Path('bot/test/runner-modes.node-test.js')
tests = test_path.read_text()
tests = replace_once(
    tests,
    "  assert.deepEqual(requests, ['progress:bot-a', 'claim:bot-a']);",
    "  assert.deepEqual(requests, ['progress:bot-a', 'claim:bot-a', 'claim:external-b']);\n  assert.equal(states.get('external-b').claimed, true);",
    'external completion claim expectation',
)
test_path.write_text(tests)

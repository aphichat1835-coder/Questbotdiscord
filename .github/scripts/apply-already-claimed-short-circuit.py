from pathlib import Path

path = Path('bot/src/discord-runner.js')
source = path.read_text(encoding='utf-8')
old = """  async function claimSilently(quest) {
    const retryAt = Math.max("""
new = """  async function claimSilently(quest) {
    if (quest.claimed) {
      claimRetryAt.delete(quest.id);
      recordQuestVerification(currentQuestStatusContext().key, 'claim', currentQuestStatusContext());
      transitionCurrentRunner(RUNNER_STATE.RUNNING, {
        questId: quest.id,
        questName: quest.name,
        questEvent: quest.eventName,
        progress: 100,
        serverProgressSeconds: quest.progressSecs,
      });
      return true;
    }

    const retryAt = Math.max("""

if source.count(old) != 1:
    raise SystemExit(f'expected one claimSilently anchor, found {source.count(old)}')

path.write_text(source.replace(old, new, 1), encoding='utf-8')
Path('.github/scripts/apply-already-claimed-short-circuit.py').unlink(missing_ok=True)
Path('.github/workflows/apply-already-claimed-short-circuit.yml').unlink(missing_ok=True)

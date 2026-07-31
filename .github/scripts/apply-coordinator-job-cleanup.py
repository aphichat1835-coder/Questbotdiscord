from pathlib import Path

coordinator_path = Path('bot/src/quest/rate-limit-coordinator.js')
coordinator = coordinator_path.read_text(encoding='utf-8')
old_snapshot = """  snapshot() {
    const circuits = [...this.circuits.values()];"""
new_snapshot = """  releaseJob(jobKey) {
    if (typeof jobKey !== 'string' || jobKey.length === 0) return false;
    return this.blockedMutationJobs.delete(jobKey);
  }

  snapshot() {
    const circuits = [...this.circuits.values()];"""
if coordinator.count(old_snapshot) != 1:
    raise SystemExit(f'coordinator snapshot anchor count: {coordinator.count(old_snapshot)}')
coordinator_path.write_text(coordinator.replace(old_snapshot, new_snapshot, 1), encoding='utf-8')

observer_path = Path('bot/src/quest/runner-completion-observer.js')
observer = observer_path.read_text(encoding='utf-8')
old_import = "import { transientRetryDelayMs } from '../runner-schedule.js';"
new_import = """import { transientRetryDelayMs } from '../runner-schedule.js';
import { discordRateLimitCoordinator } from './rate-limit-coordinator.js';"""
if observer.count(old_import) != 1:
    raise SystemExit(f'completion observer import anchor count: {observer.count(old_import)}')
observer = observer.replace(old_import, new_import, 1)
old_finally = """    .finally(() => observedCompletions.delete(jobKey))
    .catch((error) => reportSafely(error, jobKey));"""
new_finally = """    .finally(() => {
      discordRateLimitCoordinator.releaseJob(jobKey);
      observedCompletions.delete(jobKey);
    })
    .catch((error) => reportSafely(error, jobKey));"""
if observer.count(old_finally) != 1:
    raise SystemExit(f'completion observer finally anchor count: {observer.count(old_finally)}')
observer_path.write_text(observer.replace(old_finally, new_finally, 1), encoding='utf-8')

Path('.github/scripts/apply-coordinator-job-cleanup.py').unlink(missing_ok=True)
Path('.github/workflows/apply-coordinator-job-cleanup.yml').unlink(missing_ok=True)

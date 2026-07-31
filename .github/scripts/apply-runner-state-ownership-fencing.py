from pathlib import Path

runner_path = Path('bot/src/discord-runner.js')
runner = runner_path.read_text(encoding='utf-8')

old_import = "import { currentRunnerExecutionContext } from './quest/runner-execution-context.js';"
new_import = """import { currentRunnerExecutionContext } from './quest/runner-execution-context.js';
import { assertRunnerMutationOwnership } from './quest/runner-ownership-guard.js';"""
if runner.count(old_import) != 1:
    raise SystemExit(f'runner ownership import anchor count: {runner.count(old_import)}')
runner = runner.replace(old_import, new_import, 1)

old_transition = """function transitionCurrentRunner(state, values = {}, { preserveMutation = false } = {}) {
  const jobKey = currentRunnerExecutionContext()?.jobKey
    ?? currentQuestStatusContext().jobKey;
  if (!jobKey) return null;
  try {
    const current = getRunnerState(jobKey);"""
new_transition = """function transitionCurrentRunner(state, values = {}, { preserveMutation = false } = {}) {
  const executionContext = currentRunnerExecutionContext();
  const jobKey = executionContext?.jobKey ?? currentQuestStatusContext().jobKey;
  if (!jobKey) return null;
  try {
    if (executionContext?.workerHolder) assertRunnerMutationOwnership(jobKey);
    const current = getRunnerState(jobKey);"""
if runner.count(old_transition) != 1:
    raise SystemExit(f'runner transition anchor count: {runner.count(old_transition)}')
runner = runner.replace(old_transition, new_transition, 1)

old_catch = """  } catch (error) {
    console.warn(`[RunnerState:${jobKey}] direct transition failed — ${error?.message ?? 'unknown error'}`);
    return null;
  }
}"""
new_catch = """  } catch (error) {
    if (isTerminalRunnerError(error)) throw error;
    console.warn(`[RunnerState:${jobKey}] direct transition failed — ${error?.message ?? 'unknown error'}`);
    return null;
  }
}"""
if runner.count(old_catch) != 1:
    raise SystemExit(f'runner transition catch anchor count: {runner.count(old_catch)}')
runner = runner.replace(old_catch, new_catch, 1)
runner_path.write_text(runner, encoding='utf-8')

observer_path = Path('bot/src/quest/runner-state-observer.js')
observer = observer_path.read_text(encoding='utf-8')
old_observer_import = "import { stateScheduleReason } from './smart-scheduler.js';"
new_observer_import = """import { resolveRunnerExecutionContext } from './runner-execution-context.js';
import { assertRunnerMutationOwnership } from './runner-ownership-guard.js';
import { stateScheduleReason } from './smart-scheduler.js';"""
if observer.count(old_observer_import) != 1:
    raise SystemExit(f'observer import anchor count: {observer.count(old_observer_import)}')
observer = observer.replace(old_observer_import, new_observer_import, 1)

old_sync = """export function syncRunnerState(job) {
  let current = getRunnerState(job.key);"""
new_sync = """export function syncRunnerState(job) {
  const executionContext = resolveRunnerExecutionContext(job.key);
  if (executionContext?.workerHolder) assertRunnerMutationOwnership(job.key);
  let current = getRunnerState(job.key);"""
if observer.count(old_sync) != 1:
    raise SystemExit(f'observer sync anchor count: {observer.count(old_sync)}')
observer = observer.replace(old_sync, new_sync, 1)
observer_path.write_text(observer, encoding='utf-8')

Path('.github/scripts/apply-runner-state-ownership-fencing.py').unlink(missing_ok=True)
Path('.github/workflows/apply-runner-state-ownership-fencing.yml').unlink(missing_ok=True)

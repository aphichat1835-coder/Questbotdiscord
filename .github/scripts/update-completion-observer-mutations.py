from pathlib import Path

path = Path('bot/scripts/mutation-safety.sh')
source = path.read_text(encoding='utf-8')
old = r'''cp -- src/quest/runner-completion-observer.js "$tmp_dir/runner-completion-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-observer.js')
source = path.read_text(encoding='utf-8')
old = """  void Promise.resolve(job.done)
    .then(
      () => runObserverHandler(jobKey, () => handleResolved(jobKey, mode, scheduleId)),
      (error) => runObserverHandler(jobKey, () => handleRejected(jobKey, error)),
    )
    .finally(() => observedCompletions.delete(jobKey))
    .catch((error) => reportSafely(error, jobKey));"""
new = """  void Promise.resolve(job.done)
    .then(
      () => handleResolved(jobKey, mode, scheduleId),
      (error) => handleRejected(jobKey, error),
    )
    .finally(() => observedCompletions.delete(jobKey));"""
if source.count(old) < 1:
    raise SystemExit('mutation target not found: completion observer containment')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-completion-observer.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-completion-observer.js" src/quest/runner-completion-observer.js
rm -- "$tmp_dir/runner-completion-observer.js"
record_result 'completion observer transition failure escapes its promise chain' "$status"

if [[ "$survived" -gt 0 ]]; then
  echo "$survived critical mutation(s) survived" >&2
  exit 1
fi

echo 'All 14 critical mutations were killed'
'''
new = r'''cp -- src/quest/runner-completion-observer.js "$tmp_dir/runner-completion-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-observer.js')
source = path.read_text(encoding='utf-8')
old = """  void Promise.resolve(job.done)
    .then(
      () => runObserverHandler(jobKey, () => handleResolved(jobKey, mode, scheduleId)),
      (error) => runObserverHandler(jobKey, () => handleRejected(jobKey, error)),
    )
    .finally(() => {
      discordRateLimitCoordinator.releaseJob(jobKey);
      observedCompletions.delete(jobKey);
    })
    .catch((error) => reportSafely(error, jobKey));"""
new = """  void Promise.resolve(job.done)
    .then(
      () => handleResolved(jobKey, mode, scheduleId),
      (error) => handleRejected(jobKey, error),
    )
    .finally(() => {
      discordRateLimitCoordinator.releaseJob(jobKey);
      observedCompletions.delete(jobKey);
    });"""
if source.count(old) != 1:
    raise SystemExit('mutation target not found: completion observer containment')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-completion-observer.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-completion-observer.js" src/quest/runner-completion-observer.js
rm -- "$tmp_dir/runner-completion-observer.js"
record_result 'completion observer transition failure escapes its promise chain' "$status"

cp -- src/quest/runner-completion-observer.js "$tmp_dir/runner-completion-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-observer.js')
source = path.read_text(encoding='utf-8')
old = '      discordRateLimitCoordinator.releaseJob(jobKey);'
new = '      void jobKey;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: completed coordinator job cleanup')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/coordinator-job-cleanup.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-completion-observer.js" src/quest/runner-completion-observer.js
rm -- "$tmp_dir/runner-completion-observer.js"
record_result 'completed runner leaves its coordinator mutation lock active' "$status"

if [[ "$survived" -gt 0 ]]; then
  echo "$survived critical mutation(s) survived" >&2
  exit 1
fi

echo 'All 15 critical mutations were killed'
'''

if source.count(old) != 1:
    raise SystemExit(f'expected one legacy completion mutation block, found {source.count(old)}')

path.write_text(source.replace(old, new, 1), encoding='utf-8')
Path('.github/scripts/update-completion-observer-mutations.py').unlink(missing_ok=True)
Path('.github/workflows/update-completion-observer-mutations.yml').unlink(missing_ok=True)

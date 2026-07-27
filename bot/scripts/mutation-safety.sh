#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp_dir="$(mktemp -d)"
survived=0

cleanup() {
  [[ ! -f "$tmp_dir/mutation-retry.js" ]] || cp -- "$tmp_dir/mutation-retry.js" src/mutation-retry.js
  [[ ! -f "$tmp_dir/smart-scheduler.js" ]] || cp -- "$tmp_dir/smart-scheduler.js" src/quest/smart-scheduler.js
  [[ ! -f "$tmp_dir/recovery-planner.js" ]] || cp -- "$tmp_dir/recovery-planner.js" src/quest/recovery-planner.js
  [[ ! -f "$tmp_dir/registry.js" ]] || cp -- "$tmp_dir/registry.js" src/quest/executors/registry.js
  [[ ! -f "$tmp_dir/runner-state-store.js" ]] || cp -- "$tmp_dir/runner-state-store.js" src/quest/runner-state-store.js
  [[ ! -f "$tmp_dir/rate-limit-coordinator.js" ]] || cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

record_result() {
  local name="$1"
  local status="$2"
  if [[ "$status" -eq 0 ]]; then
    survived=$((survived + 1))
    echo "SURVIVED: $name" >&2
    cat -- "$tmp_dir/test-output.log" >&2
  else
    echo "KILLED: $name"
  fi
}

cp -- src/mutation-retry.js "$tmp_dir/mutation-retry.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/mutation-retry.js')
source = path.read_text(encoding='utf-8')
old = 'if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };'
new = 'if (false) return { verifiedAfterFailure: true };'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: uncertain verification')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-fault-injection.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/mutation-retry.js" src/mutation-retry.js
rm -- "$tmp_dir/mutation-retry.js"
record_result 'uncertain mutation skips fresh verification' "$status"

cp -- src/quest/smart-scheduler.js "$tmp_dir/smart-scheduler.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/smart-scheduler.js')
source = path.read_text(encoding='utf-8')
old = '&& expiresAt > now'
new = '&& expiresAt <= now'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: deadline comparison')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/smart-scheduler.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/smart-scheduler.js" src/quest/smart-scheduler.js
rm -- "$tmp_dir/smart-scheduler.js"
record_result 'expired Quest becomes deadline eligible' "$status"

cp -- src/quest/recovery-planner.js "$tmp_dir/recovery-planner.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/recovery-planner.js')
source = path.read_text(encoding='utf-8')
old = '&& MUTATION_RECOVERY_STATUSES.has(state.mutation_status)'
new = '&& false'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: recovery checkpoint')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-recovery-planner.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/recovery-planner.js" src/quest/recovery-planner.js
rm -- "$tmp_dir/recovery-planner.js"
record_result 'recovery ignores uncertain mutation checkpoint' "$status"

cp -- src/quest/executors/registry.js "$tmp_dir/registry.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/executors/registry.js')
source = path.read_text(encoding='utf-8')
old = 'if (quest?.autoSupported === false) return unsupportedQuestExecutor;'
new = 'if (false) return unsupportedQuestExecutor;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: multi-task AND')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-executor-contract.node-test.js \
  test/quest-schema-modules.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/registry.js" src/quest/executors/registry.js
rm -- "$tmp_dir/registry.js"
record_result 'multi-task AND is accepted by automatic executor' "$status"

cp -- src/quest/runner-state-store.js "$tmp_dir/runner-state-store.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-state-store.js')
source = path.read_text(encoding='utf-8')
old = 'if (Object.hasOwn(options, optionName)) return options[optionName];'
new = 'if (false) return options[optionName];'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: explicit checkpoint update')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-state-store.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-state-store.js" src/quest/runner-state-store.js
rm -- "$tmp_dir/runner-state-store.js"
record_result 'explicit checkpoint updates are ignored' "$status"

cp -- src/quest/rate-limit-coordinator.js "$tmp_dir/rate-limit-coordinator.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/rate-limit-coordinator.js')
source = path.read_text(encoding='utf-8')
old = 'return this.accountBucketResetAt.get(`${task.account}:${bucket}`) ?? 0;'
new = 'return 0;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: user-scoped bucket')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-coordinator-hardening.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
rm -- "$tmp_dir/rate-limit-coordinator.js"
record_result 'user-scoped bucket block is bypassed' "$status"

if [[ "$survived" -gt 0 ]]; then
  echo "$survived critical mutation(s) survived" >&2
  exit 1
fi

echo 'All 6 critical mutations were killed'

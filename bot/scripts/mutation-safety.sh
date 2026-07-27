#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp_dir="$(mktemp -d)"
current_target=''
current_backup=''
survived=0

restore_current() {
  if [[ -n "$current_target" && -n "$current_backup" && -f "$current_backup" ]]; then
    cp -- "$current_backup" "$current_target"
  fi
  current_target=''
  current_backup=''
}

cleanup() {
  restore_current
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

replace_occurrence() {
  local target="$1"
  local from="$2"
  local to="$3"
  local occurrence="$4"

  python3 - "$target" "$from" "$to" "$occurrence" <<'PY'
from pathlib import Path
import sys

target = Path(sys.argv[1]).resolve()
root = Path.cwd().resolve()
if target == root or root not in target.parents:
    raise SystemExit(f'mutation target escapes bot root: {target}')

source = target.read_text(encoding='utf-8')
old = sys.argv[2]
new = sys.argv[3]
occurrence = int(sys.argv[4])
start = 0
index = -1
for _ in range(occurrence + 1):
    index = source.find(old, start)
    if index < 0:
        raise SystemExit(f'mutation target not found in {target}: {old}')
    start = index + len(old)

target.write_text(source[:index] + new + source[index + len(old):], encoding='utf-8')
PY
}

run_mutant() {
  local name="$1"
  local target="$2"
  local from="$3"
  local to="$4"
  local occurrence="$5"
  shift 5

  current_target="$target"
  current_backup="$tmp_dir/$(basename "$target").original"
  cp -- "$current_target" "$current_backup"
  replace_occurrence "$current_target" "$from" "$to" "$occurrence"

  set +e
  node --import ./test/setup-env.js --test --test-concurrency=1 "$@" \
    >"$tmp_dir/test-output.log" 2>&1
  local status=$?
  set -e

  restore_current
  if [[ $status -eq 0 ]]; then
    survived=$((survived + 1))
    echo "SURVIVED: $name" >&2
    cat "$tmp_dir/test-output.log" >&2
  else
    echo "KILLED: $name"
  fi
}

run_mutant \
  'uncertain mutation skips fresh verification' \
  'src/mutation-retry.js' \
  'if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };' \
  'if (false) return { verifiedAfterFailure: true };' \
  0 \
  'test/quest-fault-injection.node-test.js'

run_mutant \
  'expired Quest becomes deadline eligible' \
  'src/quest/smart-scheduler.js' \
  '&& expiresAt > now' \
  '&& expiresAt <= now' \
  0 \
  'test/smart-scheduler.node-test.js'

run_mutant \
  'recovery ignores uncertain mutation checkpoint' \
  'src/quest/recovery-planner.js' \
  '&& MUTATION_RECOVERY_STATUSES.has(state.mutation_status)' \
  '&& false' \
  0 \
  'test/runner-recovery-planner.node-test.js'

run_mutant \
  'multi-task AND is accepted by automatic executor' \
  'src/quest/executors/registry.js' \
  'if (quest?.autoSupported === false) return unsupportedQuestExecutor;' \
  'if (false) return unsupportedQuestExecutor;' \
  0 \
  'test/quest-executor-contract.node-test.js' \
  'test/quest-schema-modules.node-test.js'

run_mutant \
  'explicit checkpoint updates are ignored' \
  'src/quest/runner-state-store.js' \
  'if (Object.hasOwn(options, optionName)) return options[optionName];' \
  'if (false) return options[optionName];' \
  0 \
  'test/runner-state-store.node-test.js'

run_mutant \
  'user-scoped bucket block is bypassed' \
  'src/quest/rate-limit-coordinator.js' \
  'return this.accountBucketResetAt.get(`${task.account}:${bucket}`) ?? 0;' \
  'return 0;' \
  0 \
  'test/quest-coordinator-hardening.node-test.js'

if [[ $survived -gt 0 ]]; then
  echo "$survived critical mutation(s) survived" >&2
  exit 1
fi

echo 'All 6 critical mutations were killed'

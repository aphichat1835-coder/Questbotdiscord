import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const botRoot = fileURLToPath(new URL('..', import.meta.url));
const setup = './test/setup-env.js';

const MUTATION_RETRY_FILE = new URL('../src/mutation-retry.js', import.meta.url);
const SMART_SCHEDULER_FILE = new URL('../src/quest/smart-scheduler.js', import.meta.url);
const RECOVERY_PLANNER_FILE = new URL('../src/quest/recovery-planner.js', import.meta.url);
const EXECUTOR_REGISTRY_FILE = new URL('../src/quest/executors/registry.js', import.meta.url);
const RUNNER_STATE_STORE_FILE = new URL('../src/quest/runner-state-store.js', import.meta.url);
const RATE_LIMIT_COORDINATOR_FILE = new URL('../src/quest/rate-limit-coordinator.js', import.meta.url);

const mutants = Object.freeze([
  {
    name: 'uncertain mutation skips fresh verification',
    file: MUTATION_RETRY_FILE,
    from: 'if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };',
    to: 'if (false) return { verifiedAfterFailure: true };',
    occurrence: 0,
    tests: ['test/quest-fault-injection.node-test.js'],
  },
  {
    name: 'expired Quest becomes deadline eligible',
    file: SMART_SCHEDULER_FILE,
    from: '&& expiresAt > now',
    to: '&& expiresAt <= now',
    tests: ['test/smart-scheduler.node-test.js'],
  },
  {
    name: 'recovery ignores uncertain mutation checkpoint',
    file: RECOVERY_PLANNER_FILE,
    from: '&& MUTATION_RECOVERY_STATUSES.has(state.mutation_status)',
    to: '&& false',
    tests: ['test/runner-recovery-planner.node-test.js'],
  },
  {
    name: 'multi-task AND is accepted by automatic executor',
    file: EXECUTOR_REGISTRY_FILE,
    from: "if (quest?.autoSupported === false) return unsupportedQuestExecutor;",
    to: 'if (false) return unsupportedQuestExecutor;',
    tests: [
      'test/quest-executor-contract.node-test.js',
      'test/quest-schema-modules.node-test.js',
    ],
  },
  {
    name: 'explicit checkpoint updates are ignored',
    file: RUNNER_STATE_STORE_FILE,
    from: 'if (Object.hasOwn(options, optionName)) return options[optionName];',
    to: 'if (false) return options[optionName];',
    tests: ['test/runner-state-store.node-test.js'],
  },
  {
    name: 'user-scoped bucket block is bypassed',
    file: RATE_LIMIT_COORDINATOR_FILE,
    from: "return this.accountBucketResetAt.get(`${task.account}:${bucket}`) ?? 0;",
    to: 'return 0;',
    tests: ['test/quest-coordinator-hardening.node-test.js'],
  },
]);

function replaceOccurrence(source, from, to, occurrence = 0) {
  let cursor = 0;
  let index = -1;
  for (let count = 0; count <= occurrence; count++) {
    index = source.indexOf(from, cursor);
    if (index < 0) throw new Error(`Mutation target not found: ${from}`);
    cursor = index + from.length;
  }
  return source.slice(0, index) + to + source.slice(index + from.length);
}

function runTargetedTests(tests) {
  return spawnSync(
    process.execPath,
    ['--import', setup, '--test', ...tests],
    {
      cwd: botRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
    },
  );
}

let survived = 0;
for (const mutant of mutants) {
  const original = fs.readFileSync(mutant.file, 'utf8');
  const mutated = replaceOccurrence(
    original,
    mutant.from,
    mutant.to,
    mutant.occurrence ?? 0,
  );

  try {
    fs.writeFileSync(mutant.file, mutated, { encoding: 'utf8', flag: 'w' });
    const result = runTargetedTests(mutant.tests);
    if (result.status === 0) {
      survived++;
      console.error(`SURVIVED: ${mutant.name}`);
      console.error(result.stdout);
      console.error(result.stderr);
    } else {
      console.log(`KILLED: ${mutant.name}`);
    }
  } finally {
    fs.writeFileSync(mutant.file, original, { encoding: 'utf8', flag: 'w' });
  }
}

if (survived > 0) {
  console.error(`${survived} critical mutation(s) survived`);
  process.exitCode = 1;
} else {
  console.log(`All ${mutants.length} critical mutations were killed`);
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const setup = './test/setup-env.js';

const mutants = Object.freeze([
  {
    name: 'uncertain mutation skips fresh verification',
    file: 'src/mutation-retry.js',
    from: 'if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };',
    to: 'if (false) return { verifiedAfterFailure: true };',
    occurrence: 0,
    tests: ['test/quest-fault-injection.node-test.js'],
  },
  {
    name: 'expired Quest becomes deadline eligible',
    file: 'src/quest/smart-scheduler.js',
    from: '&& expiresAt > now',
    to: '&& expiresAt <= now',
    tests: ['test/smart-scheduler.node-test.js'],
  },
  {
    name: 'recovery ignores uncertain mutation checkpoint',
    file: 'src/quest/recovery-planner.js',
    from: '&& MUTATION_RECOVERY_STATUSES.has(state.mutation_status)',
    to: '&& false',
    tests: ['test/runner-recovery-planner.node-test.js'],
  },
  {
    name: 'multi-task AND is accepted by automatic executor',
    file: 'src/quest/executors/registry.js',
    from: "if (quest?.autoSupported === false) return unsupportedQuestExecutor;",
    to: 'if (false) return unsupportedQuestExecutor;',
    tests: [
      'test/quest-executor-contract.node-test.js',
      'test/quest-schema-modules.node-test.js',
    ],
  },
  {
    name: 'explicit checkpoint updates are ignored',
    file: 'src/quest/runner-state-store.js',
    from: 'if (Object.hasOwn(options, optionName)) return options[optionName];',
    to: 'if (false) return options[optionName];',
    tests: ['test/runner-state-store.node-test.js'],
  },
  {
    name: 'user-scoped bucket block is bypassed',
    file: 'src/quest/rate-limit-coordinator.js',
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
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

let survived = 0;
for (const mutant of mutants) {
  const absolute = path.join(root, mutant.file);
  const original = fs.readFileSync(absolute, 'utf8');
  const mutated = replaceOccurrence(
    original,
    mutant.from,
    mutant.to,
    mutant.occurrence ?? 0,
  );

  try {
    fs.writeFileSync(absolute, mutated);
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
    fs.writeFileSync(absolute, original);
  }
}

if (survived > 0) {
  console.error(`${survived} critical mutation(s) survived`);
  process.exitCode = 1;
} else {
  console.log(`All ${mutants.length} critical mutations were killed`);
}

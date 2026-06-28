import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const fixture = 'tests/fixtures/quests_2026_06_16.schema.json';

if (!existsSync(fixture)) {
  console.warn(`[skip] Optional quest schema fixture not found: ${fixture}`);
  console.warn('[skip] Add the sanitized fixture later to enable schema validation.');
  process.exit(0);
}

const result = spawnSync(
  'python',
  ['scripts/validate-quest-schema-fixture.py', fixture],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { appendSafeSuffix, resolveContainedPath } from '../src/path-safety.js';

const SAFE_ROOT = path.resolve('test-fixtures/path-safety-root');
const SAFE_SOURCE = path.join(SAFE_ROOT, 'quests.db');

test('resolveContainedPath keeps a simple file inside the selected directory', () => {
  const result = resolveContainedPath(SAFE_ROOT, 'backup.db');
  assert.equal(result, path.join(SAFE_ROOT, 'backup.db'));
  assert.equal(path.dirname(result), SAFE_ROOT);
});

test('resolveContainedPath rejects traversal, absolute and nested names', () => {
  const absoluteEscape = path.resolve('escape.db');
  for (const unsafeName of ['../escape.db', absoluteEscape, 'nested/backup.db', '..', '.']) {
    assert.throws(() => resolveContainedPath(SAFE_ROOT, unsafeName), /Unsafe path name|escapes/);
  }
});

test('appendSafeSuffix preserves the original file directory', () => {
  const result = appendSafeSuffix(SAFE_SOURCE, '.backup');
  assert.equal(result, `${SAFE_SOURCE}.backup`);
  assert.throws(() => appendSafeSuffix(SAFE_SOURCE, '/../escape'), /Unsafe path suffix/);
});

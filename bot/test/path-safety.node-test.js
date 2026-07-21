import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { appendSafeSuffix, resolveContainedPath } from '../src/path-safety.js';

test('resolveContainedPath keeps a simple file inside the selected directory', () => {
  const root = path.resolve('/tmp/questbot-safe-root');
  const result = resolveContainedPath(root, 'backup.db');
  assert.equal(result, path.join(root, 'backup.db'));
  assert.equal(path.dirname(result), root);
});

test('resolveContainedPath rejects traversal, absolute and nested names', () => {
  const root = path.resolve('/tmp/questbot-safe-root');
  for (const unsafeName of ['../escape.db', '/tmp/escape.db', 'nested/backup.db', '..', '.']) {
    assert.throws(() => resolveContainedPath(root, unsafeName), /Unsafe path name|escapes/);
  }
});

test('appendSafeSuffix preserves the original file directory', () => {
  const source = path.resolve('/tmp/questbot-safe-root/quests.db');
  const result = appendSafeSuffix(source, '.backup');
  assert.equal(result, path.resolve('/tmp/questbot-safe-root/quests.db.backup'));
  assert.throws(() => appendSafeSuffix(source, '/../escape'), /Unsafe path suffix/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function operationSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
}

function operationBlocks(section) {
  return section
    .split(/\n  Object\.freeze\(\{/)
    .slice(1)
    .map((candidate) => {
      const end = candidate.indexOf('\n  }),');
      assert.ok(end >= 0, 'backup operation block is not closed correctly');
      return candidate.slice(0, end);
    });
}

function assertProfileBlocks(source, {
  declaration,
  nextDeclaration,
  slotArrayName,
  root,
}) {
  const blocks = operationBlocks(operationSection(source, declaration, nextDeclaration));
  assert.equal(blocks.length, 7);

  blocks.forEach((block, index) => {
    const target = `${root}/questbot-slot-${index + 1}.db`;
    assert.match(block, new RegExp(`path:\\s*${slotArrayName}\\[${index}\\]`));
    assert.equal(
      block.split(target).length - 1,
      3,
      `${target} must be used by backup, remove and modifiedAt in its own slot block`,
    );
  });
}

test('every fixed backup slot block keeps copy, cleanup and timestamp operations on its declared path', async () => {
  const source = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');

  assertProfileBlocks(source, {
    declaration: 'const LOCAL_BACKUP_OPERATIONS',
    nextDeclaration: 'const PERSISTENT_BACKUP_OPERATIONS',
    slotArrayName: 'LOCAL_BACKUP_SLOT_PATHS',
    root: './data/backups',
  });
  assertProfileBlocks(source, {
    declaration: 'const PERSISTENT_BACKUP_OPERATIONS',
    nextDeclaration: 'const LOCAL_BACKUP_PROFILE',
    slotArrayName: 'PERSISTENT_BACKUP_SLOT_PATHS',
    root: '/var/data/backups',
  });

  assert.match(source, /operationContainsDeclaredPath\(operation, method\)/);
  assert.match(source, /targets a different fixed path/);
});

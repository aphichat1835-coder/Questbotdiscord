import fs from 'node:fs';

function updateFile(file, replacements) {
  let source = fs.readFileSync(file, 'utf8');
  for (const [before, after, label] of replacements) {
    if (!source.includes(before)) throw new Error(`Missing anchor ${label} in ${file}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(file, source);
}

updateFile('test/final-hardening.node-test.js', [
  [
    "import { resolveContainedPath } from '../src/path-safety.js';",
    "import { appendSafeSuffix } from '../src/path-safety.js';",
    'final-hardening path helper import',
  ],
  [
`  const backups = (await fs.readdir(tempDir))
    .filter((name) => name.includes('.pre-tracker-removal-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backupPath = resolveContainedPath(tempDir, backups[0]);
  const backup = new Database(backupPath, { readonly: true });`,
`  const backupPath = appendSafeSuffix(databasePath, '.pre-tracker-removal.bak');
  const backup = new Database(backupPath, { readonly: true });`,
    'legacy backup lookup',
  ],
]);

updateFile('test/runner-modes.node-test.js', [
  [
    "process.env.DATABASE_BACKUP_DIR = `/tmp/questbot-runner-backups-${process.pid}`;",
    "process.env.DATABASE_BACKUP_ENABLED = 'true';",
    'backup enable environment',
  ],
  [
    "const { backupDatabase } = await import('../src/db.js');",
    "const { backupDatabase, clearAllDatabaseBackupSlots } = await import('../src/db.js');",
    'database test imports',
  ],
  [
`test('scheduled database backups retain only the configured number of snapshots', async () => {
  await fs.rm(process.env.DATABASE_BACKUP_DIR, { recursive: true, force: true });
  await runDatabaseBackup(new Date('2026-07-01T03:00:00Z'));
  await runDatabaseBackup(new Date('2026-07-02T03:00:00Z'));
  await runDatabaseBackup(new Date('2026-07-03T03:00:00Z'));

  const backups = (await fs.readdir(process.env.DATABASE_BACKUP_DIR))
    .filter((name) => name.endsWith('.db'));
  assert.equal(backups.length, 2);
  await fs.rm(process.env.DATABASE_BACKUP_DIR, { recursive: true, force: true });
});`,
`test('scheduled database backups rotate through the configured fixed slots', async () => {
  await clearAllDatabaseBackupSlots();
  const first = await runDatabaseBackup(new Date('2026-07-01T03:00:00Z'));
  const second = await runDatabaseBackup(new Date('2026-07-02T03:00:00Z'));
  const third = await runDatabaseBackup(new Date('2026-07-03T03:00:00Z'));

  assert.notEqual(first, second);
  assert.equal(first, third);
  for (const destination of new Set([first, second])) {
    const stat = await fs.stat(destination);
    assert.ok(stat.size > 0);
  }
  await clearAllDatabaseBackupSlots();
});`,
    'scheduled backup retention test',
  ],
]);

updateFile('.env.example', [
  [
    'DATABASE_BACKUP_DIR=\nDATABASE_BACKUP_RETENTION=7',
    'DATABASE_BACKUP_ENABLED=false\nDATABASE_BACKUP_RETENTION=7',
    'backup environment example',
  ],
]);

updateFile('README.md', [
  [
`DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_DIR=/var/data/backups
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=เปลี่ยนเป็นรหัสยาวและสุ่ม`,
`DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_ENABLED=true
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=เปลี่ยนเป็นรหัสยาวและสุ่ม`,
    'README backup environment',
  ],
  [
    'ระบบใช้เฉพาะตาราง `scheduled_runners` สำหรับ Auto Daily เมื่อพบตาราง Tracker เก่า ระบบจะสำรองไฟล์ฐานข้อมูลก่อนแล้วจึงลบตารางเก่าอัตโนมัติ',
    'ระบบใช้เฉพาะตาราง `scheduled_runners` สำหรับ Auto Daily เมื่อพบตาราง Tracker เก่า ระบบจะสำรองไฟล์ฐานข้อมูลก่อนแล้วจึงลบตารางเก่าอัตโนมัติ การสำรองรายวันใช้ Slot คงที่ใน `bot/data/backups` สูงสุด 7 ไฟล์ จึงไม่รับ Path จาก Environment และไม่สะสมไฟล์ไม่สิ้นสุด',
    'README backup behavior',
  ],
]);

console.log('Applied guarded backup hardening updates');

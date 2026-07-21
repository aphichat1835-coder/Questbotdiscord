import fs from 'node:fs';

const file = new URL('../test/runner-modes.node-test.js', import.meta.url);
let source = fs.readFileSync(file, 'utf8');

const oldImport = "const panelCommand = await import('../src/commands/panel.js');\n";
if (!source.includes(oldImport)) {
  throw new Error('Legacy panel test import anchor was not found');
}
source = source.replace(oldImport, '');

const oldTest = `test('modal handlers recheck permissions when the modal is submitted', async () => {
  let runReply;
  await runCommand.handleModal({
    customId: 'run_modal:scheduled:channel',
    user: { id: 'owner-no-role' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    async reply(payload) {
      runReply = payload;
    },
  });
  assert.match(runReply.content, /สิทธิ์ของคุณเปลี่ยนไป/);

  let editReply;
  await panelCommand.handlePanelModal({
    customId: 'panel_edit_modal',
    user: { id: 'owner-no-role' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    async reply(payload) {
      editReply = payload;
    },
  });
  assert.match(editReply.content, /สิทธิ์ของคุณเปลี่ยนไป/);
});`;

const newTest = `test('run modal rechecks permissions when the modal is submitted', async () => {
  let runReply;
  await runCommand.handleModal({
    customId: 'run_modal:scheduled:channel',
    user: { id: 'owner-no-role' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    async reply(payload) {
      runReply = payload;
    },
  });
  assert.match(runReply.content, /สิทธิ์ของคุณเปลี่ยนไป/);
});`;

if (!source.includes(oldTest)) {
  throw new Error('Legacy panel modal test anchor was not found');
}
source = source.replace(oldTest, newTest);
fs.writeFileSync(file, source);
console.log('Removed the final legacy panel modal test');

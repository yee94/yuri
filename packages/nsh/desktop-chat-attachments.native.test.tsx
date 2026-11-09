import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) test(`${platform} Chat partial unknown, metadata readback, identity adoption and 401 fencing`, async () => {
  const app = await open('desktop-chat-attachments.fixture.tsx', { platform, width: 1000, height: 1000 });
  const audit = async () => { await app.press('id:fixture-audit'); return JSON.parse(app.texts().find(value => value.startsWith('{"files":'))!); };
  await app.press('id:fixture-attach'); await app.waitFor('id:desktop-chat-attachment-recovery');
  let result = await audit(); expect(result.files.length).toBe(2); expect(result.blocked).toBe(true);
  await app.press('id:fixture-attach'); result = await audit(); expect(result.calls.filter((name: string) => name.endsWith('.pick')).length).toBe(1);
  await app.press('id:fixture-unauthorized'); await app.press('id:desktop-chat-attachment-readback');
  result = await audit(); expect(result.blocked).toBe(true); expect(result.files.length).toBe(2);
  expect(app.texts().join('\n').includes('synthetic-private-path-must-not-render')).toBe(false);
  await app.press('id:fixture-unknown'); await app.press('id:desktop-chat-attachment-readback');
  result = await audit(); expect(result.files.length).toBe(3); expect(result.blocked).toBe(true);
  await app.press('id:desktop-chat-attachment-readback'); await app.waitFor('id:desktop-chat-attachment-recovery', { state: 'gone' });
  result = await audit(); expect(result.files.length).toBe(4); expect(new Set(result.files).size).toBe(4); expect(result.blocked).toBe(false);
  expect(result.calls.filter((name: string) => name.endsWith('.pick')).length).toBe(1);
});

test('renewed same-scope authority and covered Chat reject late files; recovery is metadata-only', async () => {
  const app = await open('desktop-chat-attachments.fixture.tsx', { platform: 'macos', width: 1000, height: 1000 });
  const audit = async () => { await app.press('id:fixture-audit'); return JSON.parse(app.texts().find(value => value.startsWith('{"files":'))!); };
  await app.press('id:fixture-late'); await app.press('id:fixture-attach'); await app.waitFor('id:desktop-chat-attachment-recovery');
  await app.press('id:fixture-renew'); await app.press('id:fixture-cover'); await app.press('id:fixture-settle-late'); await app.waitFor('text:late settled');
  let result = await audit(); expect(result.files.length).toBe(1); expect(result.calls.includes('desktop.attachments.cancel')).toBe(true);
  expect(result.calls.includes('desktop.attachments.release')).toBe(true);
  await app.press('id:fixture-show'); await app.press('id:desktop-chat-attachment-cancel');
  await app.waitFor('id:desktop-chat-attachment-recovery', { state: 'gone' }); result = await audit(); expect(result.blocked).toBe(false); expect(result.files.length).toBe(1);
  expect(result.calls.some((name: string) => name === 'runtime.request' || name.includes('delete'))).toBe(false);
});

test('failed native close admission does not dispose the Chat attachment owner or leave its gate locked', async () => {
  const app = await open('desktop-chat-attachments.fixture.tsx', { platform: 'macos', width: 1000, height: 1000 });
  const audit = async () => { await app.press('id:fixture-audit'); return JSON.parse(app.texts().find(value => value.startsWith('{"files":'))!); };
  await app.press('id:fixture-ready'); await app.press('id:fixture-attach');
  let result = await audit(); expect(result.files.length).toBe(2); expect(result.blocked).toBe(false);
  await app.press('id:fixture-failed-close'); result = await audit(); expect(result.closeDenied).toBe(true); expect(result.shown).toBe(true); expect(result.blocked).toBe(false);
  await app.press('id:fixture-attach'); result = await audit(); expect(result.files.length).toBe(3); expect(result.blocked).toBe(false);
  expect(result.calls.filter((name: string) => name.endsWith('.pick')).length).toBe(2);
});

test('actual NSH child cleanup fences late receipt writes without touching disposed signals', async () => {
  const app = await open('desktop-chat-attachments.fixture.tsx', { platform: 'macos', width: 1000, height: 1100 });
  await app.press('id:fixture-late'); await app.press('id:fixture-attach'); await app.waitFor('id:desktop-chat-attachment-recovery');
  await app.press('id:fixture-dispose'); await app.waitFor('id:desktop-chat-attachment-recovery', { state: 'gone' });
  await app.press('id:fixture-settle-late'); await app.waitFor('text:late settled'); await app.press('id:fixture-audit');
  const result = JSON.parse(app.texts().find(value => value.startsWith('{"files":'))!);
  expect(result.files.length).toBe(1); expect(result.calls.includes('desktop.attachments.release')).toBe(true); expect(result.errors.length).toBe(0);
});

test('fifty composer input events do zero attachment authority or lifecycle reads', async () => {
  const app = await open('desktop-chat-attachments.fixture.tsx', { platform: 'macos', width: 1000, height: 1100 });
  const audit = async () => { await app.press('id:fixture-audit'); return JSON.parse(app.texts().find(value => value.startsWith('{"files":'))!); };
  const before = await audit();
  for (let index = 0; index < 50; index++) await app.type('id:fixture-draft', 'x');
  const after = await audit(); expect(after.currentReads).toBe(before.currentReads); expect(after.operationReads).toBe(before.operationReads);
  expect(after.calls.length).toBe(0); expect(after.files.length).toBe(1);
});

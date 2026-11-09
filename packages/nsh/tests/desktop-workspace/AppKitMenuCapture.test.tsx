import { expect, open, test } from 'nsh/test';

// Run with --target macos and the paired patched CLI/runtime. The restored
// menu-source assertion must not be replaced by a headless keymap invocation.
test('AppKit capture removes native accelerators and restores one menu owner', async () => {
  const app = await open('../../desktop-shortcuts-menu-fixture.tsx', { platform: 'macos', width: 900, height: 650 });
  await app.waitFor('text:ready');
  await app.press('id:physical-menu-mode');
  await app.press('id:claim');
  await app.press('id:capture');
  await app.waitFor('text:owned:[]');
  await app.keyboard.press('mod+shift+k');
  await app.waitFor('text:captured:mod+shift+k');
  expect(app.texts()).toContain('calls:0');
  await app.press('id:settings');
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:1');
  expect(app.texts()).toContain('source:menu');
  await app.wait(120);
  expect(app.texts()).toContain('calls:1');
});

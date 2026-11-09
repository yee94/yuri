import { expect, open, test } from 'nsh/test';

// NSH 0.4 headless submit() drops Return modifiers. Exercise the real AppKit
// input instead of changing production editing to accommodate that test driver.
test('AppKit modified Return edits the same native input without sending', async () => {
  const app = await open('./Keyboard.tsx', { platform: 'macos', width: 1000, height: 600 });
  await app.type('id:desktop-keyboard', 'native');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('submits:1');
  await app.keyboard.press('shift+enter');
  expect(app.value('id:desktop-keyboard')).toBe('native\n');
  expect(app.texts()).toContain('submits:1');
  await app.keyboard.press('alt+enter');
  expect(app.value('id:desktop-keyboard')).toBe('native\n\n');
  expect(app.texts()).toContain('submits:1');
});

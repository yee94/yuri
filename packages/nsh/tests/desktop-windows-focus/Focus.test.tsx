import { expect, open, test } from 'nsh/test';

// This is the Windows headless contract, not evidence of Win32 physical input.
test('Windows generic Button owns Tab, Enter and Space without a keymap binding', async () => {
  const app = await open('./Focus.tsx', { platform: 'windows', width: 500, height: 400 });
  await app.keyboard.press('tab');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:1');
  await app.keyboard.press('space');
  expect(app.texts()).toContain('calls:2');
});

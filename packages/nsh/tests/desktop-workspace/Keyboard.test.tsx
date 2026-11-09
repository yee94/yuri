import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} Enter submits and autocomplete never sends`, async () => {
    const app = await open('./Keyboard.tsx', { platform, width: 1000, height: 600 });
    await app.type('id:desktop-keyboard', 'native');
    await app.keyboard.press('enter');
    expect(app.texts()).toContain('submits:1');
    await app.clear('id:desktop-keyboard');
    expect(app.value('id:desktop-keyboard')).toBe('');
    await app.type('id:desktop-keyboard', '@src');
    await app.keyboard.press('enter');
    expect(app.value('id:desktop-keyboard')).toBe('@src/file.ts ');
    expect(app.texts()).toContain('submits:1');
  });
}

test('IME and inactive owner cannot submit through the shared adapter', async () => {
  const app = await open('./Keyboard.tsx', { platform: 'macos' });
  await app.type('id:desktop-keyboard', '中文');
  await app.press('id:composition-start');
  await app.submit('id:desktop-keyboard');
  expect(app.texts()).toContain('submits:0');
  await app.press('id:inactive');
  await app.submit('id:desktop-keyboard');
  expect(app.texts()).toContain('submits:0');
});

import { expect, open, test, type App } from 'nsh/test';

const start = () => open('./Contracts.tsx', { platform: 'windows', width: 500, height: 700 });
const control = (app: App, action: string) => app.host.send('focus.control', { action });

test('Windows headless: Button, role Button View, non-pressable stop and Input cycle in both directions', async () => {
  const app = await start();
  await app.keyboard.press('tab');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:B');
  await app.keyboard.press('tab');
  expect(app.texts()).toContain('focus:role');
  await app.keyboard.press('space');
  await app.keyboard.press('tab');
  expect(app.texts()).toContain('focus:chart');
  await app.keyboard.press('enter');
  await app.keyboard.press('space');
  expect(app.texts()).toContain('calls:BR');
  await app.keyboard.press('tab');
  expect(app.texts()).toContain('focus:input');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:BRI');
  await app.keyboard.press('tab');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:BRIB');
  await app.keyboard.press('shift+tab');
  expect(app.texts()).toContain('focus:input');
});

for (const action of ['disable', 'hide', 'exclude', 'destroy']) {
  test(`Windows headless: ${action} revokes the old focus owner without a ghost press`, async () => {
    const app = await start();
    await control(app, 'focus-role');
    expect(app.texts()).toContain('focus:role');
    await control(app, action);
    await app.keyboard.press('enter');
    expect(app.texts()).toContain('calls:');
    await app.keyboard.press('tab');
    await app.keyboard.press('enter');
    expect(app.texts()).toContain('calls:B');
  });
}

test('Windows headless: blur of another view cannot erase the focused Button', async () => {
  const app = await start();
  await control(app, 'focus-button');
  await control(app, 'blur-role');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:B');
});

test('Windows headless: newest modal is the only Tab and activation scope', async () => {
  const app = await start();
  await control(app, 'focus-button');
  await control(app, 'modal');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:');
  await app.keyboard.press('tab');
  await app.keyboard.press('enter');
  await app.keyboard.press('tab');
  await app.keyboard.press('space');
  await app.keyboard.press('shift+tab');
  await app.keyboard.press('enter');
  expect(app.texts()).toContain('calls:MMM');
});

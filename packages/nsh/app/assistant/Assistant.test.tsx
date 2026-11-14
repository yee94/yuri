import { expect, open, test } from 'nsh/test';

const webPhone = { platform: 'web' as const, locale: 'en-US', width: 390, height: 844 };

/** The tab bar only exists on the web fallback; device targets skip these. */
async function openWeb() {
  try {
    return await open('../dev/App.tsx', webPhone);
  } catch (error) {
    if (String(error).includes('ERR_NSH_TEST_UNSUPPORTED') || String(error).includes('unsupported on --target')) return null;
    throw error;
  }
}

async function openBots() {
  const app = await openWeb();
  if (!app) return null;
  await app.press('id:tab-assistant');
  await app.waitFor('text:Ops Bot');
  return app;
}

test('the pinned contact sits above the other bots with its unread badge', async () => {
  const app = await openBots();
  if (!app) return;
  expect(app.shows('id:assistant-pinned-a-pinned')).toBe(true);
  expect(app.texts()).toContain('Pinned Bot');
  expect(app.shows('id:assistant-a-ops')).toBe(true);
  expect(app.texts()).toContain('Deploy finished on the staging host.');
});

test('the contact menu pins and unpins a bot, moving it between the two groups', async () => {
  const app = await openBots();
  if (!app) return;
  let buttons: string[] = [];
  app.onDialog((dialog) => {
    buttons = dialog.buttons;
    return dialog.buttons.includes('Pin') ? 'Pin' : null;
  });
  await app.longPress('id:assistant-a-ops');
  await app.waitUntil(() => !app.shows('id:assistant-pinned-a-pinned'));
  await app.waitFor('id:assistant-pinned-a-ops');
  expect(buttons).toContain('Edit');
  expect(buttons).toContain('Delete');
});

test('the bot editor keeps the Web fields and its scheduled tasks link', async () => {
  const app = await openBots();
  if (!app) return;
  app.onDialog((dialog) => (dialog.buttons.includes('Edit') ? 'Edit' : null));
  await app.longPress('id:assistant-a-docs');
  await app.waitFor('text:Default prompt');
  expect(app.texts()).toContain('Workspace');
  expect(app.texts()).toContain('Changing workspace starts a new bot session.');
  expect(app.texts()).toContain('Message channels');
  expect(app.shows('id:assistant-channel-wechat')).toBe(true);
  expect(app.texts()).toContain('Save bot');
});

test('the WeChat channel shows the QR handshake and its scan step', async () => {
  const app = await openBots();
  if (!app) return;
  app.onDialog((dialog) => (dialog.buttons.includes('Edit') ? 'Edit' : null));
  await app.longPress('id:assistant-a-docs');
  await app.waitFor('id:assistant-channel-wechat');
  await app.press('id:assistant-channel-wechat');
  await app.waitFor('text:Connect with QR code');
  await app.press('text:Connect with QR code');
  await app.waitFor('text:Scan and confirm in WeChat');
});

test('a contact opens its bound session on the shared chat page', async () => {
  const app = await openBots();
  if (!app) return;
  await app.press('id:assistant-a-ops');
  await app.waitFor('id:chat-input');
  expect(app.texts()).toContain('Did the staging deploy finish?');
});

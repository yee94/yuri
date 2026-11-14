import { expect, open, test } from 'nsh/test';

const webPhone = { platform: 'web' as const, locale: 'en-US', width: 390, height: 844 };

async function openWeb() {
  try {
    return await open('../dev/App.tsx', webPhone);
  } catch (error) {
    if (String(error).includes('ERR_NSH_TEST_UNSUPPORTED') || String(error).includes('unsupported on --target')) return null;
    throw error;
  }
}

async function openSettings() {
  const app = await openWeb();
  if (!app) return null;
  await app.press('id:tab-settings');
  await app.waitFor('text:Appearance');
  return app;
}

test('the settings home lists the same groups as the Web phone', async () => {
  const app = await openSettings();
  if (!app) return;
  expect(app.texts()).toContain('Connection');
  expect(app.texts()).toContain('Personalization');
  expect(app.texts()).toContain('OpenCode');
  await app.type('id:settings-search', 'zzz');
  await app.waitFor('text:No matching settings');
});

test('appearance offers the ten Web languages and both font sizes', async () => {
  const app = await openSettings();
  if (!app) return;
  await app.press('text:Appearance');
  await app.waitFor('text:Switch theme');
  expect(app.texts()).toContain('Interface Font Size');
  expect(app.texts()).toContain('Code Font Size');
  expect(app.value('id:appearance-font-size')).toBe('100');
  expect(app.value('id:appearance-code-font-size')).toBe('100');
  await app.press('id:appearance-language');
  await app.waitFor('text:English');
  expect(app.texts()).toContain('Japanese');
  expect(app.texts()).toContain('Spanish');
  await app.press('text:Japanese');
  await app.waitUntil(() => app.texts().includes('言語'));
});

test('the interface font size steps up and resets to the default', async () => {
  const app = await openSettings();
  if (!app) return;
  await app.press('text:Appearance');
  await app.waitFor('id:appearance-font-size');
  await app.press('id:appearance-font-size-plus');
  await app.waitUntil(() => app.value('id:appearance-font-size') === '105');
  await app.waitUntil(() => (app.storage()['yuri.settings.typography'] ?? '').includes('"fontSize":105'));
  await app.press('id:appearance-font-size-reset');
  await app.waitUntil(() => (app.storage()['yuri.settings.typography'] ?? '').includes('"fontSize":100'));
  expect(app.shows('id:appearance-code-font-size')).toBe(true);
});

test('about shows the client, service and OpenCode versions', async () => {
  const app = await openSettings();
  if (!app) return;
  await app.press('text:About');
  await app.waitFor('text:Yuri Client');
  expect(app.texts()).toContain('1.18.2 (370)');
  expect(app.texts()).toContain('1.2.3');
  expect(app.texts()).toContain('0.9.0 (global CLI — upgrade manually)');
  expect(app.texts()).toContain('Upgrade the configured OpenCode CLI with its package manager, then restart the service.');
});

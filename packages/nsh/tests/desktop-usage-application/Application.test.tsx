import { expect, open, test } from 'nsh/test';
import { createUsageApplicationHost, identity, isNavigationReadOnlyGoalRPC, registeredProviderIDs } from './Host.js';

async function launch(platform, entry = './App.tsx') {
  const fixture = createUsageApplicationHost();
  const app = await open(entry, { platform, clock: {}, width: 1440, height: 1200, host: { handlers: fixture.handlers } });
  await app.waitFor('id:new-session-composer');
  await app.waitUntil(() => app.enabled('id:desktop-settings'));
  return { app, fixture };
}
async function usagePage(app) {
  await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
  await app.waitUntil(() => app.enabled('id:desktop-settings-search'));
  await app.paste('id:desktop-settings-search', { text: 'Usage' });
  await app.press('id:desktop-settings-page:usage');
  await app.waitFor('id:desktop-usage-scroll');
  await app.waitUntil(() => app.enabled('id:usage-refresh') && app.enabled('id:desktop-settings-close'));
}
async function reveal(app, selector) {
  for (let count = 0; count < 30 && !app.shows(selector); count++) await app.scroll('id:desktop-usage-scroll', 160);
  await app.waitFor(selector);
}
function clean(app, fixture) {
  expect(fixture.rejected).toEqual([]); expect(fixture.usageRejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  expect(fixture.requests.every(input => input.method === 'GET' || isNavigationReadOnlyGoalRPC(input))).toBe(true);
  expect(app.requests()).toEqual([]);
}
async function refresh(app, fixture) {
  const count = fixture.quotaReads.length;
  await app.press('id:usage-refresh');
  await app.waitUntil(() => fixture.quotaReads.length > count && app.enabled('id:usage-refresh') && app.enabled('id:desktop-settings-close'));
  const batch = fixture.quotaReads.slice(count);
  expect(batch).toHaveLength(registeredProviderIDs.length + 1);
  for (const id of registeredProviderIDs) expect(batch.filter(input => input.path === '/api/quota/' + id)).toHaveLength(1);
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual entity-free Settings Usage activates desktop publisher once and retains local selection/drafts/families', async () => {
    const { app, fixture } = await launch(platform); await usagePage(app);
    expect(app.count('id:desktop-usage-scroll')).toBe(1); expect(app.shows('id:usage-scroll')).toBe(false);
    expect(app.shows('id:settings-entity-split')).toBe(false);
    expect(app.shows('id:usage-auto-refresh')).toBe(true); expect(app.shows('id:usage-provider-google')).toBe(true);
    expect(fixture.quotaReads).toHaveLength(registeredProviderIDs.length + 1);
    for (const id of registeredProviderIDs) expect(fixture.quotaReads.filter(input => input.path === '/api/quota/' + id)).toHaveLength(1);
    await app.press('id:usage-provider-google');
    await reveal(app, 'id:usage-family-gemini-auth'); await app.press('id:usage-family-gemini-auth');
    expect(app.shows('id:usage-model-gemini/z-model')).toBe(false);
    await app.press('id:usage-magpie-manual'); await app.paste('id:usage-magpie-url', { text: 'https://fixture.invalid/retained-usage' });
    const reads = fixture.requests.length, quota = fixture.quotaReads.length;
    await app.press('id:usage-provider-claude'); await app.press('id:usage-provider-magpie:usage-fixture');
    expect(app.texts()).toContain('$5'); await app.press('id:usage-provider-google');
    expect(fixture.requests).toHaveLength(reads); expect(fixture.quotaReads).toHaveLength(quota);
    expect(app.value('id:usage-magpie-url')).toBe('https://fixture.invalid/retained-usage');
    expect(app.shows('id:usage-model-gemini/z-model')).toBe(false);
    let confirmations = 0; app.onDialog(() => { confirmations++; return 'Cancel'; });
    await app.press('id:desktop-settings-close');
    expect(confirmations).toBe(1); expect(app.count('id:desktop-usage-scroll')).toBe(1);
    expect(app.value('id:usage-magpie-url')).toBe('https://fixture.invalid/retained-usage');
    await app.setLifecycle('background'); const paused = fixture.quotaReads.length;
    await app.wait(1000); expect(fixture.quotaReads).toHaveLength(paused);
    await app.setLifecycle('active');
    await app.waitUntil(() => app.enabled('id:usage-refresh') && app.enabled('id:desktop-settings-close'));
    expect(fixture.quotaReads).toHaveLength(paused + registeredProviderIDs.length + 1);
    expect(app.value('id:usage-magpie-url')).toBe('https://fixture.invalid/retained-usage');
    expect(app.shows('id:usage-model-gemini/z-model')).toBe(false);
    expect(app.count('id:desktop-usage-scroll')).toBe(1);
    clean(app, fixture);
  });

  test(platform + ' Settings/search/help temporarily cover one real composer; 50 edits add no usage or catalog reads', async () => {
    const { app, fixture } = await launch(platform);
    await app.waitFor('text:Saved exact conversation'); await app.press('text:Saved exact conversation');
    await app.waitFor('id:composer'); await app.waitFor('text:Verified saved session transcript');
    await app.paste('id:composer', { text: 'Retained real product draft' });
    await usagePage(app); await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Retained real product draft');
    const quota = fixture.quotaReads.length;
    for (const [trigger, surface] of [['desktop-global-search', 'desktop-command-palette'], ['desktop-shortcuts', 'desktop-help-dialog']]) {
      await app.press('id:' + trigger); await app.waitFor('id:' + surface);
      expect(app.shows('id:desktop-settings-window')).toBe(false); expect(app.enabled('id:desktop-new-session')).toBe(false);
      await app.keyboard.press('escape'); await app.waitFor('id:' + surface, { state: 'gone' });
      expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Retained real product draft');
    }
    const reads = fixture.requests.length;
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Composer edit ${index}` }); }
    expect(fixture.quotaReads).toHaveLength(quota); expect(fixture.requests).toHaveLength(reads);
    expect(app.value('id:composer')).toBe('Composer edit 49');
    expect(app.count('id:composer')).toBe(1); clean(app, fixture);
  });

  test(platform + ' production provider read failure preserves prior quota and never renders authoritative empty', async () => {
    const { app, fixture } = await launch(platform); fixture.failProvider(true); await usagePage(app);
    await app.press('id:usage-provider-google');
    await app.waitFor('id:usage-read-error');
    expect(app.shows('id:usage-no-data')).toBe(false); expect(app.shows('id:usage-no-windows')).toBe(false);
    fixture.failProvider(false); await refresh(app, fixture); await reveal(app, 'id:usage-account-z-account');
    expect(app.texts()).toContain('$19.25');
    fixture.failProvider(true); await refresh(app, fixture); await app.waitFor('id:usage-read-error');
    expect(app.shows('id:usage-account-z-account')).toBe(true); expect(app.texts()).toContain('$19.25');
    expect(app.shows('id:usage-no-data')).toBe(false); expect(app.shows('id:usage-no-windows')).toBe(false);
    expect(fixture.quotaReads.filter(input => input.path === '/api/quota/google')).toHaveLength(3);
    clean(app, fixture);
  });

  test(platform + ' real native authority retirement rejects late old Host quota without bypassing pending Settings guard', async () => {
    const { app, fixture } = await launch(platform, './DelayedRoot.tsx'); await usagePage(app); await app.press('id:usage-provider-google');
    await app.host.send('usage.application.control', { action: 'arm' });
    await app.press('id:usage-refresh'); await app.waitUntil(() => fixture.audit.some(event => event.phase === 'held'));
    expect(app.enabled('id:desktop-settings-close')).toBe(false);
    expect(fixture.audit.find(event => event.phase === 'held').expectedHost).toEqual({ hostID: identity.hostID, lease: identity.lease });
    await app.setLifecycle('background'); fixture.rotateAuthorization(); await app.setLifecycle('active');
    await app.waitFor('id:desktop-settings-window', { state: 'gone' }); await app.waitFor('id:new-session-composer');
    await usagePage(app); await app.press('id:usage-provider-google');
    await app.waitFor('text:Rotated Google Usage');
    const reads = fixture.quotaReads.length; await app.host.send('usage.application.control', { action: 'release' });
    await app.waitUntil(() => fixture.audit.some(event => event.phase === 'released')); await app.wait(100);
    expect(app.texts()).toContain('Rotated Google Usage'); expect(app.texts()).not.toContain('Initial Google Usage');
    expect(app.count('id:desktop-usage-scroll')).toBe(1); expect(fixture.quotaReads).toHaveLength(reads);
    const google = fixture.quotaReads.filter(input => input.path === '/api/quota/google');
    expect(google.filter(input => input.expectedHost.lease === identity.lease)).toHaveLength(2);
    expect(google.filter(input => input.expectedHost.lease === 'navigation-rotated-lease')).toHaveLength(1);
    clean(app, fixture);
  });
}

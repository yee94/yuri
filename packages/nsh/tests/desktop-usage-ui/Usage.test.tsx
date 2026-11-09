import { expect, open, test } from 'nsh/test';

async function launch(platform) {
  const events: Array<{ event: string; value?: any }> = [];
  const app = await open('./App.tsx', { platform, clock: {}, width: 1280, height: 900, host: { handlers: { 'desktop.usage.test': value => { events.push(value); } } } });
  const control = (action, value?) => app.host.send('desktop.usage.control', { action, value });
  const requests = () => events.filter(event => event.event === 'request');
  const writes = () => events.filter(event => event.event === 'write');
  await app.waitUntil(() => requests().length === 4);
  await app.waitUntil(() => app.enabled('id:usage-refresh'));
  await app.waitFor('id:usage-provider-google');
  expect(app.requests()).toEqual([]);
  expect(Object.keys(app.storage())).toHaveLength(0);
  const protection = async () => {
    const count = events.filter(event => event.event === 'protection').length;
    await control('protection'); await app.waitUntil(() => events.filter(event => event.event === 'protection').length === count + 1);
    return events.filter(event => event.event === 'protection').at(-1).value;
  };
  return { app, events, control, requests, writes, protection };
}
async function reveal(app, selector) {
  for (let count = 0; count < 40 && !app.shows(selector); count++) await app.scroll('id:desktop-usage-scroll', 180);
  await app.waitFor(selector);
}
async function fill(app, selector, value) { await app.clear(selector); await app.paste(selector, { text: value }); }
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' workspace keeps preferences, providers and detail without navigation/remount; resize follows the actual Web grid', async () => {
    const f = await launch(platform);
    expect(f.app.shows('id:settings-entity-split')).toBe(false);
    expect(f.app.shows('id:usage-display-mode')).toBe(true);
    await reveal(f.app, 'id:usage-account-z-account');
    expect(f.app.texts()).toContain('$19.25');
    const count = f.requests().length;
    const catalog = f.events.filter(event => event.event === 'model-catalog').length;
    for (let index = 0; index < 50; index++) await fill(f.app, 'id:usage-fixture-unrelated-input', `unrelated-${index}`);
    expect(f.requests()).toHaveLength(count);
    expect(f.events.filter(event => event.event === 'model-catalog')).toHaveLength(catalog);
    await f.app.press('id:usage-magpie-manual'); await fill(f.app, 'id:usage-magpie-url', 'https://fixture.invalid/usage');
    const draftCatalog = f.events.filter(event => event.event === 'model-catalog').length;
    for (let index = 0; index < 50; index++) await fill(f.app, 'id:usage-magpie-url', `https://fixture.invalid/usage-${index}`);
    expect(f.requests()).toHaveLength(count);
    expect(f.events.filter(event => event.event === 'model-catalog')).toHaveLength(draftCatalog);
    await reveal(f.app, 'id:usage-provider-claude'); await f.app.press('id:usage-provider-claude');
    expect(f.events.filter(event => event.event === 'route')).toHaveLength(0);
    expect(f.requests()).toHaveLength(count);
    expect(f.writes()).toHaveLength(0);
    await f.app.press('id:usage-provider-magpie:fixture'); expect(f.app.texts()).toContain('$5');
    expect(f.requests()).toHaveLength(count);
    expect(f.app.value('id:usage-magpie-url')).toBe('https://fixture.invalid/usage-49');
    expect((await f.protection()).dirty).toBe(true);
    await f.app.setViewport(700, 900);
    expect(f.app.shows('id:desktop-usage-providers')).toBe(true);
    expect(f.app.shows('id:desktop-usage-detail')).toBe(true);
    await f.app.setViewport(1280, 900);
    expect(f.app.value('id:usage-magpie-url')).toBe('https://fixture.invalid/usage-49');
    await f.control('language', 'zh-CN'); expect(f.app.texts()).toContain('自动刷新');
    await f.control('language', 'pl'); expect(f.app.shows('id:usage-magpie-url')).toBe(true);
  });
  test(platform + ' real model/header controls preserve read authority, unknown ACK and foreground lifecycle', async () => {
    const f = await launch(platform);
    await reveal(f.app, 'id:usage-model-gemini/z-model');
    await f.app.press('id:usage-family-gemini-auth'); expect(f.app.shows('id:usage-model-gemini/z-model')).toBe(false);
    await f.app.press('id:usage-family-gemini-auth'); await f.app.waitFor('id:usage-model-gemini/z-model');
    await f.app.press('id:usage-model-gemini/z-model');
    await f.app.waitUntil(() => f.writes().length === 1 && f.requests().length === 7);
    expect(f.writes()[0].value.usageSelectedModels.google).toEqual(['gemini/z-model']);
    await f.control('ack', true); await f.app.press('id:usage-model-gemini/z-model');
    await f.app.waitUntil(() => f.writes().length === 2 && f.requests().length === 10);
    expect(f.writes()[1].value.usageSelectedModels.google).toEqual([]);
    await f.app.press('id:usage-header-toggle');
    await f.app.waitUntil(() => f.writes().length === 3 && f.requests().length === 13);
    expect(f.writes()[2].value.usageDropdownProviders.includes('google')).toBe(false);
    await f.app.press('id:usage-predictions');
    await f.app.waitUntil(() => f.writes().length === 4 && f.requests().length === 16);
    expect(f.writes()[3].value.usageShowPredValues).toBe(true);
    await f.app.press('id:usage-display-mode'); await f.app.press('text:Quota remaining');
    await f.app.waitUntil(() => f.writes().length === 5 && f.requests().length === 19);
    await f.app.waitUntil(() => f.app.enabled('id:usage-refresh'));
    expect(f.writes()[4].value.usageDisplayMode).toBe('remaining');
    expect(f.app.texts()).toContain('87% · 13 / 100');
    await f.control('failure', true); await f.app.press('id:usage-refresh');
    await f.app.waitFor('id:usage-settings-error');
    await reveal(f.app, 'id:usage-account-z-account'); expect(f.app.shows('id:usage-no-data')).toBe(false);
    const count = f.requests().length;
    await f.control('active', false); await f.app.setLifecycle('background');
    await f.app.wait(50); expect(f.requests()).toHaveLength(count);
    await f.control('active', true); expect(f.requests()).toHaveLength(count);
    await f.control('failure', false); await f.app.setLifecycle('active');
    await f.app.waitUntil(() => f.requests().length === count + 4);
    expect(f.writes()).toHaveLength(5);
    await f.control('current', false); const retired = f.requests().length;
    await f.app.wait(50); expect(f.requests()).toHaveLength(retired);
    await f.control('mounted', false);
  });
  test(platform + ' pending unknown write survives retirement and restores through GET only', async () => {
    const f = await launch(platform);
    await f.control('delay'); await reveal(f.app, 'id:usage-model-gemini/z-model'); await f.app.press('id:usage-model-gemini/z-model');
    await f.app.waitUntil(() => f.writes().length === 1);
    expect((await f.protection()).pending).toBe(true);
    await f.control('current', false); await f.control('resolve');
    const paused = f.requests().length;
    await f.app.wait(1000); expect(f.requests()).toHaveLength(paused);
    await f.control('current', true); await f.app.waitUntil(() => f.requests().length === paused + 4);
    await f.app.waitUntil(() => f.app.enabled('id:usage-refresh'));
    expect(f.writes()).toHaveLength(1);
    expect(f.app.shows('id:usage-preference-error')).toBe(false);
    expect((await f.protection()).pending).toBe(false);
  });
  test(platform + ' thousands of account windows and model cards are native recycled rows, not eager Each trees', async () => {
    const f = await launch(platform); await f.control('large', true); await f.app.press('id:usage-refresh');
    await f.app.waitUntil(() => f.requests().length === 8);
    await reveal(f.app, 'id:usage-value-z-account:window-0');
    expect(f.app.shows('id:usage-value-z-account:window-999')).toBe(false);
    expect(f.app.shows('id:usage-model-other/model-1999')).toBe(false);
    expect(f.app.shows('id:usage-provider-magpie:fixture-1999')).toBe(false);
    expect(f.app.count('text:/^Fixture dynamic [0-9]+$/')).toBeLessThan(60);
    const count = f.requests().length;
    expect(f.app.count('text:/^Window [0-9]+$/')).toBeLessThan(60);
    await f.app.scroll('id:desktop-usage-scroll', 2000);
    expect(f.app.count('text:/^Window [0-9]+$/')).toBeLessThan(60);
    expect(f.app.count('text:/^Fixture dynamic [0-9]+$/')).toBeLessThan(60);
    await f.app.wait(50);
    expect(f.requests()).toHaveLength(count);
  });
}

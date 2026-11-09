import { expect, open, test } from 'nsh/test';

async function launch(platform) {
  const events = [];
  const app = await open('./App.tsx', { platform, width: 1000, height: 700, host: { handlers: { 'desktop.chat.header.test': value => { events.push(value); } } } });
  const control = (action, value?) => app.host.send('desktop.chat.header.control', { action, value });
  await app.waitFor('id:desktop-chat-header-actions');
  return { app, control, events };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' services busy prevents user dismissal and tab changes but not authority revocation', async () => {
    const f = await launch(platform);
    await f.app.press('id:desktop-chat-header-menu'); await f.app.press('id:desktop-chat-header-menu-instance');
    expect(f.events.filter(event => event.event === 'services-tab').at(-1)?.tab).toBe('instance');
    await f.control('services-busy', true);
    expect(f.app.enabled('id:desktop-chat-header-tab-mcp')).toBe(false);
    await f.app.keyboard.press('escape'); expect(f.app.shows('id:desktop-chat-header-services')).toBe(true);
    await f.control('active', false); await f.app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    expect(f.events.filter(event => event.event === 'services-tab').at(-1)?.tab).toBe(null);
    await f.control('services-busy', false); await f.control('active', true);
    await f.app.press('id:desktop-chat-header-menu'); await f.app.press('id:desktop-chat-header-menu-instance');
    await f.app.keyboard.press('escape'); await f.app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    expect(f.events.filter(event => event.event === 'services-tab').at(-1)?.tab).toBe(null);
    expect(f.app.value('id:header-fixture-composer')).toBe('Keep draft');
  });
  test(platform + ' renders actual desktop entry sequence and Web geometry without mobile menu/model picker', async () => {
    const f = await launch(platform);
    expect(f.app.shows('id:desktop-chat-header-menu')).toBe(true);
    expect(f.app.shows('id:desktop-chat-header-work-status')).toBe(true);
    expect(f.app.shows('id:desktop-chat-header-context-ring')).toBe(true);
    expect(f.app.shows('id:chat-header-options')).toBe(false); expect(f.app.shows('id:chat-header-metadata')).toBe(false);
    await f.app.press('id:desktop-chat-header-menu'); await f.app.waitFor('id:desktop-chat-header-menu-terminal');
    expect(f.app.shows('label:Open Session in Mini Chat')).toBe(true);
    for (const id of ['new-session', 'files', 'changes', 'selection', 'remote-desktop', 'auto-read', 'refresh']) expect(f.app.shows('id:desktop-chat-header-menu-' + id)).toBe(false);
    await f.app.press('id:desktop-chat-header-menu-terminal');
    expect(f.events.some(event => event.event === 'result' && event.action === 'terminal' && event.status === 'accepted')).toBe(true);
    await f.app.press('id:desktop-chat-header-context'); expect(f.app.shows('id:desktop-chat-header-context-detail')).toBe(true);
    expect(f.app.texts()).toContain('40.0%  40.0K/100.0K');
  });
  test(platform + ' desktop services keep explicit missing instance, usage empty/error, and injected MCP', async () => {
    const f = await launch(platform);
    await f.app.press('id:desktop-chat-header-menu'); await f.app.press('id:desktop-chat-header-menu-instance');
    await f.app.waitFor('id:desktop-chat-header-services'); expect(f.app.texts()).toContain('Unavailable');
    await f.app.press('id:desktop-chat-header-tab-usage'); expect(f.app.texts()).toContain('No rate limits reported.');
    await f.app.press('id:desktop-chat-header-tab-mcp'); expect(f.app.shows('id:fixture-mcp')).toBe(true);
    await f.app.keyboard.press('escape'); await f.app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    await f.app.press('id:desktop-chat-header-host'); await f.app.waitFor('id:desktop-chat-header-services');
    await f.control('active', false); expect(f.app.shows('id:desktop-chat-header-services')).toBe(false);
    await f.control('active', true); expect(f.app.shows('id:desktop-chat-header-services')).toBe(false);
    expect(f.app.shows('id:desktop-chat-header-context-ring')).toBe(true);
  });
  test(platform + ' quota cards retain partial errors, real thin bars, unknown usage and no optimistic mode success', async () => {
    const f = await launch(platform);
    const window = { usedPercent: 80, remainingPercent: 20, windowSeconds: null, resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null };
    await f.control('metadata', { loading: false, errors: [], tokens: 40_000, limit: 100_000, quota: {
      loading: false, loaded: true, displayMode: 'usage', timeFormat: '24h', errors: ['Partial quota refresh failed'], groups: [{ id: 'openai', logoID: 'openai', name: 'OpenAI', rows: [
        { key: 'known', label: '5h', window }, { key: 'unknown', label: '7d', window: { ...window, usedPercent: null, remainingPercent: null } },
      ], stale: true }],
    } });
    await f.app.press('id:desktop-chat-header-menu'); await f.app.press('id:desktop-chat-header-menu-usage');
    expect(f.app.shows('id:desktop-chat-header-quota-fill-known')).toBe(true);
    expect(f.app.shows('id:desktop-chat-header-quota-fill-unknown')).toBe(false);
    expect(f.app.texts()).toContain('80%'); expect(f.app.texts()).toContain('Partial quota refresh failed');
    expect(f.app.texts()).toContain('Showing the last known status. Latest status is still updating.');
    await f.control('result', 'unknown'); await f.app.press('id:desktop-chat-header-quota-remaining');
    expect(f.events.filter(event => event.event === 'result').at(-1)?.status).toBe('unknown');
    expect(f.app.texts()).toContain('80%'); expect(f.app.texts()).not.toContain('20%');
    await f.app.press('id:desktop-chat-header-quota-refresh');
    expect(f.events.filter(event => event.event === 'action-start' && event.action === 'refresh-usage')).toHaveLength(1);
    expect(f.app.requests()).toHaveLength(0);
  });
  test(platform + ' no read source/owner churn during 50 input characters, modal and foreground suspend', async () => {
    const f = await launch(platform);
    for (let index = 0; index < 50; index++) await f.app.type('id:header-fixture-composer', 'x');
    expect(f.app.value('id:header-fixture-composer')).toBe('Keep draft' + 'x'.repeat(50));
    expect(f.app.requests()).toHaveLength(0); expect(f.app.host.calls()).toHaveLength(0);
    expect(f.events).toEqual([{ event: 'mount' }]);
    await f.control('active', false); await f.control('active', true);
    await f.app.setLifecycle('background'); await f.app.setLifecycle('active');
    expect(f.events).toEqual([{ event: 'mount' }]);
    expect(f.app.shows('id:desktop-chat-header-context-ring')).toBe(true);
    await f.app.press('id:desktop-chat-header-menu'); await f.control('operation', false);
    expect(f.app.shows('id:desktop-chat-header-menu-terminal')).toBe(false); expect(f.app.enabled('id:desktop-chat-header-panel')).toBe(false);
    await f.control('operation', true); expect(f.app.shows('id:desktop-chat-header-context-ring')).toBe(true);
    await f.control('metadata', { loading: false, errors: [], pending: true }); expect(f.app.texts()).toContain('Awaiting update');
    await f.control('metadata', { loading: false, errors: [], contextStale: true, tokens: 40, limit: 100 }); expect(f.app.shows('id:desktop-chat-header-context-ring')).toBe(false);
  });
  test(platform + ' unavailable ports remain visible and action late completion cannot cross modal or Host', async () => {
    const f = await launch(platform); await f.control('available', false);
    await f.app.press('id:desktop-chat-header-menu'); expect(f.app.shows('id:desktop-chat-header-menu-mini-chat')).toBe(true);
    expect(f.app.texts()).toContain('Unavailable'); expect(f.app.enabled('id:desktop-chat-header-menu-terminal')).toBe(false);
    expect(f.events.filter(event => event.event === 'action-start')).toHaveLength(0);
    await f.app.keyboard.press('escape'); await f.control('available', true); await f.control('deferred', true);
    await f.app.press('id:desktop-chat-header-panel'); await f.control('active', false); await f.control('active', true); await f.control('release');
    expect(f.events.filter(event => event.event === 'action-commit')).toHaveLength(0);
    expect(f.events.filter(event => event.event === 'result')).toHaveLength(0);
    await f.app.press('id:desktop-chat-header-panel'); await f.control('scope', 'B'); await f.control('host', 'Host B'); await f.control('release');
    expect(f.events.filter(event => event.event === 'action-commit')).toHaveLength(0);
    await f.control('deferred', false); await f.control('result', 'unsupported'); await f.app.press('id:desktop-chat-header-panel');
    expect(f.events.filter(event => event.event === 'result').at(-1)?.status).toBe('unsupported');
  });
  test(platform + ' apps/GitHub use captured IDs; locale and long-title narrow window preserve buttons', async () => {
    const f = await launch(platform); await f.app.press('id:desktop-chat-header-apps'); await f.app.press('id:desktop-chat-header-app-finder');
    expect(f.events.some(event => event.event === 'action-commit' && event.action === 'select-app' && event.value === 'finder')).toBe(true);
    await f.app.press('id:desktop-header-github-menu'); await f.app.press('id:desktop-header-github-account-oauth-b');
    expect(f.events.some(event => event.event === 'action-commit' && event.action === 'github-account' && event.value === JSON.stringify(['oauth', 'b']))).toBe(true);
    await f.control('title', 'Long title '.repeat(100)); await f.control('language', 'zh-CN');
    await f.app.setViewport(420, 360); await f.app.press('id:desktop-chat-header-menu');
    expect(f.app.texts()).toContain('查看用量'); await f.app.press('id:desktop-chat-header-menu-usage');
    expect(f.app.shows('id:desktop-chat-header-services')).toBe(true);
    await f.app.back(); expect(f.app.shows('id:desktop-chat-header-services')).toBe(false);
    expect(f.app.value('id:header-fixture-composer')).toBe('Keep draft');
  });
}

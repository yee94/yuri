import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  async function launch() {
    const events: Record<string, unknown>[] = [];
    const app = await open('./App.tsx', { platform, width: 1000, height: 700, host: { handlers: { 'desktop.header.services.test': (value: Record<string, unknown>) => { events.push(value); } } } });
    const control = (action: string, value?: unknown) => app.host.send('desktop.header.services.control', { action, value });
    await app.waitFor('id:services-composer'); return { app, events, control };
  }
  test(platform + ' MCP actual native rows, runtime switches, explicit refresh and no Settings mount', async () => {
    const f = await launch(); expect(f.events.filter(event => event.event === 'request')).toHaveLength(0);
    await f.app.press('id:services-show-mcp'); await f.app.waitFor('id:desktop-header-services-mcp-toggle-Alpha');
    expect(f.app.shows('id:desktop-header-services-mcp-row-Auth')).toBe(true); expect(f.app.shows('id:desktop-header-services-mcp-row-Registration')).toBe(true);
    expect(f.events.filter(event => event.event === 'request')).toHaveLength(2);
    await f.app.press('id:desktop-header-services-mcp-toggle-Alpha');
    expect(f.events.filter(event => event.method === 'POST')).toHaveLength(1);
    expect(f.events.some(event => String(event.path).includes('/Alpha/disconnect?'))).toBe(true);
    await f.app.press('id:desktop-header-services-mcp-refresh');
    expect(f.events.filter(event => String(event.path).startsWith('/api/config/mcp'))).toHaveLength(1);
    expect(f.app.shows('id:integration-oauth-code')).toBe(false); expect(f.app.requests()).toHaveLength(0);
  });
  test(platform + ' Instance committed version and owner actions; missing default/new-window/update gates disabled', async () => {
    const f = await launch(); await f.app.press('id:services-show-instance'); await f.app.waitFor('id:desktop-header-services-instance-row-a');
    expect(f.app.texts()).toContain('1.2.3'); expect(f.app.texts()).toContain('Relay'); expect(f.app.texts()).not.toContain('99 ms');
    expect(f.app.enabled('id:desktop-header-services-instance-default-a')).toBe(false); expect(f.app.enabled('id:desktop-header-services-instance-new-window-a')).toBe(false); expect(f.app.enabled('id:desktop-header-services-update')).toBe(false);
    await f.app.press('id:desktop-header-services-instance-connect-ssh'); expect(f.events.some(event => event.event === 'instance-commit' && event.action === 'connect' && event.id === 'ssh')).toBe(true);
    expect(f.events.filter(event => event.event === 'update-write')).toHaveLength(0);
    await f.app.press('id:desktop-header-services-instance-add'); expect(f.events.some(event => event.event === 'instance-commit' && event.action === 'add')).toBe(true);
  });
  test(platform + ' retained partial/unknown retry is read-only; modal fences late writes and 50 inputs add zero GETs', async () => {
    const f = await launch(); await f.app.press('id:services-show-mcp'); await f.app.waitFor('id:desktop-header-services-mcp-toggle-Alpha');
    const reads = f.events.filter(event => event.event === 'request').length;
    for (let i = 0; i < 50; i++) await f.app.type('id:services-composer', 'x');
    expect(f.events.filter(event => event.event === 'request')).toHaveLength(reads); expect(f.app.value('id:services-composer')).toBe('Keep draft' + 'x'.repeat(50));
    await f.control('unknown', true); await f.app.press('id:desktop-header-services-mcp-toggle-Alpha'); await f.app.waitFor('id:desktop-header-services-mcp-retry-Alpha');
    expect(f.app.enabled('id:desktop-header-services-mcp-toggle-Alpha')).toBe(false);
    const writes = f.events.filter(event => event.method === 'POST').length;
    await f.control('fail', '/api/mcp'); await f.app.press('id:desktop-header-services-mcp-retry-Alpha');
    expect(f.app.shows('id:desktop-header-services-error')).toBe(true); expect(f.app.shows('id:desktop-header-services-mcp-row-Alpha')).toBe(true);
    await f.control('fail', ''); await f.app.press('id:desktop-header-services-mcp-retry-Alpha'); expect(f.events.filter(event => event.method === 'POST')).toHaveLength(writes);
    await f.control('unknown', false); await f.control('defer', true); await f.app.press('id:desktop-header-services-mcp-toggle-Alpha');
    await f.control('active', false); expect(f.app.enabled('id:desktop-header-services-mcp-toggle-Alpha')).toBe(false);
    const count = f.events.filter(event => event.event === 'request').length;
    await f.control('release'); expect(f.events.filter(event => event.event === 'request')).toHaveLength(count);
    await f.app.press('id:services-hide'); await f.app.setLifecycle('background'); await f.app.setLifecycle('active');
    expect(f.events.filter(event => event.event === 'request')).toHaveLength(count); expect(f.events.filter(event => event.event === 'mount')).toHaveLength(1);
  });
  test(platform + ' successful empty differs from unavailable; Chinese narrow viewport keeps compact controls', async () => {
    const f = await launch(); await f.control('empty', true); await f.app.press('id:services-show-mcp'); await f.app.waitFor('id:desktop-header-services-mcp-empty');
    expect(f.app.texts()).toContain('Configure MCP servers in Settings.'); await f.app.setViewport(360, 500);
    await f.control('language', 'zh-CN'); expect(f.app.shows('id:desktop-header-services-mcp-refresh')).toBe(true);
    await f.app.press('id:services-show-instance'); await f.app.waitFor('id:desktop-header-services-instance-row-a');
    expect(f.app.shows('id:desktop-header-services-instance-new-window-a')).toBe(true); expect(f.app.shows('id:desktop-header-services-instance-add')).toBe(true);
  });
}

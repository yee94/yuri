import { expect, open, test } from 'nsh/test';

async function launch(platform) {
  const events = [];
  const app = await open('./App.tsx', { platform, width: 1440, height: 900, host: { handlers: { 'desktop.help.test': value => { events.push(value.event); } } } });
  const control = (action, value) => app.host.send('desktop.help.control', { action, value });
  return { app, events, control };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' closed help builds zero catalogs and open reference retains all 41 rows without search/edit controls', async () => {
    const f = await launch(platform);
    for (let index = 0; index < 50; index++) { await f.control('overrides', { open_help: 'mod+alt+k' }); await f.control('noise'); }
    expect(f.events).toEqual([]);
    await f.control('open'); await f.app.waitFor('id:desktop-help-dialog');
    expect(f.app.shows('id:desktop-shortcuts-filter')).toBe(false); expect(f.app.shows('id:desktop-shortcuts-reset-all')).toBe(false);
    expect(f.app.shows('id:desktop-help-unavailable-open_command_palette')).toBe(false);
    expect(f.app.shows('id:desktop-help-unavailable-toggle_terminal')).toBe(true);
    expect(f.app.shows('id:desktop-help-row-toggle_terminal')).toBe(true);
    const count = f.events.filter(event => event === 'catalog-read').length;
    expect(count).toBe(1);
    for (let index = 0; index < 50; index++) await f.control('noise');
    expect(f.events.filter(event => event === 'catalog-read').length).toBe(count);
    await f.app.scroll('id:desktop-help-scroll', 2000); await f.app.waitFor('id:desktop-help-row-open_settings');
    await f.app.keyboard.press('escape'); await f.app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    expect(f.events.filter(event => event === 'closed')).toHaveLength(1); expect(f.events).not.toContain('composer-escape');
    const closedCount = f.events.length;
    for (let index = 0; index < 50; index++) await f.control('overrides', {});
    expect(f.events).toHaveLength(closedCount);
    expect(f.app.value('id:help-fixture-composer')).toBe('Keep this composer');
  });
  test(platform + ' remaps and aliases update in the same presentation; locale and window resize retain scrolling help', async () => {
    const f = await launch(platform); await f.control('open');
    await f.app.waitFor('id:desktop-help-row-open_help');
    expect(f.app.shows(platform === 'macos' ? 'label:⌘.' : 'label:Ctrl+.')).toBe(true);
    await f.control('overrides', { open_help: 'mod+alt+k', leader_key: 'alt+l' });
    expect(f.app.shows(platform === 'macos' ? 'label:⌥⌘K' : 'label:Ctrl+Alt+K')).toBe(true);
    expect(f.app.shows(platform === 'macos' ? 'label:⌥L → M' : 'label:Alt+L → M')).toBe(true);
    expect(f.events.filter(event => event === 'closed')).toHaveLength(0);
    expect(f.events.filter(event => event === 'catalog-read')).toHaveLength(2);
    await f.control('language', 'zh-CN');
    expect(f.app.texts()).toContain('键盘快捷键');
    await f.control('language', 'pl');
    await f.app.setViewport(420, 360); await f.app.scroll('id:desktop-help-scroll', 4000);
    expect(f.app.shows('id:desktop-help-row-open_settings')).toBe(true);
    await f.app.setViewport(1000, 700); expect(f.app.shows('id:desktop-help-dialog')).toBe(true);
    expect(f.events.filter(event => event === 'closed')).toHaveLength(0);
    await f.app.press('id:desktop-help-backdrop'); await f.app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    expect(f.events.filter(event => event === 'closed')).toHaveLength(1);
  });
  test(platform + ' scope/active/background changes close once and reopening has a fresh presentation owner', async () => {
    const f = await launch(platform); await f.control('open');
    await f.control('scope', 'B'); await f.app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    expect(f.events.filter(event => event === 'closed')).toHaveLength(1);
    await f.control('open'); await f.app.waitFor('id:desktop-help-dialog');
    await f.control('active', false); await f.app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    expect(f.events.filter(event => event === 'closed')).toHaveLength(2);
    await f.control('active', true); await f.control('open'); await f.app.setLifecycle('background');
    expect(f.events.filter(event => event === 'closed')).toHaveLength(3);
    await f.app.setLifecycle('active'); expect(f.app.shows('id:desktop-help-dialog')).toBe(false);
    await f.control('open'); await f.app.back();
    expect(f.events.filter(event => event === 'closed')).toHaveLength(4);
    expect(f.events).not.toContain('composer-escape');
  });
}

import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: anchored Web menu without search, current/draft actions and zero closed catalog reads`, async () => {
    const app = await open('./desktop-session-switcher-fixture.tsx', { platform, width: 1000, height: 800 });
    await app.press('id:metrics'); expect(app.texts()).toContain('snapshots:0 retries:0');
    await app.press('id:switcher-title'); await app.waitFor('id:desktop-switcher-session-s299');
    expect(app.shows('id:desktop-switcher-search')).toBe(false);
    expect(app.shows('id:desktop-switcher-session-s0')).toBe(false);
    expect(app.shows('id:desktop-switcher-session-child')).toBe(false);
    await app.press('id:desktop-switcher-expand-s299'); await app.waitFor('id:desktop-switcher-session-child');
    await app.press('id:desktop-switcher-session-s299'); expect(app.shows('id:desktop-session-switcher')).toBe(false);
    expect(app.texts()).toContain('closes:1 nav:0 drafts:0 generation:1');
    await app.press('id:draft'); await app.waitFor('id:desktop-switcher-new');
    await app.press('id:desktop-switcher-session-s298'); expect(app.texts()).toContain('closes:2 nav:1 drafts:0 generation:1');
    await app.press('id:switcher-title'); await app.press('id:desktop-switcher-new');
    expect(app.texts()).toContain('closes:3 nav:1 drafts:1 generation:1');
    expect(app.requests()).toEqual([]);
  });
  test(`${platform}: standard menu arrows/Home/End, empty/retry/Escape and lifecycle`, async () => {
    const app = await open('./desktop-session-switcher-fixture.tsx', { platform, width: 1000, height: 800 });
    await app.press('id:switcher-title'); await app.keyboard.press('end');
    await app.keyboard.press('up'); await app.keyboard.press('home');
    await app.keyboard.press('down'); await app.keyboard.press('down'); await app.keyboard.press('enter');
    expect(app.texts()).toContain('closes:1 nav:1 drafts:0 generation:1');
    await app.press('id:error'); await app.press('id:switcher-title'); await app.waitFor('id:desktop-switcher-error');
    expect(app.shows('id:desktop-switcher-session-s299')).toBe(true);
    await app.press('id:desktop-switcher-retry'); expect(app.shows('id:desktop-switcher-error')).toBe(false);
    await app.keyboard.press('escape'); expect(app.shows('id:desktop-session-switcher')).toBe(false);
    await app.press('id:empty'); await app.press('id:switcher-title'); await app.waitFor('id:desktop-switcher-empty');
    expect(app.shows('id:desktop-switcher-new')).toBe(true);
    await app.keyboard.press('escape');
    await app.press('id:loading'); await app.press('id:switcher-title'); await app.waitFor('id:desktop-switcher-loading');
    expect(app.shows('id:desktop-switcher-empty')).toBe(false);
    await app.setLifecycle('background'); expect(app.shows('id:desktop-session-switcher')).toBe(false);
    expect(app.requests()).toEqual([]);
  });
  test(`${platform}: mouse hover and keyboard share highlight; Host replacement has a new owner`, async () => {
    const app = await open('./desktop-session-switcher-fixture.tsx', { platform, width: 1000, height: 800 });
    await app.press('id:switcher-title'); await app.hover('id:desktop-switcher-session-s297');
    await app.keyboard.press('enter'); expect(app.texts()).toContain('closes:1 nav:1 drafts:0 generation:1');
    await app.press('id:switcher-title'); await app.keyboard.press('s');
    expect(app.shows('id:desktop-switcher-session-s293')).toBe(true);
    expect(app.shows('id:desktop-switcher-search')).toBe(false);
    await app.host.send('desktop-switcher-fixture.host');
    await app.keyboard.press('s'); await app.keyboard.press('enter');
    expect(app.texts()).toContain('closes:2 nav:2 drafts:0 generation:2');
    expect(app.requests()).toEqual([]);
  });
  test(`${platform}: 300-row catalog, repeated typeahead does not enumerate it and closed menu reads nothing`, async () => {
    const app = await open('./desktop-session-switcher-fixture.tsx', { platform, width: 1000, height: 800 });
    for (let i = 0; i < 50; i++) await app.host.send('desktop-switcher-fixture.host');
    await app.press('id:metrics'); expect(app.texts()).toContain('snapshots:0 retries:0');
    await app.press('id:switcher-title');
    for (let i = 0; i < 50; i++) await app.keyboard.press('s');
    expect(app.shows('id:desktop-switcher-session-s0')).toBe(false);
    await app.keyboard.press('escape');
    for (let i = 0; i < 50; i++) await app.host.send('desktop-switcher-fixture.host');
    await app.press('id:metrics'); expect(app.texts()).toContain('snapshots:1 retries:0');
    expect(app.requests()).toEqual([]);
  });
  test(`${platform}: IME admission releases menu keys; then typeahead cycles, never filters`, async () => {
    const app = await open('./desktop-session-switcher-fixture.tsx', { platform, width: 1000, height: 800 });
    await app.press('id:switcher-title');
    await app.host.send('desktop-switcher-fixture.composition', true);
    await app.keyboard.press('s'); await app.keyboard.press('down'); await app.keyboard.press('enter'); await app.keyboard.press('escape');
    expect(app.shows('id:desktop-session-switcher')).toBe(true);
    expect(app.texts()).toContain('closes:0 nav:0 drafts:0 generation:1');
    await app.host.send('desktop-switcher-fixture.composition', false);
    await app.keyboard.press('s'); await app.keyboard.press('s'); await app.keyboard.press('enter');
    expect(app.texts()).toContain('closes:1 nav:1 drafts:0 generation:1');
    expect(app.requests()).toEqual([]);
  });
}

import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: routed plan validates exact bindings, readiness, direction, remaps, scope and disposal`, async () => {
    const app = await open('desktop-shortcuts-routing.fixture.tsx', { platform, width: 1100, height: 1000 });
    await app.waitFor('text:not-ready');
    expect(app.texts()).toContain('bindings:[]');
    await app.press('id:dispatch-palette'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:release-preferences'); await app.waitFor('text:ready');
    await app.press('id:capture-palette');
    await app.press('id:dispatch-copy'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:dispatch-forged'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:true');
    await app.press('id:dispatch-back');
    expect(app.texts().some(text => text.includes('"keystroke":"shift+tab","direction":-1'))).toBe(true);
    await app.press('id:dispatch-forward');
    expect(app.texts().some(text => text.includes('"keystroke":"tab","direction":1'))).toBe(true);
    await app.press('id:rebind');
    await app.waitUntil(() => app.texts().some(text => text.startsWith('bindings:') && text.includes('alt+f8')));
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:dispatch-palette'); expect(app.texts()).toContain('accepted:true');
    await app.press('id:capture-palette');
    await app.press('id:scope');
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:capture-palette');
    await app.press('id:dispose'); expect(app.texts()).toContain('bindings:[]');
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
  });

  test(`${platform}: routed abort and leader use the physical dispatcher, and all native gates revoke old items`, async () => {
    const app = await open('desktop-shortcuts-routing.fixture.tsx', { platform, width: 1100, height: 1000 });
    await app.press('id:release-preferences'); await app.waitFor('text:ready');
    await app.press('id:dispatch-abort');
    expect(app.texts()).toContain('accepted:true');
    expect(app.texts()).toContain('abort-primed:true leader-pending:false');
    expect(app.texts()).toContain('events:[]');
    await app.press('id:dispatch-abort');
    expect(app.texts().some(text => text.includes('"id":"abort","intent":{"source":"keyboard","keystroke":"escape"}'))).toBe(true);
    await app.press('id:dispatch-leader'); expect(app.texts()).toContain('abort-primed:false leader-pending:true');
    await app.keyboard.press('m');
    await app.waitUntil(() => app.texts().some(text => text.includes('"id":"model","intent":{"source":"leader","keystroke":"m"}')));
    for (const gate of ['active', 'ime']) {
      await app.press('id:capture-palette'); await app.press(`id:${gate}`);
      expect(app.texts()).toContain('bindings:[]');
      await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
      await app.press(`id:${gate}`);
      await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    }
    await app.press('id:capture-palette'); await app.setLifecycle('background'); expect(app.texts()).toContain('bindings:[]');
    await app.setLifecycle('active'); await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:capture-palette'); await app.press('id:settings');
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:settings'); await app.press('id:capture-palette'); await app.press('id:capture');
    expect(app.texts()).toContain('bindings:[]');
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.keyboard.press('alt+f10'); expect(app.texts()).toContain('capture:alt+f10');
    await app.press('id:settings');
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:capture-palette'); await app.press('id:menu-owned');
    expect(app.texts().filter(text => text.startsWith('bindings:')).some(text => text.includes('open_command_palette'))).toBe(false);
    await app.press('id:dispatch-old'); expect(app.texts()).toContain('accepted:false');
    await app.press('id:menu-palette'); expect(app.texts()).toContain('accepted:true');
    expect(app.texts().some(text => text.includes('"id":"palette","intent":{"source":"menu"}'))).toBe(true);
  });

  test(`${platform}: 50 edits do zero plan rebuilds, action scans or storage writes`, async () => {
    const app = await open('desktop-shortcuts-routing.fixture.tsx', { platform, width: 1100, height: 1000 });
    await app.press('id:release-preferences'); await app.waitFor('text:ready');
    await app.press('id:reset-metrics');
    for (let index = 0; index < 50; index++) await app.type('id:routing-input', 'x');
    await app.press('id:metrics'); expect(app.texts()).toContain('plans:0 scans:0 writes:0');
    expect(app.value('id:routing-input')).toBe('x'.repeat(50));
  });
}

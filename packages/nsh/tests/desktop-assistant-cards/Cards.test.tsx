import { expect, open, test, type App } from 'nsh/test';
type Frame = { bounds: { size: { width: number; height: number } } };
type Report = { sequence: number; cardMounts: number; sessionReads: number; modelReads: number; seedReads: number; subscriptions: number; releases: number; frames: { session: Frame; assistant: Frame; schedule: Frame }; samples: string[]; rawIntact: boolean };
async function snapshot(app: App, measure = false): Promise<Report> {
  const before = app.texts().find(text => text.startsWith('report:{'));
  await app.host.send('cards.control', { action: 'snapshot', value: measure ? 'measure' : '' });
  await app.waitUntil(() => app.texts().some(text => text.startsWith('report:{') && text !== before));
  return JSON.parse(app.texts().find(text => text.startsWith('report:{'))!.slice(7));
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: actual three receipt components keep Web 304x148 geometry and full metadata`, async () => {
    const app = await open('../../desktop-assistant-cards-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    const value = await snapshot(app, true);
    for (const frame of Object.values(value.frames)) expect(frame.bounds.size).toEqual({ width: 304, height: 148 });
    for (const text of ['Actual live session title', 'actual-project', 'feature/native-contact', '+12', '−3', '2 files', 'openai/gpt-5', 'anthropic/claude-sonnet-4', '09:30']) expect(app.texts()).toContain(text);
    expect(app.shows('id:provider-logo-openai')).toBe(true); expect(app.shows('id:provider-logo-anthropic')).toBe(true);
    expect(app.spanStyle('text:09:30').fontSize).toBe(17.5);
    await app.setViewport(280, 832);
    const narrow = await snapshot(app, true);
    for (const frame of Object.values(narrow.frames)) { expect(frame.bounds.size.width).toBeLessThanOrEqual(248); expect(frame.bounds.size.height).toBe(148); }
    await app.setColorScheme('dark'); expect((await snapshot(app)).rawIntact).toBe(true);
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0); expect(Object.keys(app.storage())).toHaveLength(0);
  });
  test(`${platform}: real Input 50 edits/unrelated signals do zero card/avatar/model rebuilding or I/O`, async () => {
    const app = await open('../../desktop-assistant-cards-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    const before = await snapshot(app);
    for (let index = 0; index < 50; index++) { await app.type('id:cards-input', 'x'); await app.host.send('cards.control', { action: 'unrelated', value: index }); }
    const after = await snapshot(app);
    for (const key of ['cardMounts', 'sessionReads', 'modelReads', 'seedReads', 'subscriptions'] as const) expect(after[key]).toBe(before[key]);
    expect(app.value('id:cards-input')).toHaveLength(50); expect(after.rawIntact).toBe(true);
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0);
  });
  test(`${platform}: status and task updates are local; unknown does not become idle/zero`, async () => {
    const app = await open('../../desktop-assistant-cards-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    await app.host.send('cards.control', { action: 'status', value: 'busy' });
    expect(app.shows('id:desktop-assistant-card-changes')).toBe(false);
    expect(app.shows('id:desktop-assistant-card-status >> text:Working')).toBe(true);
    for (const kind of ['weekly', 'cron', 'once', 'unknown']) await app.host.send('cards.control', { action: 'schedule', value: kind });
    expect(app.texts()).toContain('Time unavailable');
    await app.host.send('cards.control', { action: 'sparse' });
    expect(app.shows('id:desktop-assistant-card-status')).toBe(false); expect(app.shows('id:desktop-assistant-card-model >> id:provider-logo-openai')).toBe(false);
    expect(app.shows('id:desktop-assistant-card-changes')).toBe(false);
    expect(app.texts()).not.toContain('stale'); expect((await snapshot(app, true)).frames.session.bounds.size.height).toBe(148);
    await app.host.send('cards.control', { action: 'locale', value: 'zh-CN' }); expect(app.texts()).toContain('定时任务');
  });
  test(`${platform}: whole card native Button navigation is raw and modal/background fenced`, async () => {
    const app = await open('../../desktop-assistant-cards-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    for (const kind of ['session', 'assistant', 'schedule']) await app.press(`id:desktop-assistant-receipt-${kind}`);
    expect(app.texts()).toContain('calls:3');
    await app.press('id:cards-modal');
    for (const kind of ['session', 'assistant', 'schedule']) expect(app.enabled(`id:desktop-assistant-receipt-${kind}`)).toBe(false);
    await expect(app.press('id:desktop-assistant-receipt-session')).rejects.toMatchObject({ code: 'ERR_NSH_TEST_DISABLED' });
    await app.press('id:cards-modal'); await app.setLifecycle('inactive');
    expect(app.enabled('id:desktop-assistant-receipt-session')).toBe(false);
    await app.setLifecycle('active'); expect(app.enabled('id:desktop-assistant-receipt-session')).toBe(true);
    expect(app.texts()).toContain('calls:3'); expect(app.openedUrls()).toHaveLength(0);
  });
  // NSH 0.4's headless tabs_to_views explicitly covers only MacOs/Web;
  // Win32 tab_focus also walks text fields only. This is a runtime blocker,
  // not permission for the card to install a second/global keyboard system.
  const keyboardTest = platform === 'windows' ? test.skip : test;
  keyboardTest(`${platform}: native Button owns Tab, Enter and Space activation without global key bindings (Windows upstream blocker)`, async () => {
    const app = await open('../../desktop-assistant-cards-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    await app.keyboard.press('tab'); await app.keyboard.press('enter'); expect(app.texts()).toContain('calls:1');
    await app.keyboard.press('space'); expect(app.texts()).toContain('calls:2');
    await app.keyboard.press('tab'); await app.keyboard.press('enter'); expect(app.texts()).toContain('calls:3');
    await app.keyboard.press('tab'); await app.keyboard.press('space'); expect(app.texts()).toContain('calls:4');
    expect(app.openedUrls()).toHaveLength(0); expect(app.requests()).toHaveLength(0);
  });
  test(`${platform}: receipt and existing Bot avatar share the original working clock and clean leases`, async () => {
    const app = await open('../../desktop-assistant-cards-fixture.tsx', { platform, width: 1068, height: 832, clock: {} });
    await app.press('id:cards-working'); await app.clock!.runFor(100);
    const value = await snapshot(app);
    expect(value.subscriptions).toBe(2); expect(value.samples).toHaveLength(2); expect(value.samples[0]).toBe(value.samples[1]);
    for (let index = 0; index < 50; index++) { await app.type('id:cards-input', 'x'); await app.host.send('cards.control', { action: 'unrelated', value: index }); }
    const typed = await snapshot(app);
    for (const key of ['cardMounts', 'sessionReads', 'modelReads', 'seedReads', 'subscriptions'] as const) expect(typed[key]).toBe(value[key]);
    await app.clock!.runFor(100); const next = await snapshot(app); expect(next.samples[0]).toBe(next.samples[1]);
    await app.press('id:cards-modal'); const paused = await snapshot(app); expect(paused.samples).toHaveLength(0); expect(paused.releases).toBe(2);
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0);
  });
}

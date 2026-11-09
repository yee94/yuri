import { expect, open, test, type App } from 'nsh/test';
type Frame = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } }; pagePosition: { x: number; y: number } };
type Report = { sequence: number; priorityReads: number; seedReads: number; botReads: number; subscriptions: number; releases: number; presenterMounts: number; listMounts: number; rowMounts: number; reduced: boolean; frames: { list: Frame; column: Frame; composer: Frame; region: Frame } };
async function snapshot(app: App, measure = false): Promise<Report> {
  const before = app.texts().find(text => text.startsWith('report:{'));
  await app.host.send('feedback.control', { action: 'snapshot', value: measure ? 'measure' : '' });
  await app.waitUntil(() => app.texts().some(text => text.startsWith('report:{') && text !== before));
  return JSON.parse(app.texts().find(text => text.startsWith('report:{'))!.slice(7));
}
const shown = (app: App) => app.shows('id:desktop-assistant-processing-feedback');
async function set(app: App, action: string, value: boolean) { await app.host.send('feedback.control', { action, value }); }

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: actual idle/sending/processing/failed/flight/modal/background presence, no extra sending toast`, async () => {
    const app = await open('../../desktop-assistant-send-feedback-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    expect(shown(app)).toBe(false); expect((await snapshot(app)).seedReads).toBe(0);
    await set(app, 'sending', true); expect(shown(app)).toBe(false);
    await set(app, 'processing', true); expect(shown(app)).toBe(false);
    await set(app, 'sending', false); expect(shown(app)).toBe(true);
    for (let index = 0; index < 3; index++) expect(app.shows(`id:desktop-assistant-processing-dot-${index}`)).toBe(true);
    expect(app.shows('id:desktop-assistant-processing-avatar')).toBe(true);
    await set(app, 'flight', true); expect(shown(app)).toBe(false);
    await set(app, 'flight', false); expect(shown(app)).toBe(true);
    await set(app, 'current', false); expect(shown(app)).toBe(false);
    await set(app, 'current', true); expect(shown(app)).toBe(true);
    await app.setLifecycle('inactive'); expect(shown(app)).toBe(false);
    await app.setLifecycle('background'); expect(shown(app)).toBe(false);
    await app.setLifecycle('active'); expect(shown(app)).toBe(true);
    await app.host.send('feedback.control', { action: 'failed' }); expect(shown(app)).toBe(false);
    expect(app.texts()).toContain('Existing message-scoped failure');
    expect(app.texts()).not.toContain('Sending…'); expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0);
  });
  test(`${platform}: exact overlay column is independent of the retained inverted List and composer frames`, async () => {
    const app = await open('../../desktop-assistant-send-feedback-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    const before = await snapshot(app, true);
    expect(before.frames.column.bounds.size.width).toBe(672);
    expect(before.frames.column.bounds.size.height).toBe(before.frames.region.bounds.size.height);
    expect(before.frames.composer.bounds.size.height).toBe(76);
    for (const [action, value] of [['processing', true], ['sending', true], ['flight', true], ['current', false], ['current', true], ['sending', false], ['flight', false], ['processing', false]] as const) {
      await set(app, action, value);
      const next = await snapshot(app, true);
      expect(next.frames.list).toEqual(before.frames.list); expect(next.frames.composer).toEqual(before.frames.composer); expect(next.frames.region).toEqual(before.frames.region);
      expect(next.listMounts).toBe(1); expect(next.presenterMounts).toBe(1);
    }
    await app.scroll('id:feedback-original-list', 120); const scrolled = await snapshot(app, true);
    await set(app, 'processing', true); expect((await snapshot(app, true)).frames.list).toEqual(scrolled.frames.list);
    await app.setViewport(800, 700); const resized = await snapshot(app, true);
    await set(app, 'processing', false); expect((await snapshot(app, true)).frames.list).toEqual(resized.frames.list);
    expect(resized.frames.column.bounds.size.width).toBe(480);
  });
  test(`${platform}: reduced-motion static dots and 50 real input/unrelated updates do zero priority/avatar reconstruction or I/O`, async () => {
    const app = await open('../../desktop-assistant-send-feedback-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    await set(app, 'processing', true); const before = await snapshot(app);
    expect(before.reduced).toBe(true); expect(before.subscriptions).toBe(0);
    for (let index = 0; index < 50; index++) { await app.type('id:feedback-real-input', 'x'); await app.host.send('feedback.control', { action: 'unrelated', value: index }); }
    const after = await snapshot(app);
    for (const key of ['priorityReads', 'seedReads', 'botReads', 'subscriptions', 'presenterMounts', 'listMounts', 'rowMounts'] as const) expect(after[key]).toBe(before[key]);
    expect(app.value('id:feedback-real-input')).toHaveLength(50); expect(shown(app)).toBe(true);
    await app.host.send('feedback.control', { action: 'locale', value: 'zh-CN' }); expect(shown(app)).toBe(true);
    expect((await snapshot(app)).seedReads).toBe(after.seedReads);
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0); expect(Object.keys(app.storage())).toHaveLength(0);
  });
  test(`${platform}: motion uses the existing avatar singleton; modal/background release it, no input-created leases`, async () => {
    const app = await open('../../desktop-assistant-send-feedback-fixture.tsx', { platform, width: 1068, height: 832, clock: {} });
    await set(app, 'processing', true); await app.clock!.runFor(200); const before = await snapshot(app);
    expect(before.subscriptions).toBe(1);
    for (let index = 0; index < 50; index++) { await app.type('id:feedback-real-input', 'x'); await app.host.send('feedback.control', { action: 'unrelated', value: index }); }
    const after = await snapshot(app);
    for (const key of ['priorityReads', 'seedReads', 'botReads', 'subscriptions', 'presenterMounts', 'listMounts'] as const) expect(after[key]).toBe(before[key]);
    await set(app, 'current', false); expect((await snapshot(app)).releases).toBe(1); expect(shown(app)).toBe(false);
    await set(app, 'current', true); expect((await snapshot(app)).subscriptions).toBe(2);
    await app.setLifecycle('background'); expect((await snapshot(app)).releases).toBe(2); expect(shown(app)).toBe(false);
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0);
  });
}

import { expect, open, test, type App } from 'nsh/test';

type Frame = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } }; pagePosition: { x: number; y: number } };
type Metrics = { root: Frame; surface: Frame; input: Frame; list: Frame; body: Frame; slot: Frame; row: Frame; bodyBounds: { origin: { x: number; y: number }; size: { width: number; height: number } }; measuredWidth: number; editorMounts: number; transcriptMounts: number; rowComputations: number; editorRefs: number; listRefs: number; bodyRefs: number; bodyLayouts: number; bodyMeasures: number; slotProjections: number };
async function metrics(app: App): Promise<Metrics> {
  const previous = app.texts().find(text => text.startsWith('result:{'));
  await app.press('id:measure');
  await app.waitUntil(() => app.texts().some(text => text.startsWith('result:{') && text !== previous));
  return JSON.parse(app.texts().find(text => text.startsWith('result:{'))!.slice(7));
}
const control = (app: App, action: string, value?: number | string) => app.host.send('layout.control', { action, value });
async function counters(app: App): Promise<Metrics> {
  await control(app, 'snapshot');
  return JSON.parse(app.texts().find(text => text.startsWith('result:{'))!.slice(7));
}
function sameOwners(before: Metrics, after: Metrics) {
  expect(after.editorMounts).toBe(before.editorMounts); expect(after.transcriptMounts).toBe(before.transcriptMounts);
  expect(after.editorRefs).toBe(before.editorRefs); expect(after.listRefs).toBe(before.listRefs); expect(after.bodyRefs).toBe(before.bodyRefs);
  expect(after.rowComputations).toBe(before.rowComputations);
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: actual native slots share Web columns and do not derive width from a pane's windowSize`, async () => {
    const app = await open('../../desktop-chat-layout-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:composer');
    let value = await metrics(app);
    expect(value.root.bounds.size.width).toBe(808);
    expect(value.surface.bounds.size.width).toBe(752);
    expect(value.input.bounds.size.height).toBe(52);
    // The slot preserves the shared control's intrinsic size. A subsequent
    // desktop presentation may remove its current 3pt height discrepancy.
    expect(value.surface.bounds.size.height).toBeGreaterThanOrEqual(99);
    expect(value.surface.bounds.size.height).toBeLessThanOrEqual(102);
    expect(value.measuredWidth).toBe(752);
    expect(value.surface.pagePosition.x - value.root.pagePosition.x).toBe(28);
    expect(value.surface.pagePosition.y).toBeGreaterThan(value.list.pagePosition.y);
    await app.setViewport(1700, 900); value = await metrics(app);
    expect(value.surface.bounds.size.width).toBe(912);
    await app.press('id:wide'); value = await metrics(app); expect(value.surface.bounds.size.width).toBe(1104);
    await app.press('id:wide'); await app.setViewport(1068, 832); await app.press('id:panel'); value = await metrics(app);
    expect(value.root.bounds.size.width).toBe(408); expect(value.surface.bounds.size.width).toBe(360);
    expect(value.surface.bounds.size.width).toBeGreaterThan(0);
    await app.press('id:panel'); await app.setViewport(800, 700); value = await metrics(app);
    expect(value.surface.bounds.size.width).toBe(508);
    expect(value.editorMounts).toBe(1); expect(value.transcriptMounts).toBe(1);
  });
  test(`${platform}: 50 input events, hover, resize and modal admission retain the same editor/List and perform zero row work`, async () => {
    const app = await open('../../desktop-chat-layout-fixture.tsx', { platform, width: 1068, height: 832 });
    const before = await metrics(app);
    await app.type('id:composer', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX');
    expect(app.value('id:composer')).toHaveLength(50);
    await app.hover('id:composer'); await app.setViewport(900, 700); await app.setViewport(1068, 832);
    const after = await metrics(app);
    expect(after.editorMounts).toBe(before.editorMounts); expect(after.transcriptMounts).toBe(before.transcriptMounts);
    expect(after.rowComputations).toBe(before.rowComputations);
    expect(app.requests()).toHaveLength(0);
    await app.press('id:modal'); expect(app.enabled('id:composer')).toBe(false); expect(app.enabled('id:send')).toBe(false);
    expect(app.value('id:composer')).toHaveLength(50);
    await app.press('id:modal'); await app.press('id:send'); expect(app.texts()).toContain('calls:1');
    await app.paste('id:composer', { text: '中文 IME fixture' }); expect(app.value('id:composer')).toContain('中文');
  });
  test(`${platform}: recovery, queue, Goal, changes/tasks, attachments and blocking remain in-flow; empty does not hide composer`, async () => {
    const app = await open('../../desktop-chat-layout-fixture.tsx', { platform, width: 1068, height: 832 });
    const before = await metrics(app); await app.type('id:composer', 'retained'); await app.press('id:status');
    for (const id of ['warning', 'retry', 'blocking', 'draft-feedback', 'queue', 'goal', 'changes', 'tasks', 'attachments']) expect(app.shows(`id:${id}`)).toBe(true);
    const after = await metrics(app);
    expect(after.list.bounds.size.height).toBeLessThan(before.list.bounds.size.height);
    expect(after.list.bounds.size.height).toBeGreaterThan(0);
    expect(after.surface.pagePosition.y + after.surface.bounds.size.height).toBe(before.surface.pagePosition.y + before.surface.bounds.size.height);
    expect(after.editorMounts).toBe(1); expect(after.transcriptMounts).toBe(1);
    await app.press('id:mode'); await app.waitFor('id:chat-empty'); expect(app.shows('id:composer')).toBe(true); expect(app.value('id:composer')).toBe('retained');
    await app.setColorScheme('dark'); expect(app.shows('id:desktop-chat-composer-fill')).toBe(true);
    await app.setColorScheme('light'); expect(app.shows('id:desktop-chat-composer-fill')).toBe(false);
  });
  test(`${platform}: reserve 0→210→0 centers both columns in remaining space without shrinking the original List`, async () => {
    const app = await open('../../desktop-chat-layout-fixture.tsx', { platform, width: 1440, height: 900 });
    const before = await metrics(app);
    expect(before.body.bounds.size.width).toBe(1180); expect(before.row.bounds.size.width).toBe(752);
    await control(app, 'slot', 'inline'); let value = await metrics(app);
    expect(value.list.bounds.size.width).toBe(before.list.bounds.size.width);
    expect(value.list.pagePosition.x).toBe(before.list.pagePosition.x);
    expect(value.surface.bounds.size.width).toBe(752); expect(value.row.bounds.size.width).toBe(752);
    expect(value.surface.pagePosition.x).toBe(before.surface.pagePosition.x - 105);
    expect(value.row.pagePosition.x).toBe(value.surface.pagePosition.x);
    expect(value.slot.bounds.size.width).toBe(196);
    expect(value.slot.pagePosition.x).toBe(value.body.pagePosition.x + value.body.bounds.size.width - 14 - 196);
    expect(value.slot.pagePosition.y).toBe(value.body.pagePosition.y + 8);
    expect(value.bodyLayouts).toBe(before.bodyLayouts); sameOwners(before, value);
    await control(app, 'slot', 'hidden'); value = await metrics(app);
    expect(value.surface.bounds).toEqual(before.surface.bounds); expect(value.row.bounds.size.width).toBe(752);
    expect(value.surface.pagePosition.x).toBe(before.surface.pagePosition.x); sameOwners(before, value);
    await app.setViewport(1000, 900); const narrowWindow = await metrics(app);
    expect(narrowWindow.list.bounds.size.width).toBe(740); expect(narrowWindow.surface.bounds.size.width).toBe(708);
    await control(app, 'reserve', 210); value = await metrics(app);
    expect(value.list.bounds.size.width).toBe(740); expect(value.surface.bounds.size.width).toBe(498);
    expect(value.row.bounds.size.width).toBe(498); expect(value.row.pagePosition.x).toBe(value.surface.pagePosition.x);
    await control(app, 'reserve', 0); value = await metrics(app); expect(value.surface.bounds.size.width).toBe(708); sameOwners(before, value);
    await app.setViewport(1440, 900); await app.press('id:panel'); await control(app, 'reserve', 210); value = await metrics(app);
    expect(value.list.bounds.size.width).toBe(780); expect(value.surface.bounds.size.width).toBe(522); expect(value.row.bounds.size.width).toBe(522);
    expect(value.surface.pagePosition.x - value.root.pagePosition.x).toBe(24); sameOwners(before, value);
    await app.setViewport(1068, 900); value = await metrics(app);
    expect(value.list.bounds.size.width).toBe(408); expect(value.surface.bounds.size.width).toBe(150); expect(value.row.bounds.size.width).toBe(150);
    for (const reserve of [1e20, -210, 'nan', 'infinity', 0]) {
      await control(app, 'reserve', reserve); value = await metrics(app);
      expect(value.surface.bounds.size.width).toBe(360); expect(value.row.bounds.size.width).toBe(360);
      expect(value.list.bounds.size.width).toBe(408); sameOwners(before, value);
    }
  });
  test(`${platform}: shared body ref exposes root position; popup does not reserve or mistake parent bounds for root coordinates`, async () => {
    const app = await open('../../desktop-chat-layout-fixture.tsx', { platform, width: 1000, height: 900 });
    const before = await metrics(app); await control(app, 'slot', 'overlay'); let value = await metrics(app);
    expect(value.slot.bounds.size.width).toBe(264);
    expect(value.slot.pagePosition.x).toBe(value.body.pagePosition.x + value.body.bounds.size.width - 14 - 264);
    expect(value.slot.pagePosition.y).toBe(value.body.pagePosition.y + 12);
    expect(value.surface.bounds.size.width).toBe(before.surface.bounds.size.width); expect(value.list.bounds.size.width).toBe(740);
    expect(value.bodyBounds.origin).toEqual(value.body.pagePosition);
    expect(value.body.bounds.origin.y).not.toBe(value.body.pagePosition.y);
    expect(value.bodyMeasures).toBe(before.bodyMeasures); sameOwners(before, value);
    await app.press('id:status'); value = await metrics(app);
    expect(value.bodyLayouts).toBeGreaterThan(before.bodyLayouts); expect(value.bodyMeasures).toBe(value.bodyLayouts);
    expect(value.bodyBounds.origin).toEqual(value.body.pagePosition);
    expect(value.slot.pagePosition.y).toBe(value.body.pagePosition.y + 12);
    expect(value.body.pagePosition.y).toBeGreaterThan(before.body.pagePosition.y); sameOwners(before, value);
  });
  test(`${platform}: 50 input events issue zero geometry measures/GETs and hidden status slots perform zero projection, including after close`, async () => {
    const app = await open('../../desktop-chat-layout-fixture.tsx', { platform, width: 1440, height: 900 });
    const before = await counters(app); expect(before.slotProjections).toBe(0);
    for (let i = 0; i < 50; i++) { await app.type('id:composer', 'x'); await control(app, 'metadata', i); }
    const after = await counters(app);
    expect(after.bodyLayouts).toBe(before.bodyLayouts); expect(after.bodyMeasures).toBe(before.bodyMeasures);
    expect(after.slotProjections).toBe(0); sameOwners(before, after);
    await control(app, 'slot', 'inline'); await app.waitFor('id:layout-status-slot');
    const visible = await counters(app);
    for (let i = 0; i < 50; i++) await app.type('id:composer', 'x');
    const typed = await counters(app);
    expect(typed.bodyMeasures).toBe(visible.bodyMeasures); expect(typed.bodyLayouts).toBe(visible.bodyLayouts);
    expect(typed.slotProjections).toBe(visible.slotProjections); sameOwners(before, typed);
    await control(app, 'slot', 'hidden'); const closed = await counters(app);
    expect(closed.slotProjections).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) await control(app, 'metadata', i + 100);
    const hidden = await counters(app); expect(hidden.slotProjections).toBe(closed.slotProjections);
    expect(hidden.bodyMeasures).toBe(closed.bodyMeasures); sameOwners(before, hidden);
    expect(app.value('id:composer')).toBe('x'.repeat(100)); expect(app.requests()).toHaveLength(0);
    expect(app.host.calls().filter(call => call.name === 'runtime.request')).toHaveLength(0);
  }, 60_000);
}

test('iOS surface branches completely ignore desktop reserve, status slot and body geometry ports', async () => {
  const app = await open('../../desktop-chat-layout-fixture.tsx', { platform: 'ios', width: 1000, height: 900 });
  const before = await metrics(app); await control(app, 'slot', 'inline'); await control(app, 'reserve', 210);
  let value = await metrics(app);
  expect(value.bodyRefs).toBe(0); expect(value.bodyLayouts).toBe(0); expect(value.bodyMeasures).toBe(0); expect(value.slotProjections).toBe(0);
  expect(value.surface.bounds).toEqual(before.surface.bounds); expect(value.row.bounds.size.width).toBe(before.row.bounds.size.width);
  expect(app.shows('id:desktop-chat-body')).toBe(false); expect(app.shows('id:layout-status-slot')).toBe(false); sameOwners(before, value);
  await control(app, 'slot', 'overlay'); await control(app, 'reserve', 1e20); value = await metrics(app);
  expect(value.surface.bounds).toEqual(before.surface.bounds); expect(value.row.bounds.size.width).toBe(before.row.bounds.size.width); expect(value.slotProjections).toBe(0);
  expect(app.shows('id:layout-status-popup')).toBe(false); expect(app.requests()).toHaveLength(0);
});

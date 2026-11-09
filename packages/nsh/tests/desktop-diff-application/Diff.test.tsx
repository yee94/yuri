import { expect, open, test } from 'nsh/test';
import { createDiffHost, navigationRecord, draftKey, draftRecord, preferenceKey, panelRecord } from './Host.js';

async function launch(platform, panel = false, coordination = 'single-engine', options = {}) {
  const fixture = createDiffHost(options), preferenceIO = [];
  fixture.handlers['diff.application.storage'] = value => { preferenceIO.push(value); };
  const app = await open('./Root.tsx', { platform, clock: {}, width: 1440, height: 1200,
    storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep diff application draft'),
      ...(panel ? { 'desktop.panel-tabs.v1': panelRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true, panelWidth: 600 }) } : {}) }, host: { params: { windowKey: 'primary', windowKind: 'main', ...(coordination === 'missing' ? {} : { windowCoordination: coordination }) }, handlers: fixture.handlers } });
  await app.waitFor('id:composer'); return { app, fixture, preferenceIO };
}
async function preferences(app) {
  await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
  await app.paste('id:desktop-settings-search', { text: 'Diff Layout' });
  await app.press('id:desktop-settings-field:chat.diff-layout');
  await app.waitFor('id:settings-preference-diffLayoutPreference');
}
async function split(app) {
  await app.press('id:settings-preference-diffLayoutPreference'); await app.press('text:Always side-by-side');
  await app.press('id:settings-preferences-save');
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual YuriNativeApp root uses natural List viewport through the production Diff adapter and keeps long-item visible demand', async () => {
    const { app, fixture } = await launch(platform, true, 'single-engine', { long: true });
    await app.waitFor('text:APPLICATION_TOP_OLD'); expect(app.shows('id:native-desktop-diff-list')).toBe(true);
    expect(app.shows('text:APPLICATION_END_NEW')).toBe(false);
    await app.scroll('id:desktop-diff-stack', 2400); await app.waitFor('text:APPLICATION_BODY_OLD');
    expect(app.shows('text:APPLICATION_TOP_OLD')).toBe(false);
    const count = fixture.patchReads.length;
    await app.press('id:desktop-diff-refresh'); await app.waitFor('text:APPLICATION_BODY_OLD');
    expect(fixture.patchReads).toHaveLength(count + 1); expect(app.shows('text:APPLICATION_TOP_OLD')).toBe(false);
    for (let i = 0; i < 50; i++) await app.type('id:composer', 'x');
    expect(app.value('id:composer')).toBe('Keep diff application draft' + 'x'.repeat(50));
    await app.setViewport(1400, 1150); await app.waitFor('text:APPLICATION_BODY_OLD');
    expect(fixture.patchReads).toHaveLength(count + 1); expect(fixture.fullReads).toEqual([]);
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  for (const coordination of ['multi-engine', 'missing']) test(platform + ' actual primary refuses global Diff preference I/O for ' + coordination + ' native coordination', async () => {
    const { app, fixture, preferenceIO } = await launch(platform, true, coordination);
    await app.waitFor('text:AFTER_ROOT'); await preferences(app);
    expect(app.enabled('id:settings-preference-diffLayoutPreference')).toBe(false);
    expect(app.enabled('id:settings-preferences-save')).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.count('id:desktop-diff-list-wrap')).toBe(0);
    expect(preferenceIO).toEqual([]); expect(app.storage()[preferenceKey]).toBeUndefined();
    expect(app.value('id:composer')).toBe('Keep diff application draft'); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Settings uses root device owner and never writes a Host diff preference', async () => {
    const { app, fixture } = await launch(platform, true); await app.waitFor('text:AFTER_ROOT');
    expect(app.texts().filter(value => value === 'SAME_ROOT')).toHaveLength(1); expect(fixture.fullReads).toEqual([]); expect(fixture.patchReads).toHaveLength(1);
    await preferences(app); await split(app);
    await app.waitUntil(() => !!app.storage()[preferenceKey]);
    expect(JSON.parse(app.storage()[preferenceKey])).toEqual({ version: 1, layoutPreference: 'side-by-side', wrapLines: false });
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:composer')).toBe('Keep diff application draft');
    expect(app.texts().filter(value => value === 'SAME_ROOT')).toHaveLength(2);
    // Returning from Settings revalidates the selected workspace patch once.
    expect(fixture.patchReads).toHaveLength(2);
    await app.press('id:desktop-diff-list-wrap'); await app.waitUntil(() => JSON.parse(app.storage()[preferenceKey]).wrapLines);
    expect(fixture.patchReads).toHaveLength(2); expect(fixture.fullReads).toEqual([]);
    await app.press('id:desktop-diff-list-full-context'); await app.waitFor('text:FULL_CONTEXT_ROOT');
    expect(fixture.fullReads).toHaveLength(1); expect(app.count('id:desktop-native-diff')).toBe(1);
    expect(app.value('id:composer')).toBe('Keep diff application draft');
    await preferences(app); expect(app.shows('id:settings-preference-diffLayoutPreference >> text:Always side-by-side')).toBe(true);
    expect(app.enabled('id:settings-preferences-save')).toBe(false);
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual root unknown local preference keeps native close veto and only reconciles the original write', async () => {
    const { app, fixture } = await launch(platform); await preferences(app);
    await app.host.send('diff.application.control', { action: 'lose-ack' }); await split(app);
    await app.waitFor('id:settings-diff-preferences-error');
    await app.host.send('desktop.window.closeRequested', { ticket: 'diff:unknown', windowID: 'diff-window', generation: 1, reason: 'close' });
    await app.waitUntil(() => fixture.decisions.length === 1);
    expect(fixture.decisions[0]).toEqual({ ticket: 'diff:unknown', approved: false });
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Keep diff application draft');
    const committed = app.storage()[preferenceKey];
    await app.host.send('diff.application.control', { action: 'reconcile' }); await app.press('id:settings-diff-preferences-retry');
    await app.waitFor('id:settings-diff-preferences-error', { state: 'gone' });
    expect(app.storage()[preferenceKey]).toBe(committed);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await app.host.send('desktop.window.closeRequested', { ticket: 'diff:resolved', windowID: 'diff-window', generation: 2, reason: 'close' });
    await app.waitUntil(() => fixture.decisions.length === 2);
    expect(fixture.decisions[1]).toEqual({ ticket: 'diff:resolved', approved: true });
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
}

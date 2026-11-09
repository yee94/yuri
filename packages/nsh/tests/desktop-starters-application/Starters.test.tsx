import { expect, open, test } from 'nsh/test';
import { createStartersHost, newDraftNavigation, newDraftKey, draftRecord } from './Host.js';

for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual draft homepage reorders with native pan release and keeps composer, plus and source group', async () => {
    const fixture = createStartersHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': newDraftNavigation, [newDraftKey]: draftRecord('Keep native starter draft') }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:new-session-presets-add'));
    await app.waitFor('id:new-session-preset-explore');
    await app.drag('id:new-session-preset-explore', { x: 110, y: 0 });
    await app.waitUntil(() => fixture.writes.length === 1);
    expect(fixture.starters().map(row => row.name)).toEqual(['weigh', 'explore']);
    expect(app.value('id:new-session-composer')).toBe('Keep native starter draft');
    expect(app.shows('id:new-session-presets-add')).toBe(true); expect(app.shows('id:new-session-presets-trash')).toBe(false);
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });

  test(platform + ' actual desktop hover remove does not activate a starter or consume the draft, and fifty input edits do not reload catalogs', async () => {
    const fixture = createStartersHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': newDraftNavigation, [newDraftKey]: draftRecord('Retain hover draft') }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:new-session-presets-add'));
    await app.hover('id:new-session-preset-explore'); await app.waitFor('id:new-session-preset-remove-global:command:explore');
    await app.press('id:new-session-preset-remove-global:command:explore'); await app.waitUntil(() => fixture.writes.length === 1);
    expect(fixture.starters().map(row => row.name)).toEqual(['weigh']); expect(app.value('id:new-session-composer')).toBe('Retain hover draft');
    const reads = fixture.reads.length;
    await app.type('id:new-session-composer', 'x'.repeat(50)); expect(fixture.reads.length).toBe(reads);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    expect(app.enabled('id:new-session-presets-add')).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Retain hover draft' + 'x'.repeat(50));
    expect(fixture.writes).toHaveLength(1); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
}

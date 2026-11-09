import { expect, open, test } from 'nsh/test';
import { attachment, createCompactHost, draftKey, draftRecord } from './Host.js';

async function launch(platform) {
  const fixture = createCompactHost(), app = await open('./Root.tsx', { platform, width: 1200, height: 800,
    storage: { [draftKey]: draftRecord('/compact', [attachment]) }, host: { handlers: fixture.handlers } });
  await app.waitFor('id:compact-run'); await app.waitUntil(() => app.enabled('id:compact-run')); return { app, fixture };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' real registry/writer use compact control wire and preserve all attachments', async () => {
    const { app, fixture } = await launch(platform); await app.press('id:compact-run'); await app.waitFor('text:accepted');
    expect(fixture.compacts.length).toBe(1); expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(app.texts()).toContain('barrier');
    const saved = JSON.parse(app.storage()[draftKey]); expect(saved.draft).toBe(''); expect(saved.attachments).toEqual([attachment]); expect(saved.pendingSend).toBe(null); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' unknown compact only reads its original exact checkpoint, never POSTs on retry', async () => {
    const { app, fixture } = await launch(platform); fixture.loseAck(); await app.press('id:compact-run'); await app.waitFor('text:unknown');
    const pending = JSON.parse(app.storage()[draftKey]).pendingSend; expect(pending.localCompact.resourcePolicy).toBe('preserve'); expect(pending.uncertain).toBe(true);
    await app.type('id:compact-document', 'newer text'); await app.press('id:compact-reconcile'); expect(fixture.compacts.length).toBe(1); expect(app.texts()).toContain('pending');
    fixture.verify(); await app.press('id:compact-reconcile'); await app.waitFor('text:clear'); expect(fixture.compacts.length).toBe(1); expect(app.value('id:compact-document')).toBe('newer text'); expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
  });
  test(platform + ' coalesced server ID is not forged into this operation admission', async () => {
    const { app, fixture } = await launch(platform); fixture.coalesce(); await app.press('id:compact-run'); await app.waitFor('text:unknown');
    expect(app.texts()).toContain('barrier'); await app.press('id:compact-reconcile'); expect(fixture.compacts.length).toBe(1); expect(app.texts()).toContain('pending'); expect(fixture.rejected).toEqual([]);
  });
}

import { expect, open, test } from 'nsh/test';
import { attachment, createLocalPageHost, draftRecord, sourceKey } from './Host.js';

async function launch(platform, text) {
  const fixture = createLocalPageHost();
  const app = await open('./Root.tsx', { platform, width: 1280, height: 820, storage: { [sourceKey]: draftRecord(text) }, host: { handlers: fixture.handlers } });
  await app.waitFor('id:new-session-composer'); await app.waitUntil(() => app.enabled('id:send'));
  return { app, fixture };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' real page magic installs once then uses actual Chat admission, retaining source text/files/context', async () => {
    const { app, fixture } = await launch(platform, '/explore retained');
    await app.press('id:send'); await app.waitFor('text:complete');
    expect(fixture.stats().creates).toBe(1); expect(fixture.stats().prompts.length).toBe(1);
    const prompt = fixture.stats().prompts[0]; expect(prompt.text).not.toBe('/explore retained'); expect(prompt.files).toBeUndefined();
    const source = JSON.parse(app.storage()[sourceKey]); expect(source.draft).toBe('/explore retained'); expect(source.attachments).toEqual([attachment]); expect(source.context.instructionsText).toBe('retained context'); expect(source.pendingSend).toBe(null);
    expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' model is a real modal and compact remains claimed on draft without Host fallback', async () => {
    const { app, fixture } = await launch(platform, '/compact');
    await app.press('id:send'); expect(fixture.stats().creates).toBe(0); expect(app.value('id:new-session-composer')).toBe('/compact');
    await app.clear('id:new-session-composer'); await app.type('id:new-session-composer', '/model retained'); await app.press('id:send');
    await app.waitFor('id:new-session-selection-search'); expect(app.value('id:new-session-composer')).toBe('/model retained'); expect(fixture.stats().creates).toBe(0); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' native edits during compiler await are revision-fenced before creation', async () => {
    const { app, fixture } = await launch(platform, '/explore'); fixture.holdMagic();
    const sending = app.press('id:send'); await app.waitUntil(() => fixture.magicWaiting());
    await app.clear('id:new-session-composer'); await app.type('id:new-session-composer', '/explore'); fixture.resolveMagic(); await sending;
    await app.waitUntil(() => app.enabled('id:send')); expect(fixture.stats().creates).toBe(0); expect(app.value('id:new-session-composer')).toBe('/explore'); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' unknown creation keeps the actual source page and never repeats create', async () => {
    const { app, fixture } = await launch(platform, '/explore'); fixture.loseCreate();
    await app.press('id:send'); await app.waitFor('id:new-session-create-unknown');
    expect(fixture.stats().creates).toBe(1); expect(fixture.stats().prompts.length).toBe(0); expect(app.value('id:new-session-composer')).toBe('/explore');
    expect(app.enabled('id:send')).toBe(false);
    const source = JSON.parse(app.storage()[sourceKey]); expect(source.pendingSend.localMagic.resourcePolicy).toBe('preserve'); expect(source.attachments).toEqual([attachment]);
  });
  test(platform + ' actual native Tab inserts magic without create; explicit Enter then runs the existing handoff', async () => {
    const { app, fixture } = await launch(platform, '/expl');
    await app.clear('id:new-session-composer'); await app.type('id:new-session-composer', '/expl'); await app.waitFor('id:command-explore'); await app.keyboard.press('tab');
    expect(app.value('id:new-session-composer')).toBe('/explore '); expect(fixture.stats().creates).toBe(0);
    await app.submit('id:new-session-composer'); await app.waitFor('text:complete'); expect(fixture.stats().creates).toBe(1); expect(fixture.stats().prompts.length).toBe(1); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' fifty native input events do not read command catalog/history or dispatch any request', async () => {
    const { app, fixture } = await launch(platform, 'draft'); await app.wait(350);
    const before = fixture.requests.length;
    await app.clear('id:new-session-composer'); await app.type('id:new-session-composer', 'x'.repeat(50));
    expect(fixture.requests.length).toBe(before); expect(fixture.stats().creates).toBe(0); expect(fixture.rejected).toEqual([]);
  });
}

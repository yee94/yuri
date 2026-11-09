import { expect, open, test } from 'nsh/test';

const composer = 'id:new-session-composer >> nth=0';

test('actual desktop new-session publishes one current owner, requires confirm and hands off the captured context under the same authority', async () => {
  const app = await open('desktop-git-dispatch-owner.fixture.tsx', { platform: 'macos', width: 1280, height: 900 });
  await app.waitFor('text:active:/fixture/project');
  await app.waitUntil(() => app.value(composer) === 'Existing local draft');
  expect(app.shows('text:intents:0')).toBe(true);
  await app.press('id:git-owner-toggle'); await app.waitFor('text:none');
  await app.press('id:git-owner-toggle'); await app.waitFor('text:active:/fixture/project');
  await app.press('id:git-owner-stage'); await app.waitFor('text:requires-confirmation');
  expect(app.value(composer)).toBe('Existing local draft');
  await app.press('id:git-owner-audit');
  expect(app.texts().join('\n')).toContain('"creates":0');
  await app.press('id:git-owner-confirm'); await app.waitFor('text:staged');
  await app.waitUntil(() => app.value(composer) === 'Captured visible request');
  expect(app.value(composer)).not.toContain('Captured hidden instructions');
  await app.type(composer, ' edited');
  await app.waitUntil(() => app.texts().some(value => value.startsWith('intents:') && value !== 'intents:0'));
  await app.submit(composer); await app.waitFor('text:complete');
  await app.press('id:git-owner-audit');
  expect(app.texts().join('\n')).toContain('"creates":1');
  expect(app.texts().join('\n')).toContain('Captured hidden instructions\\nGit conflict context (JSON)');
  expect(app.texts().join('\n')).toContain('Captured diff');
  expect(app.texts().join('\n')).not.toContain('new-session-handoff-scope-mismatch');
});

test('actual iOS page restores the legacy unpartitioned draft and publishes no desktop owner or initial-context overwrite', async () => {
  const app = await open('desktop-git-dispatch-owner.fixture.tsx', { platform: 'ios', width: 390, height: 844 });
  await app.waitUntil(() => app.value(composer) === 'Existing local draft');
  expect(app.shows('text:none')).toBe(true); expect(app.shows('text:intents:0')).toBe(true);
  await app.press('id:git-owner-stage');
  expect(app.value(composer)).toBe('Existing local draft');
  expect(app.shows('text:idle')).toBe(true);
  await app.press('id:git-owner-audit'); expect(app.texts().join('\n')).toContain('"creates":0');
});

test('retained inactive desktop root becomes writable on its first activation', async () => {
  const app = await open('desktop-git-dispatch-owner-activation.fixture.tsx', { platform: 'macos', width: 1280, height: 900 });
  await app.waitFor('id:activate-draft'); expect(app.shows('id:new-session-project')).toBe(false);
  await app.press('id:activate-draft');
  await app.waitFor('id:new-session-project'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.type('id:new-session-composer', 'First activation stays writable');
  expect(app.value('id:new-session-composer')).toBe('First activation stays writable');
});

test('stable identity lease renewal keeps the draft and a same-ID origin/authorization change never adopts its bytes', async () => {
  const app = await open('desktop-git-dispatch-owner-activation.fixture.tsx', { platform: 'macos', width: 1280, height: 900 });
  await app.press('id:activate-draft'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.type('id:new-session-composer', 'Only initial identity');
  await app.press('id:activation-lease'); await app.waitFor('text:lease-done'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  expect(app.value('id:new-session-composer')).toBe('Only initial identity'); await app.type('id:new-session-composer', ' after lease');
  await app.press('id:activation-authorization'); await app.waitFor('text:authorization-done'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.waitUntil(() => app.value('id:new-session-composer') === ''); await app.type('id:new-session-composer', 'Only different authorization');
  await app.press('id:activation-restore'); await app.waitFor('text:restore-done'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.waitUntil(() => app.value('id:new-session-composer') === 'Only initial identity after lease');
  await app.press('id:activation-origin'); await app.waitFor('text:origin-done'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.waitUntil(() => app.value('id:new-session-composer') === ''); await app.type('id:new-session-composer', 'Only different origin');
  await app.press('id:activation-restore'); await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.waitUntil(() => app.value('id:new-session-composer') === 'Only initial identity after lease');
});

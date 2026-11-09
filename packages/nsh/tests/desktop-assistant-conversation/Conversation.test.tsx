import { expect, open, test, type App } from 'nsh/test';

type Frame = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } }; pagePosition: { x: number; y: number } };
type Report = { editorMounts: number; editorRefs: number; messageMounts: number; cardRenders: number; fileRenders: number; contentReads: number; avatarSeedReads: number; width: number; height: number; frames: { input: Frame; surface: Frame; footer: Frame; user: Frame } };
async function snapshot(app: App, measure = false): Promise<Report> {
  const previous = app.texts().find(text => text.startsWith('report:{'));
  if (measure) await app.press('id:measure'); else await app.host.send('assistant-layout.control', { action: 'snapshot' });
  await app.waitUntil(() => app.texts().some(text => text.startsWith('report:{') && text !== previous));
  return JSON.parse(app.texts().find(text => text.startsWith('report:{'))!.slice(7));
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: Web contact inline composer is 76pt, 48pt literal editor, no Session tool band`, async () => {
    const app = await open('../../desktop-assistant-conversation-fixture.tsx', { platform, width: 1068, height: 832, reducedMotion: true });
    const value = await snapshot(app, true);
    expect(value.frames.input.bounds.size.height).toBe(48);
    expect(value.frames.surface.bounds.size.height).toBe(50);
    expect(value.frames.footer.bounds.size.height).toBe(76);
    expect(value.frames.surface.bounds.size.width).toBe(752);
    expect(value.frames.input.bounds.size.width).toBe(674);
    expect(value.frames.input.pagePosition.y).toBe(value.frames.surface.pagePosition.y + 1);
    expect(value.frames.footer.pagePosition.y + 10).toBe(value.frames.surface.pagePosition.y);
    expect(value.width).toBe(752); expect(value.height).toBe(76);
    for (const id of ['desktop-chat-composer-actions', 'selection', 'dictation', 'stop']) expect(app.shows(`id:${id}`)).toBe(false);
    expect(app.shows('id:overlay-slot')).toBe(true);
    await app.setColorScheme('dark'); expect(app.shows('id:desktop-assistant-composer-fill')).toBe(true);
    await app.setColorScheme('light'); expect(app.shows('id:desktop-assistant-composer-fill')).toBe(false);
  });
  test(`${platform}: original mixed part order, first-run avatar only, user literal text and all three card slots`, async () => {
    const app = await open('../../desktop-assistant-conversation-fixture.tsx', { platform, width: 1068, height: 1100, reducedMotion: true });
    expect(app.shows('id:desktop-assistant-avatar-first')).toBe(true);
    expect(app.shows('id:desktop-assistant-avatar-second')).toBe(false);
    expect(app.shows('id:desktop-assistant-avatar-user')).toBe(false);
    expect(app.shows('id:desktop-assistant-markdown-first-0')).toBe(true);
    expect(app.shows('id:desktop-assistant-literal-user-0')).toBe(true);
    expect(app.texts()).toContain('**Literal** user text, not Markdown. A long line that wraps inside the 82 percent and 480 point maximum bubble.');
    const ordered = app.texts().filter(text => ['Session receipt', 'After session card', 'source.txt', 'Assistant receipt', 'Schedule receipt'].includes(text));
    expect(ordered).toEqual(['Session receipt', 'After session card', 'source.txt', 'Assistant receipt', 'Schedule receipt']);
    const value = await snapshot(app); expect(value.cardRenders).toBe(3); expect(value.fileRenders).toBe(1);
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0);
  });
  test(`${platform}: 50 draft edits and unrelated updates do zero message/part/avatar/card/I/O work; resize and modal keep Input`, async () => {
    const app = await open('../../desktop-assistant-conversation-fixture.tsx', { platform, width: 1068, height: 1100, reducedMotion: true });
    const before = await snapshot(app);
    for (let index = 0; index < 50; index++) { await app.type('id:assistant-editor', 'x'); await app.host.send('assistant-layout.control', { action: 'unrelated', value: index }); }
    const typed = await snapshot(app);
    for (const key of ['editorMounts', 'editorRefs', 'messageMounts', 'contentReads', 'avatarSeedReads', 'cardRenders', 'fileRenders'] as const) expect(typed[key]).toBe(before[key]);
    expect(app.value('id:assistant-editor')).toHaveLength(50);
    await app.setViewport(800, 700); await app.setViewport(1400, 900);
    for (let index = 0; index < 6; index++) { await app.press('id:modal'); expect(app.enabled('id:assistant-editor')).toBe(index % 2 !== 0); }
    const after = await snapshot(app);
    for (const key of ['editorMounts', 'editorRefs', 'messageMounts', 'contentReads', 'cardRenders', 'fileRenders'] as const) expect(after[key]).toBe(before[key]);
    expect(app.value('id:assistant-editor')).toHaveLength(50);
    await app.press('id:send'); expect(app.texts()).toContain('calls:1');
    expect(app.requests()).toHaveLength(0); expect(app.host.calls()).toHaveLength(0);
  });
  test(`${platform}: real status slots, empty/peer/error/legacy and unsupported attachment are explicit`, async () => {
    const app = await open('../../desktop-assistant-conversation-fixture.tsx', { platform, width: 1068, height: 1100, reducedMotion: true });
    expect(app.shows('id:desktop-assistant-typing')).toBe(false);
    await app.press('id:busy'); expect(app.shows('id:desktop-assistant-typing')).toBe(true); expect(app.shows('id:desktop-assistant-sending-user')).toBe(true);
    await app.press('id:busy'); expect(app.shows('id:desktop-assistant-typing')).toBe(false);
    await app.press('id:peer'); expect(app.shows('id:desktop-assistant-time-peer')).toBe(true); expect(app.shows('id:desktop-assistant-avatar-peer')).toBe(true); expect(app.texts().some(text => text.includes('Peer contact'))).toBe(true);
    await app.press('id:error'); expect(app.shows('id:desktop-assistant-error-error')).toBe(true); expect(app.shows('id:desktop-assistant-avatar-error')).toBe(false);
    await app.press('id:legacy'); expect(app.texts()).toContain('Legacy text');
    await app.type('id:assistant-editor', 'retained'); await app.press('id:empty'); expect(app.shows('id:desktop-assistant-empty')).toBe(true);
    expect(app.value('id:assistant-editor')).toBe('retained');
    await app.press('id:attach'); expect(app.shows('id:attachment-placeholder')).toBe(true); expect(app.shows('id:feedback-slot')).toBe(true);
    const value = await snapshot(app, true); expect(value.frames.footer.bounds.size.height).toBeGreaterThan(76); expect(value.editorMounts).toBe(1);
    expect(app.requests()).toHaveLength(0);
  });
}

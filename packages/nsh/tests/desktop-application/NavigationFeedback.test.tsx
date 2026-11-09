import { expect, open, test } from 'nsh/test';

const restore = 'id:desktop-navigation-restore-feedback', write = 'id:desktop-navigation-write-feedback';
const readButton = 'id:desktop-navigation-restore-retry', writeButton = 'id:desktop-navigation-write-retry';
async function launch(platform, language = 'en') {
  const calls = [];
  const app = await open('./NavigationFeedback.tsx', { platform, width: 900, height: 600, host: { params: { language }, handlers: { 'navigation.test.feedback': event => { calls.push(event.lane); } } } });
  const control = event => app.host.send('navigation.test.feedback.control', event);
  const state = (restore, write = 'idle') => control({ action: 'state', restore, write });
  return { app, calls, control, state };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' feedback renders only explicit failures and never raw errors', async () => {
    const f = await launch(platform);
    for (const status of ['idle', 'loading', 'empty', 'restored', 'missing', 'superseded']) {
      await f.state(status); expect(f.app.shows(restore)).toBe(false); expect(f.app.shows(write)).toBe(false);
    }
    for (const status of ['error', 'blocked']) {
      await f.state(status, 'error'); expect(f.app.shows(restore)).toBe(true); expect(f.app.shows(write)).toBe(true);
      const texts = f.app.texts().join('\n'); expect(texts).not.toContain('/private'); expect(texts).not.toContain('secret body');
      expect(texts).toContain(status === 'blocked' ? 'Your last location cannot be restored right now.' : 'Could not restore your last location.');
    }
    await f.state('restored', 'pending'); expect(f.app.shows(restore)).toBe(false); expect(f.app.shows(write)).toBe(false);
    expect(f.calls).toEqual([]);
  });
  test(platform + ' retries exact read/write lane, disables both while inactive or busy, and safely settles rejection', async () => {
    const f = await launch(platform); await f.state('error', 'error');
    await f.control({ action: 'active', value: false });
    expect(f.app.enabled(readButton)).toBe(false); expect(f.app.enabled(writeButton)).toBe(false);
    await f.control({ action: 'active', value: true }); await f.control({ action: 'hold' });
    await f.app.press(readButton); expect(f.calls).toEqual(['restore']);
    expect(f.app.enabled(readButton)).toBe(false); expect(f.app.enabled(writeButton)).toBe(false);
    await f.control({ action: 'release' }); expect(f.app.enabled(writeButton)).toBe(true);
    await f.control({ action: 'reject' }); await f.app.press(writeButton);
    expect(f.calls).toEqual(['restore', 'write']); expect(f.app.enabled(readButton)).toBe(true);
    expect(f.app.shows(restore)).toBe(true); expect(f.app.shows(write)).toBe(true);
    expect(f.app.texts().join('\n')).not.toContain('/private');
    await f.state('blocked'); await f.app.press(readButton); expect(f.calls).toEqual(['restore', 'write', 'restore']);
  });
}
for (const [language, sample] of [
  ['en', 'Could not restore'], ['zh-CN', '未能恢复'], ['zh-TW', '無法還原'], ['ja', '復元できませんでした'], ['ko', '복원하지 못했습니다'],
  ['fr', 'Impossible de restaurer'], ['es', 'No se pudo restaurar'], ['pl', 'Nie udało się przywrócić'], ['pt-BR', 'Não foi possível restaurar'], ['uk', 'Не вдалося відновити'],
]) test('feedback uses actual ' + language + ' dictionary', async () => {
  const f = await launch('macos', language); await f.state('error', 'error');
  expect(f.app.texts().join('\n')).toContain(sample);
  expect(f.app.texts().join('\n')).not.toContain('sessions.navigation.');
});

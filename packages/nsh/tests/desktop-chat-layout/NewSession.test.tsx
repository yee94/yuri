import { expect, open, test, type App } from 'nsh/test';

type Frame = { bounds: { size: { width: number; height: number } }; pagePosition: { x: number; y: number } };
async function metrics(app: App): Promise<{ pane: Frame; content: Frame }> {
  const previous = app.texts().find(text => text.startsWith('result:{'));
  await app.host.send('layout.measure', {});
  await app.waitUntil(() => app.texts().some(text => text.startsWith('result:{') && text !== previous));
  return JSON.parse(app.texts().find(text => text.startsWith('result:{'))!.slice(7));
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: new-session uses the Session column at every viewport and keeps its draft`, async () => {
    const app = await open('./NewSession.tsx', { platform, width: 1068, height: 832, host: { handlers: { 'layout.measure': null } } });
    await app.waitFor('id:draft');
    await app.type('id:draft', 'Keep this local draft');
    for (const [width, height, expected] of [[1068, 832, 752], [1700, 900, 912], [800, 700, 508], [680, 620, 388], [1068, 832, 752]]) {
      await app.setViewport(width, height);
      const value = await metrics(app);
      expect(value.content.bounds.size.width).toBe(expected);
      expect(value.content.pagePosition.x - value.pane.pagePosition.x).toBe((value.pane.bounds.size.width - expected) / 2);
      expect(app.value('id:draft')).toBe('Keep this local draft');
    }
    expect(app.requests()).toEqual([]);
  });
}

test('iOS new-session keeps its original unpadded mobile layout', async () => {
  const app = await open('./NewSession.tsx', { platform: 'ios', width: 800, height: 700 });
  const value = await metrics(app);
  expect(app.shows('id:desktop-new-session-layout')).toBe(false);
  expect(value.content.bounds.size.width).toBe(value.pane.bounds.size.width);
  expect(value.content.pagePosition.x).toBe(value.pane.pagePosition.x);
  expect(app.requests()).toEqual([]);
});

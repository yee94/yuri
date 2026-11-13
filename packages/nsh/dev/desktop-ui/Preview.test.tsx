import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: production home and Session render without credentials or a product Host`, async () => {
    const app = await open('./App.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:new-session-composer');
    await app.waitUntil(() => app.enabled('id:new-session-composer'));
    expect(app.shows('id:desktop-workspace')).toBe(true);
    await app.press('text:Session UI preview');
    await app.waitFor('id:transcript');
    await app.waitFor('text:Verify the Session layout without sending a real request.');
    await app.waitUntil(() => app.texts().some(text => text.includes('Native Session preview')));
    expect(app.count('id:composer')).toBe(1);
    expect(app.count('id:transcript')).toBe(1);
    expect(app.shows('id:root-error-feedback')).toBe(false);
    expect(app.requests()).toEqual([]);
  });
}

import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} a held native decision disables controls without destroying drafts`, async () => {
    const app = await open('./CloseCommit.tsx', { platform, width: 1000, height: 700 });
    await app.press('id:fixture-close');
    await app.waitFor('text:commit-locked');
    expect(app.enabled('id:fixture-settings-input')).toBe(false);
    expect(app.enabled('id:fixture-close')).toBe(false);
    expect(app.value('id:fixture-settings-input')).toBe('retained settings draft');
    await app.press('id:fixture-native-reject');
    await app.waitFor('text:editable');
    expect(app.enabled('id:fixture-settings-input')).toBe(true);
    await app.type('id:fixture-settings-input', ' still writable');
    expect(app.value('id:fixture-settings-input')).toBe('retained settings draft still writable');
  });
}

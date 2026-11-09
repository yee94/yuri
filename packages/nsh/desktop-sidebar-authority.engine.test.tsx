import { expect, open, test, type App } from 'nsh/test';

async function audit(app: App) {
  const prior = app.texts().find(text => text.startsWith('authority-audit:'));
  await app.press('id:authority-audit');
  await app.waitUntil(() => app.texts().some(text => text.startsWith('authority-audit:') && text !== prior));
  const text = app.texts().find(text => text.startsWith('authority-audit:'))!;
  const match = /^authority-audit:(\d+):(.*)$/.exec(text)!;
  return { scans: Number(match[1]), requests: JSON.parse(match[2]!) as Array<{ path: string; method: string }> };
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: root snapshot and real AssistantHome are consumed by the original sidebar`, async () => {
    const app = await open('./desktop-sidebar-authority-fixture.tsx', { platform, width: 1100, height: 900 });
    await app.waitFor('id:desktop-assistant-avatar'); await app.waitFor('text:99+');
    expect(app.shows('id:projects-indicator-sidebar-assistants-running')).toBe(true);
    expect(app.shows('id:projects-indicator-sidebar-schedules-running')).toBe(true);
    await app.hover('id:desktop-session-/workspace-root'); expect(app.shows('id:desktop-children-root')).toBe(true);
    await app.press('id:authority-start-budget'); const before = await audit(app);
    for (let index = 0; index < 50; index++) await app.type('id:authority-unrelated-input', `input ${index}`);
    const after = await audit(app); expect(after.scans).toBe(0);
    expect(after.requests.filter(row => row.path.startsWith('/api/')).length).toBe(before.requests.filter(row => row.path.startsWith('/api/')).length);
    await app.press('id:authority-home-disable'); await app.waitFor('id:assistant-home');
    await app.waitUntil(() => !app.shows('id:desktop-assistant-avatar'));
    expect(app.shows('id:desktop-assistant-unread')).toBe(false);
    expect(app.shows('id:projects-indicator-sidebar-assistants-running')).toBe(false);
    expect(app.shows('id:projects-indicator-sidebar-schedules-running')).toBe(true);
    const adopted = await audit(app); expect(adopted.requests.filter(row => row.path === '/api/yuri/assistants/snapshot').length).toBe(2);
    expect(adopted.requests.some(row => row.method !== 'GET')).toBe(false);
  });
  test(`${platform}: actual folder hook opens a local owner and uses the original mounted folder writer after first create`, async () => {
    const app = await open('./desktop-sidebar-authority-fixture.tsx', { platform, width: 1100, height: 900 });
    await app.waitFor('id:desktop-folder-folder'); await app.hover('id:desktop-folder-folder');
    await app.press('role:button[New session in Synthetic folder]'); await app.waitFor('id:authority-folder-input');
    let state = await audit(app); expect(state.requests.some(row => row.method !== 'GET')).toBe(false);
    await app.type('id:authority-folder-input', 'First input'); await app.press('id:authority-folder-send');
    await app.waitFor('text:handoff:created:acknowledged');
    await app.press('id:authority-folder-send'); state = await audit(app);
    expect(state.requests.filter(row => row.path === '/api/session' && row.method === 'POST').length).toBe(1);
    expect(state.requests.filter(row => row.path === '/api/session-folders' && row.method === 'POST').length).toBe(1);
  });
}

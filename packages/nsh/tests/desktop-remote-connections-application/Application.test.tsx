import { expect, open, test } from 'nsh/test';
import { createRemoteConnectionsApplicationHost, sshMethods } from './host.js';

async function remotePage(app) {
  await app.waitFor('id:new-session-composer');
  await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
  await app.type('id:desktop-settings-search', 'Remote instances');
  await app.press('id:desktop-settings-page:remote-instances');
  await app.waitFor('id:remote-instances-saved');
}
function localOnly(fixture) {
  expect(fixture.nativeCalls.every(call => sshMethods.includes(call.name))).toBe(true);
  expect(fixture.nativeCalls.filter(call => call.name.endsWith('.capabilities') || call.name.endsWith('.read')).every(call => Object.keys(call.input).length === 0)).toBe(true);
  expect(fixture.nativeCalls.every(call => !('expectedHost' in call.input) && !('windowID' in call.input))).toBe(true);
  expect(fixture.nativeCalls.filter(call => call.name.endsWith('.start') || call.name.endsWith('.cancel') || call.name.endsWith('.remove'))).toEqual([]);
  expect(fixture.runtimeCalls.every(call => call.method === 'GET' && ['desktop-fixture', 'other-fixture'].includes(call.expectedHost?.hostID))).toBe(true);
  expect(fixture.rejected.filter(call => call.message !== 'lost_ack')).toEqual([]);
}

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} real App getter consumes asynchronously discovered native port through Settings route`, async () => {
    const fixture = createRemoteConnectionsApplicationHost();
    const app = await open('./App.tsx', { platform, width: 1440, height: 1200, host: { handlers: fixture.handlers } });
    await remotePage(app);
    expect(app.shows('id:remote-instances-connect')).toBe(true);
    await app.waitFor('id:desktop-ssh-fixture');
    expect(app.count('id:desktop-ssh-owner')).toBe(1);
    await app.press('id:desktop-ssh-native-ready'); await app.waitFor('id:desktop-ssh-sync-unavailable');
    for (const id of ['desktop-ssh-sync-push', 'desktop-ssh-sync-pull', 'desktop-ssh-history-push', 'desktop-ssh-history-pull', 'desktop-ssh-select-config']) expect(app.count('id:' + id)).toBe(0);
    expect(app.enabled('id:desktop-ssh-connect')).toBe(false);
    expect(app.value('id:desktop-ssh-host')).toBe('local-service.example.invalid');
    expect(fixture.nativeCalls.filter(call => call.name === 'desktop.ssh.read').length).toBeGreaterThan(0);
    localOnly(fixture);
  });

  test(`${platform} unsupported native service retains original remote-instance page and existing navigation`, async () => {
    const fixture = createRemoteConnectionsApplicationHost('unsupported');
    const app = await open('./App.tsx', { platform, width: 1440, height: 1200, host: { handlers: fixture.handlers } });
    await remotePage(app);
    expect(app.shows('id:desktop-ssh-owner')).toBe(false);
    expect(app.shows('id:desktop-ssh-unavailable')).toBe(true);
    expect(app.enabled('id:desktop-ssh-add')).toBe(false);
    expect(app.enabled('id:desktop-ssh-discovery-retry')).toBe(true);
    expect(app.shows('id:remote-instances-saved')).toBe(true); expect(app.shows('id:remote-instances-connect')).toBe(true);
    expect(app.shows('id:remote-clients-add')).toBe(true);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await remotePage(app);
    expect(app.shows('id:remote-instances-saved')).toBe(true); expect(app.shows('id:desktop-ssh-owner')).toBe(false);
    expect(fixture.nativeCalls.map(call => call.name)).toEqual(['desktop.ssh.capabilities']);
    localOnly(fixture);
  });

  test(`${platform} starting capability keeps SSH visible and explicit discovery retry creates the single real panel`, async () => {
    const fixture = createRemoteConnectionsApplicationHost('starting');
    const app = await open('./App.tsx', { platform, width: 1440, height: 1200, host: { handlers: fixture.handlers } });
    await remotePage(app); await app.waitFor('id:desktop-ssh-unavailable');
    expect(app.enabled('id:desktop-ssh-add')).toBe(false);
    expect(fixture.nativeCalls.map(call => call.name)).toEqual(['desktop.ssh.capabilities']);
    fixture.support(); await app.press('id:desktop-ssh-discovery-retry');
    await app.waitFor('id:desktop-ssh-fixture'); expect(app.count('id:desktop-ssh-owner')).toBe(1);
    expect(app.shows('id:desktop-ssh-discovery')).toBe(false);
    await app.press('id:desktop-ssh-fixture'); await app.type('id:desktop-ssh-label', ' same owner');
    await app.press('id:desktop-ssh-refresh'); expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH same owner');
    expect(app.count('id:desktop-ssh-owner')).toBe(1);
    localOnly(fixture);
  });

  test(`${platform} actual Settings dirty guard cancels close/navigation and retains native draft`, async () => {
    const fixture = createRemoteConnectionsApplicationHost();
    const app = await open('./App.tsx', { platform, width: 1440, height: 1200, host: { handlers: fixture.handlers } });
    await remotePage(app); await app.waitFor('id:desktop-ssh-fixture'); await app.press('id:desktop-ssh-fixture');
    await app.type('id:desktop-ssh-label', ' retained draft');
    let confirmations = 0;
    app.onDialog(() => { confirmations++; return 'Cancel'; });
    await app.press('id:desktop-settings-close');
    expect(app.shows('id:desktop-settings-window')).toBe(true); expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH retained draft');
    await app.paste('id:desktop-settings-search', { text: 'Saved connections' });
    await app.press('id:desktop-settings-page:instances');
    expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH retained draft'); expect(confirmations).toBe(2);
    await app.host.send('desktop.window.closeRequested', { ticket: 'ssh-dirty', windowID: 'window', generation: 1, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'ssh-dirty', approved: false });
    expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH retained draft'); expect(confirmations).toBe(3);
    expect(fixture.nativeCalls.filter(call => call.name === 'desktop.ssh.save')).toEqual([]);
    localOnly(fixture);
  });

  test(`${platform} exact fake native unknown save guards Settings and read-only receipt recovery never replays`, async () => {
    const fixture = createRemoteConnectionsApplicationHost();
    const app = await open('./App.tsx', { platform, width: 1440, height: 1200, host: { handlers: fixture.handlers } });
    await remotePage(app); await app.waitFor('id:desktop-ssh-fixture'); await app.press('id:desktop-ssh-fixture');
    await app.type('id:desktop-ssh-label', ' fake committed'); fixture.loseSave();
    await app.press('id:desktop-ssh-save');
    await app.waitFor('id:desktop-ssh-unknown');
    expect(app.enabled('id:desktop-settings-close')).toBe(false);
    await app.host.send('desktop.window.closeRequested', { ticket: 'ssh-pending', windowID: 'window', generation: 1, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'ssh-pending', approved: false });
    expect(fixture.nativeCalls.filter(call => call.name === 'desktop.ssh.save').length).toBe(1);
    await app.press('id:desktop-ssh-refresh'); expect(app.shows('id:desktop-ssh-unknown')).toBe(true);
    fixture.recoverReceipt(); await app.press('id:desktop-ssh-refresh'); await app.waitFor('id:desktop-ssh-unknown', { state: 'gone' });
    await app.waitUntil(() => app.enabled('id:desktop-settings-close')); app.onDialog(() => 'Discard');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await remotePage(app); await app.waitFor('id:desktop-ssh-fixture'); await app.press('id:desktop-ssh-fixture');
    expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH fake committed');
    const saves = fixture.nativeCalls.filter(call => call.name === 'desktop.ssh.save'); expect(saves.length).toBe(1);
    expect(Object.keys(saves[0].input).sort()).toEqual(['instance', 'requestID', 'revision']);
    expect(saves[0].input.revision).toBe(1);
    localOnly(fixture);
  });
}

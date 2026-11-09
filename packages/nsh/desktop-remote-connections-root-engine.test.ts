import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const engine = process.env.NSH_REMOTE_CONNECTIONS_NATIVE_ENGINE === '1' ? test : test.skip;
engine.each(['macos', 'windows'].flatMap(platform => ['settings', 'header'].map(source => [platform, source])))('root-owned pending/unknown survives actual %s %s presentation teardown', (platform, source) => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-ssh-root-'));
  try {
    const methods = ['capabilities', 'read', 'save', 'remove', 'start', 'cancel'].map(name => `desktop.ssh.${name}`);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Synthetic SSH root admission', id: 'example.yuri.ssh-root', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: [...methods, 'fixture.control'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import { mount, signal, cleanup, host, View, Text } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createNativeDesktopRemoteConnectionsRoot } from ${JSON.stringify(path.join(root, 'desktop-remote-connections-root'))};
import { createDesktopSettingsContentProtection } from ${JSON.stringify(path.join(root, 'desktop-settings-content-core'))};
import { DesktopSettingsPublisher } from ${JSON.stringify(path.join(root, 'desktop-settings-publisher'))};
import { language } from ${JSON.stringify(path.join(root, 'i18n'))};
function App() {
 language.set('en');
 const settings = signal(false), header = signal(false), draft = signal('Keep draft'), version = signal(0), audit = signal(''), writer = signal('writable'), control = signal('none');
 const remote = createNativeDesktopRemoteConnectionsRoot({ current: () => true, runtimeReady: () => true, connectionMutation: async mutation => {
   if (!mutation.current() || !mutation.canLeave()) return { status: 'stale' };
   if (mutation.source === 'settings' && !await protection.requestLeave()) return { status: 'stale' };
   writer.set('released'); return mutation.dispatch();
 } });
 cleanup(remote.dispose); cleanup(remote.subscribe(() => version.set(version() + 1)));
 cleanup(host.on('fixture.audit', value => audit.set(JSON.stringify(value))));
 const protection = createDesktopSettingsContentProtection({ page: 'remote-instances', active: settings, changed: () => {}, unavailable: async () => {} });
 async function command(name) { await host.call('fixture.control', { name }); control.set(name); }
 return <View class="flex-1 gap-2">
  <Text>{'calls=' + audit()}</Text><Text>{'control=' + control()}</Text><Text>{'writer=' + writer()}</Text>
  <Text>{'root=' + (version() >= 0 && remote.guard.canLeave()) + ';phase=' + (remote.snapshot().connection?.phase || 'none')}</Text>
  <Button testID="settings-open" onPress={() => settings.set(true)}><Text>Settings</Text></Button>
  <Button testID="force-unmount" onPress={() => { settings.set(false); header.set(false); }}><Text>Force presentation teardown</Text></Button>
  <Button testID="header-open" onPress={() => header.set(true)}><Text>Header</Text></Button>
  <If when={header()}><Button testID="header-connect" onPress={() => { const row = remote.snapshot().state?.snapshot?.instances[0]; if (row) void remote.connectFromHeader(row, { current: header }); }}><Text>Connect</Text></Button></If>
  <Button testID="release" onPress={() => { void command('release'); }}><Text>Release start</Text></Button>
  <Button testID="recover" onPress={async () => { await command('recover'); await remote.refresh(); }}><Text>Read-only recovery</Text></Button>
  <Input testID="composer" value={draft()} onChange={event => draft.set(event.value)} />
  <If when={settings()}><DesktopSettingsPublisher.Provider value={protection}>{remote.slot({ active: true })}</DesktopSettingsPublisher.Provider></If>
 </View>;
}
mount(App);`);
    writeFileSync(path.join(directory, 'host.mjs'), readFileSync(path.join(root, 'desktop-remote-connections-native-test-host.mjs'), 'utf8').replace(/^export /gm, '') + `
export function createHost(player) {
 const memory = new StrictNativeSshHost(); let release, withheld;
 const gate = new Promise(resolve => { release = resolve; });
 return { async call(name, input) {
  if (name === 'fixture.control') {
   memory.exact(input, ['name']);
   if (input.name === 'release') release();
   else if (input.name === 'recover') memory.value = withheld;
   else throw new Error('unexpected_control');
   return { ok: true };
  }
  if (name === 'desktop.ssh.start') {
   const promise = memory.call(name, input, { timeout: 30000 });
   player.hostEvent('fixture.audit', memory.calls.map(row => row.name));
   const result = await promise; withheld = result; memory.value = { ...result, receipts: [], statuses: [] };
   await gate; throw new Error('lost_start_ACK');
  }
  try { return await memory.call(name, input, { timeout: name === 'desktop.ssh.capabilities' ? 5000 : 30000 }); }
  finally { player.hostEvent('fixture.audit', memory.calls.map(row => row.name)); }
 } };
}`);
    writeFileSync(path.join(directory, 'Root.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('original root owns protection, presentation does not', async () => {
 const app = await open('./App.tsx', { platform: ${JSON.stringify(platform)}, width: 1100, height: 1900 });
 const calls = () => JSON.parse(app.texts().find(value => value.startsWith('calls=[')).slice(6));
 await app.waitFor('text:calls=["desktop.ssh.capabilities"]');
 await app.press('id:header-open'); await app.type('id:composer', 'x'.repeat(50));
 expect(calls()).toEqual(['desktop.ssh.capabilities']);
 await app.press('id:force-unmount'); await app.press('id:settings-open'); await app.waitFor('id:desktop-ssh-fixture');
 if (${JSON.stringify(source)} === 'settings') { await app.press('id:desktop-ssh-fixture'); await app.press('id:desktop-ssh-connect'); }
 else { await app.press('id:force-unmount'); await app.press('id:header-open'); await app.press('id:header-connect'); }
 await app.waitFor('text:root=false;phase=dispatching'); await app.waitFor('text:writer=released');
 await app.press('id:force-unmount'); expect(app.count('id:desktop-ssh-owner')).toBe(0);
 await app.press('id:release'); await app.waitFor('text:root=false;phase=unknown');
 const before = calls(); await app.type('id:composer', 'y'.repeat(50));
 expect(calls()).toEqual(before); expect(app.value('id:composer')).toBe('Keep draft' + 'x'.repeat(50) + 'y'.repeat(50));
 await app.press('id:header-open'); await app.press('id:header-connect'); expect(calls()).toEqual(before);
 await app.press('id:recover'); await app.waitFor('text:root=true;phase=settled');
 expect(app.shows('text:writer=released')).toBe(true); expect(calls().filter(name => name === 'desktop.ssh.start').length).toBe(1);
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Root.test.tsx', '--web-host', 'host.mjs'], { cwd: directory, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

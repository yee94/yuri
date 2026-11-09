import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const engine = process.env.NSH_REMOTE_CONNECTIONS_NATIVE_ENGINE === '1' ? test : test.skip;
engine.each(['macos', 'windows'].flatMap(platform => ['ready', 'denied', 'partial', 'late'].map(mode => [platform, mode])))('production native SSH loader + actual slot (%s %s headless)', (platform, mode) => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-ssh-native-'));
  try {
    const methods = ['capabilities', 'read', 'save', 'remove', 'start', 'cancel'].map(name => `desktop.ssh.${name}`);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Synthetic native SSH', id: 'example.yuri.native-ssh', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: [...methods, 'fixture.ssh.control'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-remote-connections-native-fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'host.mjs'), readFileSync(path.join(root, 'desktop-remote-connections-native-test-host.mjs'), 'utf8').replace(/^export /gm, '') + `
export function createHost(player) {
  const memory = new StrictNativeSshHost(); let release;
  const mode = ${JSON.stringify(mode)};
  if (mode === 'denied') memory.capabilityError = new Error('ERR_ACCESS_DENIED');
  if (mode === 'partial') memory.capability = { version: 1, connections: { supported: true, phase: 'ready', maxPending: 16 } };
  if (mode === 'late') memory.capabilityGate = new Promise(resolve => { release = resolve; });
  return { async call(name, input) {
    if (name === 'fixture.ssh.control') {
      memory.exact(input, ['name']);
      if (input.name === 'lose-save') memory.loseNextSave = true;
      else if (input.name === 'recover-read-failure') { memory.value = memory.withheld; memory.failNextRead = true; }
      else if (input.name === 'hold') memory.operationGate = new Promise(resolve => { release = resolve; });
      else if (input.name === 'release') { memory.operationGate = undefined; release?.(); }
      else throw Error('invalid_fixture_command');
      return { ok: true };
    }
    try { return await memory.call(name, input, { timeout: name === 'desktop.ssh.capabilities' ? 5000 : 30000 }); }
    finally { player.hostEvent('fixture.ssh.calls', memory.calls.map(row => row.name)); }
  } };
}`);
    writeFileSync(path.join(directory, 'Native.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('connection-only real production loader and slot', async () => {
  const app = await open('./App.tsx', { platform: ${JSON.stringify(platform)}, width: 1100, height: 1900 });
  const audit = () => JSON.parse(app.texts().find(value => value.startsWith('["desktop.ssh.')));
  const mode = ${JSON.stringify(mode)};
  if (mode === 'denied' || mode === 'partial') {
    await app.waitFor('id:fixture-native-unavailable');
    expect(app.shows('id:desktop-ssh-owner')).toBe(false);
    expect(audit()).toEqual(['desktop.ssh.capabilities']); return;
  }
  if (mode === 'late') {
    await app.press('id:fixture-native-dispose'); await app.waitFor('text:control=dispose');
    await app.press('id:fixture-native-release'); await app.waitFor('text:control=release'); await app.wait(100);
    expect(app.shows('id:desktop-ssh-owner')).toBe(false);
    expect(audit()).toEqual(['desktop.ssh.capabilities']); return;
  }
  await app.waitFor('id:desktop-ssh-fixture'); await app.press('id:desktop-ssh-fixture');
  await app.type('id:desktop-ssh-label', ' local'); await app.waitFor('text:guard=ready;dirty=true;pending=false');
  await app.press('id:fixture-native-active'); expect(app.enabled('id:desktop-ssh-save')).toBe(false);
  expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH local');
  await app.press('id:fixture-native-active'); await app.press('id:fixture-native-hold'); await app.waitFor('text:control=hold');
  await app.press('id:desktop-ssh-save'); await app.waitFor('text:guard=ready;dirty=true;pending=true');
  await app.press('id:fixture-native-active'); expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH local');
  await app.press('id:fixture-native-active'); await app.press('id:fixture-native-release');
  await app.waitFor('text:guard=ready;dirty=false;pending=false');
    await app.press('id:desktop-ssh-check'); await app.waitFor('text:Done');
    await app.press('id:desktop-ssh-connect'); await app.waitFor('text:Ready');
   for (const id of ['desktop-ssh-select-config', 'desktop-ssh-sync-push', 'desktop-ssh-sync-pull', 'desktop-ssh-history-push', 'desktop-ssh-history-pull', 'desktop-ssh-sync-apply', 'desktop-ssh-sync-success']) expect(app.count('id:' + id)).toBe(0);
   await app.press('id:fixture-native-runtime'); await app.waitFor('text:current=true;runtimeReady=false');
   expect(app.enabled('id:desktop-ssh-cancel')).toBe(false);
   await app.press('id:fixture-native-runtime'); await app.waitFor('text:current=true;runtimeReady=true');
  expect(audit().every(name => ${JSON.stringify(methods)}.includes(name))).toBe(true);
  await app.press('id:desktop-ssh-cancel'); await app.waitFor('text:Idle');
  await app.type('id:desktop-ssh-label', ' unknown'); await app.press('id:fixture-native-lose-save'); await app.waitFor('text:control=lose-save');
  await app.press('id:desktop-ssh-save'); await app.waitFor('id:desktop-ssh-unknown');
  const saves = () => audit().filter(name => name === 'desktop.ssh.save').length;
  expect(saves()).toBe(2); expect(app.enabled('id:desktop-ssh-save')).toBe(false);
  await app.press('id:desktop-ssh-refresh'); await app.wait(100); expect(app.shows('id:desktop-ssh-unknown')).toBe(true); expect(saves()).toBe(2);
  await app.press('id:fixture-native-recover-read-failure'); await app.waitFor('text:control=recover-read-failure');
  await app.press('id:desktop-ssh-refresh'); await app.waitFor('id:desktop-ssh-error');
  expect(app.shows('text:snapshot=2;label=Fixture SSH local;busy=false;unknown=true')).toBe(true);
  await app.press('id:desktop-ssh-refresh'); await app.waitFor('text:snapshot=3;label=Fixture SSH local unknown;busy=false;unknown=false');
  expect(saves()).toBe(2); expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH local unknown');
   app.onDialog(() => 'Discard'); await app.press('id:desktop-ssh-fixture'); await app.waitFor('text:guard=ready;dirty=false;pending=false');
   app.onDialog(() => 'Remove'); await app.press('id:desktop-ssh-remove'); await app.wait(100);
   expect(app.count('id:desktop-ssh-fixture')).toBe(0);
   expect(audit().filter(name => name === 'desktop.ssh.remove').length).toBe(1);
   await app.press('id:fixture-native-dispose'); await app.waitFor('text:control=dispose');
  expect(audit().filter(name => name === 'desktop.ssh.cancel').length).toBe(1);
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Native.test.tsx', '--web-host', 'host.mjs'], { cwd: directory, encoding: 'utf8', timeout: 90_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

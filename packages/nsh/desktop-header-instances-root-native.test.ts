import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('actual native committed projection + unique remote root + services view on macOS/Windows headless', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-header-instances-root-'));
  try {
    const methods = ['capabilities', 'read', 'save', 'remove', 'start', 'cancel'].map(name => `desktop.ssh.${name}`);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Instance root fixture', id: 'example.yuri.instances-root', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: [...methods, 'fixture.instances.control'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-instances-root-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Instances.test.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-instances-root-headless.tsx'))};\n`);
    writeFileSync(path.join(directory, 'host.mjs'), readFileSync(path.join(root, 'desktop-remote-connections-native-test-host.mjs'), 'utf8').replace(/^export /gm, '') + `
export function createHost(player) {
  const memory = new StrictNativeSshHost();
  return { async call(name, input) {
    if (name === 'fixture.instances.control') {
      memory.exact(input, ['name']);
      if (input.name === 'bound') memory.value = { ...memory.value, statuses: [{ id:'fixture', attempt:1, requestID:'synthetic', phase:'ready', error:null, retry:0, running:false, connectionID:'fixture-connection' }] };
      else if (input.name === 'lose-start') memory.operationError = new Error('lost_ack');
      else throw new Error('Invalid fixture command');
      return { ok:true };
    }
    try { return await memory.call(name, input, { timeout:name === 'desktop.ssh.capabilities' ? 5000:30000 }); }
    finally { player.hostEvent('fixture.instances.calls', memory.calls.map(row => row.name)); }
  } };
}`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Instances.test.tsx', '--web-host', 'host.mjs'], { cwd: directory, encoding: 'utf8', timeout: 160_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);

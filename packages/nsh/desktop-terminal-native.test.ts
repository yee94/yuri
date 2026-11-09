import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real NSH engine: inline dock exposes native renderer gap without a workspace, fake terminal, shell or PTY', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'nsh-desktop-terminal-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Synthetic terminal dock', id: 'example.yuri.terminal', version: '0.1.0', build: 1, theme: path.join(directory, 'theme.json'), capabilities: { host: ['terminal.desktop.capabilities'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(directory, 'desktop-terminal-fixture.tsx'))};\n`);
    // Intentionally transport-only: never advertise an unregistered renderer.
    writeFileSync(path.join(temporary, 'host.js'), `export function createHost(player) {
      const calls = [];
      return { async call(name, input) {
        calls.push(name); player.hostEvent('desktop-terminal-fixture.calls', [...calls]);
        if (name === 'terminal.desktop.capabilities' && input.expectedHost?.lease) return { scope: 'native-opaque', wsVersion: 2, durableMetadata: true };
        throw new Error('Forbidden synthetic terminal call: ' + name);
      } };
    }`);
    const steps = [
        'const state = () => JSON.parse(app.texts().find(text => text.startsWith("terminal-fixture:")).slice(17));',
        'await app.waitFor("id:desktop-terminal-unavailable");',
        'expect(app.shows("id:desktop-terminal-viewport")).toBe(false);',
        'expect(app.enabled("id:desktop-terminal-new")).toBe(false);',
        'expect(app.enabled("id:desktop-terminal-focus")).toBe(false);',
        'expect(state().calls).toEqual(["terminal.desktop.capabilities"]);',
        'await app.press("id:desktop-terminal-expand");',
        'expect(state().expanded).toBe(true);',
        'await app.press("id:desktop-terminal-retry");',
        'await app.waitUntil(() => state().calls.length === 2);',
        'await app.press("id:desktop-terminal-hide");',
        'expect(state().closed).toBe(1);',
        'expect(app.enabled("id:desktop-terminal-retry")).toBe(false);',
        'await app.press("id:terminal-fixture-active");',
        'await app.wait(100);',
        'expect(state().calls.length).toBe(2);',
        'await app.press("id:terminal-fixture-scope");',
        'await app.waitUntil(() => state().calls.length === 3);',
        'expect(state().calls.every(name => name === "terminal.desktop.capabilities")).toBe(true);',
      ].join('\n');
    writeFileSync(path.join(temporary, 'desktop-terminal-run.test.tsx'), `import { expect, open, test } from 'nsh/test';\nfor (const platform of ['macos', 'windows'] as const) test('renderer gap ' + platform, async () => { const app = await open('./App.tsx', { platform, width: 1000, height: 700 });\n${steps}\n});\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-terminal-run.test.tsx', '--web-host', 'host.js'], {
      cwd: temporary, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);

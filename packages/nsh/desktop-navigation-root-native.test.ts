import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createNavigationHost, navigationIdentity } from './tests/desktop-application/NavigationHost.js';

test('synthetic Host only permits the exact read-only Goal RPC, never general POST or malformed authority/body', () => {
  const expectedHost = { hostID: navigationIdentity.hostID, lease: navigationIdentity.lease };
  const exact = { path: '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Ffixture%2Factual', method: 'POST', body: { input: { sessionID: navigationIdentity.sessionID } }, expectedHost };
  const fixture = createNavigationHost();
  expect(fixture.handlers['runtime.request'](exact)).toEqual({ status: 200, body: { output: null } });
  expect(fixture.readonlyRPCs).toEqual([exact]); expect(fixture.mutations).toEqual([]);
  for (const input of [
    { ...exact, path: exact.path + '&extra=true' }, { ...exact, path: '/api/rpc/opencode.goal/set?location%5Bdirectory%5D=%2Ffixture%2Factual' },
    { ...exact, method: 'PUT' }, { ...exact, body: undefined }, { ...exact, body: { input: { sessionID: 'other-session' } } },
    { ...exact, body: { input: { sessionID: navigationIdentity.sessionID, objective: 'must not write' } } },
    { ...exact, body: { input: { sessionID: navigationIdentity.sessionID }, extra: true } },
    { ...exact, expectedHost: undefined }, { ...exact, expectedHost: { ...expectedHost, lease: 'retired-lease' } },
    { ...exact, path: '/api/session' }, { ...exact, path: '/api/session/ses_saved/command' }, { ...exact, path: '/api/session/ses_saved/prompt_async' },
  ]) {
    const strict = createNavigationHost(); expect(() => strict.handlers['runtime.request'](input)).toThrow(); expect(strict.readonlyRPCs).toEqual([]);
  }
});

test('real YuriNativeApp navigation restore, root intent, public persistence and native close admission on both desktop models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'navigation-production-root-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.navigation-production-root'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('navigation.test.storage');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/NavigationRoot.tsx'))};\n`);
    writeFileSync(path.join(directory, 'NavigationRoot.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/NavigationRoot.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Navigation.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/Navigation.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Navigation.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 135_000);

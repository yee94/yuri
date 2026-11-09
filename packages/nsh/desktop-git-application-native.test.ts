import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { bundleDesktopHost } from './tests/bundle-desktop-host';
import { createGitHost, identity } from './tests/desktop-git-application/host.js';

const expectedHost = { hostID: identity.hostID, lease: identity.lease };
const directory = '?directory=' + encodeURIComponent(identity.directory);
test.each([
  { path: '/api/session', method: 'POST', body: {}, expectedHost },
  { path: '/api/small-model/generate', method: 'POST', body: { prompt: 'synthetic' }, expectedHost },
  { path: '/api/git/unregistered' + directory, method: 'GET', expectedHost },
  { path: '/api/git/status' + directory, method: 'GET' },
  { path: '/api/git/status' + directory, method: 'GET', expectedHost: { ...expectedHost, lease: 'retired' } },
  { path: '/api/git/status' + directory + '&unexpected=1', method: 'GET', expectedHost },
  { path: '/api/git/status' + directory + '&directory=other', method: 'GET', expectedHost },
  { path: '/api/git/status' + directory, method: 'GET', body: {}, expectedHost },
  { path: '/api/session/' + identity.sessionID + '/prompt' + directory, method: 'POST', expectedHost, body: { id: 'input', text: 'synthetic', delivery: 'queue', model: 'invented' } },
])('independent synthetic Host rejects unsupported request $method $path', input => {
  const fixture = createGitHost();
  expect(() => fixture.handlers['runtime.request'](input)).toThrow();
  expect(fixture.rejected).toHaveLength(1);
});

test('production-root desktop Git staging and explicit send remain scoped, durable and non-replaying on both headless platforms', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), host = bundleDesktopHost(path.join(root, 'tests/desktop-git-application/host.js'));
  try {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-git-application/Application.test.tsx', '--web-host', host.outfile], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('14 passed');
  } finally { host.dispose(); }
}, 190_000);

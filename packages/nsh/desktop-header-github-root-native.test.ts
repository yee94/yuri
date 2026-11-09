import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('actual Settings root → Git → original GitHub component shares the window source on Mac/Win; no external network', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'github-root-native-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'GitHub root synthetic fixture', id: 'example.yuri.github-root', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-github-root-fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'Root.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const scope = { hostID: 'github-root', lease: 'synthetic-lease' };
const status = selected => ({ connected: true, user: { login: selected }, accounts: ['a', 'b'].map(id => ({ id, source: 'oauth', current: id === selected, user: { login: id } })), capabilities: { exactAccountRemoval: false, deviceFlowCancellation: true } });
async function launch(platform, shared = true) {
 const reads = [], writes = [], rejected = []; let data = status('a'), fail = false, unknown = false, cancelUnknown = false;
 const app = await open('./App.tsx', { platform, width: 1200, height: 900, host: { params: { shared }, handlers: {
  'connection.list': () => ({ selected: scope.hostID, runtimeScope: scope, connections: [{ id: scope.hostID, url: 'https://synthetic.invalid', authorizationID: 'synthetic-auth' }] }),
  'runtime.request': input => {
   if (input.expectedHost?.hostID !== scope.hostID || input.expectedHost.lease !== scope.lease) { rejected.push(input); throw new Error('Wrong synthetic scope'); }
   if (input.method === 'GET') {
    if (input.path === '/api/github/auth/status') { reads.push(input); if (fail) return { status: 503, body: {} }; return { status: 200, body: data }; }
    if (input.path === '/api/git/identities' || input.path === '/api/git/discover-credentials') return { status: 200, body: [] };
    if (input.path === '/api/git/global-identity' || input.path === '/api/config/settings') return { status: 200, body: {} };
   }
   if (input.method === 'POST' && input.path === '/api/github/auth/activate') { writes.push(input); if (unknown) return { status: 503, body: {} }; data = status(input.body.accountId); return { status: 200, body: data }; }
   if (input.method === 'POST' && input.path === '/api/github/auth/start') { writes.push(input); return { status: 200, body: { deviceCode: 'synthetic-device-only', userCode: 'FAKE-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 20, cancellable: true } }; }
   if (input.method === 'POST' && input.path === '/api/github/auth/cancel') { writes.push(input); return cancelUnknown ? { status: 503, body: {} } : { status: 200, body: { cancelled: true, status: 'cancelled', providerRevoked: false } }; }
   rejected.push(input); throw new Error('Unexpected synthetic wire');
  },
 } } });
 await app.waitFor('id:github-root-ready');
 const control = (action, value?) => app.host.send('desktop-github-root.control', { action, value });
 async function audit() { const previous = app.texts().find(text => text.startsWith('github-root-audit:')); await control('audit'); await app.waitUntil(() => app.texts().some(text => text.startsWith('github-root-audit:{') && text !== previous)); return JSON.parse(app.texts().find(text => text.startsWith('github-root-audit:{')).slice('github-root-audit:'.length)); }
 return { app, reads, writes, rejected, audit, control, fail: value => { fail = value; }, unknown: value => { unknown = value; }, data: value => { data = value; }, cancelUnknown: value => { cancelUnknown = value; } };
}
for (const platform of ['macos', 'windows']) {
 test(platform + ' production component chain uses Settings operation after Header modal revocation; input is zero extra status I/O', async () => {
  const f = await launch(platform), app = f.app; expect(f.reads).toHaveLength(0);
  await app.press('id:github-root-ensure'); await app.waitFor('id:desktop-header-github-menu');
  await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-b'); expect(f.writes).toHaveLength(1);
  await app.press('id:github-root-settings'); await app.waitFor('id:github-current'); expect(app.texts()).toContain('b'); expect(app.enabled('id:desktop-header-github-menu')).toBe(false);
  expect(app.shows('id:github-activate-oauth-a')).toBe(true); await app.press('id:github-activate-oauth-a'); await app.waitUntil(() => app.shows('id:github-activate-oauth-b'));
  expect((await f.audit()).login).toBe('a'); expect(f.writes).toHaveLength(2);
  const count = f.reads.length, before = await f.audit();
  for (let i = 0; i < 50; i++) await app.type('id:github-root-input', 'x');
  expect(f.reads.length).toBe(count); expect((await f.audit()).mounts).toBe(before.mounts);
  f.fail(true); await app.press('id:github-refresh'); await app.waitFor('id:github-error'); expect(app.shows('id:github-activate-oauth-b')).toBe(true); expect((await f.audit()).login).toBe('a');
  await app.press('id:github-root-close'); await app.waitUntil(() => !app.shows('id:github-current')); expect((await f.audit()).canClose).toBe(true); expect(f.rejected).toEqual([]);
 });
 test(platform + ' unknown Header selection survives directory switch without a replacement writer', async () => {
  const f = await launch(platform), app = f.app; await app.press('id:github-root-ensure'); await app.waitFor('id:desktop-header-github-menu'); f.unknown(true);
  await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-b'); expect((await f.audit()).pending).not.toBe(null);
  await f.control('directory', '/fixture/b'); expect(app.shows('id:desktop-header-github-menu')).toBe(false); const count = f.reads.length;
  await app.press('id:github-root-ensure'); expect(f.reads.length).toBe(count); expect((await f.audit()).canClose).toBe(false);
  await app.press('id:github-root-settings'); await app.waitFor('id:desktop-settings-github-unavailable'); expect(app.shows('id:github-connect')).toBe(false); expect(f.reads.length).toBe(count);
  await app.press('id:github-root-close'); await f.control('directory', '/fixture/a'); f.data(status('b')); await app.press('id:github-root-refresh'); expect((await f.audit()).pending).toBe(null); expect(f.writes).toHaveLength(1); expect(f.rejected).toEqual([]);
 });
 test(platform + ' original Settings OAuth flow and cancel-unknown retain mounted controller and veto actual Settings close', async () => {
  const f = await launch(platform), app = f.app; await app.press('id:github-root-settings'); await app.waitFor('id:github-connect');
  await app.press('id:github-connect'); await app.waitFor('id:github-flow'); const before = await f.audit(); expect(before.canClose).toBe(false);
  await app.press('id:github-root-close'); expect(app.shows('id:github-flow')).toBe(true); expect((await f.audit()).mounts).toBe(before.mounts);
  f.cancelUnknown(true); await app.press('id:github-cancel'); await app.waitFor('id:github-cancellation'); expect((await f.audit()).canClose).toBe(false);
  await app.press('id:github-root-close'); expect(app.shows('id:github-connect')).toBe(true); expect((await f.audit()).mounts).toBe(before.mounts);
  await f.control('directory', '/fixture/b'); expect((await f.audit()).canClose).toBe(false); expect(f.writes.filter(write => write.path === '/api/github/auth/start')).toHaveLength(1); expect(f.rejected).toEqual([]);
 });
 test(platform + ' missing shared slot fails closed instead of creating the original private sender', async () => {
  const f = await launch(platform, false), app = f.app; await app.press('id:github-root-settings'); await app.waitFor('id:desktop-settings-github-unavailable');
  expect(app.shows('id:github-connect')).toBe(false); expect(f.reads).toHaveLength(0); expect(f.writes).toHaveLength(0); expect(f.rejected).toEqual([]);
 });
}
`);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.env.NSH_BIN || 'nsh', 'test', 'Root.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 200_000);

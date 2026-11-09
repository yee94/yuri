import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('shared prior reaches the production Settings component through the existing root injection, with no external network', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'github-status-native-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Shared GitHub status fixture', id: 'example.yuri.github-status', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-github-root-fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'Status.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const scope = { hostID: 'github-root', lease: 'synthetic-lease' };
const status = selected => ({ connected: true, user: { login: selected }, accounts: ['a', 'b'].map(id => ({ id, source: 'oauth', current: id === selected, user: { login: id } })), capabilities: { exactAccountRemoval: false, deviceFlowCancellation: true }, token: 'NEVER_DISPLAY' });
async function launch(platform) {
 const reads = [], writes = [], rejected = []; let data = status('a'), fail = false, unknown = false, failAfterActivate = false, holdWrite = false, release;
 const app = await open('./App.tsx', { platform, width: 1200, height: 900, host: { handlers: {
  'connection.list': () => ({ selected: scope.hostID, runtimeScope: scope, connections: [{ id: scope.hostID, url: 'https://synthetic.invalid', authorizationID: 'synthetic-auth' }] }),
  'runtime.request': async input => {
   if (input.expectedHost?.hostID !== scope.hostID || input.expectedHost.lease !== scope.lease) { rejected.push(input); throw new Error('Wrong synthetic scope'); }
   if (input.method === 'GET') {
    if (input.path === '/api/github/auth/status') { reads.push(input); return fail ? { status: 503, body: {} } : { status: 200, body: data }; }
    if (input.path === '/api/git/identities' || input.path === '/api/git/discover-credentials') return { status: 200, body: [] };
    if (input.path === '/api/git/global-identity' || input.path === '/api/config/settings') return { status: 200, body: {} };
   }
   if (input.method === 'POST' && input.path === '/api/github/auth/activate' && Object.keys(input.body).join(',') === 'accountId') {
    writes.push(input); if (holdWrite) await new Promise(done => { release = done; });
    if (unknown) return { status: 503, body: {} }; data = status(input.body.accountId); if (failAfterActivate) fail = true; return { status: 200, body: data };
   }
   if (input.method === 'POST' && input.path === '/api/github/auth/start') { writes.push(input); return { status: 200, body: { deviceCode: 'synthetic-device-only', userCode: 'FAKE-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 20, cancellable: true } }; }
   if (input.method === 'POST' && input.path === '/api/github/auth/cancel') { writes.push(input); return { status: 200, body: { cancelled: true, status: 'cancelled', providerRevoked: false } }; }
   rejected.push(input); throw new Error('Unexpected synthetic wire');
  },
 } } });
 await app.waitFor('id:github-root-ready');
 const control = (action, value?) => app.host.send('desktop-github-root.control', { action, value });
 async function audit() { const previous = app.texts().find(text => text.startsWith('github-root-audit:')); await control('audit'); await app.waitUntil(() => app.texts().some(text => text.startsWith('github-root-audit:{') && text !== previous)); return JSON.parse(app.texts().find(text => text.startsWith('github-root-audit:{')).slice('github-root-audit:'.length)); }
 return { app, reads, writes, rejected, audit, fail: value => { fail = value; }, unknown: value => { unknown = value; }, data: value => { data = value; }, failAfterActivate: value => { failAfterActivate = value; }, hold: () => { holdWrite = true; }, release: () => { holdWrite = false; release?.(); } };
}
for (const platform of ['macos', 'windows']) {
 test(platform + ' Header selection then failed Settings first GET shows last confirmed current and explicit stale, with fifty unrelated updates doing zero status I/O', async () => {
  const f = await launch(platform), app = f.app; await app.press('id:github-root-ensure'); await app.waitFor('id:desktop-header-github-menu');
  await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-b'); f.fail(true);
  await app.press('id:github-root-settings'); await app.waitFor('id:github-stale'); expect(app.texts()).toContain('b'); expect(app.shows('id:github-error')).toBe(true);
  expect(app.shows('id:github-activate-oauth-a')).toBe(true); expect(app.enabled('id:github-activate-oauth-a')).toBe(false); expect(app.texts()).not.toContain('NEVER_DISPLAY');
  const before = await f.audit(), count = f.reads.length;
  for (let i = 0; i < 50; i++) await app.type('id:github-root-input', 'x');
  expect(f.reads.length).toBe(count); expect((await f.audit()).mounts).toBe(before.mounts); expect(app.value('id:github-root-input')).toBe('x'.repeat(50)); expect(f.writes).toHaveLength(1);
  f.fail(false); await app.press('id:github-refresh'); await app.waitUntil(() => !app.shows('id:github-stale')); expect(app.enabled('id:github-activate-oauth-a')).toBe(true);
  await app.press('id:github-activate-oauth-a'); expect((await f.audit()).login).toBe('a'); expect(f.writes).toHaveLength(2); expect((await f.audit()).mounts).toBe(before.mounts);
  await app.press('id:github-root-close'); await app.waitUntil(() => !app.shows('id:github-current')); expect((await f.audit()).canClose).toBe(true); expect(f.rejected).toEqual([]);
 });
 test(platform + ' valid Settings ACK keeps the original mounted controller/input through failed readback and never repeats its mutation', async () => {
  const f = await launch(platform), app = f.app; await app.press('id:github-root-settings'); await app.waitFor('id:github-current');
  await app.type('id:github-root-input', 'kept'); const before = await f.audit(); f.hold(); f.failAfterActivate(true);
  const activating = app.press('id:github-activate-oauth-b'); await app.waitUntil(() => f.writes.length === 1); await app.press('id:github-root-close'); expect((await f.audit()).open).toBe(true);
  f.release(); await activating; await app.waitFor('id:github-stale'); expect((await f.audit()).login).toBe('b'); expect(app.texts()).toContain('b'); expect((await f.audit()).mounts).toBe(before.mounts); expect(app.value('id:github-root-input')).toBe('kept');
  await app.press('id:github-root-close'); expect((await f.audit()).open).toBe(true); expect(f.writes).toHaveLength(1);
  f.fail(false); await app.press('id:github-refresh'); expect(f.writes).toHaveLength(1); expect((await f.audit()).canClose).toBe(true); await app.press('id:github-root-close'); expect(f.rejected).toEqual([]);
 });
 test(platform + ' unknown Settings activation survives close attempt/background and failed reconciliation in the same controller', async () => {
  const f = await launch(platform), app = f.app; await app.press('id:github-root-settings'); await app.waitFor('id:github-current'); const before = await f.audit();
  f.unknown(true); await app.press('id:github-activate-oauth-b'); await app.waitFor('id:github-error'); expect((await f.audit()).canClose).toBe(false);
  await app.press('id:github-root-close'); expect((await f.audit()).open).toBe(true); expect((await f.audit()).mounts).toBe(before.mounts);
  f.data(status('b')); f.fail(true); await app.setLifecycle('background'); await app.setLifecycle('active'); await app.waitFor('id:github-stale');
  expect(app.shows('id:github-accept-state')).toBe(false); expect((await f.audit()).canClose).toBe(false); expect(f.writes).toHaveLength(1);
  f.fail(false); await app.press('id:github-refresh'); expect(app.shows('id:github-stale')).toBe(false); expect((await f.audit()).canClose).toBe(true); expect((await f.audit()).mounts).toBe(before.mounts); expect((await f.audit()).login).toBe('b');
  await app.press('id:github-root-close'); expect(f.writes).toHaveLength(1); expect(f.rejected).toEqual([]);
 });
 test(platform + ' authoritative shared status adoption never rebuilds OAuth flow, timer owner or cleanup close guard', async () => {
  const f = await launch(platform), app = f.app; await app.press('id:github-root-settings'); await app.waitFor('id:github-connect');
  await app.press('id:github-connect'); await app.waitFor('id:github-user-code'); const before = await f.audit(); f.data(status('b'));
  await app.press('id:github-refresh'); expect(app.shows('id:github-flow')).toBe(true); expect(app.texts()).toContain('FAKE-CODE'); expect(app.texts()).not.toContain('synthetic-device-only'); expect((await f.audit()).login).toBe('b');
  await app.press('id:github-root-close'); expect(app.shows('id:github-flow')).toBe(true); expect((await f.audit()).mounts).toBe(before.mounts); expect((await f.audit()).canClose).toBe(false);
  await app.press('id:github-cancel'); await app.waitUntil(() => !app.shows('id:github-flow')); expect((await f.audit()).canClose).toBe(true);
  expect(f.writes.map(value => value.path)).toEqual(['/api/github/auth/start', '/api/github/auth/cancel']); expect(f.rejected).toEqual([]);
 });
}
`);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.env.NSH_BIN || 'nsh', 'test', 'Status.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 200_000);

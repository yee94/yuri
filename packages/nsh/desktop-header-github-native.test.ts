import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('real GitHub Header component and shared source on macOS/Windows, with all external network denied', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'desktop-header-github-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'GitHub Header fixture', id: 'example.yuri.github-header', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['runtime.request'], network: { http: [{ host: 'avatars.githubusercontent.com', methods: ['GET'], schemes: ['https'], port: 443, pathPrefixes: ['/u/'] }] } } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-github.fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'GitHub.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const avatar = 'https://avatars.githubusercontent.com/u/123?v=4';
const user = login => ({ login, name: login === 'a' ? ' Name A ' : '', avatarUrl: avatar, email: 'NOT_IN_HEADER', token: 'NEVER_IN_HEADER' });
const account = (id, source, current) => ({ id, source, current, user: user(id) });
const value = selected => ({ connected: true, user: user(selected), accounts: [account('a', 'oauth', selected === 'a'), account('b', 'gh-cli', selected === 'b')] });
async function launch(platform, initial = value('a'), auto = true) {
 const reads = [], writes = [], rejected = []; let data = initial, fail = false, unknown = false, holdRead = false, holdWrite = false, release;
 const app = await open('./App.tsx', { platform, width: 800, height: 600, host: { params: { auto }, handlers: {
  'runtime.request': async input => {
   if (!['github-A', 'github-B'].includes(input.expectedHost?.hostID) || input.expectedHost.lease !== 'lease-' + input.expectedHost.hostID.slice(-1)) { rejected.push(input); throw new Error('Wrong authority'); }
   if (input.path === '/api/github/auth/status' && input.method === 'GET' && input.body === undefined) { reads.push(input); if (holdRead) await new Promise(done => { release = done; }); if (fail) throw new Error('Synthetic read failure'); return { status: 200, body: data }; }
   if (input.path === '/api/github/auth/activate' && input.method === 'POST' && input.body && Object.keys(input.body).join(',') === 'accountId' && ['a', 'b'].includes(input.body.accountId)) {
    writes.push(input); if (holdWrite) await new Promise(done => { release = done; }); if (unknown) throw new Error('Synthetic lost receipt'); data = value(input.body.accountId); return { status: 200, body: data };
   }
   rejected.push(input); throw new Error('Unexpected wire');
  },
 } } });
 const control = (action, value?) => app.host.send('desktop-header-github.control', { action, value });
 async function audit() { const before = app.texts().find(text => text.startsWith('github-audit:')); await control('audit'); await app.waitUntil(() => app.texts().some(text => text.startsWith('github-audit:{') && text !== before)); return JSON.parse(app.texts().find(text => text.startsWith('github-audit:{')).slice('github-audit:'.length)); }
 return { app, reads, writes, rejected, control, audit, data: next => { data = next; }, fail: next => { fail = next; }, unknown: next => { unknown = next; }, holdRead: () => { holdRead = true; }, holdWrite: () => { holdWrite = true; }, release: () => { holdRead = false; holdWrite = false; release?.(); } };
}
for (const platform of ['macos', 'windows']) {
 test(platform + ' Web has no empty GitHub control, single connected account is avatar-only and untrusted images are rejected', async () => {
  const f = await launch(platform, { connected: false, accounts: [] }, false), app = f.app;
  expect(app.shows('id:desktop-header-github-menu')).toBe(false); expect(app.shows('id:desktop-header-github-single')).toBe(false); expect(f.reads).toEqual([]);
  await f.control('ensure'); expect(f.reads).toHaveLength(1); expect(app.shows('id:desktop-header-github-single')).toBe(false);
  f.data({ connected: true, user: user('a'), accounts: [account('a', 'oauth', true)] }); await f.control('refresh'); await app.waitFor('id:desktop-header-github-single');
  expect(app.shows('id:desktop-header-github-avatar')).toBe(true); expect(app.shows('id:desktop-header-github-menu')).toBe(false); expect(f.writes).toEqual([]);
  f.data({ connected: true, user: { ...user('a'), avatarUrl: 'https://evil.example/avatar?bearer=secret' }, accounts: [] }); await f.control('refresh'); expect(app.shows('id:desktop-header-github-avatar')).toBe(false); expect(app.shows('id:desktop-header-github-single')).toBe(true);
  expect(f.rejected).toEqual([]);
  expect((await f.audit()).opens).toBe(0);
 });
 test(platform + ' real account menu/source labels/current selection, exact POST ACK and fifty inputs have zero reads/enumeration/remount', async () => {
  const f = await launch(platform), app = f.app; await app.waitFor('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-menu');
  expect(app.texts()).toContain('Name A'); expect(app.texts()).toContain('b · CLI'); expect(app.texts()).toContain('a · OAuth');
  expect(app.texts()).not.toContain('NOT_IN_HEADER'); expect(app.texts()).not.toContain('NEVER_IN_HEADER');
  await app.press('id:desktop-header-github-account-oauth-a'); expect(f.writes).toEqual([]); await app.press('id:desktop-header-github-menu');
  await app.press('id:desktop-header-github-account-gh-cli-b'); expect(f.writes).toHaveLength(1); expect(f.writes[0].body).toEqual({ accountId: 'b' }); expect((await f.audit()).login).toBe('b');
  const before = await f.audit(), reads = f.reads.length, writes = f.writes.length;
  for (let i = 0; i < 50; i++) await app.type('id:github-header-input', 'x');
  const after = await f.audit(); expect(after.enumerations).toBe(before.enumerations); expect(after.commits).toBe(before.commits); expect(after.mounts).toBe(before.mounts); expect(f.reads.length).toBe(reads); expect(f.writes.length).toBe(writes);
  expect(f.rejected).toEqual([]);
 });
 test(platform + ' modal/background retain data but revoke actions; original Settings controller shares this source without a second OAuth engine', async () => {
  const f = await launch(platform), app = f.app; await app.waitFor('id:desktop-header-github-menu'); const before = await f.audit();
  await f.control('modal', true); expect(app.enabled('id:desktop-header-github-menu')).toBe(false); expect((await f.audit()).login).toBe('a'); await f.control('modal', false);
  await app.setLifecycle('background'); expect(app.enabled('id:desktop-header-github-menu')).toBe(false); await app.setLifecycle('active'); expect(app.enabled('id:desktop-header-github-menu')).toBe(true);
  expect(f.reads).toHaveLength(1); expect((await f.audit()).mounts).toBe(before.mounts);
  await f.control('settings'); expect((await f.audit()).settingsLogin).toBe('a'); await f.control('settings-select');
  const shared = await f.audit(); expect(shared.settingsLogin).toBe('b'); expect(shared.login).toBe('b'); expect(f.writes).toHaveLength(1); expect(f.writes[0].path).toBe('/api/github/auth/activate'); expect(f.rejected).toEqual([]);
 });
 test(platform + ' failed reads and unknown selection retain prior, cannot replay and exact GET current resolves; late retired Host never commits', async () => {
  const f = await launch(platform), app = f.app; await app.waitFor('id:desktop-header-github-menu');
  f.fail(true); await f.control('refresh'); expect((await f.audit()).issue).toBe('read'); expect((await f.audit()).login).toBe('a'); f.fail(false); await f.control('refresh');
  f.unknown(true); await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-gh-cli-b'); expect((await f.audit()).pending).toBe(true); expect((await f.audit()).login).toBe('a'); expect(app.enabled('id:desktop-header-github-menu')).toBe(false);
  await f.control('refresh'); expect((await f.audit()).pending).toBe(true); expect(f.writes).toHaveLength(1); f.data(value('b')); await f.control('refresh'); expect((await f.audit()).pending).toBe(false); expect((await f.audit()).login).toBe('b'); expect(f.writes).toHaveLength(1);
  const readCount = f.reads.length; f.holdRead(); const refreshing = f.control('refresh'); await app.waitUntil(() => f.reads.length === readCount + 1); await f.control('authority', false); const prior = await f.audit(); f.data(value('a')); f.release(); await refreshing;
  expect((await f.audit()).commits).toBe(prior.commits); expect((await f.audit()).login).toBe('b'); expect(app.shows('id:desktop-header-github-menu')).toBe(false);
  const count = f.reads.length; await f.control('authority', true); await f.control('scope', 'B'); await app.waitFor('id:desktop-header-github-menu'); expect(f.reads.length).toBe(count + 1); expect(f.reads.at(-1).expectedHost.hostID).toBe('github-B'); expect(f.rejected).toEqual([]);
 });
 test(platform + ' an already-issued switch may accept a same-scope ACK but never sends late UI feedback across a modal', async () => {
  const f = await launch(platform), app = f.app; await app.waitFor('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-menu'); f.holdWrite();
  const selecting = app.press('id:desktop-header-github-account-gh-cli-b'); await app.waitUntil(() => f.writes.length === 1); await f.control('modal', true);
  expect((await f.audit()).login).toBe('a'); expect(app.enabled('id:desktop-header-github-menu')).toBe(false); f.release(); await selecting;
  const confirmed = await f.audit(); expect(confirmed.login).toBe('b'); expect(confirmed.result).toBe(''); expect(app.enabled('id:desktop-header-github-menu')).toBe(false); expect(f.writes).toHaveLength(1);
  await f.control('modal', false); expect(app.enabled('id:desktop-header-github-menu')).toBe(true); expect(f.rejected).toEqual([]);
 });
 test(platform + ' a keyed Host replacement retires an in-flight writer without delivering callbacks into the destroyed consumer', async () => {
  const f = await launch(platform), app = f.app; await app.waitFor('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-menu'); f.holdWrite();
  const selecting = app.press('id:desktop-header-github-account-gh-cli-b'); await app.waitUntil(() => f.writes.length === 1); await f.control('scope', 'B'); await app.waitFor('id:desktop-header-github-menu');
  const next = await f.audit(); expect(next.scope).toBe('B'); expect(next.login).toBe('a'); f.release(); await selecting;
  const after = await f.audit(); expect(after.login).toBe('a'); expect(after.commits).toBe(next.commits); expect(after.result).toBe(''); expect(f.writes).toHaveLength(1); expect(f.rejected).toEqual([]);
 });
 test(platform + ' onOpen coordinates the parent popup only on an admitted closed-to-open transition, then rechecks real availability', async () => {
  const f = await launch(platform), app = f.app; await app.waitFor('id:desktop-header-github-menu'); expect((await f.audit()).opens).toBe(0);
  await f.control('other-popup', true); expect(app.shows('id:github-other-popup')).toBe(true);
  await app.press('id:desktop-header-github-menu'); expect(app.shows('id:github-other-popup')).toBe(false); expect(app.shows('id:desktop-header-github-account-gh-cli-b')).toBe(true); expect((await f.audit()).opens).toBe(1);
  const before = await f.audit(); for (let i = 0; i < 50; i++) await app.type('id:github-header-input', 'x'); expect((await f.audit()).opens).toBe(1); expect(f.reads).toHaveLength(1); expect(f.writes).toHaveLength(0);
  await f.control('modal', true); expect(app.shows('id:desktop-header-github-account-gh-cli-b')).toBe(false); expect((await f.audit()).opens).toBe(1);
  await f.control('modal', false); await f.control('revoke-on-open', true); await app.press('id:desktop-header-github-menu');
  expect((await f.audit()).opens).toBe(2); expect(app.shows('id:desktop-header-github-account-gh-cli-b')).toBe(false); expect(app.enabled('id:desktop-header-github-menu')).toBe(false); expect(f.writes).toHaveLength(0);
  await f.control('revoke-on-open', false); await f.control('presentation', true); await app.press('id:desktop-header-github-menu'); expect((await f.audit()).opens).toBe(3); expect(app.shows('id:desktop-header-github-account-gh-cli-b')).toBe(true);
  await app.press('id:desktop-header-github-account-oauth-a'); expect((await f.audit()).opens).toBe(3); expect(f.writes).toHaveLength(0);
  await f.control('authority', false); expect((await f.audit()).opens).toBe(3); expect(app.shows('id:desktop-header-github-menu')).toBe(false); expect((await f.audit()).mounts).toBe(before.mounts); expect(f.rejected).toEqual([]);
 });
}
`);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.env.NSH_BIN || 'nsh', 'test', 'GitHub.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 180_000);

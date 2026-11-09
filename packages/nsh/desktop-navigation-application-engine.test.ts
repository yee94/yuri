import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('real NSH headless production binder resolves against a strict synthetic Host and preserves failed/stale metadata', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'navigation-production-binder-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Navigation binder fixture', id: 'example.yuri.navigation-binder', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-navigation-application-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Binder.test.tsx'), `
import { expect, open, test } from 'nsh/test';
function synthetic() {
  let status = 200, wrong = false, origin = 'https://a.example', lease = 'native-lease-1';
  const reads = [], rejected = [];
  const response = () => ({ status, body: status === 200 ? { id: 'saved', title: 'Fresh synthetic Host title', location: { directory: wrong ? '/wrong' : '/project' }, time: { archived: 0 } } : { error: 'synthetic lookup failed' } });
  const handlers = {
    'connection.list': () => ({ connections: [{ id: 'A', url: origin, authorizationID: 'auth-A', label: 'Synthetic', lastUsedAt: 1 }], selected: 'A', runtimeScope: { hostID: 'A', lease } }),
    'runtime.request': input => {
      if (input.method !== 'GET' || input.body !== undefined || input.path !== '/api/session/saved?directory=%2Fproject' || input.expectedHost.hostID !== 'A' || input.expectedHost.lease !== lease) { rejected.push(input); throw new Error('unexpected wire'); }
      reads.push(input);
      return response();
    },
  };
  return { handlers, reads, rejected, fail: code => { status = code; }, wrong: () => { wrong = true; }, recover: () => { status = 200; wrong = false; }, switchOrigin: () => { origin = 'https://new.example'; lease = 'native-lease-2'; } };
}
test('GET metadata success, 503 prior/retry and wrong-directory failure run through actual default binder', async () => {
  const host = synthetic(), app = await open('./App.tsx', { host: { handlers: host.handlers } });
  host.fail(503); await app.press('id:nav-app-start'); await app.waitFor('text:restore:error');
  expect(app.texts()).toContain('applied:none'); await app.press('id:nav-app-inspect'); await app.waitFor('text:disk:session');
  host.recover(); host.wrong(); await app.press('id:nav-app-retry'); await app.waitFor('text:restore:error');
  expect(app.texts()).toContain('applied:none');
  host.recover(); await app.press('id:nav-app-retry'); await app.waitFor('text:restore:restored');
  expect(app.texts()).toContain('applied:Fresh synthetic Host title'); expect(app.texts()).toContain('slot:0');
  expect(host.reads.length).toBe(3); expect(host.rejected).toEqual([]);
});
test('actual runtime.request 404 clears metadata, not the current route', async () => {
  const host = synthetic(); host.fail(404); const app = await open('./App.tsx', { host: { handlers: host.handlers } });
  await app.press('id:nav-app-start'); await app.waitFor('text:restore:missing');
  await app.press('id:nav-app-inspect'); await app.waitFor('text:disk:empty'); expect(app.texts()).toContain('applied:none');
  expect(host.rejected).toEqual([]);
});
test('user navigation and failed Storage flush keep prior; retry writes only metadata', async () => {
  const host = synthetic(); const app = await open('./App.tsx', { host: { handlers: host.handlers } });
  await app.press('id:nav-app-start'); await app.waitFor('text:restore:restored');
  await app.press('id:nav-app-fail-write'); await app.press('id:nav-app-user');
  await app.waitFor('text:write:error'); expect(app.texts()).toContain('applied:user');
  await app.press('id:nav-app-inspect'); await app.waitFor('text:disk:session');
  await app.press('id:nav-app-flush'); await app.waitFor('text:disk:new-session');
  expect(app.texts()).toContain('applied:user'); expect(app.texts()).toContain('restore:superseded');
  expect(host.reads.length).toBe(1); expect(host.rejected).toEqual([]);
});
test('same connection ID new origin does not reapply old-origin metadata', async () => {
  const host = synthetic(); const app = await open('./App.tsx', { host: { handlers: host.handlers } });
  await app.press('id:nav-app-start'); await app.waitFor('text:restore:restored');
  host.switchOrigin(); await app.press('id:nav-app-reload'); await app.waitFor('text:restore:empty');
  expect(app.texts()).toContain('applies:1'); expect(app.texts()).toContain('slot:0');
  await app.press('id:nav-app-inspect'); await app.waitFor('text:disk:session'); expect(host.reads.length).toBe(1); expect(host.rejected).toEqual([]);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Binder.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);

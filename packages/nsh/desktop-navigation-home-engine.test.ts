import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('production navigation adapter restores both home sections with strict captured GET admission on NSH headless', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'navigation-home-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Navigation home fixture', id: 'example.yuri.navigation-home', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-navigation-home.fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Home.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const key = 'desktop.navigation.v1';
const partition = { connectionID: 'A', origin: 'https://a.example', authorizationID: 'auth-A' };
const seed = section => JSON.stringify({ version: 1, entries: [{ partition, target: { kind: 'home', section } }] });
function synthetic() {
  let failed = null;
  const reads = [], rejected = [];
  const assistants = { enabled: true, revision: 1, assistants: [] }, schedules = { tasks: [], failedProjectIds: [] };
  const handlers = {
    'connection.list': () => ({ selected: 'A', connections: [{ id: 'A', url: partition.origin, authorizationID: 'auth-A', label: 'Synthetic', lastUsedAt: 0 }], runtimeScope: { hostID: 'A', lease: 'lease-1' } }),
    'runtime.request': input => {
      if (input.method !== 'GET' || input.body !== undefined || input.expectedHost.hostID !== 'A' || input.expectedHost.lease !== 'lease-1' || !['/api/yuri/assistants/snapshot', '/api/yuri/scheduled-tasks'].includes(input.path)) { rejected.push(input); throw new Error('Unexpected navigation-home wire'); }
      reads.push(input);
      const body = input.path.endsWith('/snapshot') ? assistants : schedules;
      if (typeof failed === 'number') return { status: failed, body: { error: 'Synthetic snapshot unavailable' } };
      return { status: 200, body: failed === 'partial' ? { ...body, partial: true } : body };
    },
  };
  return { handlers, reads, rejected, fail: value => { failed = value; } };
}
for (const section of ['assistants', 'schedules']) test('home ' + section + ' admits a complete empty catalog without guessed directory/ID', async () => {
  const host = synthetic(), raw = seed(section), app = await open('./App.tsx', { storage: { [key]: raw }, host: { handlers: host.handlers } });
  await app.waitFor('text:restore:restored'); expect(app.texts()).toContain('applied:' + section); expect(app.texts()).toContain('slot:0');
  expect(app.storage()[key]).toBe(raw); expect(host.reads.length).toBe(1); expect(host.rejected).toEqual([]);
});
test('home snapshot 404 and partial preserve prior bytes and explicit retry only rereads admission', async () => {
  const host = synthetic(), raw = seed('assistants'); host.fail(404);
  const app = await open('./App.tsx', { storage: { [key]: raw }, host: { handlers: host.handlers } });
  await app.waitFor('text:restore:error'); expect(app.storage()[key]).toBe(raw); expect(app.texts()).toContain('applied:none');
  host.fail('partial'); await app.press('id:home-read-retry'); await app.waitFor('text:restore:error'); expect(app.storage()[key]).toBe(raw);
  host.fail(null); await app.press('id:home-read-retry'); await app.waitFor('text:restore:restored'); expect(app.texts()).toContain('applied:assistants');
  expect(host.reads.length).toBe(3); expect(host.rejected).toEqual([]);
});
test('explicit user home choice supersedes the late initial GET without replaying or persisting catalog contents', async () => {
  const host = synthetic(); const app = await open('./App.tsx', { storage: { [key]: seed('assistants') }, host: { params: { holdSnapshot: true }, handlers: host.handlers } });
  await app.waitFor('text:snapshot:held'); await app.press('id:home-user-schedules'); await app.press('id:home-release-snapshot');
  await app.waitFor('text:restore:superseded'); await app.press('id:home-inspect');
  await app.waitUntil(() => JSON.parse(app.storage()[key]).entries[0].target.section === 'schedules');
  expect(app.texts()).toContain('applied:user-schedules'); expect(app.texts()).toContain('applies:0');
  expect(JSON.parse(app.storage()[key]).entries[0].target).toEqual({ kind: 'home', section: 'schedules' });
  expect(host.reads.length).toBe(1); expect(host.rejected).toEqual([]);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Home.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 75_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 95_000);

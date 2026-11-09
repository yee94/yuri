import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHost } from './features-memory-host.js';
// @ts-expect-error Fixture seed is a Node-only build module.
import { featuresUIKitSeed } from './tests/features-uikit/seed.mjs';
// @ts-expect-error Reuse the build-owned staging module without a second graph implementation.
import { stageNativeApplication } from './scripts/stage-native-application.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, executable: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'features-foundation-'));
  executable = path.join(temporary, 'policy');
  const result = spawnSync('xcrun', ['swiftc', 'tests/features-uikit/SyntheticHost.swift', 'tests/features-uikit/policy-cli.swift', '-o', executable], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
}, 70_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
type Call = { name: string; input: Record<string, unknown> };
function foundation(calls: Call[]) {
  const result = spawnSync(executable, [], { input: JSON.stringify({ seed: featuresUIKitSeed(), calls }), encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout) as Array<{ value?: unknown; error?: string }>;
}
const scope = { hostID: 'features-memory', lease: 'features-memory-lease' };
const read = (path: string): Call => ({ name: 'runtime.request', input: { path, method: 'GET', expectedHost: scope } });
const write = (path: string, method: string, body?: unknown): Call => ({ name: 'runtime.request', input: { path, method, ...(body === undefined ? {} : { body }), expectedHost: scope } });
const connect: Call = { name: 'connection.list', input: {} };
it('Foundation mapper matches the existing memory policy across admission, writes, lost ACK and readback', () => {
  const calls: Call[] = [connect, { name: 'features.fixture.identity', input: {} }, read('/api/config/settings'), read('/api/config/settings/bootstrap'), read('/api/config/catalog/providers?directory=%2Fmanaged'), read('/api/yuri/session-index'), read('/api/yuri/assistants/capability'),
    write('/api/config/settings', 'PUT', { favoriteModels: [{ providerID: 'fixture', modelID: 'model', variant: 'high' }] }),
    { name: 'features.fixture.configure', input: { lose: 'POST /api/yuri/assistants' } },
    write('/api/yuri/assistants', 'POST', { name: 'Created durable', providerID: 'fixture', modelID: 'model', defaultPrompt: '', workspacePath: null, variant: null }),
    read('/api/yuri/assistants/snapshot'),
    write('/api/projects/project/scheduled-tasks/task/run', 'POST'),
    write('/api/projects/project/scheduled-tasks', 'PATCH', { task: { id: 'task', enabled: false } }),
    read('/api/projects/project/scheduled-tasks')];
  const host = createHost();
  const expected = calls.map(call => { try { return { value: host.call(call.name, call.input) }; } catch { return { error: true }; } });
  const actual = foundation(calls);
  for (const [index, value] of expected.entries()) {
    if ('error' in value) expect(actual[index].error).toBeTruthy(); else expect(actual[index].value).toEqual(value.value);
  }
});
it('rejects missing/wrong scope and forbidden capabilities without recording a synthetic write', () => {
  const output = foundation([connect,
    { name: 'runtime.request', input: { path: '/api/yuri/assistants', method: 'POST', body: {} } },
    { name: 'runtime.request', input: { path: '/api/yuri/assistants', method: 'POST', body: {}, expectedHost: { ...scope, lease: 'retired' } } },
    write('https://host.invalid/api/yuri/assistants', 'POST', {}),
    { name: 'connection.connect', input: {} }, { name: 'speech.synthesize', input: {} },
    { name: 'features.fixture.audit', input: {} }]);
  expect(output.slice(1, 6).every(row => !!row.error)).toBe(true);
  expect(output[6].value).toMatchObject({ requests: [], network: false, keychain: false, modelInvocations: 0 });
});
it('requires actual connection adoption and applies an unknown Task update exactly once before read-only recovery', () => {
  const output = foundation([read('/api/config/settings'), connect,
    { name: 'features.fixture.configure', input: { lose: 'PATCH /api/projects/project/scheduled-tasks' } },
    write('/api/projects/project/scheduled-tasks', 'PATCH', { task: { id: 'task', name: 'Recovered fixture task' } }),
    read('/api/projects/project/scheduled-tasks'), { name: 'features.fixture.audit', input: {} }, { name: 'features.fixture.audit', input: {} }]);
  expect(output[0].error).toBeTruthy(); expect(output[3].error).toContain('ACK lost');
  expect(output[4].value).toMatchObject({ body: { tasks: [expect.objectContaining({ id: 'task', name: 'Recovered fixture task' })] } });
  for (const index of [5, 6]) {
    const audit = output[index].value as { requests: Array<{ method: string }>; lostACKs: number };
    expect(audit.requests.filter(call => call.method === 'PATCH')).toHaveLength(1); expect(audit.lostACKs).toBe(1);
  }
});
it('keeps history cursors opaque and retries a failed older page without writes or erasing the first page', () => {
  const first = '/api/yuri/scheduled-task-runs?limit=20&projectId=project&taskId=task';
  const older = '/api/yuri/scheduled-task-runs?limit=20&before=memory-opaque-next&projectId=project&taskId=task';
  const output = foundation([connect, read(first), { name: 'features.fixture.configure', input: { failRead: older } }, read(older), read(older), read(first), read(first + '&before=2'), { name: 'features.fixture.audit', input: {} }]);
  expect(output[1].value).toMatchObject({ body: { runs: [{ id: 'memory-history-1' }, { id: 'memory-history-2' }], nextCursor: 'memory-opaque-next', complete: false } });
  expect(output[3].value).toMatchObject({ status: 503 });
  expect(output[4].value).toMatchObject({ body: { runs: [{ id: 'memory-history-3' }, { id: 'memory-history-4' }], nextCursor: 'features-opaque-page-4', complete: false } });
  expect(output[5].value).toEqual(output[1].value); expect(output[6].error).toBeTruthy();
  expect(output[7].value).toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ method: 'GET' })]) });
  const audit = output[7].value as { requests: Array<{ method: string }> };
  expect(audit.requests.every(call => call.method === 'GET')).toBe(true);
});
it('reuses staging with an isolated entry and retains the production default', async () => {
  const repo = path.join(temporary, 'repo');
  const put = (file: string, source: string) => { const target = path.join(repo, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, source); };
  put('packages/nsh/App.tsx', 'console.log("production");');
  put('packages/nsh/tests/features-uikit/fixture.tsx', 'console.log("fixture");');
  put('packages/nsh/nsh.json', '{}'); put('packages/nsh/theme.json', '{}');
  const staged = await stageNativeApplication({ root: path.join(temporary, 'fixture-stage'), workspaceRoot: repo, entry: 'packages/nsh/tests/features-uikit/fixture.tsx' });
  expect(staged.manifest.sourceEntry).toBe('source/packages/nsh/tests/features-uikit/fixture.tsx');
  const normal = await stageNativeApplication({ root: path.join(temporary, 'normal-stage'), workspaceRoot: repo });
  expect(normal.manifest.sourceEntry).toBe('source/packages/nsh/App.tsx');
  await expect(stageNativeApplication({ root: path.join(temporary, 'bad-stage'), workspaceRoot: repo, entry: 'packages/../escape.tsx' })).rejects.toThrow('Invalid native staging entry');
});
it('loads actual production components/bridges and exposes audit without a fake current or UI replacement', () => {
  const fixture = readFileSync(path.join(root, 'tests/features-uikit/fixture.tsx'), 'utf8');
  const main = readFileSync(path.join(root, 'tests/features-uikit/uikit-main.swift'), 'utf8');
  expect(fixture).toContain('BotEditor, TaskEditor'); expect(fixture).toContain('captureHostOperation()'); expect(fixture).toContain('await loadConnections()');
  expect(fixture).not.toContain('app.connection.set'); expect(fixture).not.toContain('current: () => true');
  for (const bridge of ['NativeSheetPresentation.install', 'NativeDatePicker.install', 'AppearanceBridge(app:', 'ScheduleDateBridge(app:']) expect(main).toContain(bridge);
  expect(main).not.toMatch(/URLSession|ConnectionStore|RuntimeBridge|SecItem/);
  expect(main).toContain('features-audit.json');
});

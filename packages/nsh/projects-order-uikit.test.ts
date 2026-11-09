import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url)), fixtures = path.join(root, 'tests/projects-order-uikit');
const expectedHost = { hostID: 'projects-order-uikit-synthetic', lease: 'projects-order-uikit-memory-lease' };
type Call = { name: string; input: Record<string, unknown> };
type Result = { ok: boolean; value?: unknown; error?: string; snapshot: Record<string, unknown> };
const request = (resource: string, method = 'GET', body?: unknown): Call => ({ name: 'runtime.request', input: { path: resource, method, expectedHost, ...(body === undefined ? {} : { body }) } });
const audit: Call = { name: 'fixture.projectsOrder.audit', input: {} };
let temporary: string, binary: string;
beforeAll(() => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  temporary = mkdtempSync(path.join(parent, 'projects-order-swift-pure-')); binary = path.join(temporary, 'synthetic-host');
  const driver = path.join(temporary, 'Driver.swift');
  writeFileSync(driver, `import Foundation
@main struct Driver {
  static func main() throws {
    let seed = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let host = try ProjectsOrderSyntheticHost(seed: seed)
    let calls = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
    var results: [[String: Any]] = []
    for call in calls {
      do { let value = try host.call(call["name"] as! String, call["input"]); results.append(["ok": true, "value": value, "snapshot": host.snapshot]) }
      catch { results.append(["ok": false, "error": error.localizedDescription, "snapshot": host.snapshot]) }
    }
    print(try ProjectsOrderSyntheticHost.json(results))
  }
}
`);
  const result = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-parse-as-library', path.join(fixtures, 'SyntheticHost.swift'), driver, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
}, 65_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
function run(calls: Call[]): Result[] {
  const result = spawnSync(binary, [path.join(fixtures, 'seed.json')], { input: JSON.stringify(calls), encoding: 'utf8', timeout: 10_000 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
}
const ids = Array.from({ length: 12 }, (_, i) => `s0-${i}`), activity = Object.fromEntries(ids.map((id, i) => [id, 1000 - i]));
describe('Foundation-only Projects UIKit carrier; no NSH engine or device', () => {
  it('admits a synthetic connection snapshot and requires the exact native lease on reads and writes', () => {
    const results = run([{ name: 'connection.list', input: {} }, request('/api/yuri/session-index'),
      { name: 'runtime.request', input: { path: '/api/session-folders/order' } },
      { name: 'runtime.request', input: { path: '/api/session-folders/order', expectedHost: { ...expectedHost, lease: 'retired' } } },
      { name: 'runtime.request', input: { path: '/api/session-folders/order', expectedHost: { ...expectedHost, extra: true } } }, audit]);
    expect(results[0]).toMatchObject({ ok: true, value: { selected: expectedHost.hostID, runtimeScope: expectedHost, connections: [{ url: 'https://synthetic.invalid', authorizationID: 'fixture-memory-authorization' }] } });
    expect(results.map(result => result.ok)).toEqual([true, true, false, false, false, true]);
    expect(results.at(-1)?.snapshot).toMatchObject({ reads: 1, rejected: 3, sessionOrderWrites: 0, worktreeOrderWrites: 0, networkEnabled: false });
  });
  it('serves real Projects directory/attention/order envelopes with varied rows and hidden worktree rank', () => {
    const results = run([request('/api/yuri/session-index'), request('/api/session/active'), request('/api/session?directory=%2Ffixture%2Frepo&parentID=null&limit=20&order=desc'), request('/api/git/worktrees?directory=%2Ffixture%2Frepo'), request('/api/git/check?directory=%2Ffixture%2Frepo'), request('/api/yuri/message-queue/worktrees/order?projectDirectory=%2Ffixture%2Frepo')]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(results[1].value).toEqual({ status: 200, body: { 's0-11': { type: 'running' } } });
    expect(results[2].value).toMatchObject({ body: { data: expect.arrayContaining([expect.objectContaining({ id: 's0-0', summary: { additions: 12, deletions: 3 } }), expect.objectContaining({ id: 's0-11' })]) } });
    expect(results[5].value).toMatchObject({ body: { orderedPaths: ['/fixture/a', '/fixture/b', '/fixture/c', '/fixture/retained-unloaded-tree'] } });
  });
  it('records only actual scoped order writes, preserving metadata, pins, activity and unrelated scopes', () => {
    const order = ['s0-1', 's0-2', 's0-11', 's0-0', ...ids.slice(3, 11)];
    const results = run([audit, request('/api/session-folders/order', 'POST', { scopeKey: '/fixture/repo', order, activity, onlyIfAbsent: false }), audit, audit]);
    expect(results.every(result => result.ok)).toBe(true);
    const before = results[0].snapshot, after = results[3].snapshot;
    expect(after).toMatchObject({ sessionOrderWrites: 1, worktreeOrderWrites: 0, activities: before.activities, pins: before.pins, sessions: before.sessions, auditReads: 3 });
    expect(after.orders).toMatchObject({ '/fixture/repo': order, '/fixture/a': (before.orders as Record<string, string[]>)['/fixture/a'], __pinned__: ['s0-0', 's1-0', 's2-0'] });
  });
  it('uses CAS for in-memory worktree sorting and retains unloaded paths', () => {
    const orderedPaths = ['/fixture/b', '/fixture/a', '/fixture/c', '/fixture/retained-unloaded-tree'];
    const body = { projectDirectory: '/fixture/repo', expectedRevision: 1, requestID: 'fixture-drop', orderedPaths };
    const results = run([request('/api/yuri/message-queue/worktrees/order', 'PUT', body), request('/api/yuri/message-queue/worktrees/order', 'PUT', body), audit]);
    expect(results[0]).toMatchObject({ ok: true, value: { status: 200, body: { revision: 2 } } });
    expect(results[1]).toMatchObject({ ok: true, value: { status: 409 } });
    expect(results[2].snapshot).toMatchObject({ worktreeOrderWrites: 1, sessionOrderWrites: 0, treePaths: orderedPaths });
  });
  it.each([
    request('/api/session', 'POST', { location: { directory: '/fixture/repo' } }),
    request('/api/session/s0-0/prompt?directory=%2Ffixture%2Frepo', 'POST', { text: 'disabled' }),
    request('/api/session/s0-0', 'DELETE'), request('/api/git/worktrees?directory=%2Ffixture%2Frepo', 'DELETE', { directory: '/fixture/a' }),
    request('/api/fs/write', 'POST', { path: '/fixture/file', content: 'disabled' }), request('/api/config/settings', 'PUT', {}),
    request('https://synthetic.invalid/api/session-folders/order'), request('//synthetic.invalid/api/session-folders/order'),
    request('/api/session-folders/order?scope=a&scope=b'), request('/api/session-folders/order#fragment'),
    request('/api/session-folders/order', 'POST', { scopeKey: '/fixture/repo', order: ids, activity, onlyIfAbsent: 0 }),
    request('/api/session-folders/order', 'POST', { scopeKey: '/fixture/repo', order: ['s1-0', ...ids.slice(1)], activity, onlyIfAbsent: false }),
    request('/api/session-folders/order', 'POST', { scopeKey: '/fixture/repo', order: ids, activity: {}, onlyIfAbsent: false }),
    request('/api/yuri/message-queue/worktrees/order', 'PUT', { projectDirectory: '/fixture/repo', requestID: 'fixture', expectedRevision: true, orderedPaths: [] }),
    { name: 'connection.select', input: { id: 'other' } }, { name: 'runtime.stream', input: {} }, { name: 'fixture.projectsOrder.audit', input: { reorder: true } },
  ])('rejects unsafe or malformed fixture calls without mutations: %j', call => {
    const result = run([call])[0]; expect(result.ok).toBe(false);
    expect(result.snapshot).toMatchObject({ rejected: 1, sessionOrderWrites: 0, worktreeOrderWrites: 0, networkEnabled: false, keychainEnabled: false, sessionWritesEnabled: false });
  });
  it('keeps native UIKit wiring independent, stages exact source bytes, and never automates device launch', () => {
    const swift = readFileSync(path.join(fixtures, 'SyntheticHost.swift'), 'utf8') + readFileSync(path.join(fixtures, 'uikit-main.swift'), 'utf8');
    expect(swift).not.toMatch(/URLSession|SecItem|import Security|import Network|WKWebView|RuntimeBridge\(|ConnectionStore\(|Process\(/);
    expect(swift).toContain('surface.grantCapabilities'); expect(swift).toContain('surface.loadBundle'); expect(swift).toContain('NativeSheetPresentation.install(on: surface)');
    const fixture = readFileSync(path.join(fixtures, 'fixture.tsx'), 'utf8');
    expect(fixture).toContain("import { ProjectsHome, ProjectDetail } from '../../projects'"); expect(fixture).toContain("import { projectsFixtureAdmission } from '../projects-fixture-admission'"); expect(fixture).not.toContain('app.connection.set'); expect(fixture).not.toMatch(/\.reorder\(|\.reorderWorktree\(/);
    const admission = readFileSync(path.join(root, 'tests/projects-fixture-admission.ts'), 'utf8');
    expect(admission).toContain('loadConnections({ forceReconnect: true }).then('); expect(admission).toContain('captureHostOperation().current()'); expect(admission).not.toContain('app.connection.set');
    expect(fixture).toContain('active={admission.active() && nav.routes().at(-1) === route}');
    const script = readFileSync(path.join(root, 'scripts/build-projects-order-uikit.mjs'), 'utf8');
    expect(script).toContain('bytes.equals(await readFile(destination))'); expect(script).toContain('sourceSHA256'); expect(script).toContain('stagedSwift');
    expect(script).toContain('.nsh/projects-order-uikit'); expect(script).not.toMatch(/simctl|--web-host|\.nsh\/out|build-new-session-uikit/);
  });
});

import { expect, test } from 'vitest';
import { createDataset, datasetHash } from './dataset.mjs';
import { startFakeHost } from './fake-host.mjs';
import { distribution, gates, validateEvidence } from './gates.mjs';
import { summarizeRuns } from './summarize-electron.mjs';
import { analyzeTrace } from './analyze-electron-trace.mjs';

test('dataset L has exact scale, cross-host collisions and five streams on three hosts', () => {
  const data = createDataset();
  expect(data.hosts).toHaveLength(5);
  expect(data.projects).toHaveLength(50);
  expect(data.summaries).toHaveLength(5000);
  expect(data.streaming).toHaveLength(5);
  expect(new Set(data.streaming.map(s => s.hostId)).size).toBe(3);
  expect(new Set(data.projects.map(p => `${p.hostId ?? ''}:${p.path}`)).size).toBe(50);
  const collisions = data.projects.filter(p => data.projects.some(other => other.id !== p.id && other.path === p.path));
  expect(collisions).toHaveLength(10);
  expect(datasetHash(createDataset())).toBe(datasetHash(data));
  for (const catalog of Object.values(data.catalogs)) expect(catalog).toHaveLength(300);
});

test('local control keeps the same project/summary/stream cardinality without remote work', () => {
  const data = createDataset({ localOnly: true });
  expect(data.hosts).toEqual([]);
  expect(data.projects).toHaveLength(50);
  expect(data.summaries).toHaveLength(5000);
  expect(data.streaming).toHaveLength(5);
  expect(data.projects.every(p => !p.hostId)).toBe(true);
});

test('percentiles use nearest rank, reject missing/nonfinite samples and cover all 25 gates', () => {
  expect(distribution([4, 1, 3, 2])).toEqual({ count: 4, p50: 2, p95: 4, max: 4 });
  expect(() => distribution([])).toThrow();
  expect(() => distribution([NaN])).toThrow();
  expect(gates.map(g => g.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
});

test('evidence cannot claim success from missing artifacts, nonproduction timing or helper timings', () => {
  expect(validateEvidence({ gate: 8, status: 'passed', runtime: 'helper' }).length).toBeGreaterThan(0);
  const record = { schemaVersion: 1, phase: 'baseline', runtime: 'electron', production: true,
    device: 'test device', os: 'test os', runtimeVersion: 'test version', build: 'test hash',
    datasetHash: 'test dataset', command: 'test command', measurement: 'input dispatch', gate: 8,
    status: 'measured', artifacts: ['raw.json'], metrics: { dispatch: { unit: 'ms', samples: [1, 2, 3] } } };
  expect(validateEvidence(record)).toEqual([]);
  expect(validateEvidence({ ...record, production: false })).toContain('Timing requires production build');
  expect(validateEvidence({ ...record, artifacts: [] })).toContain('raw artifacts required');
});

test('fake upstream serves real HTTP, rejects unknown routes and exposes externally observed resource counts', async () => {
  const host = await startFakeHost();
  try {
    const sessions = await fetch(`${host.origin}/session`).then(r => r.json());
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every(s => !s.hostId)).toBe(true);
    expect((await fetch(`${host.origin}/missing`)).status).toBe(404);
    const metrics = await fetch(`${host.origin}/__perf/metrics`).then(r => r.json());
    expect(metrics.requests).toBe(2);
    expect(metrics.requestsByPath['/session']).toBe(1);
    expect(metrics.subscriptions).toBe(0);
  } finally { await host.close(); }
});

test('fake upstream status SSE is counted and released, controllable failures do not become empty success', async () => {
  const host = await startFakeHost();
  const abort = new AbortController();
  try {
    const response = await fetch(`${host.origin}/global/event`, { signal: abort.signal });
    const reader = response.body.getReader();
    await reader.read();
    expect(host.counts.subscriptions).toBe(1);
    await fetch(`${host.origin}/__perf/control`, { method: 'POST', body: JSON.stringify({ event: { type: 'session.status', properties: { sessionID: 'test', status: { type: 'busy' } } } }) });
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('session.status');
    expect(event).toContain('emittedAt');
    abort.abort();
    await fetch(`${host.origin}/__perf/control`, { method: 'POST', body: JSON.stringify({ mode: 'unauthorized' }) });
    expect((await fetch(`${host.origin}/session`)).status).toBe(401);
  } finally { abort.abort(); await host.close(); }
});

test('Gateway upstream fixture exposes snapshot and status-only event envelope, not token deltas', async () => {
  const host = await startFakeHost();
  const abort = new AbortController();
  try {
    const capability = await fetch(`${host.origin}/api/hosts/capabilities`).then(r => r.json());
    expect(capability).toMatchObject({ remoteProjects: true, protocol: 1, instanceId: 'perf-host-1' });
    const snapshot = await fetch(`${host.origin}/api/yuri/session-index`).then(r => r.json());
    expect(snapshot.directories.reduce((n, d) => n + d.sessions.length, 0)).toBeGreaterThan(0);
    const response = await fetch(`${host.origin}/api/hosts/status-stream`, { signal: abort.signal });
    const reader = response.body.getReader();
    await reader.read();
    for (const type of ['message.part.delta', 'session.status']) {
      await fetch(`${host.origin}/__perf/control`, { method: 'POST', body: JSON.stringify({ event: { directory: '/workspace/project-0', payload: { type, properties: { sessionID: 'fixture' } } } }) });
    }
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('session.status');
    expect(event).not.toContain('message.part.delta');
  } finally { abort.abort(); await host.close(); }
});

test('fixture associates a known remote project idempotently and does not pretend to implement other mutations', async () => {
  const host = await startFakeHost();
  try {
    const { projects } = await fetch(`${host.origin}/api/projects`).then(r => r.json());
    const associate = () => fetch(`${host.origin}/api/projects`, {
      method: 'POST', body: JSON.stringify({ path: projects[0].path }),
    }).then(r => r.json());
    expect(await associate()).toEqual({ project: projects[0], created: false });
    expect(await associate()).toEqual({ project: projects[0], created: false });
    expect((await fetch(`${host.origin}/api/projects`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(`${host.origin}/api/projects`, { method: 'POST', body: '{"path":"/missing"}' })).status).toBe(404);
  } finally { await host.close(); }
});

test('startup summary retains failed launches and cannot call fewer than 20 captured windows complete', () => {
  const document = { phase: 'baseline', build: 'test', requestedColdStarts: 20, runs: [
    { index: 0, raw: { status: 'blocked', reason: 'missing CLI' } },
    { index: 1, raw: { status: 'measured', launchEpochMs: 100, windows: [[1, { sidebar: { captureCompletedEpochMs: 200, emptyImage: false }, transcript: { captureCompletedEpochMs: 300, emptyImage: false } }]] } },
  ] };
  const summary = summarizeRuns(document);
  expect(summary.failures).toHaveLength(1);
  expect(summary.startup.sidebar).toMatchObject({ samples: [100], minimum20: false });
  expect(summary.startup.transcript.distributionMs.max).toBe(200);
});

test('L fixture implements known non-Git worktrees and scoped scheduler sync without accepting unknown mutations', async () => {
  const host = await startFakeHost();
  try {
    const { projects } = await fetch(`${host.origin}/api/projects`).then(r => r.json());
    const all = await fetch(`${host.origin}/api/yuri/session-index`).then(r => r.json());
    const directories = projects.slice(0, 2).map(project => project.path);
    for (const directory of directories) {
      const response = await fetch(`${host.origin}/api/git/worktrees?directory=${encodeURIComponent(directory)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
    const sync = body => fetch(`${host.origin}/api/yuri/session-index/sync`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await sync({ directories: [...directories, directories[0]] });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.directories).toEqual(all.directories.filter(row => directories.includes(row.directory)));
    expect(body.directories.every(row => row.sessions.length > 0)).toBe(true);
    expect(body.sync).toMatchObject({ active: false, completed: 2, total: 2, completedDirectories: directories, failedDirectories: [] });
    expect((await (await sync({ directories: [] })).json()).directories).toEqual([]);
    expect((await sync({ directories: [directories[0], '/missing'] })).status).toBe(404);
    for (const input of [{}, { directories: 'not-an-array' }, { directories: [null] }]) expect((await sync(input)).status).toBe(400);
    expect((await fetch(`${host.origin}/api/yuri/session-index/sync`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fetch(`${host.origin}/api/git/worktrees?directory=/missing`)).status).toBe(404);
    expect((await fetch(`${host.origin}/api/git/worktrees`)).status).toBe(400);
    expect((await fetch(`${host.origin}/api/git/worktrees`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`${host.origin}/api/yuri/session-index/sync`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(`${host.origin}/api/unknown`, { method: 'POST', body: '{}' })).status).toBe(405);
    const after = await fetch(`${host.origin}/api/yuri/session-index`).then(r => r.json());
    expect(after).toEqual(all);
    expect(host.counts.requestsByPath['/api/yuri/session-index/sync']).toBe(8);
  } finally { await host.close(); }
});

test('trace analysis includes containing renderer task microtasks but does not misattribute GPU work', () => {
  const trace = { traceEvents: [
    { ph: 'M', name: 'process_name', pid: 1, args: { name: 'Renderer' } },
    { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
    { ph: 'M', name: 'process_name', pid: 3, args: { name: 'GPU Process' } },
    { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 2, ts: 0, dur: 60000 },
    { ph: 'X', name: 'EventDispatch', pid: 1, tid: 2, ts: 100, dur: 200, args: { data: { type: 'input' } } },
    { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 3, tid: 4, ts: 0, dur: 500000 },
  ] };
  const report = analyzeTrace(trace);
  expect(report.inputContainingTasksAtLeast50ms).toBe(1);
  expect(report.allRendererMainTaskMs.max).toBe(60);
  expect(report.eventDispatch.input.max).toBe(0.2);
  expect(() => analyzeTrace({ traceEvents: [] })).toThrow('No real Chromium renderer');
});

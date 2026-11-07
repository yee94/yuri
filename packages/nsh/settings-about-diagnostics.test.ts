import { afterEach, expect, test, vi } from 'vitest';
import { aboutDiagnosticTypes, aboutDiagnosticsCall, createAboutDiagnosticsRoot } from './settings-about-diagnostics';
import { runtimeEventFrom, type RuntimeEvent } from './model';

let root: ReturnType<typeof createAboutDiagnosticsRoot> | undefined;
afterEach(() => { root?.dispose(); root = undefined; });
const scope = { hostID: 'private-host-id', generation: 1 };
const status = (enabled = true, lease = 'memory-lease') => ({ schemaVersion: 2, mode: 'event-recorder', enabled, recordingLease: enabled ? lease : null });
const event = (type = 'session.status'): RuntimeEvent => ({ key: 'global', type, directory: '/private/path', id: 'private-event-id', body: { sessionID: 'private-session', text: 'private-user-text', attachments: ['private-file-content'], token: 'private-token' } });
test('default closed, old snapshot authorization is not event recording consent', async () => {
  const call = vi.fn(async () => ({ schemaVersion: 1, enabled: true, mode: 'snapshot-only' }));
  root = createAboutDiagnosticsRoot({ call, scope: () => scope });
  root.onEvent(event(), scope); await root.refresh(); root.onEvent(event(), scope); await root.flush();
  expect(call).toHaveBeenCalledExactlyOnceWith('native.diagnostics.status');
});
test('real parsed runtime event feeds the compatible Web schema subset and never serializes private fields', async () => {
  const call = vi.fn(async () => status()); root = createAboutDiagnosticsRoot({ call, scope: () => scope, now: () => 42 }); await root.refresh();
  const parsed = runtimeEventFrom({ key: 'global', data: JSON.stringify({ payload: { type: 'session.execution.failed.2', properties: event().body }, directory: '/private/path' }) });
  expect(parsed).not.toBeNull(); root.onEvent(parsed!, scope); await root.flush();
  const append = call.mock.calls.find(([name]) => name === 'native.diagnostics.append');
  expect(append).toEqual(['native.diagnostics.append', { hostID: scope.hostID, lease: 'memory-lease', dropped: 0, events: [{ at: 42, feat: 'transcript', kind: 'sse-event', sessionID: 'session-1', source: 'sse', sseType: 'session.execution.failed', surfaceKind: 'global' }] }]);
  expect(JSON.stringify(append?.[1]?.events)).not.toMatch(/private|token|path|text|attachments/);
});
test('100,000 token events do zero body reads/serializations/native calls/catalog scans even while enabled', async () => {
  const call = vi.fn(async () => status()); root = createAboutDiagnosticsRoot({ call, scope: () => scope }); await root.refresh();
  let reads = 0;
  const noise = { key: 'global', type: 'message.part.delta', get body() { reads++; throw new Error('Token body inspected'); } } as RuntimeEvent;
  for (let index = 0; index < 100_000; index++) root.onEvent(noise, scope);
  await root.flush(); expect(reads).toBe(0); expect(call).toHaveBeenCalledTimes(1);
  root.adopt(status(false)); const disabled = Object.create(noise) as RuntimeEvent; disabled.type = 'session.status';
  for (let index = 0; index < 1_000; index++) root.onEvent(disabled, scope);
  expect(reads).toBe(0);
});
test('queue, batch and identity storage are bounded; backpressure loss is reported instead of retaining raw payloads', async () => {
  let release!: (value: unknown) => void, blocked = true;
  const batches: Record<string, unknown>[] = [];
  const call = vi.fn(async (name: string, body?: Record<string, unknown>) => {
    if (name !== 'native.diagnostics.append') return status();
    batches.push(body!);
    if (blocked) return new Promise(resolve => { release = resolve; });
    return { accepted: true };
  });
  root = createAboutDiagnosticsRoot({ call, scope: () => scope }); await root.refresh();
  for (let index = 0; index < 10_000; index++) root.onEvent({ ...event(), body: { sessionID: `private-${index}` } }, scope);
  expect(batches).toHaveLength(1);
  blocked = false; release({ accepted: true }); await root.flush();
  expect(batches).toHaveLength(5); // 1 immediately admitted + bounded 128 / 32.
  const all = batches.flatMap(batch => batch.events as unknown[]); expect(all).toHaveLength(129);
  expect(batches.reduce((total, batch) => total + Number(batch.dropped), 0)).toBe(9_871);
  expect(JSON.stringify(all)).not.toContain('private');
  expect((all.at(-1) as { sessionID: string }).sessionID).toBe('session-0');
  for (const batch of batches) expect((batch.events as unknown[]).length).toBeLessThanOrEqual(32);
});
test('single owner, scope/generation fence, status race and lease rotation isolate Host data', async () => {
  let selected: typeof scope | null = scope;
  const call = vi.fn(async () => status()); root = createAboutDiagnosticsRoot({ call, scope: () => selected }); await root.refresh();
  expect(() => createAboutDiagnosticsRoot({ call, scope: () => selected })).toThrow('duplicate_owner');
  root.onEvent(event(), { ...scope, generation: 2 }); expect(call).toHaveBeenCalledTimes(1);
  selected = { ...scope, hostID: 'other-host', generation: 2 };
  root.onEvent(event(), scope); expect(call).toHaveBeenCalledTimes(1);
  await root.refresh(); root.onEvent(event(), selected); await root.flush();
  expect(call.mock.calls.at(-1)?.[1]).toMatchObject({ hostID: 'other-host', events: [{ sessionID: 'session-1' }] });
  root.adopt(status(false)); root.onEvent(event(), selected); const before = call.mock.calls.length; await root.flush(); expect(call).toHaveBeenCalledTimes(before);
});
test('Settings toggles update the single root immediately and export waits for pending native append', async () => {
  let enabled = false, release!: (value: unknown) => void;
  const names: string[] = [];
  const call = vi.fn(async (name: string, body?: Record<string, unknown>) => {
    names.push(name);
    if (name === 'native.diagnostics.setEnabled') enabled = body?.enabled === true;
    if (name === 'native.diagnostics.append') return new Promise(resolve => { release = resolve; });
    if (name === 'native.diagnostics.export') return { outcome: 'cancelled' };
    return status(enabled);
  });
  root = createAboutDiagnosticsRoot({ call, scope: () => scope }); await root.refresh();
  await aboutDiagnosticsCall(call, 'native.diagnostics.setEnabled', { enabled: true }); root.onEvent(event(), scope);
  const exporting = aboutDiagnosticsCall(call, 'native.diagnostics.export', { hostID: scope.hostID, snapshot: {} });
  expect(names).not.toContain('native.diagnostics.export'); release({ accepted: true });
  await expect(exporting).resolves.toEqual({ outcome: 'cancelled' });
  await aboutDiagnosticsCall(call, 'native.diagnostics.setEnabled', { enabled: false }); root.onEvent(event(), scope);
  expect(names.filter(name => name === 'native.diagnostics.append')).toHaveLength(1);
});
test('append failure stops the broken lease without an automatic retry or leaked error; explicit refresh recovers', async () => {
  const call = vi.fn(async (name: string) => { if (name === 'native.diagnostics.append') throw new Error('private-secret'); return status(); });
  root = createAboutDiagnosticsRoot({ call, scope: () => scope }); await root.refresh(); root.onEvent(event(), scope); await root.flush(); root.onEvent(event(), scope); await root.flush();
  expect(call.mock.calls.filter(([name]) => name === 'native.diagnostics.append')).toHaveLength(1);
  await root.refresh(); root.onEvent(event(), scope); await root.flush(); expect(call.mock.calls.filter(([name]) => name === 'native.diagnostics.append')).toHaveLength(2);
});
test('every permitted runtime event type has exactly the fixed content-free shape', async () => {
  const call = vi.fn(async () => status()); root = createAboutDiagnosticsRoot({ call, scope: () => scope }); await root.refresh();
  for (const type of aboutDiagnosticTypes) root.onEvent(event(type), scope);
  await root.flush();
  const events = call.mock.calls.filter(([name]) => name === 'native.diagnostics.append').flatMap(([, body]) => body!.events as Record<string, unknown>[]);
  expect(events.map(row => row.sseType)).toEqual(aboutDiagnosticTypes);
  for (const value of events) expect(Object.keys(value).sort()).toEqual(['at', 'feat', 'kind', 'sessionID', 'source', 'sseType', 'surfaceKind']);
});

test('the same parsed sink captures Chat stream structural facts without requiring a second subscription or native stream', async () => {
  const call = vi.fn(async (_name: string, _body?: Record<string, unknown>): Promise<unknown> => status());
  root = createAboutDiagnosticsRoot({ call, scope: () => scope }); await root.refresh();
  const parsed = runtimeEventFrom({ key: 'chat', data: JSON.stringify({ type: 'message.updated', properties: { info: { sessionID: 'private-session', text: 'private-body' } } }) });
  root.onEvent(parsed!, scope); await root.flush();
  expect(call.mock.calls.at(-1)?.[1]).toMatchObject({ events: [{ surfaceKind: 'chat', sseType: 'message.updated', sessionID: 'session-1' }] });
  expect(call.mock.calls.map(([name]) => name)).toEqual(['native.diagnostics.status', 'native.diagnostics.append']);
});

test('late Settings status from a previous scope cannot arm a new Host lease', async () => {
  let selected = scope, resolve!: (value: unknown) => void;
  const call = vi.fn(async (_name: string, _body?: Record<string, unknown>): Promise<unknown> => status());
  root = createAboutDiagnosticsRoot({ call, scope: () => selected }); await root.refresh();
  call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = aboutDiagnosticsCall(call, 'native.diagnostics.status');
  selected = { hostID: 'new-host', generation: 2 }; call.mockResolvedValue(status(false)); await root.refresh();
  resolve(status(true, 'old-host-lease')); await pending;
  root.onEvent(event(), selected); await root.flush();
  expect(call.mock.calls.filter(([name]) => name === 'native.diagnostics.append')).toEqual([]);
});

test('disposing while a status read is pending cannot arm another root or issue late append calls', async () => {
  let resolve!: (value: unknown) => void;
  const call = vi.fn(async (_name: string, _body?: Record<string, unknown>): Promise<unknown> => new Promise(done => { resolve = done; }));
  root = createAboutDiagnosticsRoot({ call, scope: () => scope }); const pending = root.refresh(); root.dispose();
  resolve(status()); await pending; root.onEvent(event(), scope); await root.flush(); expect(call).toHaveBeenCalledTimes(1);
});

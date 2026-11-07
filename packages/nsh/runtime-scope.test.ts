import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeScopeFrom, sameRuntimeScope } from './runtime-scope';

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: h.call } }));
beforeEach(() => { h.call.mockReset().mockResolvedValue({ status: 200, body: { ok: true } }); });

it('accepts only Native-issued complete scope records and freezes an independent copy', () => {
  const original = { hostID: 'A', lease: 'opaque-lease' }, scope = runtimeScopeFrom(original)!;
  expect(scope).not.toBe(original); expect(Object.isFrozen(scope)).toBe(true);
  original.lease = 'changed'; expect(scope.lease).toBe('opaque-lease');
  expect(runtimeScopeFrom(null)).toBeNull(); expect(runtimeScopeFrom(undefined)).toBeNull();
  for (const value of [false, 1, '', [], {}, { hostID: 'A' }, { hostID: 'A', lease: '' }, { hostID: '', lease: 'x' }, { hostID: ' A', lease: 'x' }, { hostID: 'A', lease: 1 }, { hostID: 'A', lease: 'x', epoch: 4 }]) expect(() => runtimeScopeFrom(value)).toThrow('invalid_runtime_scope');
  expect(sameRuntimeScope(scope, { hostID: 'A', lease: 'opaque-lease' })).toBe(true);
  expect(sameRuntimeScope(scope, { hostID: 'A', lease: 'next' })).toBe(false);
  expect(sameRuntimeScope(scope, { hostID: 'B', lease: 'opaque-lease' })).toBe(false);
  expect(sameRuntimeScope(null, null)).toBe(true); expect(sameRuntimeScope(scope, null)).toBe(false);
});

it('captures a frozen lease for GET and every later mutation continuation, without recapturing a mutable input', async () => {
  const { bindRequest } = await import('./runtime'); const source = { hostID: 'A', lease: 'one' }, send = bindRequest(source);
  await send('/read'); source.hostID = 'B'; source.lease = 'two';
  await send('/write', 'POST', { exact: 'body' });
  expect(h.call.mock.calls).toEqual([
    ['runtime.request', { path: '/read', method: 'GET', expectedHost: { hostID: 'A', lease: 'one' } }],
    ['runtime.request', { path: '/write', method: 'POST', body: { exact: 'body' }, expectedHost: { hostID: 'A', lease: 'one' } }],
  ]);
  expect(Object.isFrozen(h.call.mock.calls[0]![1].expectedHost)).toBe(true);
});

it('unbound compatibility is GET-only; every non-GET fails before Native and native() never injects a scope', async () => {
  const { request, bindRequest, bindRawRequest, native } = await import('./runtime');
  await request('/legacy-read'); expect(h.call).toHaveBeenCalledWith('runtime.request', { path: '/legacy-read', method: 'GET' }); h.call.mockClear();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'post']) {
    await expect(request('/write', method)).rejects.toThrow('scope_required');
    await expect(bindRequest(null)('/write', method)).rejects.toThrow('scope_required');
    await expect(bindRawRequest(null)('/write', method)).rejects.toThrow('scope_required');
  }
  expect(h.call).not.toHaveBeenCalled();
  await native('custom.native', { exact: 1 }); expect(h.call).toHaveBeenCalledWith('custom.native', { exact: 1 });
});

it('raw keeps non-success status/body for dedicated parsers while the JSON request reports HTTP failure', async () => {
  const { bindRequest, bindRawRequest } = await import('./runtime'), scope = { hostID: 'A', lease: 'one' };
  h.call.mockResolvedValue({ status: 409, body: { reason: 'conflict', message: 'fixture conflict' } });
  expect(await bindRawRequest(scope)('/raw', 'POST')).toEqual({ status: 409, body: { reason: 'conflict', message: 'fixture conflict' } });
  await expect(bindRequest(scope)('/raw', 'POST')).rejects.toMatchObject({ status: 409, message: 'HTTP 409: fixture conflict' });
  h.call.mockResolvedValue({ body: [] }); await expect(bindRawRequest(scope)('/raw')).rejects.toThrow('Invalid native response');
});

it('propagates unknown Native mutation failures once, with no silent fallback or replay', async () => {
  const { bindRequest } = await import('./runtime'); h.call.mockRejectedValue(new Error('unknown_runtime_request'));
  await expect(bindRequest({ hostID: 'A', lease: 'one' })('/unsupported', 'POST')).rejects.toThrow('unknown_runtime_request');
  expect(h.call).toHaveBeenCalledTimes(1);
});

it('connection snapshots preserve the actual matching lease; legacy missing scope is read-only, malformed scope is not legacy', async () => {
  const { connectionSnapshotFrom, connections } = await import('./runtime');
  const base = { connections: [{ id: 'A', url: 'https://fixture.example' }], selected: 'A' };
  expect(connectionSnapshotFrom(base).runtimeScope).toBeNull();
  h.call.mockResolvedValue({ ...base, runtimeScope: { hostID: 'A', lease: 'one' } });
  expect((await connections()).runtimeScope).toEqual({ hostID: 'A', lease: 'one' });
  expect(() => connectionSnapshotFrom({ ...base, runtimeScope: { hostID: 'B', lease: 'one' } })).toThrow();
  expect(() => connectionSnapshotFrom({ ...base, runtimeScope: { hostID: 'A' } })).toThrow();
  expect(() => connectionSnapshotFrom({ ...base, selected: 'missing' })).toThrow();
  expect(() => connectionSnapshotFrom({ connections: {}, selected: null })).toThrow();
});

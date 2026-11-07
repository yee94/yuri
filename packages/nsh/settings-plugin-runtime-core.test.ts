import { describe, expect, test, vi } from 'vitest';
import { findRuntimeMatches, nativePluginInventory, nativePluginTarget, readNativePluginInventory, readNativePluginRegistry, reloadNativePlugins, resolveLoadState, resolveUpdateFlag, updateNativePlugin } from './settings-plugin-runtime-core';
import type { SettingsRequest } from './settings-protocol';

const target = { kind: 'package' as const, target: 'example-plugin@latest' };
const registry = { kind: 'npm-ok', name: 'example-plugin', spec: target.target, latestVersion: '2.0.0', hasUpdate: true };
const active = { source: { type: 'package', target: target.target, version: '1.0.0', outdated: true, updating: false }, state: { status: 'active' } };
describe('native plugin runtime preserves Web matching and official methods', () => {
  test('GET list, POST check and POST location reload are three different operations', async () => {
    const calls: unknown[][] = [];
    const send: SettingsRequest = async (...args) => { calls.push(args); return args[0] === '/api/location/reload' ? undefined : { data: [active] }; };
    const list = await readNativePluginInventory(send, '/work tree');
    await readNativePluginInventory(send, '/work tree', true);
    await reloadNativePlugins(send, () => true);
    expect(calls).toEqual([
      ['/api/plugin?location%5Bdirectory%5D=%2Fwork%20tree', 'GET', undefined],
      ['/api/plugin/check?location%5Bdirectory%5D=%2Fwork%20tree', 'POST', {}],
      ['/api/location/reload', 'POST'],
    ]);
    expect(resolveUpdateFlag(findRuntimeMatches(target, list))).toBe('available');
  });
  test('new failure wins over a still-running old revision; preserves ref/full error', () => {
    const list = nativePluginInventory({ data: [active, { source: active.source, state: { status: 'failed', error: 'first\nsecond\nthird', ref: 'reference' } }] });
    expect(resolveLoadState(findRuntimeMatches(target, list))).toEqual({ kind: 'failed', error: 'first\nsecond\nthird', ref: 'reference' });
    expect(resolveLoadState(findRuntimeMatches({ kind: 'package', target: 'example-plugin' }, list))).toEqual({ kind: 'notReported' });
  });
  test.each([{}, { data: {} }, { data: [{ source: { type: 'unknown' }, state: { status: 'active' } }] }, { data: [{ ...active, state: { status: 'failed' } }] }])('bad inventory is never notReported (%j)', payload => {
    expect(() => nativePluginInventory(payload)).toThrow();
  });
  test('relative local files follow declaring config, not package-name heuristics', () => {
    expect(nativePluginTarget({ spec: '../plugins/plugin.js', sourcePath: '/workspace/.opencode/opencode.json' })).toEqual({ kind: 'local', path: '/workspace/plugins/plugin.js' });
    expect(nativePluginTarget({ file: true, absolutePath: '/workspace/plugins/plugin.js' })).toEqual({ kind: 'local', path: '/workspace/plugins/plugin.js' });
    expect(nativePluginTarget({ spec: './plugin.js' })).toBeNull();
  });
  test('mutable package update never writes config', async () => {
    const send = vi.fn(async () => undefined);
    await updateNativePlugin(send, target, 'entry', null, '/workspace', () => true);
    expect(send).toHaveBeenCalledExactlyOnceWith('/api/plugin/update?location%5Bdirectory%5D=%2Fworkspace', 'POST', { targets: [target.target] });
  });
  test('registry-selected update rewrites just spec, not options or scope', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    await updateNativePlugin(send, target, 'entry/a', registry, '/work tree', () => true);
    expect(send).toHaveBeenCalledExactlyOnceWith('/api/config/plugins/entry/entry%2Fa?directory=%2Fwork%20tree', 'PATCH', { spec: 'example-plugin@2.0.0' });
  });
  test('confirmed config write with reload failure is a receipt, not a replayable rejected write', async () => {
    const send = vi.fn(async () => ({ ok: true, reloadFailed: true, warning: 'Runtime unavailable' }));
    await expect(updateNativePlugin(send, target, 'entry', registry, undefined, () => true)).resolves.toEqual({ warning: 'Runtime unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  test('registry data for another target cannot rewrite this config entry', async () => {
    const send = vi.fn(async () => undefined);
    await updateNativePlugin(send, target, 'entry', { ...registry, spec: 'another-plugin' }, undefined, () => true);
    expect(send).toHaveBeenCalledExactlyOnceWith('/api/plugin/update', 'POST', { targets: [target.target] });
  });
  test('registry lookup uses existing scoped route and spec matching', async () => {
    const send = vi.fn(async () => ({ results: [registry] }));
    await expect(readNativePluginRegistry(send, target.target, '/workspace')).resolves.toEqual(registry);
    expect(send).toHaveBeenCalledWith('/api/config/plugins/registry?specs=example-plugin%40latest&directory=%2Fworkspace');
  });
  test('rejected writes propagate; stale host and local targets never mutate', async () => {
    const failed = vi.fn(async () => { throw new Error('Rejected'); });
    await expect(updateNativePlugin(failed, target, 'entry', null, undefined, () => true)).rejects.toThrow('Rejected');
    const send = vi.fn(async () => undefined);
    await expect(updateNativePlugin(send, { kind: 'local', path: '/plugin.js' }, '', null, undefined, () => true)).rejects.toThrow();
    await expect(reloadNativePlugins(send, () => false)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

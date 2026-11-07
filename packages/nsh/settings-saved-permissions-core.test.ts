import { describe, expect, test, vi } from 'vitest';
import { deleteNativeSavedPermission, readNativeSavedPermissions, type NativeSavedPermissionSnapshot } from './settings-saved-permissions-core';
import type { SettingsRequest } from './settings-protocol';

const item = { id: 'saved/a b', projectID: 'project/a', action: 'shell', resource: 'npm test' };
const snapshot: NativeSavedPermissionSnapshot = { directory: '/work tree', projectID: item.projectID, items: [item] };
describe('native saved permissions capture directory/project scope', () => {
  test('resolves project from location then reads project-filtered rules', async () => {
    const calls: unknown[][] = [];
    const send: SettingsRequest = async (...args) => { calls.push(args); return calls.length === 1 ? { project: { id: item.projectID } } : { data: [item] }; };
    await expect(readNativeSavedPermissions(send, snapshot.directory, () => true)).resolves.toEqual(snapshot);
    expect(calls).toEqual([['/api/location?location%5Bdirectory%5D=%2Fwork%20tree'], ['/api/permission/saved?projectID=project%2Fa']]);
  });
  test.each([undefined, {}, { data: [{ ...item, projectID: 'other' }] }, { data: [{ ...item, action: '' }] }])('malformed/mismatched read is not authoritative empty', async payload => {
    let calls = 0;
    await expect(readNativeSavedPermissions(async () => ++calls === 1 ? { project: { id: item.projectID } } : payload, snapshot.directory, () => true)).rejects.toThrow();
  });
  test('empty scope and a stale location resolution cannot dispatch a global list', async () => {
    const send = vi.fn(async () => ({ project: { id: 'project' } }));
    await expect(readNativeSavedPermissions(send, '', () => true)).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
    let current = true;
    const stale = vi.fn(async () => { current = false; return { project: { id: 'project' } }; });
    await expect(readNativeSavedPermissions(stale, '/workspace', () => current)).rejects.toThrow('Runtime changed'); expect(stale).toHaveBeenCalledTimes(1);
  });
  test('DELETE is encoded, confirmed before local removal and accepts 204', async () => {
    const send = vi.fn(async () => undefined);
    const next = await deleteNativeSavedPermission(send, snapshot, item.id, () => true);
    expect(send).toHaveBeenCalledWith('/api/permission/saved/saved%2Fa%20b', 'DELETE');
    expect(next.items).toEqual([]); expect(snapshot.items).toEqual([item]);
  });
  test('failure preserves the exact prior snapshot and can safely retry', async () => {
    const failed = vi.fn(async () => { throw new Error('Rejected'); });
    await expect(deleteNativeSavedPermission(failed, snapshot, item.id, () => true)).rejects.toThrow('Rejected');
    expect(snapshot.items).toEqual([item]);
    expect((await deleteNativeSavedPermission(async () => undefined, snapshot, item.id, () => true)).items).toEqual([]);
  });
  test('foreign rule, stale host or malformed scope never sends a deletion', async () => {
    const send = vi.fn(async () => undefined);
    for (const [candidate, id, current] of [[snapshot, 'foreign', true], [snapshot, item.id, false], [{ ...snapshot, projectID: 'other' }, item.id, true]] as const) {
      await expect(deleteNativeSavedPermission(send, candidate, id, () => current)).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });
});

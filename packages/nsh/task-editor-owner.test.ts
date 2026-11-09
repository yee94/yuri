import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  return { signal, cleanups: [] as Array<() => void>, generation: 1, active: true, interactive: true, request: vi.fn(), refresh: vi.fn(), dialog: vi.fn(), done: vi.fn(), close: vi.fn(), connection: signal({ id: 'host', url: 'https://host.example' }) };
});
vi.mock('nsh', () => ({ signal: h.signal, cleanup: (work: () => void) => h.cleanups.push(work), effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(), lifecycle: () => 'active' }));
vi.mock('nsh/base', () => ({ AlertDialog: { show: h.dialog } }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));
vi.mock('./state', () => ({ refresh: h.refresh, epoch: () => h.generation, app: { connection: h.connection, runtimeScope: () => null }, captureHostOperation: () => {
  const generation = h.generation, connection = h.connection();
  return { generation, current: () => generation === h.generation && connection === h.connection(), request: h.request };
} }));
import { createTaskEditorOwner } from './task-editor-owner';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const owner = () => createTaskEditorOwner(() => h.active, () => h.interactive, h.done);
beforeEach(() => {
  h.cleanups = []; h.generation = 1; h.active = true; h.interactive = true;
  h.request.mockReset(); h.refresh.mockReset(); h.dialog.mockReset(); h.done.mockReset(); h.close.mockReset();
  h.dialog.mockResolvedValue({ action: 'cancel' }); h.refresh.mockResolvedValue(undefined);
});
describe('retained TaskEditor operation and departure owner', () => {
  it.each(['snapshot', 'edit-revision'] as const)('ordinary departure rechecks captured %s after discard confirmation, preserving newer draft', async mode => {
    const state = owner(); let draft = 'clean'; const navigation = state.navigation(() => draft, h.close), commit = vi.fn();
    draft = 'dirty at confirmation'; const answer = deferred<{ action: string }>(); h.dialog.mockReturnValueOnce(answer.promise);
    const leaving = navigation.cancel(commit);
    if (mode === 'snapshot') draft = 'programmatically updated while awaiting';
    else { state.invalidateCloseGrant(); draft = 'temporary edit'; draft = 'dirty at confirmation'; }
    answer.resolve({ action: 'discard' }); await leaving;
    expect(commit).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled(); expect(h.done).not.toHaveBeenCalled(); expect(navigation.dirty()).toBe(true);
  });
  it('native close cancellation and approved-but-expired tickets retain the same dirty owner without onDone/onClose', async () => {
    const state = owner(); let draft = 'pristine'; const navigation = state.navigation(() => draft, h.close), guard = navigation.windowGuard;
    expect(guard.canClose()).toBe(true); draft = 'full dirty draft';
    expect(await guard.requestClose()).toBe(false); expect(guard.canClose()).toBe(false);
    h.dialog.mockResolvedValueOnce({ action: 'discard' }); expect(await guard.requestClose()).toBe(true);
    expect(guard.canClose()).toBe(true); expect(navigation.dirty()).toBe(true); expect(draft).toBe('full dirty draft');
    // The native ticket can expire/refuse here; no lifecycle action has happened.
    expect(state.current()).toBe(true); expect(h.close).not.toHaveBeenCalled(); expect(h.done).not.toHaveBeenCalled();
    state.invalidateCloseGrant(); draft += ' edited during file flush';
    expect(guard.canClose()).toBe(false); expect(state.current()).toBe(true);
  });
  it('window close may confirm under a modal, but edits and Host lane changes revoke its exact grant', async () => {
    const state = owner(); let draft = 'clean'; const guard = state.navigation(() => draft, h.close).windowGuard;
    draft = 'dirty'; h.interactive = false; h.dialog.mockResolvedValue({ action: 'discard' });
    expect(await guard.requestClose()).toBe(true); expect(guard.canClose()).toBe(true);
    state.invalidateCloseGrant(); draft = 'changed'; draft = 'dirty';
    expect(guard.canClose()).toBe(false); expect(await guard.requestClose()).toBe(true);
    h.generation++; expect(guard.canClose()).toBe(false); expect(await guard.requestClose()).toBe(false);
  });
  it('pending/unknown writes and a concurrent confirmation never grant native destruction', async () => {
    const state = owner(); let draft = 'clean'; const guard = state.navigation(() => draft, h.close).windowGuard;
    const pending = deferred<unknown>(); h.request.mockReturnValueOnce(pending.promise);
    const flight = state.perform(() => state.request('/task', 'PATCH'));
    expect(await guard.requestClose()).toBe(false); expect(guard.canClose()).toBe(false);
    pending.resolve({ malformed: true }); await flight; expect(await guard.requestClose()).toBe(false); expect(guard.canClose()).toBe(false);
    state.acknowledge(); draft = 'dirty'; const answer = deferred<{ action: string }>(); h.dialog.mockReturnValueOnce(answer.promise);
    const first = guard.requestClose(); expect(await guard.requestClose()).toBe(false); expect(guard.canClose()).toBe(false);
    state.invalidateCloseGrant(); draft = 'edit during confirmation'; answer.resolve({ action: 'discard' }); expect(await first).toBe(false);
  });
  it('cancel preserves the entire snapshot; explicit discard uses one shared leave guard and not onDone', async () => {
    const state = owner(); let draft = { name: 'Task', prompt: 'Full prompt', times: ['09:00'], variant: 'high' };
    const navigation = state.navigation(() => draft, h.close), commit = vi.fn();
    draft = { ...draft, prompt: 'Unsaved full prompt' };
    await navigation.cancel(commit); expect(commit).not.toHaveBeenCalled(); expect(h.done).not.toHaveBeenCalled(); expect(draft.prompt).toBe('Unsaved full prompt');
    const answer = deferred<{ action: string }>(); h.dialog.mockReturnValueOnce(answer.promise);
    const leaving = navigation.cancel(commit); await navigation.cancel(() => { throw new Error('concurrent leave'); });
    answer.resolve({ action: 'discard' }); await leaving;
    expect(commit).toHaveBeenCalledTimes(1); expect(h.dialog).toHaveBeenCalledTimes(2); expect(h.close).not.toHaveBeenCalled();
    navigation.pristine(); await navigation.cancel(); expect(h.close).toHaveBeenCalledTimes(1); expect(h.done).not.toHaveBeenCalled();
  });
  it('active and modal admission guard core mutations and pristine departure, not only controls', async () => {
    const state = owner(), navigation = state.navigation(() => ({}), h.close);
    h.interactive = false; await state.perform(() => state.request('/task', 'PATCH')); await navigation.cancel();
    await expect(state.request('/task', 'PATCH')).rejects.toThrow('common.unavailable');
    expect(h.request).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
    h.interactive = true; h.active = false; await state.perform(() => state.request('/task', 'PATCH')); await navigation.cancel();
    expect(h.request).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
  });
  it('pending and unknown writes veto every departure and cannot be replayed by save', async () => {
    const state = owner(), pending = deferred<unknown>(), navigation = state.navigation(() => ({}), h.close);
    h.request.mockReturnValueOnce(pending.promise);
    const write = state.perform(() => state.request('/task', 'PUT', { task: { id: 'stable', prompt: 'draft' } }));
    await navigation.cancel(); expect(h.close).not.toHaveBeenCalled(); expect(state.busy()).toBe(true);
    pending.resolve({ malformed: true }); await write;
    expect(state.unknown()).toBe(true); expect(state.receipt()).toMatchObject({ method: 'PUT', body: { task: { id: 'stable' } } });
    await state.perform(() => state.request('/task', 'PUT')); await navigation.cancel();
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.close).not.toHaveBeenCalled();
  });
  it.each([new Error('network lost'), Object.assign(new Error('server lost response'), { status: 500 })])('transport and 5xx uncertainty is retained across a failed verification read: %s', async failure => {
    const state = owner(); h.request.mockRejectedValueOnce(failure);
    await state.perform(() => state.request('/task', 'PATCH', { task: { id: 'id' } }));
    const receipt = state.receipt(); h.request.mockRejectedValueOnce(new Error('read unavailable'));
    await state.perform(() => state.request('/task'), true);
    expect(state.receipt()).toBe(receipt); expect(state.unknown()).toBe(true); expect(h.done).not.toHaveBeenCalled();
    expect(h.request.mock.calls.filter(call => call[1] !== 'GET')).toHaveLength(1);
  });
  it('a definite 409 permits explicit retry but a matching GET alone never clears the journal', async () => {
    const state = owner(); h.request.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    await state.perform(() => state.request('/task', 'PATCH')); expect(state.unknown()).toBe(false); expect(state.receipt()).toBeNull();
    h.request.mockResolvedValueOnce({ task: { id: 'id' } }); await state.perform(() => state.request('/task', 'PATCH'));
    h.request.mockResolvedValueOnce({ tasks: [{ id: 'id' }] }); await state.perform(() => state.request('/task'), true);
    expect(state.unknown()).toBe(true); expect(h.done).not.toHaveBeenCalled();
  });
  it('Host retirement during confirmation cannot issue a new write against a resumed lane', async () => {
    const state = owner(), answer = deferred<unknown>();
    const flight = state.perform(async () => { await answer.promise; await state.request('/task', 'DELETE'); });
    h.generation++; answer.resolve(undefined); await flight;
    expect(h.request).not.toHaveBeenCalled(); expect(h.done).not.toHaveBeenCalled();
  });
  it('confirmed receipt is never replayed when final refresh fails; Done is read-only', async () => {
    const state = owner(); h.request.mockResolvedValueOnce({ task: { id: 'id' } }); h.refresh.mockRejectedValueOnce(new Error('refresh failed'));
    await state.perform(async () => { await state.request('/task', 'PATCH'); state.acknowledge(); state.committed.set(true); await state.finish(); });
    expect(state.committed()).toBe(true); expect(state.unknown()).toBe(false); expect(h.done).not.toHaveBeenCalled();
    await state.perform(() => state.request('/task', 'PATCH')); await state.perform(state.finish, true);
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.refresh).toHaveBeenCalledTimes(2); expect(h.done).toHaveBeenCalledTimes(1);
  });
  it('unmount fences late ACK and publication', async () => {
    const state = owner(), pending = deferred<unknown>(); h.request.mockReturnValueOnce(pending.promise);
    const flight = state.perform(async () => { await state.request('/task', 'PATCH'); state.acknowledge(); state.committed.set(true); await state.finish(); });
    h.cleanups.forEach(work => work()); pending.resolve({ task: { id: 'id' } }); await flight;
    expect(state.current()).toBe(false); expect(state.committed()).toBe(false); expect(h.done).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
});

import { describe, expect, test, vi } from 'vitest';
import { aboutReadResponse, aboutSubmitResponse, createSettingsAbout } from './settings-about-core';

const plan = { version: '2.4.0', kind: 'cli-package', planId: 'opaque-plan-1', rollback: false, restartRequired: true, releaseNotes: 'Synthetic notes' };
const snapshot = { supported: true, host: 'cli', serverId: 'opaque-server', channel: 'stable', currentVersion: '2.3.0', available: true, checkError: null, update: plan, operation: null };
const task = { id: 'opaque-task', planId: plan.planId, version: plan.version, channel: 'stable', kind: plan.kind, status: 'checking', progress: null, error: null };
function fixture() {
  let current = true;
  const read = vi.fn(async (_path: string): Promise<unknown> => snapshot);
  const submitUpdate = vi.fn(async (_input: unknown): Promise<unknown> => ({ operation: task }));
  const changed = vi.fn();
  const core = createSettingsAbout({ read, submitUpdate, call: async () => { throw new Error('Unexpected native boundary'); }, hostID: 'synthetic-host', current: () => current, changed });
  return { core, read, submitUpdate, changed, retire: () => { current = false; } };
}
describe('Host update real CGI orchestration, all synthetic', () => {
  test('POST 502 is NOT the GET partial-success contract, even if its body contains an operation', () => {
    expect(() => aboutSubmitResponse({ status: 502, body: { operation: task } })).toThrow('about_update_not_accepted');
    expect(() => aboutSubmitResponse({ status: 409, body: { operation: task } })).toThrow();
    expect(aboutSubmitResponse({ status: 202, body: { operation: task } })).toEqual({ operation: task });
  });
  test('discovery and prepare never POST; cancellation destroys the exact confirmation', async () => {
    const { core, submitUpdate } = fixture();
    await core.hostUpdate(); await core.confirmUpdate(); expect(submitUpdate).not.toHaveBeenCalled();
    await core.prepareUpdate(); expect(core.state().updateConfirm?.plan).toEqual(plan);
    core.cancelUpdate(); await core.confirmUpdate(); expect(submitUpdate).not.toHaveBeenCalled();
  });
  test('confirmation submits only the existing four CGI fields; double-submit cannot duplicate admission', async () => {
    const { core, submitUpdate } = fixture(); await core.prepareUpdate();
    let finish!: (value: unknown) => void; submitUpdate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const saving = core.confirmUpdate(); await core.confirmUpdate();
    expect(submitUpdate).toHaveBeenCalledExactlyOnceWith({ version: '2.4.0', channel: 'stable', planId: 'opaque-plan-1', allowDowngrade: false });
    finish({ operation: task }); await saving;
    expect(core.state()).toMatchObject({ updateBusy: false, updateConfirm: null, updateFailed: false, hostUpdate: { value: { operation: 'checking', task: { id: task.id, progress: null } } } });
    await core.confirmUpdate(); expect(submitUpdate).toHaveBeenCalledTimes(1);
  });
  test('progress, restart gap 404/502, then explicit server success retain the same task, never guess from disconnect', async () => {
    const { core, read } = fixture(); await core.prepareUpdate(); await core.confirmUpdate();
    read.mockResolvedValue({ ...snapshot, update: null, operation: { ...task, status: 'downloading', progress: 41 } }); await core.reconcileUpdate();
    expect(core.state().hostUpdate.value?.task?.progress).toBe(41);
    read.mockResolvedValue({ ...snapshot, update: null, operation: { ...task, status: 'restarting' } }); await core.reconcileUpdate();
    read.mockImplementation(async () => aboutReadResponse('/api/system/update', { status: 404 })); await core.reconcileUpdate();
    expect(core.state().hostUpdate).toMatchObject({ status: 'failed', value: { operation: 'restarting', supported: true, task: { id: task.id } } });
    read.mockResolvedValue({ ...snapshot, checkError: 'update_check_failed', update: null, operation: { ...task, status: 'restarting' } }); await core.reconcileUpdate();
    expect(core.state().hostUpdate.value?.operation).toBe('restarting');
    read.mockResolvedValue({ ...snapshot, currentVersion: '2.4.0', update: null, operation: { ...task, status: 'succeeded' } }); await core.reconcileUpdate();
    expect(core.state().hostUpdate.value?.operation).toBe('succeeded');
  });
  test('failure retry refreshes original channel and exact version/kind before a new explicit confirmation', async () => {
    const { core, read, submitUpdate } = fixture();
    read.mockResolvedValue({ ...snapshot, operation: { ...task, channel: 'beta', status: 'failed' }, update: null }); await core.hostUpdate();
    read.mockResolvedValue({ ...snapshot, channel: 'beta', operation: { ...task, channel: 'beta', status: 'failed' }, update: { ...plan, planId: 'fresh-plan' } });
    await core.prepareUpdate(); expect(read).toHaveBeenLastCalledWith('/api/system/update?channel=beta'); expect(submitUpdate).not.toHaveBeenCalled();
    submitUpdate.mockResolvedValue({ operation: { ...task, channel: 'beta' } }); await core.confirmUpdate();
    expect(submitUpdate).toHaveBeenLastCalledWith({ version: '2.4.0', channel: 'beta', planId: 'fresh-plan', allowDowngrade: false });
  });
  test.each(['version', 'kind', 'channel'])('a failed task cannot silently retry changed %s', async field => {
    const { core, read, submitUpdate } = fixture(); read.mockResolvedValue({ ...snapshot, operation: { ...task, status: 'failed' } }); await core.hostUpdate();
    read.mockResolvedValue({ ...snapshot, channel: field === 'channel' ? 'beta' : 'stable', update: { ...plan, [field]: field === 'version' ? '2.5.0' : field === 'kind' ? 'installer' : 'stable' } });
    await core.prepareUpdate(); await core.confirmUpdate(); expect(core.state().updateFailed).toBe(true); expect(submitUpdate).not.toHaveBeenCalled();
  });
  test('POST ambiguity blocks replay until GET reconciles, and transient failure keeps it blocked', async () => {
    const { core, read, submitUpdate } = fixture(); await core.prepareUpdate(); submitUpdate.mockRejectedValue(new Error('private-transport-detail'));
    await core.confirmUpdate(); await core.prepareUpdate(); expect(submitUpdate).toHaveBeenCalledTimes(1); expect(core.state().updateUncertain).toBe(true);
    read.mockRejectedValue(new Error('private-gap')); await core.reconcileUpdate(); expect(core.state().updateUncertain).toBe(true);
    read.mockResolvedValue({ ...snapshot, update: null, operation: task }); await core.reconcileUpdate();
    expect(core.state()).toMatchObject({ updateUncertain: false, updateFailed: false, hostUpdate: { value: { operation: 'checking' } } });
    expect(JSON.stringify(core.state())).not.toContain('private-');
  });
  test('rollback only submits allowDowngrade after fresh confirmation; a stale server/plan confirmation is refused', async () => {
    const { core, read, submitUpdate } = fixture(); read.mockResolvedValue({ ...snapshot, update: { ...plan, rollback: true } }); await core.prepareUpdate();
    expect(submitUpdate).not.toHaveBeenCalled(); await core.confirmUpdate(); expect(submitUpdate.mock.calls[0][0]).toMatchObject({ allowDowngrade: true });
    const next = fixture(); await next.core.prepareUpdate(); next.read.mockResolvedValue({ ...snapshot, serverId: 'different-server' }); await next.core.hostUpdate(); await next.core.confirmUpdate();
    expect(next.submitUpdate).not.toHaveBeenCalled(); expect(next.core.state().updateFailed).toBe(true);
  });
  test('malformed plans, unsupported capabilities and discovery failures never become executable', async () => {
    for (const value of [{ ...snapshot, supported: false }, { ...snapshot, update: { ...plan, planId: null } }, { ...snapshot, channel: 'unknown' }, { ...snapshot, checkError: 'failed' }, { ...snapshot, update: { ...plan, rollback: 'yes' } }]) {
      const { core, read, submitUpdate } = fixture(); read.mockResolvedValue(value); await core.prepareUpdate(); await core.confirmUpdate(); expect(submitUpdate).not.toHaveBeenCalled();
    }
  });
  test('scope fence rejects late prepare/POST and never publishes into another Host', async () => {
    const { core, read, retire, changed } = fixture(); let resolve!: (value: unknown) => void;
    read.mockImplementation(() => new Promise(done => { resolve = done; })); const pending = core.prepareUpdate(); retire(); const before = changed.mock.calls.length;
    resolve(snapshot); await pending; expect(changed).toHaveBeenCalledTimes(before);
    const next = fixture(); await next.core.prepareUpdate(); next.submitUpdate.mockImplementation(() => new Promise(done => { resolve = done; })); const submitting = next.core.confirmUpdate(); next.retire(); const count = next.changed.mock.calls.length; resolve({ operation: task }); await submitting; expect(next.changed).toHaveBeenCalledTimes(count);
  });
  test('hung reads and POSTs time out without accepting late completions or retaining busy locks', async () => {
    vi.useFakeTimers();
    try {
      const { core, read, submitUpdate } = fixture(); await core.prepareUpdate(); submitUpdate.mockImplementation(() => new Promise(() => {})); const posting = core.confirmUpdate();
      await vi.advanceTimersByTimeAsync(8_001); await posting; expect(core.state()).toMatchObject({ updateBusy: false, updateUncertain: true });
      read.mockImplementation(() => new Promise(() => {})); const reconciling = core.reconcileUpdate(); await vi.advanceTimersByTimeAsync(8_001); await reconciling;
      expect(core.state().hostUpdate.refreshing).toBe(false); expect(core.state().updateUncertain).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

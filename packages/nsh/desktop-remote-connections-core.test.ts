import { describe, expect, test } from 'vitest';
import { createDesktopRemoteConnectionsController, DesktopSshDenied, desktopSshDefaultSelections, desktopSshSelections, desktopSshPreview, desktopSshHistory, desktopSshInstance, desktopSshSnapshot, type DesktopRemoteConnectionsPort, type DesktopSshConnectionAdmission, type DesktopSshInstance, type DesktopSshSnapshot } from './desktop-remote-connections-core';

const row: DesktopSshInstance = { id: 'ssh-a', label: 'Synthetic SSH', host: 'ssh.example.invalid', user: 'fixture', port: 22, remotePort: 3210, localPort: 0, managed: true };
const snapshot = (): DesktopSshSnapshot => ({ revision: 1, saving: false, instances: [row], statuses: [], receipts: [] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; }
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function fixture(overrides: Partial<DesktopRemoteConnectionsPort> = {}, admission: DesktopSshConnectionAdmission | null = mutation => mutation.dispatch()) {
  let value = snapshot(), serial = 0, starts = 0, saves = 0, applies = 0, reads = 0;
  const port: DesktopRemoteConnectionsPort = {
    current: () => true, newID: () => `synthetic-${++serial}`,
    async read() { reads++; return value; },
    async save(input) { saves++; value = { ...value, revision: value.revision + 1, instances: [input.instance], receipts: [...value.receipts, input.requestID] }; return value; },
    async remove(input) { value = { ...value, revision: value.revision + 1, instances: [], statuses: [], receipts: [...value.receipts, input.requestID] }; return value; },
    async start(input) { starts++; value = { ...value, receipts: [...value.receipts, input.requestID], statuses: [{ id: input.id, attempt: starts, requestID: input.requestID, phase: input.intent === 'check' ? 'checked' : 'ready', error: null, retry: 0, running: false, connectionID: input.intent === 'check' ? null : 'native-connection-a' }] }; return value; },
    async cancel(input) { value = { ...value, statuses: value.statuses.map(row => row.id === input.id ? { ...row, phase: 'idle', connectionID: null } : row) }; return value; },
    async syncPreview(input) { return { runID: input.runID, direction: input.direction, phase: 'review', files: [{ name: 'opencode.jsonc', bytes: 42 }], directories: [], agentsRoot: null, deletes: [] }; },
    async syncApply(input) { applies++; return { runID: input.runID, phase: 'success' }; },
    async syncStatus(input) { return { runID: input.runID, phase: 'success' }; },
    async syncHistory(input) { return { direction: input.direction, runs: [] }; },
    ...overrides,
  };
  const controller = createDesktopRemoteConnectionsController(port, { connectionMutation: admission ?? undefined });
  return { controller, port, counters: () => ({ starts, saves, applies, reads }), set: (next: DesktopSshSnapshot) => { value = next; } };
}
describe('native SSH contract (no bridge, processes or credentials)', () => {
  test('connect/restore require the ORIGINAL mutation admission, not only readiness or active Settings', async () => {
    const f = fixture({}, null); f.controller.setActive(true); await settle();
    expect(await f.controller.start(row.id, 'connect')).toBe(false);
    expect(await f.controller.start(row.id, 'restore')).toBe(false);
    expect(f.counters().starts).toBe(0);
    expect(await f.controller.start(row.id, 'check')).toBe(true);
  });
  test('unknown start survives Settings unmount and retirement; 50 input/guard reads perform zero I/O', async () => {
    const gate = deferred<unknown>(); let requestID = '', calls = 0;
    const f = fixture({ start(input) { calls++; requestID = input.requestID; return gate.promise; } });
    f.controller.setActive(true); await settle();
    const start = f.controller.start(row.id, 'connect');
    expect(f.controller.canLeave()).toBe(false);
    f.controller.setActive(false); gate.reject(new Error('lost start reply')); await start;
    expect(f.controller.state().unknown).toBe(requestID);
    const before = f.counters();
    for (let i = 0; i < 50; i++) { expect(f.controller.canLeave()).toBe(false); f.controller.connectionOperation(); f.controller.ready(); }
    expect(f.counters()).toEqual(before); expect(calls).toBe(1);
    f.controller.dispose(); expect(f.controller.canLeave()).toBe(false);
  });
  test('start acceptance is NOT Host completion: exact running/unknown attempt keeps root guard until exact terminal proof', async () => {
    let requestID = '';
    const f = fixture({ async start(input) { requestID = input.requestID; return { ...snapshot(), receipts: [requestID], statuses: [{ id: row.id, attempt: 3, requestID, phase: 'auth_check', error: null, retry: 0, running: true, connectionID: null }] }; } });
    f.controller.setActive(true); await settle(); expect(await f.controller.start(row.id, 'connect')).toBe(true);
    expect(f.controller.canLeave()).toBe(false); expect(f.controller.connectionOperation()?.phase).toBe('running');
    f.set({ ...snapshot(), receipts: [requestID], statuses: [{ id: row.id, attempt: 4, requestID: 'different', phase: 'idle', error: null, retry: 0, running: false, connectionID: null }] });
    await f.controller.refresh(); expect(f.controller.canLeave()).toBe(false);
    f.set({ ...snapshot(), receipts: [requestID], statuses: [{ id: row.id, attempt: 3, requestID, phase: 'ready', error: null, retry: 0, running: false, connectionID: 'native-connection-a' }] });
    await f.controller.refresh(); expect(f.controller.canLeave()).toBe(true);
    expect(f.controller.connectionOperation()).toMatchObject({ requestID, phase: 'settled', outcome: 'ready', connectionID: 'native-connection-a' });
  });
  test('same-target confirmation has a scoped canLeave exception, but stale target/Host/lease never dispatch or auto retry', async () => {
    for (const change of ['none', 'target', 'host', 'lease']) {
      const gate = deferred<void>(); let host = 'old', lease = 1, admissionCalls = 0;
      const f = fixture({}, async mutation => {
        admissionCalls++;
        expect(Object.isFrozen(mutation)).toBe(true); expect(Object.isFrozen(mutation.target)).toBe(true);
        expect(f.controller.canLeave()).toBe(false); expect(mutation.canLeave()).toBe(true);
        await gate.promise; return mutation.dispatch();
      });
      f.controller.setActive(true); await settle();
      const connect = f.controller.connect(row, { source: 'header', current: () => host === 'old' && lease === 1 });
      if (change === 'target') { f.set({ ...snapshot(), instances: [{ ...row, remotePort: 4321 }] }); await f.controller.refresh(); }
      if (change === 'host') host = 'new'; if (change === 'lease') lease++;
      gate.resolve(); expect((await connect).status).toBe(change === 'none' ? 'accepted' : 'stale');
      expect(f.counters().starts).toBe(change === 'none' ? 1 : 0); expect(admissionCalls).toBe(1);
      await f.controller.refresh(); expect(admissionCalls).toBe(1);
    }
  });
  test('a callback cannot fake acceptance; saved dispatch cannot run after admission returns or twice', async () => {
    let late: (() => Promise<{ status: string }>) | undefined;
    const f = fixture({}, async mutation => { late = mutation.dispatch; return { status: 'accepted' }; });
    f.controller.setActive(true); await settle();
    expect((await f.controller.connect(row, { source: 'header', current: () => true })).status).toBe('unsupported');
    expect((await late!()).status).toBe('stale'); expect(f.counters().starts).toBe(0);
  });
  test('only the same Settings target can prepare during its own modal; native pending/unknown have no exception', async () => {
    const gate = deferred<void>(), native = deferred<unknown>();
    const f = fixture({ start: () => native.promise }, async mutation => {
      expect(f.controller.canLeave()).toBe(false);
      expect(f.controller.canPrepareConnection(row)).toBe(true);
      expect(f.controller.canPrepareConnection({ ...row, host: 'other.example.invalid' })).toBe(false);
      await gate.promise; return mutation.dispatch();
    });
    f.controller.setActive(true); await settle(); const connect = f.controller.start(row.id, 'connect');
    gate.resolve(); await settle(); expect(f.controller.canPrepareConnection(row)).toBe(false);
    native.reject(new Error('unknown')); await connect;
    expect(f.controller.canPrepareConnection(row)).toBe(false); expect(f.controller.canLeave()).toBe(false);
  });
  test('receipt-only start remains unknown; read-only exact attempt recovery never resends or restores a released writer', async () => {
    let requestID = '', starts = 0, writer = 'writable';
    const f = fixture({ async start(input) { requestID = input.requestID; starts++; return { ...snapshot(), receipts: [requestID] }; } }, async mutation => {
      writer = 'released'; return mutation.dispatch();
    });
    f.controller.setActive(true); await settle();
    expect(await f.controller.start(row.id, 'connect')).toBe(false);
    expect(f.controller.connectionOperation()).toMatchObject({ dispatched: true, phase: 'unknown' });
    f.controller.setActive(false);
    f.set({ ...snapshot(), receipts: [requestID] }); await f.controller.readConnectionResult();
    expect(f.controller.canLeave()).toBe(false); expect(f.controller.state().unknown).toBe(requestID);
    f.set({ ...snapshot(), receipts: [requestID], statuses: [{ id: row.id, attempt: 1, requestID, phase: 'error', running: false, retry: 0, error: 'ssh_transport', connectionID: null }] });
    await f.controller.readConnectionResult(); expect(f.controller.canLeave()).toBe(true);
    expect(f.controller.connectionOperation()).toMatchObject({ phase: 'settled', outcome: 'error' });
    expect(f.controller.state().unknown).toBeNull(); expect(starts).toBe(1); expect(writer).toBe('released');
  });
  test('a definite native rejection AFTER writer release does not undo release or implicitly retry', async () => {
    let writer = 'writable', starts = 0;
    const f = fixture({ async start() { starts++; throw new DesktopSshDenied('ssh_storage'); } }, async mutation => {
      writer = 'released'; return mutation.dispatch();
    });
    f.controller.setActive(true); await settle(); expect(await f.controller.start(row.id, 'connect')).toBe(false);
    expect(f.controller.connectionOperation()).toMatchObject({ dispatched: true, phase: 'settled', outcome: 'denied' });
    expect(writer).toBe('released'); await f.controller.refresh(); expect(writer).toBe('released'); expect(starts).toBe(1);
  });
  test('strict public schema rejects secrets, Relay provenance, raw options and malformed status', () => {
    for (const key of ['password', 'token', 'sshCommand', 'relay']) expect(() => desktopSshInstance({ ...row, [key]: 'forbidden' })).toThrow();
    for (const host of ['-oProxyCommand=bad', 'user@host', 'https://host', '$(bad)', 'host\n']) expect(() => desktopSshInstance({ ...row, host })).toThrow();
    expect(() => desktopSshSnapshot({ ...snapshot(), instances: [row, row] })).toThrow();
    expect(() => desktopSshSnapshot({ ...snapshot(), statuses: [{ id: row.id, attempt: 1, requestID: 'a', phase: 'ready', running: false, retry: 0, error: null, connectionID: null }] })).toThrow();
  });
  test('successful load/save/check/connect/cancel use injected actor port and exact receipts', async () => {
    const f = fixture(); f.controller.setActive(true); await settle();
    expect(f.controller.state().snapshot?.instances).toEqual([row]);
    expect(await f.controller.save({ ...row, label: 'Renamed' })).toBe(true);
    expect(await f.controller.start(row.id, 'check')).toBe(true);
    expect(f.controller.state().snapshot?.statuses[0].phase).toBe('checked');
    expect(await f.controller.start(row.id, 'connect')).toBe(true);
    expect(await f.controller.cancel(row.id, 2)).toBe(true);
    expect(f.controller.state().snapshot?.statuses[0].phase).toBe('idle');
    expect(f.counters()).toMatchObject({ saves: 1, starts: 2 });
  });
  test('failed read keeps the prior authoritative catalog', async () => {
    let failed = false;
    const f = fixture({ async read() { if (failed) throw new Error('must not display raw secret'); return snapshot(); } });
    f.controller.setActive(true); await settle(); const prior = f.controller.state().snapshot;
    failed = true; await f.controller.refresh();
    expect(f.controller.state().snapshot).toBe(prior);
    expect(f.controller.state().failed).toBe(true);
    expect(JSON.stringify(f.controller.state())).not.toContain('raw secret');
  });
  test('unknown write never replays, absence is not rejection; exact receipt unlocks read-only recovery', async () => {
    let request = '', calls = 0;
    const f = fixture({ async save(input) { request = input.requestID; calls++; throw new Error('transport lost'); } });
    f.controller.setActive(true); await settle(); expect(await f.controller.save(row)).toBe(false);
    expect(f.controller.state().unknown).toBe(request);
    await f.controller.refresh(); expect(f.controller.state().unknown).toBe(request);
    expect(await f.controller.save(row)).toBe(false); expect(calls).toBe(1);
    f.set({ ...snapshot(), revision: 2, receipts: [request] }); await f.controller.refresh();
    expect(f.controller.state().unknown).toBeNull(); expect(calls).toBe(1);
  });
  test('definite rejection preserves draft authority and allows explicit retry without implicit resend', async () => {
    let calls = 0;
    const f = fixture({ async save() { calls++; throw new DesktopSshDenied('ssh_storage'); } });
    f.controller.setActive(true); await settle(); expect(await f.controller.save(row)).toBe(false);
    expect(f.controller.state().unknown).toBeNull(); await f.controller.refresh(); expect(calls).toBe(1);
  });
  test('an editor may retain its original CAS revision even after polling a newer registry', async () => {
    let submitted = -1;
    const f = fixture({ async save(input) { submitted = input.revision; throw new DesktopSshDenied('ssh_stale'); } });
    f.controller.setActive(true); await settle();
    const captured = f.controller.state().snapshot!.revision;
    f.set({ ...snapshot(), revision: 2, instances: [{ ...row, host: 'changed.example.invalid' }] });
    await f.controller.refresh();
    expect(await f.controller.save({ ...row, label: 'Local draft' }, captured)).toBe(false);
    expect(submitted).toBe(1);
    expect(f.controller.state().snapshot?.instances[0].host).toBe('changed.example.invalid');
  });
  test('in-flight mutation gates duplicates and delayed old read cannot overwrite committed data', async () => {
    const read = deferred<unknown>(); let first = true;
    const f = fixture({ read() { if (first) { first = false; return Promise.resolve(snapshot()); } return read.promise; } });
    f.controller.setActive(true); await settle(); const refresh = f.controller.refresh();
    const save = f.controller.save({ ...row, label: 'Committed' });
    expect(await f.controller.save(row)).toBe(false); expect(await save).toBe(true);
    read.resolve(snapshot()); await refresh;
    expect(f.controller.state().snapshot?.instances[0].label).toBe('Committed');
  });
  test('hidden/reactivated reads are fenced; retired native actor cannot start work', async () => {
    const read = deferred<unknown>(); let count = 0, live = true;
    const f = fixture({ current: () => live, async read() { return ++count === 1 ? read.promise : snapshot(); } });
    f.controller.setActive(true); f.controller.setActive(false); f.controller.setActive(true);
    read.resolve({ ...snapshot(), revision: 0 }); await settle(); await settle();
    expect(f.controller.state().snapshot?.revision).toBe(1);
    live = false; expect(await f.controller.start(row.id, 'connect')).toBe(false);
    expect(f.counters().starts).toBe(0);
  });
  test('config sync confirms exact target/direction and unknown apply is status-only', async () => {
    let applies = 0;
    const f = fixture({ async syncApply() { applies++; throw new Error('unknown after dispatch'); } });
    f.controller.setActive(true); await settle(); await f.controller.start(row.id, 'connect');
    expect(await f.controller.preview(row.id, 'pull')).toBe(true);
    expect(f.controller.state().preview?.direction).toBe('pull');
    expect(await f.controller.apply()).toBe(false);
    expect(f.controller.state().sync?.phase).toBe('unknown');
    expect(await f.controller.apply()).toBe(false); expect(await f.controller.preview(row.id, 'push')).toBe(false);
    await f.controller.refreshSync(); expect(f.controller.state().sync?.phase).toBe('success'); expect(applies).toBe(1);
  });
  test('a changed SSH attempt cannot apply an old preview', async () => {
    const f = fixture(); f.controller.setActive(true); await settle(); await f.controller.start(row.id, 'connect');
    await f.controller.preview(row.id, 'push'); await f.controller.cancel(row.id, 1); await f.controller.start(row.id, 'connect');
    expect(await f.controller.apply()).toBe(false); expect(f.counters().applies).toBe(0);
  });
  test('full file review and selections accept only metadata and exact Web allowlist', () => {
    expect(desktopSshSelections(desktopSshDefaultSelections()).directories).toEqual([true, true, true, true, true, true]);
    const review = { runID: 'full', phase: 'review', direction: 'push', files: [{ name: 'AGENTS.md', bytes: 4 }, { name: 'cursor-models.json', bytes: 5 }], directories: [{ name: 'skills', fileCount: 3, bytes: 8 }], agentsRoot: { fileCount: 1, bytes: 9 }, deletes: ['agent', 'skills', 'skill'] };
    expect(desktopSshPreview(review).agentsRoot?.bytes).toBe(9);
    expect(() => desktopSshPreview({ ...review, token: 'forbidden' })).toThrow();
    expect(() => desktopSshPreview({ ...review, directories: [{ name: '../private', fileCount: 1, bytes: 0 }] })).toThrow();
    expect(() => desktopSshPreview({ ...review, files: [{ name: 'AGENTS.md', bytes: 1, data: 'forbidden' }] })).toThrow();
    expect(() => desktopSshSelections({ ...desktopSshDefaultSelections(), directories: [true] })).toThrow();
  });
  test('scope is captured before preview await and history failure preserves prior successful metadata', async () => {
    let fail = false;
    const chosen = { ...desktopSshDefaultSelections(), singleFiles: [false, true] };
    const f = fixture({ async syncPreview(input) { expect(input.selections.singleFiles).toEqual([false, true]); expect(Object.isFrozen(input.selections.singleFiles)).toBe(true); return { runID: input.runID, phase: 'review', direction: input.direction, files: [], directories: [], agentsRoot: null, deletes: [] }; }, async syncHistory(input) { if (fail) throw new Error('private credentials'); return { direction: input.direction, runs: [] }; } });
    f.controller.setActive(true); await settle(); await f.controller.start(row.id, 'connect');
    expect(await f.controller.preview(row.id, 'push', chosen)).toBe(true);
    expect(await f.controller.history(row.id, 'pull')).toBe(true); const prior = f.controller.state().history;
    fail = true; expect(await f.controller.history(row.id, 'pull')).toBe(false); expect(f.controller.state().history).toBe(prior);
    expect(() => desktopSshHistory({ direction: 'push', runs: [{ schema: 1, runID: 'r', phase: 'success', startedAt: '00000000000000000001', endedAt: null, files: 1, bytes: 1, applied: 1, data: 'forbidden' }] })).toThrow();
    expect(JSON.stringify(f.controller.state())).not.toContain('private credentials');
  });
  test('locale keys used by native SSH exist in ten dictionaries without English placeholders', async () => {
    const { dict: en } = await import('../ui/src/lib/i18n/messages/en');
    const keys = Object.keys(en).filter(key => key.startsWith('settings.remoteInstances.native.')) as (keyof typeof en)[];
    expect(keys).toHaveLength(7);
    for (const locale of ['zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk']) {
      const { dict } = await import(`../ui/src/lib/i18n/messages/${locale}.ts`);
      expect(dict['gitView.common.done']).toBeTruthy();
      for (const key of keys) { expect(typeof dict[key]).toBe('string'); if (!key.endsWith('.port')) expect(dict[key]).not.toBe(en[key]); }
    }
  });
});

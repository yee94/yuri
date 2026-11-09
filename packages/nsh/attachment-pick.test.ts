import { beforeEach, expect, it, vi } from 'vitest';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const file = { uri: 'attachment://session/note', name: 'note.txt', mime: 'text/plain' };
beforeEach(() => vi.resetModules());
async function fixture(target: { kind: 'session' | 'assistant'; id: string } = { kind: 'session', id: 's' }) {
  const { createAttachmentPick } = await import('./attachment-pick');
  let visible = true, valid = true;
  const scope = { hostID: 'A', lease: 'opaque-A-1' }, operation = { scope, current: () => valid };
  const call = vi.fn(async (_name: string, _body: Record<string, unknown>): Promise<unknown> => null);
  const busy = vi.fn(), receive = vi.fn(), failed = vi.fn();
  const input = { target, current: () => visible, call, busy, receive, failed };
  return { picker: createAttachmentPick(input), create: () => createAttachmentPick(input), call, busy, receive, failed, operation,
    visible: (value: boolean) => { visible = value; }, valid: (value: boolean) => { valid = value; } };
}
it('captures immutable scope once and uses unique bounded IDs without Web Crypto', async () => {
  const f = await fixture(), gate = deferred<unknown>();
  f.call.mockImplementation(async name => name === 'runtime.pickAttachment' ? gate.promise : true);
  const flight = f.picker.pick(f.operation, 'files');
  const first = f.call.mock.calls[0][1];
  expect(Object.keys(first).sort()).toEqual(['expectedHost', 'kind', 'requestId']);
  expect(first).toMatchObject({ kind: 'files', expectedHost: { hostID: 'A', lease: 'opaque-A-1' } });
  expect(first.requestId).toMatch(/^[a-zA-Z0-9_]+$/); expect(String(first.requestId).length).toBeLessThanOrEqual(128);
  f.operation.scope.lease = 'replacement';
  gate.resolve(file); expect(await flight).toBe(true); expect(f.receive).toHaveBeenCalledWith(file);
  expect(first.expectedHost).toEqual({ hostID: 'A', lease: 'opaque-A-1' });
  f.call.mockResolvedValue(file); await f.picker.pick(f.operation, 'images');
  expect(f.call.mock.calls[1][1].requestId).not.toBe(first.requestId);
});
it('uses the actual assistant id and existing contact descriptor adapter, rejecting URI substitution', async () => {
  const f = await fixture({ kind: 'assistant', id: 'actual-bot' });
  const descriptor = { type: 'file', attachmentID: 'contact-file', sha256: 'a'.repeat(64), size: 4, mime: 'text/plain', filename: 'note.txt', generation: 3 };
  f.call.mockResolvedValue(descriptor); expect(await f.picker.pick(f.operation, 'files')).toBe(true);
  expect(f.call.mock.calls[0][1]).toMatchObject({ assistantID: 'actual-bot', expectedHost: f.operation.scope });
  expect(f.receive).toHaveBeenCalledExactlyOnceWith({ ...descriptor, kind: 'contact', hostID: 'A', assistantID: 'actual-bot', name: 'note.txt' });
  f.call.mockResolvedValue(file); expect(await f.picker.pick(f.operation, 'files')).toBe(false);
  expect(f.receive).toHaveBeenCalledTimes(1); expect(f.failed).toHaveBeenCalledWith('pick', expect.any(Error));
});
it.each(['hidden', 'retired', 'disposed'])('exactly cancels %s selection and ignores its late completion without unlocking a newer picker', async reason => {
  const f = await fixture(), old = deferred<unknown>(), next = deferred<unknown>();
  let picks = 0;
  f.call.mockImplementation(async name => name === 'runtime.pickAttachment' ? ++picks === 1 ? old.promise : next.promise : true);
  const first = f.picker.pick(f.operation, 'files'), original = f.call.mock.calls[0][1];
  if (reason === 'hidden') f.visible(false); else if (reason === 'retired') f.valid(false);
  if (reason === 'disposed') f.picker.dispose(); else f.picker.sync();
  await flush();
  expect(f.call.mock.calls[1]).toEqual(['runtime.cancelAttachment', { requestId: original.requestId, expectedHost: original.expectedHost }]);
  f.visible(true); f.valid(true);
  const picker = reason === 'disposed' ? f.create() : f.picker;
  const second = picker.pick(f.operation, 'images');
  expect(f.busy).toHaveBeenLastCalledWith(true);
  old.resolve(file); expect(await first).toBe(false);
  expect(f.receive).not.toHaveBeenCalled(); expect(f.busy).toHaveBeenLastCalledWith(true);
  next.resolve(file); expect(await second).toBe(true); expect(f.busy).toHaveBeenLastCalledWith(false);
  expect(f.receive).toHaveBeenCalledTimes(1);
});
it('keeps failed cancellation visible after disposal and retries the exact old cleanup before a new picker', async () => {
  const f = await fixture(), old = deferred<unknown>(), retry = deferred<unknown>();
  let cancellations = 0;
  f.call.mockImplementation(async name => {
    if (name === 'runtime.pickAttachment') return old.promise;
    if (++cancellations === 1) throw new Error('cancel unavailable');
    return retry.promise;
  });
  const first = f.picker.pick(f.operation, 'files'), original = f.call.mock.calls[0][1];
  f.picker.dispose(); await flush(); expect(f.failed).toHaveBeenCalledWith('cancel', expect.any(Error), expect.objectContaining({ scope: original.expectedHost, current: expect.any(Function), retry: expect.any(Function) }));
  const picker = f.create(), newOperation = { scope: { hostID: 'B', lease: 'opaque-B-2' }, current: () => true };
  const second = picker.pick(newOperation, 'files'); await flush();
  expect(f.call.mock.calls[2]).toEqual(['runtime.cancelAttachment', { requestId: original.requestId, expectedHost: original.expectedHost }]);
  expect(f.call.mock.calls.filter(([name]) => name === 'runtime.pickAttachment')).toHaveLength(1);
  f.call.mockImplementation(async name => name === 'runtime.pickAttachment' ? file : true);
  retry.resolve(true); expect(await second).toBe(true);
  expect(f.call.mock.calls.at(-1)![1]).toMatchObject({ expectedHost: newOperation.scope });
  expect(f.call.mock.calls.at(-1)![1].requestId).not.toBe(original.requestId);
  old.resolve(file); expect(await first).toBe(false);
});
it('retires an action-sheet continuation without native IO and does not clear a newer action busy flag', async () => {
  const f = await fixture(), choice = deferred<'files'>(), next = deferred<unknown>();
  const first = f.picker.pick(f.operation, () => choice.promise);
  f.visible(false); f.picker.sync(); f.visible(true);
  f.call.mockImplementation(async () => next.promise);
  const second = f.picker.pick(f.operation, 'images');
  choice.resolve('files'); expect(await first).toBe(false); expect(f.busy).toHaveBeenLastCalledWith(true);
  expect(f.call).toHaveBeenCalledTimes(1);
  next.resolve(null); expect(await second).toBe(false); expect(f.busy).toHaveBeenLastCalledWith(false);
});
it('missing scope is not reconstructed from current global state', async () => {
  const f = await fixture();
  expect(await f.picker.pick({ scope: null, current: () => true }, 'files')).toBe(false);
  expect(f.call).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledWith('pick');
});
it.each([true, false])('passes raw replies to the captured core adopter and preserves its %s decision', async accepted => {
  const f = await fixture(), raw = { coreOwnedDescriptor: true };
  const selection = { adopt: vi.fn(() => accepted), retire: vi.fn() };
  f.call.mockResolvedValue(raw);
  expect(await f.picker.pick(f.operation, 'files', selection)).toBe(accepted);
  expect(selection.adopt).toHaveBeenCalledExactlyOnceWith(raw);
  expect(selection.retire).toHaveBeenCalledTimes(1); expect(f.receive).not.toHaveBeenCalled();
});
it('freezes each token adopter and retires the old selection without adopting into its replacement', async () => {
  const f = await fixture(), old = deferred<unknown>(), next = deferred<unknown>();
  const originalAdopt = vi.fn(() => true), substituted = vi.fn(() => true);
  const firstSelection = { adopt: originalAdopt, retire: vi.fn() }, nextSelection = { adopt: vi.fn(() => true), retire: vi.fn() };
  let picks = 0;
  f.call.mockImplementation(async name => name === 'runtime.pickAttachment' ? ++picks === 1 ? old.promise : next.promise : true);
  const first = f.picker.pick(f.operation, 'files', firstSelection);
  firstSelection.adopt = substituted;
  await f.picker.cancel(); expect(firstSelection.retire).toHaveBeenCalledTimes(1);
  const second = f.picker.pick(f.operation, 'images', nextSelection);
  old.resolve({ old: true }); expect(await first).toBe(false);
  expect(originalAdopt).not.toHaveBeenCalled(); expect(substituted).not.toHaveBeenCalled();
  expect(nextSelection.adopt).not.toHaveBeenCalled(); expect(nextSelection.retire).not.toHaveBeenCalled();
  next.resolve({ next: true }); expect(await second).toBe(true);
  expect(nextSelection.adopt).toHaveBeenCalledExactlyOnceWith({ next: true }); expect(nextSelection.retire).toHaveBeenCalledTimes(1);
  expect(firstSelection.retire).toHaveBeenCalledTimes(1);
  const stable = deferred<unknown>(), capturedAdopt = vi.fn(() => true), selection = { adopt: capturedAdopt, retire: vi.fn() };
  f.call.mockImplementation(async () => stable.promise);
  const third = f.picker.pick(f.operation, 'files', selection); selection.adopt = substituted;
  const raw = { captured: true }; stable.resolve(raw); expect(await third).toBe(true);
  expect(capturedAdopt).toHaveBeenCalledExactlyOnceWith(raw); expect(substituted).not.toHaveBeenCalled(); expect(selection.retire).toHaveBeenCalledTimes(1);
});
it('retires a supplied core selection on an early gate rejection and native cancellation', async () => {
  const f = await fixture(), rejected = { adopt: vi.fn(() => true), retire: vi.fn() };
  expect(await f.picker.pick({ scope: null, current: () => true }, 'files', rejected)).toBe(false);
  expect(rejected.adopt).not.toHaveBeenCalled(); expect(rejected.retire).toHaveBeenCalledTimes(1);
  const cancelled = { adopt: vi.fn(() => true), retire: vi.fn() }; f.call.mockResolvedValue(null);
  expect(await f.picker.pick(f.operation, 'files', cancelled)).toBe(false);
  expect(cancelled.adopt).not.toHaveBeenCalled(); expect(cancelled.retire).toHaveBeenCalledTimes(1);
});

it('keeps the exact lost-ACK adopter and retries with GET reconciliation only through the existing pick entry', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' });
  const raw = { type: 'file', attachmentID: 'owned', sha256: 'a'.repeat(64), size: 4, mime: 'text/plain', generation: 3 };
  const original = { adopt: vi.fn(() => true), retire: vi.fn() }, replacement = { adopt: vi.fn(() => true), retire: vi.fn() };
  f.call.mockImplementation(async name => {
    if (name === 'runtime.pickAttachment') throw new Error('lost ACK');
    if (name === 'runtime.reconcileAttachment') return raw;
    return null;
  });
  expect(await f.picker.pick(f.operation, 'files', original)).toBe(false);
  expect(original.retire).not.toHaveBeenCalled(); expect(f.picker.pending()).toBe(true);
  const captured = f.call.mock.calls[0][1];
  expect(await f.picker.pick(f.operation, 'images', replacement)).toBe(true);
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(['runtime.pickAttachment', 'runtime.reconcileAttachment', 'runtime.acknowledgeAttachment']);
  expect(f.call.mock.calls[1][1]).toEqual({ requestId: captured.requestId, expectedHost: captured.expectedHost });
  expect(original.adopt).toHaveBeenCalledExactlyOnceWith(raw); expect(original.retire).toHaveBeenCalledTimes(1);
  expect(replacement.adopt).not.toHaveBeenCalled(); expect(replacement.retire).toHaveBeenCalledTimes(1);
  expect(f.picker.pending()).toBe(false);
});

it('not_found/inflight reconciliation never releases the original unknown receipt or replays PUT', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' }), selection = { adopt: vi.fn(() => true), retire: vi.fn() };
  f.call.mockImplementation(async name => { if (name === 'runtime.pickAttachment') throw new Error('lost'); return null; });
  await f.picker.pick(f.operation, 'files', selection);
  for (let i = 0; i < 5; i++) expect(await f.picker.reconcile()).toBe(false);
  expect(selection.adopt).not.toHaveBeenCalled(); expect(selection.retire).not.toHaveBeenCalled(); expect(f.picker.pending()).toBe(true);
  expect(f.call.mock.calls.filter(([name]) => name === 'runtime.pickAttachment')).toHaveLength(1);
  await f.picker.cancel(); expect(selection.retire).toHaveBeenCalledTimes(1);
});

it('a late reconcile from a retired page cannot adopt in a replacement page', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' }), gate = deferred<unknown>();
  const selection = { adopt: vi.fn(() => true), retire: vi.fn() };
  f.call.mockImplementation(async name => { if (name === 'runtime.pickAttachment') throw new Error('lost'); if (name === 'runtime.reconcileAttachment') return gate.promise; return null; });
  await f.picker.pick(f.operation, 'files', selection);
  const waiting = f.picker.reconcile();
  f.valid(false); f.picker.sync(); await flush();
  gate.resolve({ type: 'file', generation: 3 }); expect(await waiting).toBe(false);
  expect(selection.adopt).not.toHaveBeenCalled(); expect(selection.retire).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls.filter(([name]) => name === 'runtime.cancelAttachment')).toHaveLength(1);
});

it('cold receipt retries keep the saved revision and only GET until the original recovery adopter accepts', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' });
  const context = { contactGeneration: 3, draftIdentity: 'draft', draftRevision: 7, pageOperation: 'page_1' };
  const original = { adopt: vi.fn(() => false), retire: vi.fn(), prepare: vi.fn(async () => context), recover: vi.fn(() => true), commit: vi.fn(async () => {}) };
  const raw = { type: 'file', attachmentID: 'owned', sha256: 'a'.repeat(64), size: 4, mime: 'text/plain', generation: 3 };
  let settled = false;
  f.call.mockImplementation(async name => name === 'runtime.pendingAttachments' ? [{ requestId: 'cold_request', uploadID: 'cold_upload', assistantID: 'bot', generation: 3, draftRevision: 7, phase: 'unknown' }]
    : name === 'runtime.reconcileAttachment' ? settled ? raw : null : null);
  expect(await f.picker.pick(f.operation, 'files', original)).toBe(false);
  expect(f.picker.pending()).toBe(true); expect(original.retire).not.toHaveBeenCalled();
  settled = true;
  expect(await f.picker.reconcile()).toBe(true);
  expect(original.recover).toHaveBeenCalledExactlyOnceWith(raw, 7); expect(original.adopt).not.toHaveBeenCalled(); expect(original.commit).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(['runtime.pendingAttachments', 'runtime.reconcileAttachment', 'runtime.reconcileAttachment', 'runtime.acknowledgeAttachment']);
});

it('a surviving native page owner can only be retired with its original cleanup lease', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' });
  const originalScope = { hostID: 'A', lease: 'original_native_lease' };
  const selection = { adopt: vi.fn(() => true), retire: vi.fn(), prepare: async () => ({ contactGeneration: 3, draftIdentity: 'draft', draftRevision: 7, pageOperation: 'new_page' }) };
  f.call.mockImplementation(async name => name === 'runtime.pendingAttachments' ? [{ requestId: 'original_request', uploadID: 'original_upload', assistantID: 'bot', generation: 3, draftRevision: 7, phase: 'retiring', cleanupHost: originalScope }] : null);
  expect(await f.picker.pick(f.operation, 'images', selection)).toBe(false);
  expect(f.call.mock.calls).toContainEqual(['runtime.cancelAttachment', { requestId: 'original_request', expectedHost: originalScope, assistantID: 'bot' }]);
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(['runtime.pendingAttachments', 'runtime.cancelAttachment']);
  expect(selection.adopt).not.toHaveBeenCalled(); expect(selection.retire).toHaveBeenCalledTimes(1);
});

it('known capture storage/capacity failure dispatches no cancellation or automatic picker replay', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' }), selection = { adopt: vi.fn(() => true), retire: vi.fn() };
  f.call.mockRejectedValue(new Error('attachment_capture_not_dispatched:attachment_receipt_storage_failed'));
  expect(await f.picker.pick(f.operation, 'images', selection)).toBe(false);
  expect(f.picker.pending()).toBe(false); expect(selection.adopt).not.toHaveBeenCalled(); expect(selection.retire).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(['runtime.pickAttachment']);
});

it('drains a cold adopted receipt local-ACK cleanup after deferred durable write and lease retirement before same-contact Attach', async () => {
  const f = await fixture({ kind: 'assistant', id: 'bot' }), write = deferred<void>();
  const oldScope = { ...f.operation.scope };
  const raw = { type: 'file', attachmentID: 'cold_owned', sha256: 'a'.repeat(64), size: 4, mime: 'text/plain', generation: 3 };
  const nextRaw = { ...raw, attachmentID: 'fresh_owned' };
  let durableWritten = false, allowClear = false, cleared = false;
  const committed = write.promise.then(() => { durableWritten = true; });
  const old = { adopt: vi.fn(() => false), recover: vi.fn(() => true), retire: vi.fn(),
    prepare: async () => ({ contactGeneration: 3, draftIdentity: 'draft', draftRevision: 7, pageOperation: 'old_page' }), commit: () => committed };
  f.call.mockImplementation(async (name, body) => {
    if (name === 'runtime.pendingAttachments') return cleared ? [] : [{ requestId: 'cold_request', uploadID: 'cold_upload', assistantID: 'bot', generation: 3, draftRevision: 7, phase: 'unknown' }];
    if (name === 'runtime.reconcileAttachment') return raw;
    if (name === 'runtime.acknowledgeAttachment' && body.requestId === 'cold_request') {
      expect(durableWritten).toBe(true); expect(body.expectedHost).toEqual(oldScope); expect(body.descriptor).toEqual(raw);
      if (!allowClear) throw new Error('attachment_receipt_storage_failed');
      cleared = true; return null;
    }
    if (name === 'runtime.pickAttachment') return nextRaw;
    return null;
  });
  const first = f.picker.pick(f.operation, 'files', old); await flush();
  expect(old.recover).toHaveBeenCalledExactlyOnceWith(raw, 7); expect(durableWritten).toBe(false);
  expect(f.call.mock.calls.filter(([name]) => name === 'runtime.acknowledgeAttachment')).toHaveLength(0);
  f.visible(false); f.picker.sync(); await flush();
  write.resolve(); expect(await first).toBe(false); await flush();
  expect(f.failed).toHaveBeenCalledWith('cancel', expect.any(Error), expect.objectContaining({ current: expect.any(Function), retry: expect.any(Function) }));
  expect(f.call.mock.calls.filter(([name]) => name === 'runtime.reconcileAttachment')).toHaveLength(1);
  expect(f.call.mock.calls.filter(([name]) => name === 'runtime.pickAttachment' || name === 'runtime.cancelAttachment')).toHaveLength(0);
  allowClear = true; f.visible(true); f.call.mockClear();
  const freshOperation = { scope: { hostID: 'A', lease: 'fresh_lease' }, current: () => true };
  const fresh = { adopt: vi.fn(() => true), retire: vi.fn(), prepare: async () => ({ contactGeneration: 3, draftIdentity: 'draft', draftRevision: 8, pageOperation: 'new_page' }), commit: async () => {} };
  expect(await f.create().pick(freshOperation, 'images', fresh)).toBe(true);
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(['runtime.acknowledgeAttachment', 'runtime.pendingAttachments', 'runtime.pickAttachment', 'runtime.acknowledgeAttachment']);
  expect(f.call.mock.calls[0][1]).toMatchObject({ requestId: 'cold_request', expectedHost: oldScope, descriptor: raw });
  const nextRequest = f.call.mock.calls[2][1].requestId;
  expect(nextRequest).not.toBe('cold_request'); expect(f.call.mock.calls[3][1]).toMatchObject({ requestId: nextRequest, expectedHost: freshOperation.scope, descriptor: nextRaw });
  expect(fresh.adopt).toHaveBeenCalledExactlyOnceWith(nextRaw); expect(old.recover).toHaveBeenCalledTimes(1);
});

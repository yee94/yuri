import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('nsh', () => ({}));
import { createTranscriptActions, type NativeSessionHistoryReceipt, type NativeSessionHistorySnapshot } from './transcript-actions-core';
import { messageFrom } from './model';

const user = (id: string) => messageFrom({ id, type: 'user', text: id })!;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let snapshot: NativeSessionHistorySnapshot, receipt: NativeSessionHistoryReceipt | null, current: boolean;
beforeEach(() => { snapshot = { messages: [user('z-first'), user('a-second'), user('m-third')], revert: null, ready: true, more: false, cursor: null, revision: 0 }; receipt = null; current = true; });
function fixture(extra: { older?: () => Promise<void>; send?: (path: string, method?: string, body?: unknown) => Promise<unknown> } = {}) {
  const send = vi.fn(extra.send ?? (async (_path, method, body) => method === 'POST' ? { messageID: (body as { messageID: string }).messageID } : {}));
  const onRevert = vi.fn(), onOpenChat = vi.fn(), onChanged = vi.fn();
  const actions = createTranscriptActions({ target: { kind: 'session', id: 's', directory: '/repo', title: 'Fixture' }, send,
    scope: { key: 'session-fixture', current: () => current, busy: () => false, message: () => undefined }, onRevert, onOpenChat, onChanged,
    sessionHistory: { snapshot: () => snapshot, refresh: async () => {}, loadOlder: extra.older ?? (async () => {}), receipt: () => receipt, setReceipt: next => { receipt = next; } } });
  // idle authority is deliberately distinct from the mutation endpoint.
  send.mockImplementation(async (path, method = 'GET', body) => path === '/api/session/active' ? {} : extra.send ? extra.send(path, method, body) : method === 'POST' ? { messageID: (body as { messageID: string }).messageID } : {});
  return { actions, send, onRevert, onOpenChat, onChanged };
}
it('undo uses the real latest user and the prior turn before a marker, independent of ID ordering/visible tail', async () => {
  const f = fixture(); await f.actions.undoTurn(); expect(f.onRevert).toHaveBeenLastCalledWith({ messageID: 'm-third' });
  snapshot.revert = { messageID: 'a-second' }; snapshot.revision++;
  await f.actions.undoTurn(); expect(f.onRevert).toHaveBeenLastCalledWith({ messageID: 'z-first' });
});
it('native shell and synthetic display roles do not become slash undo user turns', async () => {
  snapshot.messages = [user('authored'), messageFrom({ id: 'shell', type: 'shell', command: 'pwd' })!, messageFrom({ id: 'synthetic', type: 'synthetic', description: 'context' })!];
  const f = fixture(); await f.actions.undoTurn(); expect(f.onRevert).toHaveBeenCalledWith({ messageID: 'authored' });
});
it('redo moves exactly one user turn and only clears the final marker', async () => {
  const f = fixture(); snapshot.revert = { messageID: 'z-first' };
  await f.actions.redoTurn(); expect(f.onRevert).toHaveBeenLastCalledWith({ messageID: 'a-second' });
  snapshot.revert = { messageID: 'm-third' }; snapshot.revision++;
  await f.actions.redoTurn(); expect(f.onRevert).toHaveBeenLastCalledWith(null);
  expect(f.send.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1);
});
it('loads all needed opaque pages via the existing loader, including a full-page boundary', async () => {
  snapshot.messages = [user('m-third')]; snapshot.revert = { messageID: 'm-third' }; snapshot.more = true; snapshot.cursor = 'opaque-1';
  let pages = 0;
  const f = fixture({ older: async () => {
    pages++; snapshot = { ...snapshot, messages: pages === 1 ? snapshot.messages : [user('z-first'), ...snapshot.messages], cursor: pages === 1 ? 'opaque-2' : null, more: pages === 1 };
  } });
  await f.actions.undoTurn(); expect(pages).toBe(2); expect(f.onRevert).toHaveBeenCalledWith({ messageID: 'z-first' });
});
it('failed or non-advancing pagination cannot write a partial undo or clear a missing redo marker', async () => {
  snapshot.revert = { messageID: 'outside-window' }; snapshot.more = true; snapshot.cursor = 'opaque';
  const f = fixture(); await expect(f.actions.redoTurn()).rejects.toThrow('cursor');
  expect(f.send.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true); expect(f.onRevert).not.toHaveBeenCalled();
  snapshot.more = false; await expect(f.actions.redoTurn()).rejects.toThrow('boundary');
});
it('a delayed older page cannot cross an A→B→A marker revision', async () => {
  snapshot.revert = { messageID: 'outside-window' }; snapshot.more = true; snapshot.cursor = 'opaque';
  const gate = deferred<void>(), f = fixture({ older: () => gate.promise });
  const work = f.actions.undoTurn(); await vi.waitFor(() => expect(f.send).toHaveBeenCalled());
  await Promise.resolve(); await Promise.resolve(); snapshot.revision += 2; gate.resolve();
  await expect(work).rejects.toThrow('changed'); expect(f.onRevert).not.toHaveBeenCalled();
});
it('whole-session fork has no selected-message request or last-message boundary', async () => {
  const f = fixture({ send: async () => ({ data: { id: 'forked', directory: '/repo' } }) });
  await f.actions.forkSession();
  expect(f.send.mock.calls.find(([, method]) => method === 'POST')).toEqual(['/api/session/s/fork?directory=%2Frepo', 'POST', {}]);
  expect(f.onOpenChat).toHaveBeenCalledWith({ kind: 'session', id: 'forked', directory: '/repo', title: 'Fixture' });
});
it('lost ACK preserves prior state and blocks repeated writes, including non-idempotent fork', async () => {
  const f = fixture({ send: async () => { throw new Error('lost ACK'); } });
  await expect(f.actions.forkSession()).rejects.toThrow('lost ACK');
  expect(receipt).toEqual({ action: 'fork', status: 'unknown' });
  await expect(f.actions.forkSession()).rejects.toThrow('do not replay');
  expect(f.send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1); expect(f.onOpenChat).not.toHaveBeenCalled(); expect(f.onRevert).not.toHaveBeenCalled();
});
it('late fork ACK cannot navigate after the captured page operation retires', async () => {
  const gate = deferred<unknown>(), f = fixture({ send: () => gate.promise });
  const work = f.actions.forkSession(); await vi.waitFor(() => expect(receipt?.status).toBe('pending'));
  current = false; gate.resolve({ id: 'forked' }); await expect(work).rejects.toThrow('changed'); expect(f.onOpenChat).not.toHaveBeenCalled();
});
it('late stage ACK never overwrites a newer marker, even after A→B→A', async () => {
  const gate = deferred<unknown>(), f = fixture({ send: () => gate.promise });
  const work = f.actions.undoTurn(); await vi.waitFor(() => expect(receipt?.status).toBe('pending'));
  snapshot.revision += 2; gate.resolve({ messageID: 'm-third' });
  await expect(work).rejects.toThrow('changed'); expect(f.onRevert).not.toHaveBeenCalled(); expect(receipt?.status).toBe('unknown');
});
it('failed write-ahead receipt storage issues zero Host mutations', async () => {
  const send = vi.fn(async () => ({}));
  const action = createTranscriptActions({ target: { kind: 'session', id: 's', directory: '/repo', title: '' }, send,
    scope: { key: 'journal-failure', current: () => true, busy: () => false, message: () => undefined },
    sessionHistory: { refresh: async () => {}, snapshot: () => snapshot, loadOlder: async () => {}, receipt: () => null, setReceipt: async () => { throw new Error('atomic journal write unknown'); } } });
  await expect(action.undoTurn()).rejects.toThrow('atomic journal'); expect(send.mock.calls.every(call => !call[1])).toBe(true);
});

import { describe, expect, it, vi } from 'vitest';
import { createDesktopContextOwner, desktopContextMatches, type DesktopContextChat } from './desktop-context-core';
import { contextUsageFixtureSnapshot } from './context-usage-fixture-data';
import { messageFrom, type Message } from './model';
import type { ContextMessageCommit } from './context-usage-route-core';

function signal<T>(value: T) {
  return Object.assign(() => value, { set(next: T) { value = next; }, update(work: (previous: T) => T) { value = work(value); } });
}
function fixture() {
  const data = contextUsageFixtureSnapshot();
  const scope = { host: { hostID: data.scope.hostID, lease: 'fixture-lease' }, authorityKey: 'fixture-authorization', sessionID: data.scope.sessionID, directory: data.scope.directory };
  const listeners = new Set<(value: ContextMessageCommit) => void>();
  const rows = data.messages.map(entry => messageFrom(entry)!);
  const messages = Object.assign(vi.fn(() => rowsSignal()), { set: (next: Message[]) => rowsSignal.set(next), update: (work: (rows: Message[]) => Message[]) => rowsSignal.update(work) });
  const rowsSignal = signal(rows), messageReadError = signal('');
  const chat: DesktopContextChat = { messageScope: data.scope, messages, messagesResolved: signal(true), messageReadError,
    observeMessageCommits: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }), load: vi.fn(async () => { messageReadError.set(''); }) };
  let valid = true, fail = false;
  const read = vi.fn(async (path: string) => {
    if (fail) throw new Error('Synthetic metadata failure');
    if (path.startsWith('/api/session/')) return { ...data.session, directory: scope.directory };
    if (path.startsWith('/api/config/catalog/providers?')) return { schemaVersion: 1, providers: data.providers.map(provider => ({ ...provider, models: Object.fromEntries(provider.models.map(model => [model.id, model])) })) };
    throw new Error('Unexpected request: ' + path);
  });
  const owner = createDesktopContextOwner({ scope, chat, current: () => valid, read, showAssistantTps: true });
  return { data, scope, chat, read, owner, listeners, messages, emit: (commit: ContextMessageCommit) => listeners.forEach(listener => listener(commit)), retire: () => { valid = false; owner.setDemand(false); }, fail: (next: boolean) => { fail = next; } };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

describe('desktop Context exact original-Chat projection', () => {
  it('inactive constructs no subscriptions/metadata/messages and unrelated input does no work', async () => {
    const f = fixture();
    for (let index = 0; index < 50; index++) { f.owner.setDemand(false); f.owner.setShowAssistantTps(index % 2 === 0); await f.owner.retry(); }
    expect(f.read).not.toHaveBeenCalled(); expect(f.messages).not.toHaveBeenCalled(); expect(f.chat.observeMessageCommits).not.toHaveBeenCalled();
    f.owner.setDemand(true); await flush();
    expect(f.read.mock.calls.map(([path]) => path)).toEqual(['/api/session/ses_context?directory=%2Fworkspace%2Factual', '/api/config/catalog/providers?directory=%2Fworkspace%2Factual']);
    expect(f.owner.owner.view()).toMatchObject({ messagesCount: 3, contextLimit: 400000, totalAssistantCost: .005, sessionTpsLabel: '500.0 tok/s' });
    const operations = f.owner.owner.operations(), reads = f.messages.mock.calls.length;
    for (let index = 0; index < 50; index++) { f.owner.setDemand(true); f.owner.setShowAssistantTps(true); f.owner.owner.view(); }
    expect(f.messages).toHaveBeenCalledTimes(reads); expect(f.owner.owner.operations()).toEqual(operations); expect(f.read).toHaveBeenCalledTimes(2);
    f.owner.dispose();
  });
  it('modal retains owner and raw snapshots while every action is revoked, then restores without history/model scans', async () => {
    const f = fixture(); f.owner.setDemand(true); await flush();
    const before = f.owner.owner.operations(), raw = f.owner.owner.json('final'), reads = f.messages.mock.calls.length;
    f.owner.setDemand(true, false); await f.owner.retry(); await f.owner.refresh();
    expect(f.owner.canInteract()).toBe(false); expect(f.listeners.size).toBe(1); expect(f.owner.owner.json('final')).toBe(raw);
    f.owner.setDemand(true, true);
    expect(f.owner.canInteract()).toBe(true); expect(f.messages).toHaveBeenCalledTimes(reads); expect(f.owner.owner.operations().resets).toBe(before.resets); expect(f.read).toHaveBeenCalledTimes(2);
    f.owner.dispose();
  });
  it('same-batch stream patch updates only changed rows; hidden unsubscribes and resumes exactly once from loaded window', async () => {
    const f = fixture(); f.owner.setDemand(true); await flush();
    const before = f.owner.owner.operations(), reads = f.messages.mock.calls.length;
    const changed = f.data.messages.slice(1).map(entry => messageFrom({ ...entry, parts: [...entry.parts, { id: entry.info.id + ':extra', type: 'text', text: 'Committed patch' }] })!);
    f.chat.messages.set([f.chat.messages()[0], ...changed]);
    f.emit({ kind: 'patch', messages: changed });
    expect(f.owner.owner.operations().messageVisits - before.messageVisits).toBe(2); expect(f.owner.owner.operations().resets).toBe(before.resets);
    expect(f.messages).toHaveBeenCalledTimes(reads + 1); // Test writer's own read, never the consumer's patch path.
    f.owner.setDemand(false); const hidden = f.owner.owner.operations();
    f.emit({ kind: 'patch', messages: changed }); expect(f.owner.owner.operations()).toEqual(hidden); expect(f.listeners.size).toBe(0);
    f.owner.setDemand(true); f.owner.setDemand(true); expect(f.owner.owner.operations().resets).toBe(hidden.resets + 1); expect(f.read).toHaveBeenCalledTimes(2);
    f.owner.dispose();
  });
  it('failed metadata retains complete prior content; retry is explicit and original Chat alone owns a failed message GET', async () => {
    const f = fixture(); f.owner.setDemand(true); await flush(); const before = f.owner.owner.view();
    f.fail(true); await f.owner.refresh(); expect(f.owner.owner.state().error).toContain('Synthetic metadata failure'); expect(f.owner.owner.view()).toEqual(before);
    f.fail(false); f.chat.messageReadError.set('Message read failure'); await f.owner.retry();
    expect(f.chat.load).toHaveBeenCalledExactlyOnceWith(false, ['messages']); expect(f.owner.owner.state().error).toBe('');
    expect(f.read.mock.calls.every(([path]) => !path.includes('/message'))).toBe(true);
    f.chat.messages.set([]); f.emit({ kind: 'snapshot' }); expect(f.owner.owner.view()?.messagesCount).toBe(0); expect(f.owner.owner.state().resolved).toBe(true);
    f.owner.dispose();
  });
  it('cold failure stays unresolved, preserves its error across hide, and resumes with a successful explicit authority read', async () => {
    const f = fixture(); f.fail(true); f.owner.setDemand(true); await flush();
    expect(f.owner.owner.state()).toMatchObject({ resolved: false, loading: false, error: 'Synthetic metadata failure' }); expect(f.owner.owner.view()).toBeUndefined();
    f.owner.setDemand(false); expect(f.owner.owner.state().error).toBe('Synthetic metadata failure');
    f.fail(false); f.owner.setDemand(true); await flush(); expect(f.owner.owner.view()?.messagesCount).toBe(3); f.owner.dispose();
  });
  it('Host authorization retirement immediately fences reads/actions/late results, even with colliding session/directory IDs', async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    const gate = new Promise<unknown>(done => { resolve = done; }); const regular = f.read.getMockImplementation()!;
    f.read.mockImplementation(path => path.includes('/providers?') ? gate : regular(path));
    f.owner.setDemand(true); await flush(); f.retire(); resolve({ schemaVersion: 1, providers: [] }); await flush();
    expect(f.owner.current()).toBe(false); expect(f.owner.canInteract()).toBe(false); expect(f.owner.owner.view()).toBeUndefined(); expect(f.listeners.size).toBe(0);
    const reads = f.read.mock.calls.length; await f.owner.retry(); expect(f.read).toHaveBeenCalledTimes(reads); f.owner.dispose();
  });
  it('rejects wrong Host/session/exact directory before any read, never fabricating an empty session', () => {
    const f = fixture();
    for (const scope of [{ ...f.scope, sessionID: 'other' }, { ...f.scope, directory: '/workspace/other' }, { ...f.scope, host: { ...f.scope.host, hostID: 'other' } }, { ...f.scope, authorityKey: '' }]) {
      expect(desktopContextMatches(scope, f.chat)).toBe(false);
      expect(() => createDesktopContextOwner({ scope, chat: f.chat, current: () => true, read: f.read, showAssistantTps: true })).toThrow('desktop_context_chat_scope_mismatch');
    }
    expect(f.read).not.toHaveBeenCalled(); f.owner.dispose();
  });
});

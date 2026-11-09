import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const h = vi.hoisted(() => ({ storage: new Map<string, string>(), failWrite: false, send: vi.fn(), cleanups: [] as Array<() => void> }));
vi.mock('nsh', () => ({
  signal: <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } }),
  computed: <T>(work: () => T) => work, effect: (work: () => void) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active',
  cleanup: (work: () => void) => h.cleanups.push(work),
  Storage: { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: async (key: string, value: string) => { if (h.failWrite) throw new Error('Storage unavailable'); h.storage.set(key, value); } },
}));
import * as nsh from 'nsh';
import { signal } from 'nsh';
import { messageFrom, type Attachment } from './model';
import * as model from './model';
import * as runtime from './runtime';
import * as core from './transcript-actions-core';
import * as backup from './transcript-actions-backup';
import * as historyOperation from './transcript-history-operation';
import { createTranscriptActions, type NativeRevert } from './transcript-actions-core';
import type { ScopedReferenceDocument } from './composer-references';

const ownerModule = {} as typeof import('./transcript-actions');
const imports: Record<string, unknown> = { nsh, 'nsh/base': {}, './model': model, './runtime': runtime, './state': { captureHostRequest: () => h.send }, './i18n': { t: (key: string) => key },
  './transcript-actions-core': core, './transcript-actions-backup': backup, './transcript-history-operation': historyOperation, './Icon': {}, './transcript-tools-turn': {}, './transcript-time': {}, './speech': {}, './appearance': {}, './chat-preferences-core': {} };
const source = ts.transpileModule(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcript-actions.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
}).outputText;
vm.runInNewContext(source, { exports: ownerModule, require: (id: string) => { if (!(id in imports)) throw new Error(`Unexpected module ${id}`); return imports[id]; } }, { filename: 'transcript-actions.tsx' });
const { createNativeTranscriptHistory } = ownerModule;

const target = { kind: 'session' as const, id: 'session', directory: '/workspace', title: 'Session' };
let generation = 0;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  generation++; h.storage.clear(); h.failWrite = false; h.cleanups = [];
  h.send.mockReset().mockImplementation(async (path: string, method = 'GET', body?: { messageID?: string }) => {
    if (path === '/api/session/active') return {};
    if (path.includes('/message/u?')) return { id: 'u', type: 'user', text: 'Historical input' };
    if (path.includes('/revert/stage?')) return { messageID: body?.messageID };
    if (method === 'DELETE') return null;
    if (path.includes('/fork?')) return { id: 'forked', directory: target.directory };
    if (path.startsWith('/api/session/session?')) return { id: target.id, directory: target.directory };
    throw new Error('Unexpected request');
  });
});
afterEach(() => { h.cleanups.forEach(work => work()); });
function owner(options: { storageKey?: string; active?: () => boolean; canRead?: () => boolean; refreshHistory?: () => Promise<NativeRevert | null>; loadOlder?: () => Promise<void>; more?: () => boolean } = {}) {
  const referenceScope = { host: 'fixture', draft: 'session', directory: target.directory };
  const referenceDocument = signal<ScopedReferenceDocument>({ text: 'Current input', references: [], scope: referenceScope });
  const draft = signal('Current input'), attachments = signal<Attachment[]>([{ uri: 'file:///host/current', name: 'current', mime: 'text/plain' }]);
  const messages = signal([messageFrom({ id: 'u', type: 'user', text: 'Rendered input' })!]);
  const historyBusy = signal(false), revert = signal<NativeRevert | null>(null);
  const chat = { draft, attachments, messages, historyBusy, revert, active: options.active ?? (() => true), busy: () => false, sending: () => false, pendingSend: () => null, queueEdit: () => null,
    draftStatus: () => 'ready', referenceScope, referenceDocument, messageScope: { generation: 0 },
    setReferenceDocument: (next: ScopedReferenceDocument, expected?: ScopedReferenceDocument) => { if (expected && (expected.text !== referenceDocument().text || JSON.stringify(expected.references) !== JSON.stringify(referenceDocument().references))) return false; referenceDocument.set(next); draft.set(next.text); return true; },
    flushDraft: async () => {}, load: vi.fn(async () => {}), messagesResolved: () => true, more: options.more ?? (() => false), hasGap: () => false,
    ...(options.loadOlder ? { loadOlder: options.loadOlder } : {}),
    ...(options.refreshHistory ? { refreshHistory: options.refreshHistory } : {}),
  };
  const storageKey = options.storageKey ?? `owner-${generation}`;
  const onOpenChat = vi.fn();
  const history = createNativeTranscriptHistory({ chat, target, current: () => true, canRead: options.canRead, key: 'fixture', storageKey, onOpenChat });
  return { history, chat, storageKey, onOpenChat };
}
it('journals unknown writes in the original owner and never treats empty history or an absent marker as a negative receipt', async () => {
  const f = owner(); await flush();
  const original = h.send.getMockImplementation()!;
  h.send.mockImplementation(async (...args) => { if (String(args[0]).includes('/revert/stage?')) throw new Error('Lost ACK'); return original(...args); });
  expect((await f.history.stage('u')).status).toBe('unknown');
  expect(f.history.unknown()).toBe(true); expect(f.chat.historyBusy()).toBe(true);
  expect(h.storage.get(`nsh:history-operation:v1:${f.storageKey}`)).toContain('stage');
  f.chat.messages.set([]);
  expect((await f.history.reconcile()).status).toBe('unknown');
  expect((await f.history.clear()).status).toBe('rejected');
  expect(h.send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  h.send.mockImplementation(async () => { throw Object.assign(new Error('Not found'), { status: 404 }); });
  expect((await f.history.reconcile()).status).toBe('unknown'); expect(f.history.unknown()).toBe(true);
  h.cleanups.forEach(work => work());
  const reopened = owner({ storageKey: f.storageKey }); await flush();
  expect(reopened.history.unknown()).toBe(true); expect(reopened.chat.historyBusy()).toBe(true);
  expect((await reopened.history.fork(null)).status).toBe('rejected');
});
it('rejects before dispatch when intent storage fails and does not lock another operation', async () => {
  const f = owner(); await flush(); h.failWrite = true;
  expect((await f.history.stage('u')).status).toBe('rejected');
  expect(f.history.unknown()).toBe(false); expect(f.chat.historyBusy()).toBe(false);
  expect(h.send.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
});
it('does not erase a restored unknown intent when an ordinary row fails to acquire the owner', async () => {
  const storageKey = `restored-${generation}`, receiptKey = `nsh:history-operation:v1:${storageKey}`;
  const intent = JSON.stringify({ version: 1, target, write: { kind: 'fork', messageID: null } }); h.storage.set(receiptKey, intent);
  const f = owner({ storageKey }); await flush();
  const row = createTranscriptActions(f.history.props(() => f.chat.messages()[0]!));
  expect((await row.stage()).status).toBe('rejected'); expect(h.storage.get(receiptKey)).toBe(intent);
  expect(f.history.unknown()).toBe(true); expect(h.send).not.toHaveBeenCalled();
});
it('keeps an accepted ACK when post-write authority refresh fails', async () => {
  const f = owner({ refreshHistory: async () => { throw new Error('Refresh unavailable'); } }); await flush();
  expect((await f.history.stage('u')).status).toBe('accepted');
  expect(f.chat.revert()?.messageID).toBe('u'); expect(f.history.unknown()).toBe(false); expect(f.chat.historyBusy()).toBe(false);
  expect(h.storage.get(`nsh:history-operation:v1:${f.storageKey}`)).toBe('null');
});
it('uses the same backup and document CAS for the ordinary historical edit entry', async () => {
  const f = owner(); await flush();
  await createTranscriptActions(f.history.props(() => f.chat.messages()[0]!)).edit();
  expect(f.chat.draft()).toBe('Historical input');
  expect(f.chat.attachments()).toEqual([]);
  const backup = JSON.parse(h.storage.get(`nsh:history-draft:v1:${f.storageKey}`)!);
  expect(backup.snapshots[0].text).toBe('Current input'); expect(backup.snapshots[0].files).toHaveLength(1);
});
it('admits an existing owner through an explicitly authorized read modal without creating a chat or stream', async () => {
  const f = owner({ active: () => false, canRead: () => true }); await flush();
  expect(f.history.canRead()).toBe(true); expect(f.history.capability().fork).toBe(true);
  expect((await f.history.fork(null)).status).toBe('accepted'); expect(f.onOpenChat).toHaveBeenCalledOnce();
  expect(h.send.mock.calls.some(([path]) => /stream|prompt/.test(String(path)))).toBe(false);
});
it('does not open a returned fork in a different directory', async () => {
  const f = owner(); await flush(); const original = h.send.getMockImplementation()!;
  h.send.mockImplementation(async (...args) => String(args[0]).includes('/fork?') ? { id: 'forked', directory: '/other' } : original(...args));
  const result = await f.history.fork(null);
  expect(result.status).toBe('accepted'); expect(result.target?.directory).toBe('/other'); expect(f.onOpenChat).not.toHaveBeenCalled();
});
it('notifies fork navigation only after the original owner history gates have settled', async () => {
  const f = owner(); await flush();
  const observed: boolean[][] = [];
  f.onOpenChat.mockImplementation(() => { observed.push([f.history.pending(), f.chat.historyBusy(), f.history.unknown()]); });
  expect((await f.history.fork(null)).status).toBe('accepted');
  expect(f.onOpenChat).toHaveBeenCalledOnce();
  expect(observed).toEqual([[false, false, false]]);
});
it('settles the ordinary row fork gate before its navigation callback', async () => {
  const f = owner(); await flush();
  const observed: boolean[] = [];
  f.onOpenChat.mockImplementation(() => { observed.push(f.chat.historyBusy()); });
  const row = createTranscriptActions(f.history.props(() => f.chat.messages()[0]!));
  expect((await row.forkAt(null)).status).toBe('accepted');
  expect(f.onOpenChat).toHaveBeenCalledOnce();
  expect(observed).toEqual([false]);
});
it('owns the existing history lane during complete-history paging and excludes ordinary row mutations', async () => {
  let done!: () => void, more = true;
  const gate = new Promise<void>(resolve => { done = resolve; });
  const f = owner({ more: () => more, loadOlder: async () => { await gate; more = false; } }); await flush();
  const undo = f.history.undo(); await flush();
  expect(f.chat.historyBusy()).toBe(true); expect(f.history.pending()).toBe(true);
  const row = createTranscriptActions(f.history.props(() => f.chat.messages()[0]!));
  expect((await row.stage()).status).toBe('rejected');
  expect(h.send.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
  done(); expect((await undo).status).toBe('accepted'); expect(f.chat.historyBusy()).toBe(false);
  expect(h.send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
});
it('routes real successive undo/redo through stage and clears only at the authoritative last step', async () => {
  const f = owner(); await flush();
  f.chat.messages.set(['z', 'a', 'm'].map(id => messageFrom({ id, type: 'user', text: id })!));
  const original = h.send.getMockImplementation()!;
  h.send.mockImplementation(async (...args) => {
    const path = String(args[0]);
    if (path.startsWith('/api/session/session?')) return { id: target.id, directory: target.directory, revert: f.chat.revert() };
    const selected = /\/message\/([^?]+)\?/.exec(path)?.[1];
    if (selected) return { id: decodeURIComponent(selected), type: 'user', text: selected };
    return original(...args);
  });
  expect((await f.history.undo()).status).toBe('accepted'); expect(f.chat.revert()?.messageID).toBe('m');
  expect((await f.history.undo()).status).toBe('accepted'); expect(f.chat.revert()?.messageID).toBe('a');
  expect((await f.history.redoStep()).status).toBe('accepted'); expect(f.chat.revert()?.messageID).toBe('m');
  expect(h.send.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  expect((await f.history.redoStep()).status).toBe('accepted'); expect(f.chat.revert()).toBeNull();
  expect(h.send.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1);
  expect(f.chat.draft()).toBe('Current input'); expect(f.chat.attachments()).toHaveLength(1);
});
it.each(['rejected', 'unknown'] as const)('retains the actual %s receipt and ownership when the original page hides in flight', async status => {
  let visible = true, fail!: (failure: unknown) => void;
  const gate = new Promise<never>((_, reject) => { fail = reject; });
  const f = owner({ active: () => visible }); await flush(); const original = h.send.getMockImplementation()!;
  h.send.mockImplementation(async (...args) => String(args[0]).includes('/revert/stage?') ? gate : original(...args));
  const operation = f.history.stage('u'); await flush(); visible = false;
  fail(status === 'rejected' ? Object.assign(new Error('Rejected'), { status: 409 }) : new Error('Lost ACK'));
  expect((await operation).status).toBe(status);
  expect(f.history.unknown()).toBe(status === 'unknown'); expect(f.chat.historyBusy()).toBe(status === 'unknown');
  expect(h.storage.get(`nsh:history-operation:v1:${f.storageKey}`) === 'null').toBe(status === 'rejected');
});

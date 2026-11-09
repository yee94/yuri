import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
vi.mock('nsh', () => ({}));
import { createTranscriptActions, nativeRevertFrom } from './transcript-actions-core';
import { nativeSessionActionStorageKey, inNativeSessionActionStorageLane } from './transcript-actions-storage';
import { messageFrom, record } from './model';
import * as backup from './transcript-actions-backup';

const signal = <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const target = { kind: 'session' as const, id: 's', directory: '/repo', title: 'Storage contract' };
const host = { id: 'host', url: 'https://host.example', authorizationID: 'auth' };
const key = nativeSessionActionStorageKey(host, target);
function fixture(write?: (key: string, value: string) => Promise<void>) {
  const stored = new Map<string, string>();
  const send = vi.fn(async (path: string, _method = 'GET', body?: unknown) => path === '/api/session/active' ? {} : { messageID: record(body).messageID });
  const chat = { historyActionStorageKey: key, active: () => true, busy: () => false, sending: () => false, historyBusy: signal(false),
    revert: signal<unknown>(null), messages: () => [messageFrom({ id: 'authored', type: 'user', text: 'Authored' })!],
    prepareHistoryAction: async () => {}, historyActionSnapshot: () => ({ ready: true, messages: chat.messages(), more: false, cursor: null, revision: 0, revert: null }), loadOlder: async () => {},
    refreshHistory: async () => null, load: async () => {}, draftStatus: () => 'ready', pendingSend: () => null, queueEdit: () => null,
    referenceScope: { host: 'host', draft: 's', directory: '/repo' } };
  // Execute the actual production owner with its JSX left unevaluated, as in application-recovery.test.
  const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcript-actions.tsx');
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createNativeTranscriptHistory')!;
  const output = ts.transpileModule(fn.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  const ports = { ...backup, createTranscriptActions, nativeRevertFrom, inNativeSessionActionStorageLane, record, signal, captureHostRequest: () => send, lifecycle: () => 'active', cleanup: () => {}, effect: (work: () => void) => work(), t: (value: string) => value,
    Storage: { getItem: async (name: string) => stored.get(name) ?? null, setItem: async (name: string, value: string) => { if (write) await write(name, value); stored.set(name, value); } } };
  const make = new Function(...Object.keys(ports), `${output}; return createNativeTranscriptHistory;`)(...Object.values(ports));
  const history = make({ chat, target, current: () => true, key: 'history-storage-contract', storageKey: 'legacy-subset-caller', onOpenChat: vi.fn() });
  return { history, stored, send, chat };
}
it('the production history owner takes the full state-owned key even when the old caller supplies only a subset', async () => {
  const f = fixture(); await flush(); await f.history.sessionActions.undo();
  expect(f.stored.get(`nsh:history-action:v1:${key}`)).toBe('null');
  expect(f.stored.has('nsh:history-action:v1:legacy-subset-caller')).toBe(false);
  expect(JSON.parse(decodeURIComponent(key))).toEqual(['host', 'https://host.example', 'auth', 'session', '/repo', 's']);
});
it('production history receipt clear failure preserves unknown and never repeats its successful stage', async () => {
  const f = fixture(async (name, value) => { if (name.startsWith('nsh:history-action:') && value === 'null') throw new Error('clear result unknown'); });
  await flush(); await expect(f.history.sessionActions.undo()).rejects.toThrow('clear result unknown');
  expect(f.history.sessionReceipt()).toEqual({ action: 'undo', status: 'unknown' });
  await expect(f.history.sessionActions.undo()).rejects.toThrow('do not replay');
  expect(f.send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  expect(f.stored.get(`nsh:history-action:v1:${key}`)).toBe(JSON.stringify({ action: 'undo', status: 'unknown' }));
});
it('a delayed failed history clear cannot replace a newer receipt or erase its serialized journal', async () => {
  let rejectClear!: (error: Error) => void;
  const clearing = new Promise<void>((_resolve, reject) => { rejectClear = reject; });
  const f = fixture(async (_name, value) => { if (value === 'null') await clearing; });
  await flush();
  const adapter = f.history.props(() => undefined).sessionHistory;
  await adapter.setReceipt({ action: 'undo', status: 'pending' });
  const old = adapter.setReceipt(null), rejected = expect(old).rejects.toThrow('late clear');
  const next = adapter.setReceipt({ action: 'fork', status: 'pending' });
  rejectClear(new Error('late clear')); await rejected; await next;
  expect(f.history.sessionReceipt()).toEqual({ action: 'fork', status: 'pending' });
  expect(f.stored.get(`nsh:history-action:v1:${key}`)).toBe(JSON.stringify({ action: 'fork', status: 'unknown' }));
});
it('remounted receipt readers wait for retired physical writes and unrelated scopes remain independent', async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let disk = 'old-ack'; const read = vi.fn(() => Promise.resolve(disk));
  const clearing = inNativeSessionActionStorageLane('same-production-scope', async () => { await gate; disk = 'cleared'; });
  const remount = inNativeSessionActionStorageLane('same-production-scope', read);
  expect(await inNativeSessionActionStorageLane('other-production-scope', async () => 'independent')).toBe('independent');
  expect(read).not.toHaveBeenCalled(); release(); await clearing;
  expect(await remount).toBe('cleared');
});

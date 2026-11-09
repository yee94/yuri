import { expect, test, vi } from 'vitest';
import { createNativeComposerCommandRouter, type NativeCommandActions, type NativeCommandIntent, type NativeCommandSnapshot } from './composer-command-router';
import type { NativeComposerAction } from './composer-commands-model';
import { insertNativeReference, type ScopedReferenceDocument } from './composer-references';
import type { ReferenceKeyboardContext } from './composer-reference-keyboard';

const scope = { host: 'host', directory: '/workspace', draft: 'session-draft' };
const context = { hasSession: true, hasMessages: true, hasNewDraft: false };
function fixture(text: string, wired: readonly NativeComposerAction[] = ['new', 'undo', 'redo', 'fork', 'timeline', 'compact', 'btw', 'model']) {
  let snapshot: NativeCommandSnapshot | null = { owner: {}, revision: 0, document: { text, references: [], scope }, inputMode: 'normal', context };
  const intents: NativeCommandIntent[] = [], notify = vi.fn();
  const attachments = [{ uri: 'attachment://preserved' }], queue = [{ id: 'queued' }];
  const actions: NativeCommandActions = {};
  for (const action of wired) actions[action] = intent => { intents.push(intent); };
  const write = vi.fn((document: ScopedReferenceDocument, expected: NativeCommandSnapshot) => {
    if (!snapshot || snapshot.owner !== expected.owner || snapshot.revision !== expected.revision) return false;
    snapshot = { ...snapshot, document, revision: snapshot.revision + 1 }; return true;
  });
  const router = createNativeComposerCommandRouter({ read: () => snapshot, actions, notify, write });
  const selection = (name: string, source: 'yuri' | 'opencode' = 'yuri') => ({ id: `${source === 'yuri' ? 'yuri' : 'opencode'}:${name}`, name, source });
  const keyboardContext = (): ReferenceKeyboardContext => ({ owner: snapshot!.owner, text: snapshot!.document.text, scope: snapshot!.document.scope, query: snapshot!.document.text.slice(1).split(/\s/)[0], start: 0, end: /^\/[^\s]*/.exec(snapshot!.document.text)![0].length, editing: true });
  return { router, write, notify, intents, attachments, queue, selection, keyboardContext,
    read: () => snapshot!, set: (next: NativeCommandSnapshot | null) => { snapshot = next; } };
}
test.each(['new', 'undo', 'redo', 'fork', 'compact', 'btw', 'model'] as const)('%s candidate click/Enter and manual send use one action contract; Tab only inserts', action => {
  const typed = fixture(`/${action}`);
  expect(typed.router.submit()).toBe('handled');
  const picked = fixture(`/${action.slice(0, 1)}`);
  expect(picked.router.choose(picked.selection(action), true, picked.keyboardContext())).toBe(true);
  expect(typed.intents.map(intent => intent.action)).toEqual([action]);
  expect(picked.intents.map(intent => intent.action)).toEqual([action]);
  expect(typed.attachments).toEqual(picked.attachments); expect(typed.queue).toEqual(picked.queue);
  const tab = fixture(`/${action.slice(0, 1)}`);
  expect(tab.router.choose(tab.selection(action), false, tab.keyboardContext())).toBe(true);
  expect(tab.read().document.text).toBe(`/\u2003${action} `); expect(tab.intents).toEqual([]);
  expect(tab.router.submit()).toBe('handled'); expect(tab.intents[0].action).toBe(action);
});
test('model/timeline retain submitted command and tail; timeline never auto-runs from a candidate', () => {
  for (const name of ['model', 'timeline'] as const) {
    const typed = fixture(`  /${name.toUpperCase()} keep this\n草稿`);
    const original = typed.read().document;
    expect(typed.router.submit()).toBe('handled'); expect(typed.read().document).toBe(original); expect(typed.write).not.toHaveBeenCalled();
    const picked = fixture('/m\nkeep this');
    expect(picked.router.choose(picked.selection(name), true, picked.keyboardContext())).toBe(true);
    expect(picked.read().document.text).toBe(`/\u2003${name} `);
    expect(picked.intents).toHaveLength(name === 'model' ? 1 : 0);
    if (name === 'timeline') { picked.router.submit(); expect(picked.intents[0].action).toBe('timeline'); }
  }
});
test('non-BTW local candidates replace the complete plain document and its inline refs while root attachments and queue stay owned', () => {
  for (const name of ['new', 'undo', 'redo', 'fork', 'compact', 'model', 'timeline'] as const) {
    const x = fixture('/x\n');
    const document = insertNativeReference(x.read().document, { kind: 'file', value: '/workspace/a.ts', label: 'a.ts', scope });
    x.set({ ...x.read(), document: { ...document, scope } });
    expect(x.router.choose(x.selection(name), true, x.keyboardContext())).toBe(true);
    expect(x.read().document.references).toEqual([]);
    expect(x.read().document.text).toBe(name === 'model' || name === 'timeline' ? `/\u2003${name} ` : '');
    expect(x.attachments).toHaveLength(1); expect(x.queue).toHaveLength(1);
  }
});
test('BTW claims only plain questions; references keep the entire document and no request intent', () => {
  const x = fixture('/btw Why?');
  expect(x.router.submit()).toBe('handled'); expect(x.intents[0].argument).toBe('Why?'); expect(x.read().document.text).toBe('');
  expect(x.attachments).toHaveLength(1); expect(x.queue).toHaveLength(1);
  const withReference = fixture('/btw\n');
  withReference.set({ ...withReference.read(), document: { ...insertNativeReference(withReference.read().document, { kind: 'session', value: 'session-id', label: 'Other', scope }), scope } });
  const before = withReference.read().document;
  expect(withReference.router.submit()).toBe('rejected'); expect(withReference.read().document).toBe(before);
  expect(withReference.notify).toHaveBeenLastCalledWith('plain-text-required'); expect(withReference.intents).toEqual([]);
  expect(withReference.router.choose(withReference.selection('btw'), true, withReference.keyboardContext())).toBe(true);
  expect(withReference.read().document.text).toBe(before.text.replace('/btw', '/\u2003btw '));
  expect(withReference.read().document.references).toHaveLength(1); expect(withReference.intents).toEqual([]);
});
test('Host names and flags never auto-run local actions; unwired actions preserve the exact draft', () => {
  for (const name of ['new', 'undo', 'redo', 'fork', 'compact', 'btw', 'model', 'timeline']) {
    const x = fixture('/x');
    expect(x.router.choose({ ...x.selection(name, 'opencode'), isBuiltIn: true }, true, x.keyboardContext())).toBe(true);
    expect(x.intents).toEqual([]); expect(x.read().document.text).toBe(`/${name} `);
    expect(x.router.submit()).toBe('pass'); expect(x.intents).toEqual([]);
  }
  const x = fixture('/new do not lose', ['model']), before = x.read().document;
  expect(x.router.submit()).toBe('rejected'); expect(x.read().document).toBe(before); expect(x.write).not.toHaveBeenCalled();
  expect(x.router.choose(x.selection('new'), true, x.keyboardContext())).toBe(false); expect(x.read().document).toBe(before);
  const invented = fixture('/x');
  expect(invented.router.choose(invented.selection('invented'), true, invented.keyboardContext())).toBe(false); expect(invented.intents).toEqual([]);
  expect(invented.router.choose({ id: 'yuri:undo', name: 'model', source: 'yuri' }, true, invented.keyboardContext())).toBe(false);
});
test('first unsent draft rejects session-only locals before admission; six magic prompts and native Goal remain on their own route', () => {
  for (const name of ['undo', 'redo', 'fork', 'timeline', 'btw', 'summary', 'init']) {
    const x = fixture(`/${name}`); x.set({ ...x.read(), context: { hasSession: false, hasMessages: false, hasNewDraft: true } });
    expect(x.router.submit()).toBe('rejected'); expect(x.read().document.text).toBe(`/${name}`); expect(x.intents).toEqual([]);
  }
  const compact = fixture('/compact'); compact.set({ ...compact.read(), context: { hasSession: false, hasMessages: false, hasNewDraft: true } });
  expect(compact.router.submit()).toBe('pass'); expect(compact.intents).toEqual([]); expect(compact.read().document.text).toBe('/compact');
  for (const value of ['/goal pause', '/goal do work', '/unknown value', '/newer', '/explore', '/craft-goal idea', '/debug', '/weigh', '/catch-up', '/workspace-review', 'text /new']) {
    const x = fixture(value); x.set({ ...x.read(), context: { hasSession: false, hasMessages: false, hasNewDraft: true } });
    expect(x.router.submit()).toBe('pass'); expect(x.write).not.toHaveBeenCalled(); expect(x.intents).toEqual([]);
  }
});
test('reserved-slot token, shell mode, stale ranges, revision races and ABA owner changes cannot reinterpret a new draft', () => {
  const slot = fixture('/\u2003MODEL tail'); expect(slot.router.submit()).toBe('handled'); expect(slot.read().document.text).toBe('/\u2003MODEL tail');
  const shell = fixture('/new'); shell.set({ ...shell.read(), inputMode: 'shell' }); expect(shell.router.submit()).toBe('pass');
  const x = fixture('/m'), stale = x.keyboardContext(); x.set({ ...x.read(), document: { ...x.read().document, text: '/m changed' }, revision: 1 });
  expect(x.router.choose(x.selection('model'), true, stale)).toBe(false); expect(x.intents).toEqual([]);
  const live = fixture('/model'); live.router.submit(); const intent = live.intents[0]; expect(intent.current()).toBe(true);
  const original = live.read(); live.set(null); expect(intent.current()).toBe(false);
  live.set({ ...original, owner: {} }); expect(intent.current()).toBe(false);
  const candidate = fixture('/m'), previousContext = candidate.keyboardContext(); candidate.set({ ...candidate.read(), owner: {} });
  expect(candidate.router.choose(candidate.selection('model'), true, previousContext)).toBe(false); expect(candidate.intents).toEqual([]);
  const cas = fixture('/new'); cas.write.mockReturnValueOnce(false); expect(cas.router.submit()).toBe('rejected'); expect(cas.intents).toEqual([]); expect(cas.read().document.text).toBe('/new');
});

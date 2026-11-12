import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createInputStore } from '@/sync/input-store';
import { draftKeyString, type DraftKey } from '@/sync/input-draft-types';
import { useComposerController } from './use-composer-controller';
import { useComposerSelection } from './use-composer-selection';
import archive from './fixtures/candidate-final-selection.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const titles = new Map<string, string>();
const roots: Array<{ root: ReturnType<typeof createRoot>; node: HTMLDivElement }> = [];
const key: DraftKey = { transportIdentity: 'hub', owner: { kind: 'session', ownerID: archive.sessionID } };
const remoteKey: DraftKey = { transportIdentity: 'remote-hub:hub', owner: { kind: 'session', ownerID: 'host:/repo:session' } };

function Editor({ store, draftKey = key, enabled = true, rendered }: {
  store: ReturnType<typeof createInputStore>; draftKey?: DraftKey; enabled?: boolean; rendered?: () => void;
}) {
  rendered?.();
  const composer = useComposerController({ store, draftKey, sessionTitles: titles, persistenceEnabled: false });
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const supersede = useComposerSelection({ store, draftKey, textareaRef, text: composer.document.text, enabled });
  return <textarea key={draftKeyString(draftKey)} ref={textareaRef} value={composer.document.text}
    onSelect={supersede} onFocus={supersede}
    onChange={(event) => { supersede(); composer.applyBrowserEdit(event.target.value, event.target.selectionStart, event.target.selectionEnd); }} />;
}

function setup() {
  const store = createInputStore({ persistenceEnabled: false });
  store.getState().setDraftText(key, archive.before.value);
  store.getState().setDraftText(remoteKey, '');
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node); roots.push({ root, node });
  return { store, node, root, render: async (draftKey = key, enabled = true) => act(async () => root.render(<Editor store={store} draftKey={draftKey} enabled={enabled} />)) };
}

afterEach(async () => {
  for (const { root, node } of roots.splice(0)) { await act(async () => root.unmount()); node.remove(); }
  vi.restoreAllMocks();
});

test('actual controller/store owner switches retain backward selection without stealing another input focus', async () => {
  const editor = setup();
  await editor.render();
  const textarea = editor.node.querySelector('textarea')!;
  textarea.setSelectionRange(6, 21, 'backward');
  const search = document.createElement('input'); document.body.append(search); search.focus();
  const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
  await editor.render(remoteKey);
  expect(editor.node.querySelector('textarea')!.value).toBe('');
  await editor.render();
  const returned = editor.node.querySelector('textarea')!;
  expect([returned.selectionStart, returned.selectionEnd, returned.selectionDirection]).toEqual([6, 21, 'backward']);
  expect(document.activeElement).toBe(search);
  expect(focus).not.toHaveBeenCalled();
  search.remove();
});

test.each([false, true])('external draft CAS supersedes saved selection even for identical text (during unmount: %s)', async (duringUnmount) => {
  const editor = setup();
  await editor.render();
  editor.node.querySelector('textarea')!.setSelectionRange(6, 21);
  const original = editor.store.getState().getDraft(key)!;
  const replace = () => {
    expect(editor.store.getState().replaceDraft(key, original.revision - 1, original)).toBeUndefined();
    expect(editor.store.getState().replaceDraft(key, original.revision, original)).toBeDefined();
  };
  if (duringUnmount) await act(async () => { replace(); editor.root.render(null); });
  else { await act(async () => editor.root.render(null)); replace(); }
  await editor.render();
  const returned = editor.node.querySelector('textarea')!;
  expect(returned.value).toBe(archive.before.value);
  expect([returned.selectionStart, returned.selectionEnd]).not.toEqual([6, 21]);
});

test('late cleanup of an older mounted owner cannot overwrite the newer owner selection', async () => {
  const older = setup();
  await older.render();
  older.node.querySelector('textarea')!.setSelectionRange(6, 21);
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node); roots.push({ root, node });
  await act(async () => root.render(<Editor store={older.store} />));
  node.querySelector('textarea')!.setSelectionRange(2, 4, 'backward');
  await act(async () => root.render(null));
  await act(async () => older.root.render(null));
  await older.render();
  const returned = older.node.querySelector('textarea')!;
  expect([returned.selectionStart, returned.selectionEnd, returned.selectionDirection]).toEqual([2, 4, 'backward']);
});

test('a rejected stale CAS preserves selection, and a later user selection replaces the old snapshot', async () => {
  const editor = setup();
  await editor.render();
  editor.node.querySelector('textarea')!.setSelectionRange(6, 21);
  await act(async () => editor.root.render(null));
  const original = editor.store.getState().getDraft(key)!;
  expect(editor.store.getState().replaceDraft(key, original.revision - 1, { ...original, text: 'stale restore' })).toBeUndefined();
  await editor.render();
  const returned = editor.node.querySelector('textarea')!;
  expect([returned.selectionStart, returned.selectionEnd]).toEqual([6, 21]);
  returned.focus(); returned.setSelectionRange(4, 8, 'backward');
  await act(async () => editor.root.render(null));
  await editor.render();
  const latest = editor.node.querySelector('textarea')!;
  expect([latest.selectionStart, latest.selectionEnd, latest.selectionDirection]).toEqual([4, 8, 'backward']);
});

test('user selection after restore wins; unrelated drafts do zero owner work and edits never replay selection', async () => {
  const editor = setup();
  await editor.render();
  editor.node.querySelector('textarea')!.setSelectionRange(6, 21);
  await act(async () => editor.root.render(null));
  const rendered = vi.fn();
  await act(async () => editor.root.render(<Editor store={editor.store} rendered={rendered} />));
  const returned = editor.node.querySelector('textarea')!;
  returned.focus(); returned.setSelectionRange(3, 5);
  const restore = vi.spyOn(returned, 'setSelectionRange');
  rendered.mockClear();
  for (let index = 0; index < 50; index++) await act(async () => editor.store.getState().setDraftText(remoteKey, `other ${index}`));
  expect(rendered).not.toHaveBeenCalled();
  expect([returned.selectionStart, returned.selectionEnd]).toEqual([3, 5]);
  for (let index = 0; index < 50; index++) await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(returned, `typed ${index}`);
    returned.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(editor.store.getState().getDraft(key)?.text).toBe('typed 49');
  expect(restore).not.toHaveBeenCalled();
});

test('native-owned sink is excluded from web selection capture and restoration', async () => {
  const editor = setup();
  await editor.render(key, false);
  editor.node.querySelector('textarea')!.setSelectionRange(6, 21);
  await act(async () => editor.root.render(null));
  await editor.render(key, false);
  const returned = editor.node.querySelector('textarea')!;
  expect([returned.selectionStart, returned.selectionEnd]).not.toEqual([6, 21]);
});

test('same DraftKey selection snapshots remain isolated between input stores', async () => {
  const first = setup(); const second = setup();
  await first.render(); await second.render();
  first.node.querySelector('textarea')!.setSelectionRange(6, 21, 'forward');
  second.node.querySelector('textarea')!.setSelectionRange(2, 4, 'backward');
  await act(async () => { first.root.render(null); second.root.render(null); });
  await first.render(); await second.render();
  const a = first.node.querySelector('textarea')!; const b = second.node.querySelector('textarea')!;
  expect([a.selectionStart, a.selectionEnd, a.selectionDirection]).toEqual([6, 21, 'forward']);
  expect([b.selectionStart, b.selectionEnd, b.selectionDirection]).toEqual([2, 4, 'backward']);
});

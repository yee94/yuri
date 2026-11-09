import { beforeEach, expect, test, vi } from 'vitest';
const dialogs = vi.hoisted(() => ({ show: vi.fn() }));
const host = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock('nsh/base', () => ({ AlertDialog: dialogs }));
vi.mock('./runtime', () => host);
vi.mock('./i18n', () => ({ t: (key: string) => key }));
import { createNativeDesktopEditors } from './desktop-files-editor-owner';
import type { DesktopEditorOperation } from './desktop-files-editor-model';
import type { DesktopPanelScope } from './desktop-panel-model';

const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'lease' }, authorityKey: 'synthetic-authority', sessionID: 'session', directory: '/workspace' };
beforeEach(() => { dialogs.show.mockReset(); host.native.mockReset(); });
async function fixture() {
  const owner = createNativeDesktopEditors(() => {}, { storage: false });
  let current = true, operationScope = scope;
  const operation = (): DesktopEditorOperation => ({ scope: operationScope, current: () => current, request: async path => {
    if (path.startsWith('/api/fs/stat?')) return { path: new URL('https://synthetic.invalid' + path).searchParams.get('path'), isFile: true, size: 4, mtimeMs: 1, isBinary: false, mimeType: 'text/plain' };
    if (path.startsWith('/api/fs/read?')) return 'base';
    throw new Error('No writes in close fixture');
  } });
  async function add(path: string, dirty = true) {
    const document = owner.model.acquire(scope, path)!.document;
    owner.bind(document, operation);
    await owner.model.load(document, operation());
    if (dirty) owner.model.edit(document, 'draft-' + path);
    return document;
  }
  return { owner, add, setCurrent(value: boolean) { current = value; }, setScope(value: DesktopPanelScope) { operationScope = value; } };
}

test('all-doc close rechecks previously confirmed and initially clean documents after later dialogs', async () => {
  for (const dirty of [true, false]) {
    const f = await fixture(), first = await f.add('a.ts', dirty), second = await f.add('b.ts');
    dialogs.show.mockImplementation(async options => {
      if (options.description.startsWith(second.path)) f.owner.model.edit(first, 'later-edit');
      return { action: 'discard' };
    });
    expect(await f.owner.guardAll()).toBe(false);
    expect(f.owner.model.dirty(first)).toBe(true);
    expect(f.owner.model.dirty(second)).toBe(false);
    expect(first.state().text).toBe('later-edit');
  }
});

test('edit then undo after a document was checked also revokes the close intent', async () => {
  const f = await fixture(), first = await f.add('a.ts', false), second = await f.add('b.ts');
  dialogs.show.mockImplementation(async () => {
    f.owner.model.edit(first, 'temporary'); f.owner.model.edit(first, 'base');
    return { action: 'discard' };
  });
  expect(await f.owner.guardAll()).toBe(false);
  expect(f.owner.model.protected(first)).toBe(false);
  expect(f.owner.model.protected(second)).toBe(false);
});

test('new documents created during confirmation are not silently approved', async () => {
  const f = await fixture(); await f.add('a.ts');
  let text = '';
  dialogs.show.mockImplementation(async () => { const added = await f.add('new.ts'); text = added.state().text; return { action: 'discard' }; });
  expect(await f.owner.guardAll()).toBe(false);
  expect(text).toBe('draft-new.ts');
});

test('cancel, changed authority, lease or current scope cannot approve or discard the draft', async () => {
  for (const change of ['cancel', 'authority', 'lease', 'current']) {
    const f = await fixture(), document = await f.add('a.ts');
    dialogs.show.mockImplementation(async () => {
      if (change === 'authority') f.setScope({ ...scope, authorityKey: 'other' });
      if (change === 'lease') f.setScope({ ...scope, host: { ...scope.host, lease: 'new' } });
      if (change === 'current') f.setCurrent(false);
      return { action: change === 'cancel' ? 'cancel' : 'discard' };
    });
    expect(await f.owner.guardAll()).toBe(false);
    expect(document.state().text).toBe('draft-a.ts');
    expect(f.owner.model.edit(document, 'still-usable')).toBe(true);
  }
});

test('authority changes after an earlier discard are caught at the final whole-owner check', async () => {
  const f = await fixture(), first = await f.add('a.ts'), second = await f.add('b.ts');
  dialogs.show.mockImplementation(async options => {
    if (options.description.startsWith(second.path)) f.setCurrent(false);
    return { action: 'discard' };
  });
  expect(await f.owner.guardAll()).toBe(false);
  expect(f.owner.model.protected(first)).toBe(false);
  expect(f.owner.model.protected(second)).toBe(true);
});

test('confirmed dirty-to-clean transitions approve without disposing documents or the owner', async () => {
  const f = await fixture(), first = await f.add('a.ts'), second = await f.add('b.ts');
  dialogs.show.mockResolvedValue({ action: 'discard' });
  expect(await f.owner.guardAll()).toBe(true);
  expect(f.owner.model.documents()).toEqual([first, second]);
  expect(f.owner.model.edit(first, 'still editable after a failed native approval')).toBe(true);
  expect(await f.owner.guardAll()).toBe(true);
});

test('default document storage requires the private native journal, failing closed without a plaintext NSH Storage fallback', async () => {
  host.native.mockRejectedValue(new Error('unsupported_desktop_capability'));
  const owner = createNativeDesktopEditors(() => {});
  expect(await owner.journal!.ready).toBe(false);
  expect(host.native).toHaveBeenCalledExactlyOnceWith('desktop.files.journal.snapshot', {});
  expect(owner.journalState().hydrated).toBe(false);
  expect(await owner.guardAll()).toBe(false);
  owner.journal!.stop();
});

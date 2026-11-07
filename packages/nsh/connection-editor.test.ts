import { describe, expect, it, vi } from 'vitest';
import { connectionEditorDescriptor, connectionEditorDirty, connectionEditorFailureKey, connectionEditorInput, createConnectionEditor, createConnectionEditorLeaveGuard } from './connection-editor-core';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW';
import { dict as ja } from '../ui/src/lib/i18n/messages/ja';
import { dict as ko } from '../ui/src/lib/i18n/messages/ko';
import { dict as fr } from '../ui/src/lib/i18n/messages/fr';
import { dict as es } from '../ui/src/lib/i18n/messages/es';
import { dict as pl } from '../ui/src/lib/i18n/messages/pl';
import { dict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR';
import { dict as uk } from '../ui/src/lib/i18n/messages/uk';

const descriptor = { id: 'synthetic-id', version: 'legacy', label: 'Original', url: 'https://host.example.invalid', transport: 'direct' as const };
const snapshot = { connections: [], selected: descriptor.id };

describe('connection metadata editor', () => {
  it('projects only public metadata and never returns a credential or relay key', () => {
    const actual = connectionEditorDescriptor({ ...descriptor, token: crypto.randomUUID(), relay: { key: crypto.randomUUID() } }, descriptor.id);
    expect(actual).toEqual(descriptor);
    expect(() => connectionEditorDescriptor({ ...descriptor, id: 'different' }, descriptor.id)).toThrow('connection_editor_invalid');
  });
  it('validates complete names with the same UTF-16 limit as the native form', () => {
    expect(connectionEditorInput(descriptor, ' New name ')).toEqual({ id: descriptor.id, version: 'legacy', label: 'New name' });
    for (const name of ['', '  ', 'a\nb', 'x'.repeat(121), '😀'.repeat(61)]) expect(() => connectionEditorInput(descriptor, name)).toThrow('connection_editor_invalid');
    expect(connectionEditorInput(descriptor, '😀'.repeat(60)).label.length).toBe(120);
  });
  it('rename uses only the metadata native method; failures preserve draft and allow retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('connection_editor_storage')).mockResolvedValue(snapshot);
    const editor = createConnectionEditor({ read: async () => descriptor, write, current: () => true });
    await editor.load(descriptor.id);
    await expect(editor.save('Draft name')).rejects.toThrow('connection_editor_storage');
    expect(await editor.save('Draft name')).toBe(snapshot);
    expect(write.mock.calls).toEqual(Array(2).fill(['connection.rename', { id: descriptor.id, version: 'legacy', label: 'Draft name' }]));
  });
  it('edit preserves identity/version and sends no token, pairing secret or old relay credentials', async () => {
    const write = vi.fn().mockResolvedValue(snapshot);
    const editor = createConnectionEditor({ read: async () => descriptor, write, current: () => true });
    await editor.load(descriptor.id);
    await editor.save('Updated', descriptor.url);
    expect(write).toHaveBeenCalledExactlyOnceWith('connection.edit', { id: descriptor.id, version: 'legacy', label: 'Updated', url: descriptor.url });
  });
  it('does not replay a pending write and ignores completion after closing', async () => {
    let finish!: (value: typeof snapshot) => void, alive = true;
    const write = vi.fn(() => new Promise<typeof snapshot>(resolve => { finish = resolve; }));
    const editor = createConnectionEditor({ read: async () => descriptor, write, current: () => alive });
    await editor.load(descriptor.id);
    const first = editor.save('Pending');
    expect(await editor.save('Second')).toBeUndefined();
    alive = false; finish(snapshot);
    expect(await first).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('does not adopt a descriptor from a disposed editor', async () => {
    let alive = true;
    const editor = createConnectionEditor({ read: async () => { alive = false; return descriptor; }, write: vi.fn(), current: () => alive });
    expect(await editor.load(descriptor.id)).toBeUndefined();
    expect(await editor.save('Ignored')).toBeUndefined();
  });
  it('maps stable native errors without displaying arbitrary native text or URLs', () => {
    expect(connectionEditorFailureKey(new Error('Host: connection_editor_stale'))).toBe('mobile.instances.nativeEditor.stale');
    expect(connectionEditorFailureKey(new Error('https://private.example.invalid'))).toBe('mobile.instances.nativeEditor.storage');
    expect(connectionEditorFailureKey(new Error('not_connection_editor_stale_suffix'))).toBe('mobile.instances.nativeEditor.storage');
  });
  it('all ten formal dictionaries contain real translations for every new key', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('mobile.instances.nativeEditor.')) as Array<keyof typeof en>;
    expect(keys.length).toBe(7);
    for (const dict of [zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) for (const key of keys) {
      expect(dict[key]).toBeTruthy();
      expect(dict[key]).not.toBe(en[key]);
    }
  });
});

describe('connection editor native leave contract', () => {
  it('tracks label and URL separately, including raw input that has not been saved', () => {
    expect(connectionEditorDirty(undefined, '', '')).toBe(false);
    expect(connectionEditorDirty(descriptor, descriptor.label, descriptor.url)).toBe(false);
    expect(connectionEditorDirty(descriptor, 'Edited', descriptor.url)).toBe(true);
    expect(connectionEditorDirty(descriptor, descriptor.label, 'https://new.example.invalid')).toBe(true);
    expect(connectionEditorDirty(descriptor, descriptor.label + ' ')).toBe(true);
    expect(connectionEditorDirty(descriptor, descriptor.label)).toBe(false);
  });
  it('clean navigation leaves immediately without asking or saving', async () => {
    const onLeave = vi.fn(), confirmDiscard = vi.fn();
    const guard = createConnectionEditorLeaveGuard({ dirty: () => false, busy: () => false, current: () => true, confirmDiscard, onLeave, onConfirming: vi.fn() });
    expect(guard.blocked()).toBe(false);
    await guard.back();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });
  it('cancelled label/URL discard retains the draft; explicit discard leaves once', async () => {
    const draft = { label: 'Unsaved name', url: 'https://changed.example.invalid' };
    const onLeave = vi.fn(), onConfirming = vi.fn(), confirmDiscard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const guard = createConnectionEditorLeaveGuard({ dirty: () => connectionEditorDirty(descriptor, draft.label, draft.url), busy: () => false, current: () => true, confirmDiscard, onLeave, onConfirming });
    expect(guard.blocked()).toBe(true);
    await guard.back();
    expect(onLeave).not.toHaveBeenCalled();
    expect(draft).toEqual({ label: 'Unsaved name', url: 'https://changed.example.invalid' });
    expect(guard.blocked()).toBe(true);
    await guard.back();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onConfirming.mock.calls.map(args => args[0])).toEqual([true, false, true, false]);
  });
  it('busy save prevents both a prompt and leaving', async () => {
    const onLeave = vi.fn(), confirmDiscard = vi.fn();
    const guard = createConnectionEditorLeaveGuard({ dirty: () => true, busy: () => true, current: () => true, confirmDiscard, onLeave, onConfirming: vi.fn() });
    expect(guard.blocked()).toBe(true);
    await guard.back();
    expect(confirmDiscard).not.toHaveBeenCalled(); expect(onLeave).not.toHaveBeenCalled();
  });
  it('one prompt owns simultaneous native back and cancel; late confirmation cannot pop a different route', async () => {
    let finish!: (value: boolean) => void, alive = true;
    const confirmDiscard = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })), onLeave = vi.fn();
    const guard = createConnectionEditorLeaveGuard({ dirty: () => true, busy: () => false, current: () => alive, confirmDiscard, onLeave, onConfirming: vi.fn() });
    const pending = guard.back();
    await guard.back();
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    alive = false; finish(true); await pending;
    expect(onLeave).not.toHaveBeenCalled();
  });
  it('a rejected prompt leaves edits blocked and permits an explicit retry', async () => {
    const onLeave = vi.fn(), confirmDiscard = vi.fn().mockRejectedValueOnce(new Error('synthetic dialog failure')).mockResolvedValueOnce(true);
    const guard = createConnectionEditorLeaveGuard({ dirty: () => true, busy: () => false, current: () => true, confirmDiscard, onLeave, onConfirming: vi.fn() });
    await expect(guard.back()).rejects.toThrow('synthetic dialog failure');
    expect(guard.blocked()).toBe(true); expect(onLeave).not.toHaveBeenCalled();
    await guard.back(); expect(onLeave).toHaveBeenCalledTimes(1);
  });
  it('a failed native edit does not clear leave protection or either draft field', async () => {
    const draft = { label: 'Unsaved', url: 'https://new.example.invalid' }, onLeave = vi.fn();
    const editor = createConnectionEditor({ read: async () => descriptor, write: async () => { throw new Error('connection_editor_pairing_required'); }, current: () => true });
    await editor.load(descriptor.id);
    await expect(editor.save(draft.label, draft.url)).rejects.toThrow('connection_editor_pairing_required');
    const guard = createConnectionEditorLeaveGuard({ dirty: () => connectionEditorDirty(descriptor, draft.label, draft.url), busy: () => false, current: () => true, confirmDiscard: async () => false, onLeave, onConfirming: vi.fn() });
    expect(guard.blocked()).toBe(true); await guard.back(); expect(onLeave).not.toHaveBeenCalled();
    expect(draft).toEqual({ label: 'Unsaved', url: 'https://new.example.invalid' });
  });
});

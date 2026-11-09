import { describe, expect, it, vi } from 'vitest';
import { createDesktopWindowMetadataStorage, desktopWindowMetadataIdentity, desktopWindowPreferenceCoordination } from './desktop-window-metadata';

describe('native window-private metadata partition', () => {
  it('uses native process coordination even for primary and never guesses permission from a key or missing policy', () => {
    for (const windowKey of ['primary', 'second']) {
      expect(desktopWindowPreferenceCoordination({ windowKey, windowKind: 'main', windowCoordination: 'single-engine' })).toBe('single-engine');
      for (const windowCoordination of [undefined, null, 'multi-engine', 'unknown', true]) expect(desktopWindowPreferenceCoordination({ windowKey, windowKind: 'main', windowCoordination })).toBe('multi-engine');
    }
    for (const params of [null, [], {}, { windowCoordination: 'single-engine' }, { windowKey: '../primary', windowKind: 'main', windowCoordination: 'single-engine' }]) expect(desktopWindowPreferenceCoordination(params)).toBe('multi-engine');
  });
  it('keeps exact primary compatibility, never copies primary records to another stable window', async () => {
    const rows = new Map([['desktop.navigation.v1', 'primary navigation']]);
    const storage = { getItem: vi.fn(async (key: string) => rows.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { rows.set(key, value); }), removeItem: vi.fn(async (key: string) => { rows.delete(key); }) };
    const primary = createDesktopWindowMetadataStorage(storage, desktopWindowMetadataIdentity({}));
    const secondary = createDesktopWindowMetadataStorage(storage, desktopWindowMetadataIdentity({ windowKey: 'main:second', windowKind: 'main' }));
    expect(await primary.getItem('desktop.navigation.v1')).toBe('primary navigation');
    expect(await secondary.getItem('desktop.navigation.v1')).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
    await secondary.setItem('desktop.navigation.v1', 'second navigation');
    expect(await primary.getItem('desktop.navigation.v1')).toBe('primary navigation');
    const restored = createDesktopWindowMetadataStorage(storage, desktopWindowMetadataIdentity({ windowKey: 'main:second', windowKind: 'main' }));
    expect(await restored.getItem('desktop.navigation.v1')).toBe('second navigation');
    await restored.removeItem('desktop.navigation.v1'); expect(await primary.getItem('desktop.navigation.v1')).toBe('primary navigation');
  });
  it('partitions all three UI owners with an immutable captured key and passes failures through', async () => {
    const storage = { getItem: vi.fn(async () => { throw new Error('storage offline'); }), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) };
    const identity = { windowKey: 'second', windowKind: 'main' as const }, scoped = createDesktopWindowMetadataStorage(storage, identity);
    identity.windowKey = 'third';
    for (const key of ['desktop.navigation.v1', 'desktop.layout.v1', 'desktop.panel-tabs.v1']) {
      await expect(scoped.getItem(key)).rejects.toThrow('storage offline');
      await scoped.setItem(key, 'confirmed');
      expect(storage.setItem).toHaveBeenLastCalledWith('desktop.window.v1:second:' + key, 'confirmed');
    }
  });
  it('does not accept raw receipt identity, partial descriptors, unsupported kinds or paths', () => {
    for (const params of [null, [], { windowKey: 'primary' }, { windowKind: 'main' }, { windowKey: '', windowKind: 'main' }, { windowKey: 'a/b', windowKind: 'main' }, { windowKey: 'a'.repeat(129), windowKind: 'main' }, { windowKey: 'primary', windowKind: 'mini-chat' }]) expect(() => desktopWindowMetadataIdentity(params)).toThrow();
    expect(desktopWindowMetadataIdentity({ windowID: 'random-http-receipt' }).windowKey).toBe('primary');
  });
  it('refuses global preferences and secret-bearing journals without any Storage access', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const scoped = createDesktopWindowMetadataStorage(storage, { windowKey: 'primary', windowKind: 'main' });
    for (const key of ['language', 'desktop.diff-preferences.v1', 'desktop.shortcuts.v1', 'nsh:chat-draft:v1:private', 'desktop-file-journal-v1:private', '../desktop.layout.v1']) {
      expect(() => scoped.getItem(key)).toThrow(); expect(() => scoped.setItem(key, 'never written')).toThrow(); expect(() => scoped.removeItem(key)).toThrow();
    }
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled();
  });
});

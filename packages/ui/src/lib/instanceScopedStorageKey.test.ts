import { describe, expect, it, vi } from 'vitest';
import { instanceScopedStorageKeyForRuntime } from './instanceScopedStorageKey';
import { instanceScopedStorageKey } from './instanceScopedStorage';
import { guiPreferencesKey } from './gui-plugins/preferences';

describe('explicit instance storage keys', () => {
  it.each(['local', 'relay:host@wss://relay.example', 'nsh:host', ' 主机 ', '', '   '])('preserves existing persisted key encoding for %j', runtimeKey => {
    const identity = runtimeKey.trim() || 'default';
    const encoded = btoa(unescape(encodeURIComponent(identity))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const expected = `yuri.inst.${encoded}.gui-plugins.disabled`;
    expect(instanceScopedStorageKeyForRuntime('gui-plugins.disabled', runtimeKey)).toBe(expected);
    expect(instanceScopedStorageKey('gui-plugins.disabled', runtimeKey)).toBe(expected);
    expect(guiPreferencesKey(runtimeKey)).toBe(expected);
  });

  it('preserves the existing fallback when base64 encoding is unavailable', () => {
    vi.stubGlobal('btoa', undefined);
    try {
      expect(instanceScopedStorageKeyForRuntime('drafts', ' 主机 ')).toBe(`yuri.inst.${encodeURIComponent('主机')}.drafts`);
    } finally { vi.unstubAllGlobals(); }
  });
});

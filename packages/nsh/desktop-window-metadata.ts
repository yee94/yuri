export type DesktopWindowMetadataIdentity = Readonly<{ windowKey: string; windowKind: 'main' }>;
export type DesktopWindowPreferenceCoordination = 'single-engine' | 'multi-engine';
export type DesktopWindowMetadataStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
};
const privateKeys = new Set(['desktop.navigation.v1', 'desktop.layout.v1', 'desktop.panel-tabs.v1']);

/** Native injects this descriptor before Engine load. It is UI identity, not authority. */
export function desktopWindowMetadataIdentity(params: unknown): DesktopWindowMetadataIdentity {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('desktop_window_descriptor_invalid');
  const value = params as Record<string, unknown>;
  // Existing single-window embeds and headless Hosts have no descriptor. Only
  // that complete absence may use the legacy primary metadata partition.
  if (value.windowKey === undefined && value.windowKind === undefined) return Object.freeze({ windowKey: 'primary', windowKind: 'main' });
  if (value.windowKind !== 'main' || typeof value.windowKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.windowKey)) throw new Error('desktop_window_descriptor_invalid');
  return Object.freeze({ windowKey: value.windowKey, windowKind: 'main' });
}

/** Only the native process policy permits device preference writes. An absent or
 * unknown policy deliberately uses the existing unsupported multi-Engine lane. */
export function desktopWindowPreferenceCoordination(params: unknown): DesktopWindowPreferenceCoordination {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'multi-engine';
  const value = params as Record<string, unknown>;
  if (value.windowCoordination !== 'single-engine') return 'multi-engine';
  if (value.windowKind !== 'main' || typeof value.windowKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.windowKey)) return 'multi-engine';
  return 'single-engine';
}

/** Only window-private UI metadata crosses this adapter. Drafts, native journals,
 * language, fonts and Diff/shortcut device preferences deliberately cannot. */
export function createDesktopWindowMetadataStorage(storage: DesktopWindowMetadataStorage, identity: DesktopWindowMetadataIdentity): DesktopWindowMetadataStorage {
  const captured = desktopWindowMetadataIdentity(identity);
  const key = (name: string) => {
    if (!privateKeys.has(name)) throw new Error('desktop_window_metadata_key_unavailable');
    return captured.windowKey === 'primary' ? name : `desktop.window.v1:${encodeURIComponent(captured.windowKey)}:${name}`;
  };
  return {
    getItem: name => storage.getItem(key(name)),
    setItem: (name, value) => storage.setItem(key(name), value),
    removeItem: name => storage.removeItem(key(name)),
  };
}

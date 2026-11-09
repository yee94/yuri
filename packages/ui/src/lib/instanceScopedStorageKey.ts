const SCOPE_PREFIX = 'yuri.inst.';

const encodeInstance = (identity: string): string => {
  try {
    return btoa(unescape(encodeURIComponent(identity)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  } catch {
    return encodeURIComponent(identity);
  }
};

export const instanceScopedStorageKeyForRuntime = (
  baseKey: string,
  runtimeKey: string,
): string => `${SCOPE_PREFIX}${encodeInstance(runtimeKey.trim() || 'default')}.${baseKey}`;

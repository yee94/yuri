import { resourcePath } from './resources-model';

/** Reuse the resource/shared normalizer for drive and UNC identities. Keep the
 * existing strict POSIX admission (including iOS) instead of silently repairing
 * a malformed Unix path. Normalization is identity, not a filesystem grant. */
export function terminalDirectoryPath(value: string): string | null {
  try {
    if (value.trim() !== value) return null;
    const path = resourcePath(value);
    if (value.startsWith('/') && !value.startsWith('//') && path !== value) return null;
    if (value.startsWith('//') && path !== value) return null;
    if (!value.startsWith('/') && path.startsWith('/') && !path.startsWith('//')) return null;
    if (path.startsWith('//') && path.split('/').filter(Boolean).length < 2) return null;
    return path;
  } catch { return null; }
}
export const terminalDirectory = (value: string): boolean => terminalDirectoryPath(value) !== null;

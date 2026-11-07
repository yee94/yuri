export type ResourceEntry = { name: string; path: string; isDirectory: boolean; size?: number };
export type ResourceKind = 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'binary';
export type ResourcePreview = 'quicklook' | 'avkit' | 'unsupported';
export type ResourceContent = { kind: ResourceKind; preview?: ResourcePreview; previewError?: string; text?: string; thumbnail?: string; lease: string; size: number };
export const RESOURCE_TEXT_LIMIT = 1_000_000;
export const RESOURCE_BINARY_LIMIT = 25 * 1024 * 1024;
/** Format admission is not codec support: Swift must probe the protected local asset. */
export function resourceKind(path: string, mime = '', binary = false, containsNull = false): ResourceKind {
  const name = path.split('/').pop() ?? '';
  const ext = name.lastIndexOf('.') > 0 ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  const type = mime.split(';')[0].trim().toLowerCase();
  if (['m3u', 'm3u8', 'pls', 'mpd'].includes(ext) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'application/dash+xml'].includes(type)) return 'binary';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'aac', 'wav', 'wave', 'aif', 'aiff', 'caf', 'flac', 'oga', 'opus'].includes(ext)) return 'audio';
  return binary || containsNull ? 'binary' : 'text';
}
export const resourceCanPreview = (content: ResourceContent): boolean => content.preview !== undefined
  ? content.preview !== 'unsupported'
  : content.kind === 'image' || content.kind === 'pdf';
export function resourcePath(value: string): string {
  const path = value.replace(/\\/g, '/');
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Invalid resource path');
  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop(); else segments.push(part);
  }
  return '/' + segments.join('/');
}
export const resourceName = (path: string) => resourcePath(path).split('/').pop() || '/';
export const resourceWithin = (path: string, root: string) => root === '/' || path === root || path.startsWith(root + '/');
export function resourceParent(path: string, root: string): string | null {
  path = resourcePath(path); root = resourcePath(root);
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  return path !== root && resourceWithin(parent, root) ? parent : null;
}
export function resourceEntries(value: unknown, root: string): ResourceEntry[] {
  if (!value || typeof value !== 'object' || !('entries' in value) || !Array.isArray(value.entries)) throw new Error('Invalid file listing');
  return value.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('path' in entry) || typeof entry.path !== 'string' || !('isDirectory' in entry) || typeof entry.isDirectory !== 'boolean') throw new Error('Invalid file entry');
    const path = resourcePath(entry.path);
    if (!resourceWithin(path, root)) throw new Error('File entry outside project');
    return { path, name: resourceName(path), isDirectory: entry.isDirectory, ...('size' in entry && typeof entry.size === 'number' ? { size: entry.size } : {}) };
  }).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}
/** Every new load invalidates the preceding load, including failures and Host changes. */
export function resourceFence(currentHost: () => number) {
  let revision = 0;
  return { begin() { const host = currentHost(), token = ++revision; return () => token === revision && host === currentHost(); }, cancel() { revision++; } };
}
export function resourceServeRoute(path: string): string {
  return '/api/fs/serve' + resourcePath(path).split('/').map(encodeURIComponent).join('/');
}
export const resourceFindRoute = (directory: string, query: string) => `/api/fs/find?location%5Bdirectory%5D=${encodeURIComponent(directory)}&query=${encodeURIComponent(query)}&limit=40&type=file`;
export function resourceSearchEntries(value: unknown, directory: string, root: string): ResourceEntry[] {
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) throw new Error('Invalid file search');
  return value.data.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string' || !('type' in item) || !['file', 'directory'].includes(String(item.type))) throw new Error('Invalid search entry');
    const path = resourcePath(directory + '/' + item.path);
    if (!resourceWithin(path, root)) throw new Error('File outside project');
    return { path, name: resourceName(path), isDirectory: item.type === 'directory' };
  });
}

import { contactDescriptorFrom } from './attachments';
import { record, text, type Attachment, type ChatTarget, type Row } from './model';
import { resourcePath } from './resources-model';

export type NativeAttachmentSource = { kind: 'contact'; file: Extract<Attachment, { kind: 'contact' }> }
  | { kind: 'file'; path: string } | { kind: 'direct'; src: string } | { kind: 'unavailable' };

/** Display admission does not convert an opaque contact ID into a filesystem path. */
export function nativeAttachmentSource(file: Row, target: ChatTarget, hostID: string, origin = ''): NativeAttachmentSource {
  if (target.kind === 'assistant' && typeof file.attachmentID === 'string') {
    if (file.kind === 'contact' && (file.hostID !== hostID || file.assistantID !== target.id)) return { kind: 'unavailable' };
    try {
      const descriptor = contactDescriptorFrom({ type: 'file', attachmentID: file.attachmentID, sha256: file.sha256, size: file.size, mime: file.mime,
        ...(file.filename === undefined ? {} : { filename: file.filename }), ...(file.generation === undefined ? {} : { generation: file.generation }) });
      return { kind: 'contact', file: { ...descriptor, kind: 'contact', hostID, assistantID: target.id, name: descriptor.filename ?? descriptor.attachmentID } };
    } catch { return { kind: 'unavailable' }; }
  }
  const bytes = text(file.data), bytesMime = text(file.mime).toLowerCase();
  if (bytes && /^image\/(?:png|jpeg|jpg|gif|webp|avif|bmp)$/.test(bytesMime) && /^[A-Za-z0-9+/]+={0,2}$/.test(bytes) && bytes.length <= 35 * 1024 * 1024) return { kind: 'direct', src: `data:${bytesMime};base64,${bytes}` };
  const source = text(file.uri) || text(file.url) || text(record(file.source).uri);
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source) && source.length <= 35 * 1024 * 1024) return { kind: 'direct', src: source };
  try {
    if (source.startsWith('file:')) {
      const url = new URL(source);
      if (url.hostname && url.hostname !== 'localhost' || url.search || url.hash) return { kind: 'unavailable' };
      return { kind: 'file', path: decodeURIComponent(url.pathname) };
    }
    if (source.startsWith('/api/fs/serve/')) return { kind: 'file', path: decodeURIComponent(source.slice('/api/fs/serve'.length).split('?')[0]) };
    if (source.startsWith('/') && !source.startsWith('//')) return { kind: 'file', path: source };
    if (/^https?:/i.test(source)) {
      const url = new URL(source);
      if (url.username || url.password || ['token', 'oc_client_token', 'yuri_url_token'].some(key => url.searchParams.has(key))) return { kind: 'unavailable' };
      if (origin && url.origin === new URL(origin).origin) {
        if (url.pathname.startsWith('/api/fs/serve/')) return { kind: 'file', path: decodeURIComponent(url.pathname.slice('/api/fs/serve'.length)) };
        return { kind: 'unavailable' };
      }
      return { kind: 'direct', src: source };
    }
    if (source && target.directory.startsWith('/') && !/^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(source)) {
      return { kind: 'file', path: resourcePath(`${target.directory}/${decodeURIComponent(source.split(/[?#]/)[0])}`) };
    }
  } catch { return { kind: 'unavailable' }; }
  return { kind: 'unavailable' };
}

export const nativeAttachmentName = (file: Row): string => text(file.name) || text(file.filename) || text(record(file.source).path).split('/').pop() || '';
export const nativeAttachmentImage = (file: Row): boolean => text(file.mime).startsWith('image/') || /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|heic|heif|tiff?)$/i.test(nativeAttachmentName(file));

/** Share the native resource read budget across mounted attachment leaves. */
let running = 0;
const waiting: Array<() => void> = [];
export async function scheduleAttachmentRead<T>(current: () => boolean, read: () => Promise<T>): Promise<T> {
  await new Promise<void>(resolve => { waiting.push(resolve); advance(); });
  try { if (!current()) throw new Error('attachment_preview_stale'); return await read(); }
  finally { running--; advance(); }
}
function advance() { while (running < 1 && waiting.length) { running++; waiting.shift()!(); } }

import { expect, it, vi } from 'vitest';
import { nativeAttachmentSource, scheduleAttachmentRead } from './attachment-presentation';

const session = { kind: 'session' as const, id: 'session', title: '', directory: '/work' };
it('routes Host file URLs through authenticated resources, preserving opaque contacts and rejecting credential URLs', () => {
  expect(nativeAttachmentSource({ url: 'file:///work/my%20image.png' }, session, 'host')).toEqual({ kind: 'file', path: '/work/my image.png' });
  expect(nativeAttachmentSource({ url: 'https://host.example/api/fs/serve/work/photo.png' }, session, 'host', 'https://host.example')).toEqual({ kind: 'file', path: '/work/photo.png' });
  expect(nativeAttachmentSource({ url: 'https://host.example/private.png' }, session, 'host', 'https://host.example').kind).toBe('unavailable');
  expect(nativeAttachmentSource({ url: 'https://example.com/x.png?oc_client_token=secret' }, session, 'host').kind).toBe('unavailable');
  const file = { type: 'file', attachmentID: 'opaque', sha256: 'a'.repeat(64), size: 12, mime: 'image/png', filename: 'a.png', generation: 4 };
  expect(nativeAttachmentSource(file, { ...session, kind: 'assistant' }, 'host')).toMatchObject({ kind: 'contact', file: { assistantID: 'session', hostID: 'host', generation: 4 } });
  expect(nativeAttachmentSource({ ...file, sha256: 'bad' }, { ...session, kind: 'assistant' }, 'host').kind).toBe('unavailable');
  expect(nativeAttachmentSource({ ...file, kind: 'contact', hostID: 'old-host', assistantID: 'session' }, { ...session, kind: 'assistant' }, 'host').kind).toBe('unavailable');
  expect(nativeAttachmentSource({ url: '../images/a%20b.png' }, session, 'host')).toEqual({ kind: 'file', path: '/images/a b.png' });
});
it('bounds native reads and drops a retired queued source before dispatch', async () => {
  let finish!: () => void, current = true;
  const first = scheduleAttachmentRead(() => true, () => new Promise<void>(resolve => { finish = resolve; }));
  const read = vi.fn(async () => true);
  const second = scheduleAttachmentRead(() => current, read);
  const rejected = expect(second).rejects.toThrow('attachment_preview_stale');
  await Promise.resolve(); current = false; finish();
  await first; await rejected;
  expect(read).not.toHaveBeenCalled();
});

import { describe, expect, it } from 'vitest';
import { RESOURCE_BINARY_LIMIT, RESOURCE_TEXT_LIMIT, resourceCanPreview, resourceEntries, resourceFence, resourceFindRoute, resourceKind, resourceParent, resourcePath, resourceResolve, resourceSearchEntries, resourceServeRoute, resourceWithin } from './resources-model';

describe('native resource contracts', () => {
  it('uses the shared drive-letter identity while retaining Windows roots and UNC shares', () => {
    expect(resourcePath('c:\\work\\app\\src\\..\\file.ts')).toBe('C:/work/app/file.ts');
    expect(resourcePath('c:\\')).toBe('C:/');
    expect(resourcePath('\\\\server\\share\\app\\file.ts')).toBe('//server/share/app/file.ts');
    expect(resourceResolve('c:\\work\\app\\file.ts', 'C:/work/app')).toBe('C:/work/app/file.ts');
    expect(resourceResolve('src/file.ts', 'C:/work/app')).toBe('C:/work/app/src/file.ts');
    expect(resourceResolve('file.ts', '/')).toBe('/file.ts');
    expect(resourceResolve('file.ts', 'C:/')).toBe('C:/file.ts');
    expect(resourceWithin('c:\\work\\app\\file.ts', 'C:/work/app')).toBe(true);
    expect(resourceWithin('C:/other/file.ts', 'C:/work/app')).toBe(false);
    expect(resourceWithin('D:/work/app/file.ts', 'C:/work/app')).toBe(false);
    expect(resourceWithin('//server/share-two/file', '//server/share')).toBe(false);
    expect(resourceWithin('C:/work/app', '/')).toBe(false);
    expect(() => resourceResolve('../other/file.ts', 'C:/work/app')).toThrow();
    expect(() => resourcePath('C:relative')).toThrow();
    expect(() => resourcePath('\\\\?\\C:\\work')).toThrow();
    expect(resourceParent('C:/work', 'C:/')).toBe('C:/');
    expect(resourceParent('C:/', 'C:/')).toBeNull();
    expect(resourceParent('//server/share/app', '//server/share')).toBe('//server/share');
    expect(resourceServeRoute('C:/work/a #?.ts')).toBe('/api/fs/serve/C%3A/work/a%20%23%3F.ts');
    expect(resourceServeRoute('//server/share/a.ts')).toBe('/api/fs/serve//server/share/a.ts');
  });
  it('uses the installed official file.find route and real Host response envelope', () => {
    expect(resourceFindRoute('/fixture', 'source')).toBe('/api/fs/find?location%5Bdirectory%5D=%2Ffixture&query=source&limit=40&type=file');
    expect(resourceSearchEntries({ location: { directory: '/fixture' }, data: [{ path: 'sub/source.ts', type: 'file' }] }, '/fixture', '/fixture')).toEqual([{ path: '/fixture/sub/source.ts', name: 'source.ts', isDirectory: false }]);
    expect(() => resourceSearchEntries([{ path: 'source.ts', type: 'file' }], '/fixture', '/fixture')).toThrow();
    expect(() => resourceSearchEntries({ data: [{ path: '../other/file.ts', type: 'file' }] }, '/fixture', '/fixture')).toThrow();
  });
  it('caps upward navigation at the project root including slash root', () => {
    expect(resourceParent('/fixture/project/a', '/fixture/project')).toBe('/fixture/project');
    expect(resourceParent('/fixture/project', '/fixture/project')).toBeNull();
    expect(resourceParent('/one', '/')).toBe('/');
    expect(resourceWithin('/fixture/project-two', '/fixture/project')).toBe(false);
    expect(resourcePath('/fixture/a/../b/')).toBe('/fixture/b');
    expect(() => resourcePath('https://example.invalid')).toThrow();
  });
  it('rejects malformed/escaped listings rather than reporting empty success', () => {
    expect(() => resourceEntries({}, '/fixture')).toThrow();
    expect(() => resourceEntries({ entries: [{ path: '/elsewhere', isDirectory: false }] }, '/fixture')).toThrow();
    expect(resourceEntries({ entries: [{ path: '/fixture/z', isDirectory: false }, { path: '/fixture/a', isDirectory: true }] }, '/fixture').map(entry => entry.name)).toEqual(['a', 'z']);
  });
  it('encodes file segments without auth parameters or query injection', () => {
    expect(resourceServeRoute('/fixture/a #?文.png')).toBe('/api/fs/serve/fixture/a%20%23%3F%E6%96%87.png');
  });
  it('fences out of order success/failure, disposed pages and Host changes', () => {
    let host = 0;
    const fence = resourceFence(() => host);
    const old = fence.begin(), current = fence.begin();
    expect(old()).toBe(false); expect(current()).toBe(true);
    host++; expect(current()).toBe(false);
    const next = fence.begin(); fence.cancel(); expect(next()).toBe(false);
  });
  it('admits the real Web video extensions without treating admission as decoder support', () => {
    for (const ext of ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg']) {
      expect(resourceKind(`/fixture/CLIP.${ext.toUpperCase()}`, 'application/octet-stream', true, true)).toBe('video');
    }
    expect(resourceKind('/fixture/opaque', ' Video/MP4; codecs=avc1 ', true)).toBe('video');
    expect(resourceKind('/fixture/mp4')).toBe('text');
    expect(resourceKind('/fixture/.mp4')).toBe('text');
    expect(resourceCanPreview({ kind: 'video', lease: 'opaque', size: 512 })).toBe(false);
    expect(resourceCanPreview({ kind: 'video', preview: 'avkit', lease: 'opaque', size: 512 })).toBe(true);
    expect(resourceCanPreview({ kind: 'video', preview: 'unsupported', previewError: 'codec', lease: 'opaque', size: 512 })).toBe(false);
  });
  it('admits native audio and respects audio MIME for ambiguous Ogg containers', () => {
    for (const ext of ['mp3', 'm4a', 'aac', 'wav', 'wave', 'aif', 'aiff', 'caf', 'flac', 'oga', 'opus']) expect(resourceKind(`/fixture/sound.${ext}`, '', true)).toBe('audio');
    expect(resourceKind('/fixture/sound.ogg', 'audio/ogg', true)).toBe('audio');
    expect(resourceKind('/fixture/opaque', 'audio/mpeg', true)).toBe('audio');
  });
  it('does not admit HLS/DASH/playlist manifests as standalone native media', () => {
    for (const ext of ['m3u', 'm3u8', 'pls', 'mpd']) expect(resourceKind(`/fixture/list.${ext}`, 'video/mp4')).toBe('binary');
    for (const mime of ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'application/dash+xml']) expect(resourceKind('/fixture/list.mp4', mime)).toBe('binary');
    expect(resourceKind('/fixture/file.eficy')).toBe('text');
    expect(resourceKind('/fixture/file.bin', '', false, true)).toBe('binary');
  });
  it('retains image/PDF contracts and the original finite size limits', () => {
    expect(RESOURCE_BINARY_LIMIT).toBe(26_214_400);
    expect(RESOURCE_TEXT_LIMIT).toBe(1_000_000);
    expect(resourceKind('/fixture/image.png', '', true)).toBe('image');
    expect(resourceKind('/fixture/image.SVG', '', true)).toBe('svg');
    expect(resourceKind('/fixture/opaque', 'image/svg+xml')).toBe('svg');
    expect(resourceKind('/fixture/file.pdf', '', true)).toBe('pdf');
    expect(resourceCanPreview({ kind: 'image', lease: 'legacy', size: 512 })).toBe(true);
    expect(resourceCanPreview({ kind: 'pdf', preview: 'unsupported', lease: 'opaque', size: 512 })).toBe(false);
  });
});

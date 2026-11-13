import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';

const {
  runtimeFetchMock,
  openDesktopPathMock,
  openContextFileMock,
  openContextFileAtLineMock,
  editorOpenFileMock,
  toastWarningMock,
  isDesktopDirectoryPathMock,
  isDesktopLocalMock,
} = vi.hoisted(() => ({
  runtimeFetchMock: vi.fn(),
  openDesktopPathMock: vi.fn(async () => false),
  openContextFileMock: vi.fn(),
  openContextFileAtLineMock: vi.fn(),
  editorOpenFileMock: vi.fn(async () => undefined),
  toastWarningMock: vi.fn(),
  isDesktopDirectoryPathMock: vi.fn(async () => false),
  isDesktopLocalMock: vi.fn(() => false),
}));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/components/ui', () => ({
  toast: { warning: toastWarningMock },
}));

vi.mock('@/lib/i18n', () => ({
  useI18nStore: { getState: () => ({ dictionary: {} }) },
  formatMessage: (_dictionary: unknown, key: string) => key,
}));

vi.mock('@/lib/desktop', () => ({
  isDesktopBinaryPath: vi.fn(async () => false),
  isDesktopLocalOriginActive: isDesktopLocalMock,
  isDesktopShell: isDesktopLocalMock,
  isDesktopDirectoryPath: isDesktopDirectoryPathMock,
  isVSCodeRuntime: () => false,
  openDesktopPath: openDesktopPathMock,
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      openContextFile: openContextFileMock,
      openContextFileAtLine: openContextFileAtLineMock,
    }),
  },
}));

import {
  getFileReferenceInfo,
  getResolvedReference,
  probeFileReference,
  openFileReference,
  openFileReferenceFromElement,
  resetFileReferenceStatCacheForTests,
  shouldOfferFileReference,
  type OpenFileReferenceOptions,
} from './fileReferenceActions';

describe('fileReferenceActions', () => {
  beforeEach(() => {
    resetFileReferenceStatCacheForTests();
    runtimeFetchMock.mockReset();
    openDesktopPathMock.mockReset();
    openDesktopPathMock.mockResolvedValue(false);
    toastWarningMock.mockReset();
    openContextFileMock.mockReset();
    openContextFileAtLineMock.mockReset();
    editorOpenFileMock.mockReset();
    isDesktopLocalMock.mockReturnValue(false);
    isDesktopDirectoryPathMock.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    resetFileReferenceStatCacheForTests();
  });

  test('resolves absolute paths without the session directory', () => {
    expect(getResolvedReference('/tmp/report.html', '/Users/dev/project')).toEqual({
      path: '/tmp/report.html',
      resolvedPath: '/tmp/report.html',
    });
  });

  test('resolves relative paths against the session directory', () => {
    expect(getResolvedReference('src/app.ts', '/Users/dev/project')).toEqual({
      path: 'src/app.ts',
      resolvedPath: '/Users/dev/project/src/app.ts',
    });
  });

  test('same-path Host probes isolate caches and remote opens never invoke local desktop/editor APIs', async () => {
    isDesktopLocalMock.mockReturnValue(true);
    const firstFetch = vi.fn(async () => Response.json({ exists: true, isFile: true, isBinary: false }));
    const secondFetch = vi.fn(async () => Response.json({ exists: true, isFile: true, isBinary: true }));
    const host = (id: string, fetch: typeof firstFetch) => ({
      key: `location:${id}`, queryScope: ['hub', id, '/repo'], fetch, sdk: vi.fn(),
    }) as unknown as HostRuntimeEntry;
    const a = host('a', firstFetch);
    const b = host('b', secondFetch);
    expect(await probeFileReference('/repo/src/app.ts', '/repo', a)).toEqual({ exists: true, isBinary: false });
    expect(await probeFileReference('/repo/src/app.ts', '/repo', b)).toEqual({ exists: true, isBinary: true });
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(secondFetch).toHaveBeenCalledOnce();
    expect(runtimeFetchMock).not.toHaveBeenCalled();
    await openFileReference('src/app.ts', false, { effectiveDirectory: '/repo', scope: a, referenceKind: 'href', preferRuntimeEditor: true,
      editor: { openFile: editorOpenFileMock, openDiff: vi.fn(async () => undefined) } });
    expect(openContextFileMock).toHaveBeenCalledWith('location:a', '/repo/src/app.ts', { closeFileTree: true });
    expect(editorOpenFileMock).not.toHaveBeenCalled();
    expect(openDesktopPathMock).not.toHaveBeenCalled();
    expect(isDesktopDirectoryPathMock).not.toHaveBeenCalled();
  });

  test.each(['packages/electron/dist-preview/mac-arm64/', 'packages/electron/dist-preview/mac-arm64'])('opens local directory link %s in the system file manager', async (href) => {
    isDesktopLocalMock.mockReturnValue(true);
    isDesktopDirectoryPathMock.mockResolvedValue(true);
    openDesktopPathMock.mockResolvedValue(true);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/repo' });
    expect(openDesktopPathMock).toHaveBeenCalledWith('/repo/packages/electron/dist-preview/mac-arm64');
    expect(openContextFileMock).not.toHaveBeenCalled();
  });

  test('does not inspect or open a remote directory on the local desktop', async () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'packages/ui/');
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/remote' });
    expect(isDesktopDirectoryPathMock).not.toHaveBeenCalled();
    expect(openDesktopPathMock).not.toHaveBeenCalled();
  });

  test.each([false, true])('opens encoded Markdown file links (annotated: %s)', async (annotated) => {
    const path = '30 📚 Learning/📚 Knowledge/相机画幅图解.eficy';
    const anchor = document.createElement('a');
    anchor.setAttribute('href', encodeURI(path));
    const source = annotated ? document.createElement('span') : anchor;
    if (annotated) {
      source.setAttribute('data-yuri-file-ref', encodeURI(path));
      source.append(anchor);
    }
    await openFileReferenceFromElement(source, { effectiveDirectory: '/repo' });
    expect(openContextFileMock).toHaveBeenCalledWith('/repo', `/repo/${path}`, { closeFileTree: true });
  });

  test('decodes href filenames once after parsing line fragments, but preserves raw paths', async () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'docs/a%23b%3Bc%2520.md#L12');
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/repo' });
    expect(openContextFileAtLineMock).toHaveBeenCalledWith('/repo', '/repo/docs/a#b;c%20.md', 12, 1, { closeFileTree: true });
    await openFileReference('/repo/literal%20.eficy', false, { effectiveDirectory: '/repo' });
    expect(openContextFileMock).toHaveBeenCalledWith('/repo', '/repo/literal%20.eficy', { closeFileTree: true });
  });

  test('malformed percent escapes do not crash file-link opening', async () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'docs/100%.md');
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/repo' });
    expect(openContextFileMock).toHaveBeenCalledWith('/repo', '/repo/docs/100%.md', { closeFileTree: true });
  });

  test('stats through /api/fs/stat and remembers existence', async () => {
    runtimeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ exists: true, isBinary: false }),
    });

    await expect(getFileReferenceInfo('/tmp/report.html')).resolves.toEqual({
      exists: true,
      isBinary: false,
    });
    expect(runtimeFetchMock).toHaveBeenCalledWith(
      '/api/fs/stat?path=%2Ftmp%2Freport.html&optional=true',
      { method: 'GET', cache: 'no-store' },
    );
  });

  test('hides mobile binary paths that are not images or html', () => {
    expect(shouldOfferFileReference('/tmp/notes.bin', { exists: true, isBinary: true }, true)).toBe(false);
    expect(shouldOfferFileReference('/tmp/photo.png', { exists: true, isBinary: true }, true)).toBe(true);
    expect(shouldOfferFileReference('/tmp/report.html', { exists: true, isBinary: false }, true)).toBe(true);
  });

  test('probes in the session workspace rather than the host active project', async () => {
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ exists: true, isBinary: false }) });
    await probeFileReference('/repo/docs/report.md', '/repo');
    const [url, options] = runtimeFetchMock.mock.calls[0];
    const params = new URL(url, 'https://example.com').searchParams;
    expect(params.get('directory') ?? options.query?.directory).toBe('/repo');
  });

  test('a failed probe can recover instead of caching a missing file', async () => {
    runtimeFetchMock.mockRejectedValueOnce(new Error('Relay disconnected'));
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).rejects.toThrow('Relay disconnected');
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ exists: true, isBinary: false }) });
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).resolves.toEqual({ exists: true, isBinary: false });
    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
  });

  test('accepts the server stat payload without an exists field', async () => {
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ isFile: true, size: 42, isBinary: false }) });
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).resolves.toEqual({ exists: true, isBinary: false });
  });

  test('workspace rejection does not poison probes in another directory', async () => {
    runtimeFetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(probeFileReference('/repo/docs/report.md', '/other')).rejects.toThrow('400');
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ isFile: true, isBinary: false }) });
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).resolves.toEqual({ exists: true, isBinary: false });
  });

  test('opens image paths through the shared image preview', async () => {
    const onShowPopup = vi.fn();
    await openFileReference('/tmp/photo.png', false, {
      effectiveDirectory: '/tmp',
      onShowPopup,
    });
    expect(onShowPopup).toHaveBeenCalledWith({
      open: true,
      title: 'photo.png',
      content: '',
      metadata: {
        tool: 'image-preview',
        filename: 'photo.png',
        mime: 'image/png',
      },
      image: {
        url: '/tmp/photo.png',
        filename: 'photo.png',
        mimeType: 'image/png',
      },
    });
    expect(openContextFileMock).not.toHaveBeenCalled();
  });

  test('opens html paths in preview instead of the runtime editor', async () => {
    await openFileReference('/tmp/report.html', false, {
      effectiveDirectory: '/tmp',
      editor: { openFile: editorOpenFileMock } as unknown as OpenFileReferenceOptions['editor'],
      preferRuntimeEditor: true,
    });
    expect(editorOpenFileMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith('/tmp', '/tmp/report.html', { viewerMode: 'preview', closeFileTree: true });
  });

  test.each([
    ['/work/中文 report.eficy', '/work/中文 report.eficy'],
    ['file:///work/%E4%B8%AD%E6%96%87%20report.eficy', '/work/中文 report.eficy'],
    ['file:///C:/work/%E4%B8%AD%E6%96%87%20report.eficy', 'C:/work/中文 report.eficy'],
    ['C:\\work\\中文 report.eficy', 'C:/work/中文 report.eficy'],
    ['\\\\server\\share\\report.eficy', '//server/share/report.eficy'],
    ['file://server/share/report.eficy', '//server/share/report.eficy'],
  ])('opens local plugin file %s in the existing file tab', async (href, path) => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    anchor.textContent = '查看预览';
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/session' });
    expect(openContextFileMock).toHaveBeenCalledWith('/session', path, { closeFileTree: true });
  });

  test.each(['https://example.com/a.eficy', 'mailto:a.eficy', 'file:///work/%ZZ.eficy'])('does not treat %s as a local file', async (href) => {
    await openFileReference(href, false, { effectiveDirectory: '/session' });
    expect(openContextFileMock).not.toHaveBeenCalled();
  });

  test('opens a file outside the session directory with no grant and no warning', async () => {
    await openFileReference('/private/var/folders/x/report.md', false, {
      effectiveDirectory: '/Users/dev/project',
    });
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/private/var/folders/x/report.md',
      { closeFileTree: true },
    );
  });

  test('opens a worktree file in the context panel', async () => {
    await openFileReference(
      '/Users/dev/.local/share/opencode/worktree/abc/wechat-gui/src/app.ts',
      false,
      { effectiveDirectory: '/Users/dev/project' },
    );
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/Users/dev/.local/share/opencode/worktree/abc/wechat-gui/src/app.ts',
      { closeFileTree: true },
    );
  });

  test('opens a workspace-relative markdown link in the context panel', async () => {
    await openFileReference(
      'app/wxaaiagentnodelogicsvr/test/yi/stochastic/reports/kf-full-review.md',
      false,
      { effectiveDirectory: '/Users/dev/project' },
    );
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/Users/dev/project/app/wxaaiagentnodelogicsvr/test/yi/stochastic/reports/kf-full-review.md',
      { closeFileTree: true },
    );
  });

  test('opens a binary-classified plugin report in the context panel even when the desktop opener would succeed', async () => {
    openDesktopPathMock.mockResolvedValueOnce(true);
    await openFileReference('research/KF-ITERATION-REPORT.shadcn.eficy', true, {
      effectiveDirectory: '/repo',
    });
    expect(openContextFileMock).toHaveBeenCalledWith('/repo', '/repo/research/KF-ITERATION-REPORT.shadcn.eficy', { closeFileTree: true });
    expect(openDesktopPathMock).not.toHaveBeenCalled();
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  test.each([
    ['/tmp/notes.bin', true],
    ['/tmp/Example.app', false],
    ['/tmp/Example.app', true],
  ])('opens %s (binary=%s) in the file surface without invoking the desktop opener', async (path, isBinary) => {
    openDesktopPathMock.mockResolvedValueOnce(true);
    await openFileReference(path, isBinary, {
      effectiveDirectory: '/tmp',
    });
    expect(openDesktopPathMock).not.toHaveBeenCalled();
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith('/tmp', path, { closeFileTree: true });
  });

  test('opens an archive in the context panel without an external-preview warning', async () => {
    openDesktopPathMock.mockResolvedValueOnce(false);
    await openFileReference('/private/var/folders/x/evidence-bundle.tar.gz', true, {
      effectiveDirectory: '/Users/dev/project',
    });
    expect(openDesktopPathMock).not.toHaveBeenCalled();
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/private/var/folders/x/evidence-bundle.tar.gz',
      { closeFileTree: true },
    );
  });

  test.each([false, true])('honors explicit runtime editor preference for binary=%s with line and column', async (isBinary) => {
    openDesktopPathMock.mockResolvedValueOnce(true);
    await openFileReference('/repo/report.eficy:12:3', isBinary, {
      effectiveDirectory: '/repo',
      editor: { openFile: editorOpenFileMock } as unknown as OpenFileReferenceOptions['editor'],
      preferRuntimeEditor: true,
    });
    expect(editorOpenFileMock).toHaveBeenCalledWith('/repo/report.eficy', 12, 3);
    expect(openContextFileMock).not.toHaveBeenCalled();
    expect(openDesktopPathMock).not.toHaveBeenCalled();
  });

  test('opens a binary-classified element in the context panel at its referenced line', async () => {
    openDesktopPathMock.mockResolvedValueOnce(true);
    const anchor = document.createElement('a');
    anchor.setAttribute('data-yuri-file-ref', '/repo/report.eficy:12:3');
    anchor.setAttribute('data-yuri-file-binary', 'true');
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/repo' });
    expect(openContextFileAtLineMock).toHaveBeenCalledWith('/repo', '/repo/report.eficy', 12, 3, { closeFileTree: true });
    expect(openDesktopPathMock).not.toHaveBeenCalled();
  });
});

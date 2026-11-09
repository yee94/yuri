import { describe, expect, it, vi } from 'vitest';
import { createDesktopContentLink } from './desktop-content-link';
import type { DesktopPanelScope } from './desktop-panel-model';

const scope = (): DesktopPanelScope => ({ host: { hostID: 'synthetic', lease: 'lease-1' }, authorityKey: 'synthetic-public-authority', sessionID: 'own-session', directory: '/repo/own' });
function fixture(value = scope()) {
  let selected: DesktopPanelScope | null = value;
  const openFile = vi.fn((): boolean | Promise<boolean> => true), openPanel = vi.fn((): boolean | Promise<boolean> => true);
  const openExternal = vi.fn(async () => ({ opened: true }));
  const open = createDesktopContentLink({ scope: value, current: () => selected, openFile, openPanel, openExternal });
  return { open, openFile, openPanel, openExternal, select: (next: DesktopPanelScope | null) => { selected = next; } };
}

describe('desktop content links with exact owner authority', () => {
  it.each([
    ['README.md', '/repo/own/README.md', undefined],
    ['./src/main.ts:12:4', '/repo/own/src/main.ts', 12],
    ['src/main.ts:12-18', '/repo/own/src/main.ts', 12],
    ['/repo/own/src/main.ts#L7C3', '/repo/own/src/main.ts', 7],
    ['docs/Release%20Notes.md#L2', '/repo/own/docs/Release Notes.md', 2],
    ['docs/a%23b%3Bc.md#L3', '/repo/own/docs/a#b;c.md', 3],
    ['file:///repo/own/src/main.ts#L8', '/repo/own/src/main.ts', 8],
    ['file:/repo/own/src/main.ts#L8', '/repo/own/src/main.ts', 8],
    ['file://localhost/repo/own/src/main.ts#L9', '/repo/own/src/main.ts', 9],
  ])('uses Web reference semantics, never address-bar inference: %s', async (href, path, line) => {
    const f = fixture(); await f.open(href);
    expect(f.openFile).toHaveBeenCalledExactlyOnceWith(scope(), path, line);
    expect(f.openPanel).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('supports Windows drive paths and file envelopes within the exact repository', async () => {
    const captured = { ...scope(), directory: 'C:/repo/own' }, f = fixture(captured);
    await f.open('C:\\repo\\own\\src\\main.ts:11');
    await f.open('file:///C:/repo/own/src/main.ts#L5');
    expect(f.openFile.mock.calls).toEqual([[captured, 'C:/repo/own/src/main.ts', 11], [captured, 'C:/repo/own/src/main.ts', 5]]);
  });
  it('does not require a DOM or URL global in QuickJS', async () => {
    vi.stubGlobal('URL', undefined);
    try {
      const f = fixture(); await f.open('file:///repo/own/a%23b.ts#L4');
      expect(f.openFile).toHaveBeenCalledExactlyOnceWith(scope(), '/repo/own/a#b.ts', 4);
      await f.open('http://localhost:3000/');
      expect(f.openExternal).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['http://localhost:3000/x', 'https://127.0.0.1:3000/x', 'http://[::1]:8080/#a', 'http://0.0.0.0:3000/x', 'https://example.invalid/public'])('routes HTTP(S) to the panel and never client OS localhost: %s', async href => {
    const f = fixture(); await f.open(href);
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith(scope(), href);
    expect(f.openExternal).not.toHaveBeenCalled(); expect(f.openFile).not.toHaveBeenCalled();
  });
  it('passes mailto to the public openUrl grant only', async () => {
    const f = fixture(); await f.open('mailto:person@example.invalid?subject=Release%20Notes');
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith('mailto:person@example.invalid?subject=Release%20Notes');
    expect(f.openPanel).not.toHaveBeenCalled(); expect(f.openFile).not.toHaveBeenCalled();
  });
  it.each([
    '', ' README.md', 'README.md\n', 'javascript:alert(1)', 'data:text/plain,a', 'ftp://example.invalid/a',
    'https://person:password@example.invalid/', 'https://localhost.evil@public.invalid/', '//public.invalid/a.md',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://sub.localhost/', 'http://[::ffff:127.0.0.1]/',
    'http://localhost:0/', 'http://localhost:65536/', 'http://localhost:3000/?%74oken=synthetic',
    'https://example.invalid/?yuri_url_token=synthetic', 'https://example.invalid/#access_token=synthetic',
    'https://example.invalid/?%2574oken=synthetic', 'http://localhost/%5cpath',
    'mailto:person@example.invalid?body=a%0db', 'mailto:person@example.invalid?body=a%250db',
    'mailto://person@example.invalid', 'file://other/repo/own/a.ts', 'file:///repo/own/a.ts?token=synthetic',
    '/other/a.ts', '../parent.ts', '/repo/own/../../escape.ts', 'src/a.ts:0', 'src/a.ts:9007199254740992',
    'README.md%00', 'README%zz.md', 'plain-word',
  ])('rejects unsafe, unsupported, outside, or ambiguous values without fallback: %s', async href => {
    const f = fixture(); await expect(f.open(href)).rejects.toThrow();
    expect(f.openPanel).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled(); expect(f.openFile).not.toHaveBeenCalled();
  });
  it.each(['#heading', '#footnote-a', 'README.md#heading'])('does not pretend reported anchors navigate: %s', async href => {
    const f = fixture(); await expect(f.open(href)).rejects.toThrow('content_link_anchor_unavailable');
    expect(f.openFile).not.toHaveBeenCalled(); expect(f.openPanel).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...scope(), host: { hostID: 'other', lease: 'lease-1' } },
    { ...scope(), host: { hostID: 'synthetic', lease: 'lease-2' } },
    { ...scope(), authorityKey: 'other-origin-or-authorization' }, { ...scope(), sessionID: 'parent-session' },
    { ...scope(), directory: '/repo/parent' },
  ])('checks Host, lease, authorization, own session/directory and interactive lifetime', async selected => {
    const f = fixture(); f.select(selected);
    await expect(f.open('README.md')).rejects.toThrow('content_link_stale');
    expect(f.openFile).not.toHaveBeenCalled();
  });
  it.each(['file', 'panel', 'external'])('rechecks async completion after %s action', async kind => {
    const f = fixture(); let complete!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { complete = resolve; });
    if (kind === 'file') f.openFile.mockImplementation(() => pending);
    else if (kind === 'panel') f.openPanel.mockImplementation(() => pending);
    else f.openExternal.mockImplementation(async () => ({ opened: await pending }));
    const result = f.open(kind === 'file' ? 'README.md' : kind === 'panel' ? 'http://localhost:3000' : 'mailto:person@example.invalid');
    f.select(null); complete(true);
    await expect(result).rejects.toThrow('content_link_stale');
  });
  it('captures immutable Host and scope instead of adopting a mutated options object', async () => {
    const input = { ...scope(), host: { ...scope().host } }, f = fixture(input);
    input.host.lease = 'lease-2';
    await expect(f.open('README.md')).rejects.toThrow('content_link_stale');
    expect(f.openFile).not.toHaveBeenCalled();
  });
  it('reports real callback refusal and errors with no system-browser fallback', async () => {
    const f = fixture(); f.openFile.mockReturnValue(false); f.openPanel.mockReturnValue(false); f.openExternal.mockResolvedValue({ opened: false });
    await expect(f.open('README.md')).rejects.toThrow('content_link_file_unavailable');
    await expect(f.open('http://localhost:3000/')).rejects.toThrow('content_link_panel_unavailable');
    expect(f.openExternal).not.toHaveBeenCalled();
    await expect(f.open('mailto:person@example.invalid')).rejects.toThrow('content_link_external_failed');
    f.openFile.mockImplementation(() => { throw new Error('synthetic refusal'); });
    await expect(f.open('README.md')).rejects.toThrow('synthetic refusal');
  });
});

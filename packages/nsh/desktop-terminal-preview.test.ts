import { describe, expect, it, vi } from 'vitest';
import { createDesktopTerminalPreview } from './desktop-terminal-preview';
import type { DesktopPanelScope } from './desktop-panel-model';

function fixture() {
  let selected: DesktopPanelScope | null = { host: { hostID: 'host-a', lease: 'lease-a' }, authorityKey: 'authority-a', directory: '/work', sessionID: 'session-a' };
  let active = true;
  const openPanel = vi.fn(() => true), openExternal = vi.fn(async () => ({ opened: true }));
  const open = createDesktopTerminalPreview({ scope: () => selected, active: () => active, openPanel, openExternal });
  return { open, openPanel, openExternal, host: selected.host, selected: () => selected, select: (next: DesktopPanelScope | null) => { selected = next; }, deactivate: () => { active = false; } };
}

describe('desktop terminal preview routing', () => {
  it.each(['http://localhost:3000/a', 'http://127.0.0.1:8080/', 'http://0.0.0.0:3000/', 'http://[::1]:3000/'])('keeps %s in Host proxy tabs even for external actions', async url => {
    const f = fixture();
    await f.open(f.host, '/work', url, 'external');
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith(f.selected(), url);
    expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('routes public preview to the panel and explicit public external to the OS', async () => {
    const f = fixture();
    await f.open(f.host, '/work', 'https://example.invalid/a', 'preview');
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith(f.selected(), 'https://example.invalid/a');
    await f.open(f.host, '/work', 'https://example.invalid/b', 'external');
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.invalid/b');
  });
  it('rejects stale lease, changed Host, inactive, missing and other-directory owners without side effects', async () => {
    const f = fixture();
    for (const host of [{ hostID: 'host-a', lease: 'retired' }, { hostID: 'host-b', lease: 'lease-a' }]) await expect(f.open(host, '/work', 'https://example.invalid/', 'external')).rejects.toThrow();
    await expect(f.open(f.host, '/work/child', 'https://example.invalid/', 'external')).rejects.toThrow();
    f.deactivate();
    await expect(f.open(f.host, '/work', 'http://localhost:3000/', 'preview')).rejects.toThrow();
    f.select(null);
    await expect(f.open(f.host, '/work', 'https://example.invalid/', 'external')).rejects.toThrow();
    expect(f.openPanel).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled();
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'example.invalid', 'https://u:p@example.invalid/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://localhost.example.invalid./', 'http://[::ffff:127.0.0.1]/', 'https://example.invalid/?%74oken=x', 'https://example.invalid/?access_token=x', 'https://example.invalid/%255c'])('rejects unsafe URL %s before any native action', async url => {
    const f = fixture();
    await expect(f.open(f.host, '/work', url, 'external')).rejects.toThrow();
    expect(f.openPanel).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('accepts Windows normalized directories without changing the owning scope', async () => {
    const f = fixture(), selected = { ...f.selected()!, directory: 'C:/work' };
    f.select(selected);
    await f.open(f.host, 'C:\\work', 'http://localhost:3000/', 'preview');
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith(selected, 'http://localhost:3000/');
  });
  it('propagates panel refusal and actual external open failure', async () => {
    const f = fixture(); f.openPanel.mockReturnValue(false); f.openExternal.mockResolvedValue({ opened: false });
    await expect(f.open(f.host, '/work', 'http://localhost:3000/', 'external')).rejects.toThrow('terminal_preview_unavailable');
    await expect(f.open(f.host, '/work', 'https://example.invalid/', 'external')).rejects.toThrow('terminal_preview_external_failed');
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  });
});

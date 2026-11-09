import { describe, expect, it } from 'vitest';
import { createDesktopBrowserBinding, desktopBrowserAddress } from './desktop-browser-core';

describe('isolated native desktop browser', () => {
  it('keeps Host loopback in the proxy lane and rejects URL credentials, unsafe schemes and IP aliases', () => {
    expect(desktopBrowserAddress(' example.invalid/a ')).toEqual({ kind: 'browser', url: 'https://example.invalid/a' });
    expect(desktopBrowserAddress('http://localhost:3000/a')).toEqual({ kind: 'loopback', url: 'http://localhost:3000/a' });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.invalid', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/', 'https://a.invalid/?%74oken=x', 'https://a.invalid/%5c', 'https://a.invalid/%252e', 'http://localhost:65536/', 'https://a.invalid/?yuri_preview_token=x']) expect(() => desktopBrowserAddress(url), url).toThrow();
  });
  it('same retained tab navigates only on a changed intent and late events/close keep the captured receipt', () => {
    let current = true;
    const calls: unknown[] = [];
    const scope = { hostID: 'A', lease: 'old' };
    const binding = createDesktopBrowserBinding({ scope, owner: 'browser-a', directory: '/work', current: () => current, changed: () => {}, command: (name, body) => calls.push([name, body]) });
    binding.update(true);
    expect(binding.request({ kind: 'browser', url: 'http://localhost:3000/' })).toBe(true);
    const old = binding.binding()!;
    expect(old.intent.kind).toBe('loopback');
    expect(binding.request({ kind: 'browser', url: 'http://localhost:3000/' })).toBe(false);
    expect(binding.request({ kind: 'preview', path: '/work/index.html' })).toBe(true);
    const next = binding.binding()!;
    expect(next.generation).toBe(2);
    expect(binding.event({ ...old, phase: 'ready', url: 'https://old.invalid/', canBack: false, canForward: false, error: null })).toBe(false);
    expect(binding.event({ ...next, expectedHost: { hostID: 'A', lease: 'new' }, phase: 'ready', url: '/work/index.html', canBack: false, canForward: false, error: null })).toBe(false);
    expect(binding.event({ ...next, phase: 'ready', url: '/work/index.html', canBack: false, canForward: false, error: null })).toBe(true);
    expect(binding.command('external')).toBe(false);
    expect(binding.event({ ...next, phase: 'ready', url: 'https://linked.invalid/', canBack: true, canForward: false, error: null })).toBe(true);
    // Native in-page navigation changed the current URL: requesting the original
    // intent again must navigate, not compare only with its old target prop.
    expect(binding.request({ kind: 'preview', path: '/work/index.html' })).toBe(true);
    current = false; scope.lease = 'new'; binding.dispose(); binding.dispose();
    expect(calls).toEqual([['close', { owner: 'browser-a', expectedHost: { hostID: 'A', lease: 'old' }, generation: 3 }]]);
    expect(binding.event({ ...next, phase: 'ready', url: '/work/index.html', canBack: false, canForward: false, error: null })).toBe(false);
  });
  it('inactive/current fences deny commands and paths outside captured directory', () => {
    const calls: unknown[] = [];
    const binding = createDesktopBrowserBinding({ scope: { hostID: 'A', lease: 'a' }, owner: 'browser-a', directory: '/work', current: () => true, changed: () => {}, command: (...args) => calls.push(args) });
    expect(binding.request({ kind: 'browser', url: 'https://example.invalid/' })).toBe(false);
    binding.update(true);
    expect(() => binding.request({ kind: 'preview', path: '/outside/index.html' })).toThrow();
    expect(() => binding.request({ kind: 'preview', path: '/work/report.eficy' })).toThrow();
    binding.request({ kind: 'browser', url: 'https://example.invalid/' });
    binding.update(false); expect(binding.command('reload')).toBe(false);
    expect(binding.binding()?.active).toBe(false); expect(calls).toEqual([]);
  });
});

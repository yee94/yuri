import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

describe('desktop startup splash', () => {
  it.each(['remote', 'local'])('shows the remote connection state before rendering only for a %s boot target', (target) => {
    const source = readFileSync(new URL('./runtimeConfig.ts', import.meta.url), 'utf8');
    const status = { textContent: '', hidden: true };
    runInNewContext(source.slice(source.indexOf('  const connectionStatus ='), source.indexOf('  // Transport probes')), {
      document: { getElementById: () => status },
      getInjectedBootOutcome: () => ({ target }),
      getBootstrapMessages: () => ({ connectingRemote: '正在连接远程实例…' }),
      readStoredLocaleForBootstrap: () => 'zh-CN',
    });
    expect(status.hidden).toBe(target !== 'remote');
    expect(status.textContent).toBe(target === 'remote' ? '正在连接远程实例…' : '');
  });
  it('waits for SSH recovery instead of rendering the local runtime after ten seconds', async () => {
    vi.useFakeTimers();
    try {
      const source = readFileSync(new URL('./runtimeConfig.ts', import.meta.url), 'utf8');
      let finish!: () => void;
      const recovery = new Promise<void>((resolve) => { finish = resolve; });
      const context = { desktopRelayRestoreReady: Promise.resolve(), relayHostId: 'remote', restoreDesktopRelayRuntime: () => recovery, window: { setTimeout } };
      runInNewContext(source.slice(source.indexOf('  desktopRelayRestoreReady ='), source.indexOf('  return createWebAPIs')), context);
      let ready = false;
      void context.desktopRelayRestoreReady.then(() => { ready = true; });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(ready).toBe(false);
      finish();
      await context.desktopRelayRestoreReady;
      expect(ready).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('does not time out to a blank page when application imports have not committed', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const fallback = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('Fallback: hide loading screen'))![1];
    for (const children of [0, 1]) {
      let removed = false;
      const splash = { classList: { add() {} }, remove() { removed = true; } };
      runInNewContext(fallback, { window: {}, document: { getElementById: (id: string) => id === 'root' ? { childElementCount: children } : splash }, setTimeout: (run: () => void) => run() });
      expect(removed).toBe(children > 0);
    }
  });
  it('lives outside the React root so startup progress survives the first commit', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const splashIndex = html.indexOf('<div id="initial-loading">');
    const rootIndex = html.indexOf('<div id="root" class="h-full"></div>');

    expect(splashIndex).toBeGreaterThan(-1);
    expect(rootIndex).toBeGreaterThan(splashIndex);
  });
});

describe('mobile startup splash', () => {
  it('ships a logo inside the root before any application module executes', () => {
    const html = readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');
    const root = html.slice(html.indexOf('<div id="root"'));
    expect(root).toContain('id="mobile-startup-logo"');
    const image = root.match(/<img src="([^"]+)" width="120" height="120"/);
    expect(image).not.toBeNull();
    expect(readFileSync(new URL(image![1], new URL('../mobile.html', import.meta.url)), 'utf8')).toContain('<svg');
  });
  it('keeps mini-chat branded while modules are unavailable without a timer that clears its root', () => {
    const html = readFileSync(new URL('../mini-chat.html', import.meta.url), 'utf8');
    expect(html).toContain('<div id="initial-loading"><img');
    expect(html).not.toContain('loading.remove()');
  });
});

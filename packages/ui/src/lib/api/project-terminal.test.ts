import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

const transport = vi.hoisted(() => ({ sockets: [] as Array<{ url: string; close: ReturnType<typeof vi.fn> }> }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: (path: string) => `ws://hub.invalid${path}` }) }));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: async () => 'hub-url-token', getRuntimeAuthGeneration: () => 0, subscribeRuntimeAuthGeneration: () => () => {} }));
vi.mock('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: (url: string) => {
  const socket = { url, close: vi.fn(), readyState: 0, send: vi.fn() };
  transport.sockets.push(socket);
  return socket;
} }));

import { createProjectTerminalAPI } from '@/lib/terminalApi';

describe('project terminal owner', () => {
  beforeEach(() => { transport.sockets.length = 0; });
  it('keeps same-id sessions on different hosts in independent transports', async () => {
    const fetch = vi.fn(async (_path: string) => new Response(JSON.stringify({ sessionId: 'same-id', cols: 80, rows: 24 })));
    const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true,
      fetch, sdk: () => ({}) as OpenCodeClient, service: () => { throw new Error('Unexpected service access'); } });
    const a = createProjectTerminalAPI(registry.resolve({ hubId: 'hub', hostId: 'a', directory: '/same' }));
    const b = createProjectTerminalAPI(registry.resolve({ hubId: 'hub', hostId: 'b', directory: '/same' }));
    expect(transport.sockets).toHaveLength(0);
    try {
      await a.createTerminalSession({ cwd: '/same' });
      await b.createTerminalSession({ cwd: '/same' });
      const stopA = a.connectTerminalStream('same-id', () => {});
      const stopB = b.connectTerminalStream('same-id', () => {});
      await Promise.resolve(); await Promise.resolve();
      expect(transport.sockets.map((socket) => socket.url)).toEqual([
        'ws://hub.invalid/api/hosts/a/api/terminal/ws', 'ws://hub.invalid/api/hosts/b/api/terminal/ws',
      ]);
      await a.resizeTerminal('same-id', 100, 40);
      expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/hosts/a/api/terminal/same-id/resize');
      a.dispose();
      await expect(a.resizeTerminal('same-id', 80, 24)).rejects.toThrow('disposed');
      await b.resizeTerminal('same-id', 80, 24);
      expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/hosts/b/api/terminal/same-id/resize');
      stopA(); stopB();
    } finally { a.dispose(); b.dispose(); registry.dispose(); }
  });

  it('releases a late create through its captured Host after the mobile owner leaves', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((path: string, options?: RequestInit) => options?.method === 'DELETE'
      ? Promise.resolve(new Response(null, { status: 204 }))
      : new Promise<Response>((resolve) => { finish = resolve; }));
    const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true,
      fetch, sdk: () => ({}) as OpenCodeClient, service: () => { throw new Error('Unexpected service'); } });
    const a = createProjectTerminalAPI(registry.resolve({ hubId: 'hub', hostId: 'a', directory: '/same' }));
    const creating = a.createTerminalSession({ cwd: '/same' });
    const rejected = expect(creating).rejects.toThrow('disposed');
    a.dispose();
    registry.resolve({ hubId: 'hub', hostId: 'b', directory: '/same' });
    finish(Response.json({ sessionId: 'late-pty', cols: 80, rows: 24 }));
    await rejected;
    expect(fetch.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      ['/api/hosts/a/api/terminal/create', 'POST'], ['/api/hosts/a/api/terminal/late-pty', 'DELETE'],
    ]);
    expect(transport.sockets).toHaveLength(0);
    registry.dispose();
  });
});

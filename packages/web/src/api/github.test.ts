import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeUrlResolver } from '@yuriai/ui/lib/runtime-url';
const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@yuriai/ui/lib/runtime-fetch', () => ({ runtimeFetch: fixture.fetch }));
import { createWebGitHubAPI } from './github';

const unused = (): never => { throw new Error('Auth requests must not resolve external URLs'); };
const urls: RuntimeUrlResolver = { api: unused, auth: unused, authenticatedAsset: unused, rawFile: unused, sse: unused, websocket: unused, health: unused };
beforeEach(() => fixture.fetch.mockReset());

it('keeps the existing Web disconnect body-less and does not opt legacy clients into exact deletion', async () => {
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, removed: true })));
  expect(await createWebGitHubAPI({ urls }).authDisconnect()).toEqual({ removed: true });
  expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith('/api/github/auth', { method: 'DELETE', headers: { Accept: 'application/json' } });
});

it('keeps the Web device handshake request shapes and accepts the additive cancellable response', async () => {
  const start = { deviceCode: 'synthetic-device', userCode: 'FAKE', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 600, cancellable: true };
  fixture.fetch.mockResolvedValueOnce(new Response(JSON.stringify(start))).mockResolvedValueOnce(new Response(JSON.stringify({ connected: false, status: 'authorization_pending' })));
  const api = createWebGitHubAPI({ urls }); expect(await api.authStart()).toEqual(start); await api.authComplete('synthetic-device');
  expect(fixture.fetch.mock.calls[0]).toEqual(['/api/github/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' }]);
  expect(fixture.fetch.mock.calls[1][1].body).toBe('{"deviceCode":"synthetic-device"}');
});

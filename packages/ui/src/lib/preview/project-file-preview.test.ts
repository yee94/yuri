import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

const state = vi.hoisted(() => ({ generation: 0, relay: false, fetch: vi.fn(), gateway: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => state.generation, getRuntimeTransportIdentity: () => 'fixture-transport' }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('@/lib/runtime-auth', () => ({ getRuntimeAuthGeneration: () => 0, refreshRuntimeUrlAuthToken: async () => `yuri_url_${'u'.repeat(32)}` }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ authenticatedAsset: (route: string) => `https://hub.invalid${route}?yuri_url_token=yuri_url_${'u'.repeat(32)}` }) }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => state.relay }));
vi.mock('./relay-preview-gateway-client', () => ({ ensurePreviewGatewayOrigin: () => state.gateway() }));

import { resolveProjectFilePreview } from './project-file-preview';

const target = () => ({ id: 'a'.repeat(32), kind: 'file', proxyBasePath: `/api/preview/proxy/${'a'.repeat(32)}`,
  entryPath: '/docs/index.html', previewToken: 'b'.repeat(32), expiresAt: Date.now() + 30_000 });

beforeEach(() => {
  state.generation = 0; state.relay = false; state.gateway.mockReset(); state.fetch.mockReset();
  state.fetch.mockImplementation(async (_route: string, init?: RequestInit) => init?.method === 'DELETE'
    ? new Response(null, { status: 204 }) : new Response(JSON.stringify(target())));
});

describe('scoped file preview lifecycle', () => {
  it('retains an explicit Host and directory without changing the runtime; cancellation revokes once', async () => {
    const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'fixture-transport', isCurrent: () => true,
      fetch: state.fetch, sdk: () => ({}) as OpenCodeClient, service: () => { throw new Error('unexpected'); } });
    const entry = registry.resolve({ hubId: 'hub', hostId: 'remote', directory: '/project' });
    const controller = new AbortController();
    const preview = await resolveProjectFilePreview(entry, '/project/docs/index.html', '/project', controller.signal);
    expect(preview.src).toBe(`https://hub.invalid/api/hosts/remote/api/preview/proxy/${'a'.repeat(32)}/_file/${'b'.repeat(32)}/yuri_url_${'u'.repeat(32)}/docs/index.html`);
    expect(preview.src).not.toContain('?');
    expect(state.fetch.mock.calls[0][0]).toBe('/api/hosts/remote/api/preview/targets');
    expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual({ kind: 'file', directory: '/project', path: '/project/docs/index.html' });
    controller.abort(); await preview.release(); await preview.release();
    expect(state.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
    registry.dispose();
  });
  it('maps only the scoped browser URL to native Host HTTP origin', async () => {
    const preview = await resolveProjectFilePreview(undefined, '/project/docs/index.html', '/project', new AbortController().signal, 'http://127.0.0.1:48731');
    expect(preview.src).toContain('http://127.0.0.1:48731/api/preview/proxy/');
    expect(state.gateway).not.toHaveBeenCalled();
    await preview.release();
  });
  it('uses the existing Electron Relay gateway and never falls back to srcDoc', async () => {
    state.relay = true; state.gateway.mockResolvedValue('http://127.0.0.1:48732');
    const preview = await resolveProjectFilePreview(undefined, '/project/docs/index.html', '/project', new AbortController().signal);
    expect(preview.src).toContain('http://127.0.0.1:48732/api/preview/proxy/');
    await preview.release();
    state.gateway.mockResolvedValue(null);
    await expect(resolveProjectFilePreview(undefined, '/project/docs/index.html', '/project', new AbortController().signal)).rejects.toThrow('preview_gateway_unavailable');
    expect(state.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(2);
  });
  it('does not send stale cleanup or install a document through a new runtime', async () => {
    state.gateway.mockImplementation(async () => { state.generation++; return 'http://127.0.0.1:48732'; }); state.relay = true;
    await expect(resolveProjectFilePreview(undefined, '/project/docs/index.html', '/project', new AbortController().signal)).rejects.toThrow('Project scope superseded');
    expect(state.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(0);
  });
  it('revokes a response admitted just as its caller aborts, before minting browser credentials', async () => {
    const controller = new AbortController();
    state.fetch.mockImplementationOnce(async () => { controller.abort(); return new Response(JSON.stringify(target())); });
    await expect(resolveProjectFilePreview(undefined, '/project/docs/index.html', '/project', controller.signal)).rejects.toThrow();
    expect(state.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
  });
  it('refuses malformed/other-Host roots and encoded separators before minting a browser URL', async () => {
    for (const fields of [{ entryPath: '/docs/%2fsecret' }, { entryPath: '/%2e%2e/secret' }, { proxyBasePath: '/api/hosts/wrong/api/preview/proxy/' + 'a'.repeat(32) }]) {
      state.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...target(), ...fields })));
      await expect(resolveProjectFilePreview(undefined, '/project/docs/index.html', '/project', new AbortController().signal)).rejects.toThrow('invalid_preview');
    }
  });
});

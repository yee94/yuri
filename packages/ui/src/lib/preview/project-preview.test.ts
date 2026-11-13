import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ authenticatedAsset: (path: string) => `https://hub.invalid${path}` }) }));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: async () => 'hub-token', getRuntimeAuthGeneration: () => 0 }));
import { resolveProjectPreviewUrl } from './project-preview';

describe('project localhost preview', () => {
  it('accepts the Gateway scoped base once and refuses a different Host base', async () => {
    let hostId = 'other-machine';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ proxyBasePath: `/api/hosts/${hostId}/api/preview/proxy/abcdef0123456789`, previewToken: 'preview-token', expiresAt: Date.now() + 60_000 })));
    const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => ({}) as OpenCodeClient, service: () => { throw new Error('Unexpected service access'); } });
    const entry = registry.resolve({ hubId: 'hub', hostId, directory: '/raw' });
    const signal = new AbortController().signal;
    const preview = await resolveProjectPreviewUrl(entry, 'http://localhost:3000/page', signal);
    expect(preview.src).toContain('/api/hosts/other-machine/api/preview/proxy/abcdef0123456789/page');
    expect(preview.src.match(/\/api\/hosts\//g)).toHaveLength(1);
    hostId = 'wrong-host';
    await expect(resolveProjectPreviewUrl(entry, 'http://localhost:3000/page', signal)).rejects.toThrow('invalid_preview');
    registry.dispose();
  });
  it('registers on the project host and keeps that host prefix in the browser URL', async () => {
    const fetch = vi.fn(async (_path: string) => new Response(JSON.stringify({ proxyBasePath: '/api/preview/proxy/abcdef0123456789', previewToken: 'preview-token', expiresAt: Date.now() + 60_000 })));
    const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => ({}) as OpenCodeClient, service: () => { throw new Error('Unexpected service access'); } });
    const entry = registry.resolve({ hubId: 'hub', hostId: 'other-machine', directory: '/raw' });
    const signal = new AbortController().signal;
    const preview = await resolveProjectPreviewUrl(entry, 'http://localhost:3000/page?q=ok&oc_client_token=bad#section', signal);
    expect(fetch.mock.calls[0][0]).toBe('/api/hosts/other-machine/api/preview/targets');
    expect(preview.src).toContain('https://hub.invalid/api/hosts/other-machine/api/preview/proxy/abcdef0123456789/page?');
    expect(preview.src).toContain('yuri_preview_token=preview-token');
    expect(preview.src).not.toContain('oc_client_token');
    expect(await resolveProjectPreviewUrl(entry, 'https://external.invalid/page', signal)).toEqual({ src: 'https://external.invalid/page' });
    expect(fetch).toHaveBeenCalledTimes(1);
    registry.dispose();
  });
});

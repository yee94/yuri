import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { hostApiPath } from '@/lib/remote-projects/location';
import { captureProjectScope } from '@/lib/api/project-scope';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { isLoopbackHttpUrl } from '@/lib/url';
import { isNormalizedPreviewProxyPath } from './relay-preview-frame-src';

export async function probeProjectPreviewUrl(entry: HostRuntimeEntry, url: string): Promise<boolean> {
  if (!isLoopbackHttpUrl(url)) return false;
  try {
    const result = await captureProjectScope(entry).json<{ ok: boolean }>('/api/system/probe-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(1500),
    });
    return result.ok === true;
  } catch { return false; }
}

/** localhost is the selected project Host. The browser only sees a Hub proxy URL. */
export async function resolveProjectPreviewUrl(entry: HostRuntimeEntry, rawUrl: string, signal: AbortSignal) {
  const scope = captureProjectScope(entry);
  scope.assertCurrent(signal);
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url');
  if (!isLoopbackHttpUrl(rawUrl)) return { src: url.href };
  const target = await scope.json<{ proxyBasePath?: unknown; previewToken?: unknown; expiresAt?: unknown }>('/api/preview/targets', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-opencode-directory': entry.location.directory },
    body: JSON.stringify({ url: url.href }), signal,
  });
  const prefix = hostApiPath(entry.location.hostId, '/api/preview/proxy/');
  const proxyBasePath = typeof target.proxyBasePath === 'string' && target.proxyBasePath.startsWith('/api/preview/proxy/')
    ? hostApiPath(entry.location.hostId, target.proxyBasePath) : target.proxyBasePath;
  if (typeof proxyBasePath !== 'string' || !proxyBasePath.startsWith(prefix)
    || !/^[a-f0-9]{16,64}$/i.test(proxyBasePath.slice(prefix.length))
    || !isNormalizedPreviewProxyPath(`${proxyBasePath}${url.pathname}`)
    || typeof target.previewToken !== 'string' || !target.previewToken
    || typeof target.expiresAt !== 'number' || !Number.isFinite(target.expiresAt) || target.expiresAt <= Date.now()) throw new Error('invalid_preview');
  await refreshRuntimeUrlAuthToken();
  scope.assertCurrent(signal);
  const query = new URLSearchParams(url.search);
  query.delete('yuri_client_token'); query.delete('oc_client_token'); query.delete('yuri_url_token');
  query.set('yuri_preview_token', target.previewToken);
  return {
    src: getRuntimeUrlResolver().authenticatedAsset(`${proxyBasePath}${url.pathname}?${query}${url.hash}`),
    expiresAt: target.expiresAt,
  };
}

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { isLoopbackHttpUrl } from '@/lib/url';
import { isNormalizedPreviewProxyPath } from './relay-preview-frame-src';
import { getRuntimeGeneration } from '@/lib/runtime-switch';

/** Keep Host-local URLs behind its existing preview proxy, including IP literals. */
export async function resolveMobileHtmlUrl(rawUrl: string, hostOrigin: string | undefined, signal: AbortSignal): Promise<{ src: string; expiresAt?: number }> {
  const generation = getRuntimeGeneration();
  const assertCurrent = () => {
    if (signal.aborted || generation !== getRuntimeGeneration()) throw new DOMException('Preview ended', 'AbortError');
  };
  assertCurrent();
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url');
  if (!isLoopbackHttpUrl(rawUrl)) return { src: url.href };
  if (!hostOrigin) throw new Error('unsupported_host');
  const response = await runtimeFetch('/api/preview/targets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.href }), signal,
  });
  if (!response.ok) throw new Error('preview_unavailable');
  const target = await response.json() as { proxyBasePath?: unknown; previewToken?: unknown; expiresAt?: unknown };
  assertCurrent();
  if (typeof target.proxyBasePath !== 'string' || !/^\/api\/preview\/proxy\/[a-f0-9]{16,64}$/i.test(target.proxyBasePath)
    || !isNormalizedPreviewProxyPath(`${target.proxyBasePath}${url.pathname}`)
    || typeof target.previewToken !== 'string' || !target.previewToken
    || typeof target.expiresAt !== 'number' || !Number.isFinite(target.expiresAt) || target.expiresAt <= Date.now()) throw new Error('invalid_preview');
  await refreshRuntimeUrlAuthToken();
  assertCurrent();
  const query = new URLSearchParams(url.search);
  query.delete('yuri_client_token'); query.delete('yuri_url_token');
  query.set('yuri_preview_token', target.previewToken);
  const route = `${target.proxyBasePath}${url.pathname}?${query}${url.hash}`;
  const authenticated = new URL(getRuntimeUrlResolver().authenticatedAsset(route), 'http://runtime.invalid');
  return { src: `${hostOrigin}${authenticated.pathname}${authenticated.search}${authenticated.hash}`, expiresAt: target.expiresAt };
}

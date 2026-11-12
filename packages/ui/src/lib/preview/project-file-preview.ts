import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { hostApiPath } from '@/lib/remote-projects/location';
import { captureProjectScope } from '@/lib/api/project-scope';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { ensurePreviewGatewayOrigin } from './relay-preview-gateway-client';
import { resolveRelayPreviewFrameSrc } from './relay-preview-frame-src';

type FileTarget = { id?: unknown; kind?: unknown; proxyBasePath?: unknown; entryPath?: unknown; previewToken?: unknown; expiresAt?: unknown };

const validEntryPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\?#]/.test(value)
    || Array.from(value).some((character) => character.charCodeAt(0) <= 32)) return false;
  try {
    return value.slice(1).split('/').every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded !== '' && decoded !== '.' && decoded !== '..' && !/[\\/]/.test(decoded)
        && !Array.from(decoded).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    });
  } catch { return false; }
};

/** Browser-native relative resolution retains Host, project root and both scoped grants. */
export async function resolveProjectFilePreview(
  entry: HostRuntimeEntry | undefined,
  filePath: string,
  directory: string,
  signal: AbortSignal,
  hostOrigin?: string,
): Promise<{ src: string; expiresAt: number; release: () => Promise<void> }> {
  const scope = captureProjectScope(entry);
  scope.assertCurrent(signal);
  if (entry && entry.location.directory !== directory) throw new Error('invalid_preview_directory');
  // Read a completed registration before the caller-signal fence so its grant
  // can still be revoked if cancellation races the delivered response.
  const response = await (entry ? entry.fetch : runtimeFetch)('/api/preview/targets', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory },
    body: JSON.stringify({ kind: 'file', directory, path: filePath }), signal,
  });
  if (!response.ok) {
    scope.assertCurrent(signal);
    throw new Error('preview_unavailable');
  }
  const target = await response.json() as FileTarget;
  const prefix = hostApiPath(entry?.location.hostId, '/api/preview/proxy/');
  const base = typeof target.proxyBasePath === 'string' && target.proxyBasePath.startsWith('/api/preview/proxy/')
    ? hostApiPath(entry?.location.hostId, target.proxyBasePath) : target.proxyBasePath;
  if (target.kind !== 'file' || typeof target.id !== 'string' || !/^[a-f0-9]{32}$/i.test(target.id)
    || base !== `${prefix}${target.id}` || !validEntryPath(target.entryPath)
    || typeof target.previewToken !== 'string' || !/^[a-f0-9]{32}$/i.test(target.previewToken)
    || typeof target.expiresAt !== 'number' || !Number.isFinite(target.expiresAt) || target.expiresAt <= Date.now()) throw new Error('invalid_preview');
  const { id, previewToken, entryPath, expiresAt } = target;
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (releasing) return releasing;
    releasing = (async () => {
      // Never send old target cleanup through a newly-selected Hub/credential.
      scope.assertCurrent();
      const response = await scope.fetch(`/api/preview/targets/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory },
        body: JSON.stringify({ previewToken }),
      });
      if (!response.ok) throw new Error('preview_release_failed');
      released = true;
      signal.removeEventListener('abort', abort);
    })().finally(() => { releasing = undefined; });
    return releasing;
  };
  const abort = () => { void release().catch(() => { /* Expiry remains authoritative if the original transport has ended. */ }); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    scope.assertCurrent(signal);
    await refreshRuntimeUrlAuthToken();
    scope.assertCurrent(signal);
    // The resolver is the sole mint/attach authority; relocate only its short token.
    const authenticated = new URL(getRuntimeUrlResolver().authenticatedAsset(`${base}/`), 'http://runtime.invalid');
    const urlToken = authenticated.searchParams.get('yuri_url_token') || '-';
    if (urlToken !== '-' && !/^yuri_url_[A-Za-z0-9_-]{32}$/.test(urlToken)) throw new Error('invalid_preview');
    authenticated.search = '';
    authenticated.pathname = `${base}/_file/${previewToken}/${urlToken}${entryPath}`;
    let src = authenticated.origin === 'http://runtime.invalid'
      ? `${authenticated.pathname}${authenticated.search}` : authenticated.href;
    if (hostOrigin) {
      const origin = new URL(hostOrigin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
        || origin.origin !== hostOrigin) throw new Error('unsupported_host');
      src = `${origin.origin}${authenticated.pathname}`;
    } else if (isRelayModeActive()) {
      const gatewayOrigin = await ensurePreviewGatewayOrigin();
      scope.assertCurrent(signal);
      if (!gatewayOrigin) throw new Error('preview_gateway_unavailable');
      src = resolveRelayPreviewFrameSrc({ relayActive: true, gatewayOrigin, authenticatedAssetUrl: src });
    }
    scope.assertCurrent(signal);
    return { src, expiresAt, release };
  } catch (error) {
    await release().catch(() => { /* A changed transport cannot revoke the original Host's grant; it expires. */ });
    throw error;
  }
}

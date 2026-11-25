/**
 * Resolve the iframe `src` for Host loopback preview.
 *
 * Direct / LAN: keep the authenticated asset URL (same-origin or runtime API
 * origin). Relay + Electron loopback gateway: rewrite onto
 * `http://127.0.0.1:<port>` so Chromium can load HTML/static assets while the
 * owner renderer still `runtimeFetch`es the same path through the tunnel.
 */

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const PREVIEW_PROXY_PATH_PREFIX = '/api/preview/proxy/';
const HOST_PREVIEW_PROXY_PATH = /^\/api\/hosts\/([^/]+)\/api\/preview\/proxy\//;

const isPreviewProxyPath = (pathname: string): boolean => {
  if (pathname.startsWith(PREVIEW_PROXY_PATH_PREFIX)) return true;
  const match = HOST_PREVIEW_PROXY_PATH.exec(pathname);
  if (!match) return false;
  try {
    const hostId = decodeURIComponent(match[1]);
    return Boolean(hostId) && !/[\\/?#]/.test(hostId) && !Array.from(hostId).some((character) => character.charCodeAt(0) < 32)
      && hostId !== '.' && hostId !== '..';
  } catch { return false; }
};

/**
 * WHATWG-normalize a request path and require it stay under the preview proxy
 * prefix. Rejects `/api/preview/proxy/../session` and `%2e%2e` after decode.
 */
export const isNormalizedPreviewProxyPath = (pathWithOptionalQuery: string): boolean => {
  if (typeof pathWithOptionalQuery !== 'string' || !pathWithOptionalQuery) return false;
  const pathOnly = pathWithOptionalQuery.split('?', 1)[0] || '';
  if (pathOnly.includes('\\') || pathOnly.includes('\0')) return false;
  try {
    const parsed = new URL(pathOnly, 'http://127.0.0.1');
    if (parsed.hostname !== '127.0.0.1') return false;
    return isPreviewProxyPath(parsed.pathname);
  } catch {
    return false;
  }
};

export type ResolveRelayPreviewFrameSrcInput = {
  relayActive: boolean;
  /** Loopback gateway origin from desktop `previewGateway.ensure()`, e.g. http://127.0.0.1:54321 */
  gatewayOrigin: string | null | undefined;
  /** Result of `authenticatedAsset('/api/preview/proxy/...')` (relative or absolute). */
  authenticatedAssetUrl: string;
};

/**
 * When relay is active and a gateway origin is ready, map the authenticated
 * preview proxy URL onto the gateway origin (path + query tokens + hash).
 * Otherwise return `authenticatedAssetUrl` unchanged.
 */
export const resolveRelayPreviewFrameSrc = (
  input: ResolveRelayPreviewFrameSrcInput,
): string => {
  const authenticatedAssetUrl = typeof input.authenticatedAssetUrl === 'string'
    ? input.authenticatedAssetUrl
    : '';
  if (!authenticatedAssetUrl) return '';

  if (!input.relayActive) {
    return authenticatedAssetUrl;
  }

  const gatewayOrigin = typeof input.gatewayOrigin === 'string'
    ? input.gatewayOrigin.trim()
    : '';
  if (!gatewayOrigin) {
    return authenticatedAssetUrl;
  }

  try {
    const gateway = new URL(gatewayOrigin);
    if (gateway.protocol !== 'http:' && gateway.protocol !== 'https:') {
      return authenticatedAssetUrl;
    }
    // Gateway must stay on loopback — never rewrite onto a non-local origin.
    if (gateway.hostname !== '127.0.0.1' && gateway.hostname !== 'localhost') {
      return authenticatedAssetUrl;
    }

    const asset = ABSOLUTE_URL_PATTERN.test(authenticatedAssetUrl)
      ? new URL(authenticatedAssetUrl)
      : new URL(authenticatedAssetUrl, 'http://yuri.local');

    if (!isNormalizedPreviewProxyPath(asset.pathname)) {
      return authenticatedAssetUrl;
    }

    return `${gateway.origin}${asset.pathname}${asset.search}${asset.hash}`;
  } catch {
    return authenticatedAssetUrl;
  }
};

const URL_AUTH_TOKEN_PATTERN = /^yuri_url_[A-Za-z0-9_-]{32}$/;

/**
 * Push a freshly minted short-lived URL auth token to an already-mounted
 * preview iframe bridge so subsequent lazy/dynamic requests stay authorized
 * without reloading the document or resetting scroll position.
 */
export const postPreviewUrlAuthToken = (
  frame: HTMLIFrameElement | null,
  frameSrc: string,
  token: string,
): boolean => {
  if (typeof window === 'undefined' || !frame?.contentWindow || !frameSrc || !URL_AUTH_TOKEN_PATTERN.test(token)) {
    return false;
  }
  try {
    const targetOrigin = new URL(frameSrc, window.location.href).origin;
    if (!targetOrigin || targetOrigin === 'null') return false;
    frame.contentWindow.postMessage(
      { source: 'yuri-preview-parent', version: 1, type: 'update-url-auth-token', token },
      targetOrigin,
    );
    return true;
  } catch {
    return false;
  }
};

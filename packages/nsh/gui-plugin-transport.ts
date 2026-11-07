import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

export type GuiPluginWireRequest = Readonly<{
  method: string;
  route: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}>;
export type GuiPluginWireResponse = Readonly<{ status: number; mime: string; base64: string; headers?: Readonly<Record<string, string>>; stream?: ReadableStream<Uint8Array> }>;
export type GuiPluginCapturedSender = {
  /** Construct once from native admission; implementation bounds bytes while
   * receiving, rejects redirects, and uses the original authorized Relay lane. */
  send(expectedHost: RuntimeScope, request: GuiPluginWireRequest, signal: AbortSignal): Promise<GuiPluginWireResponse>;
  isCurrent(expectedHost: RuntimeScope): boolean;
};

const allowedHeaders = new Set(['accept', 'content-type', 'x-opencode-directory', 'x-opencode-workspace', 'x-yuri-gui-revision']);
const forbiddenQuery = /^(authorization|token|access_token|api_key|apikey|oc_client_token|yuri_client_token|yuri_url_token|yuri_preview_token)$/i;
export const GUI_PLUGIN_REPLY_LIMIT = 32 * 1024 * 1024;

/** Only protocol metadata is exposed; cookies/auth/unknown headers are errors. */
export function guiPluginResponseHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GUI_PLUGIN_INVALID_RESPONSE_HEADERS');
  const headers: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (!['x-yuri-file-exists', 'x-yuri-gui-revision', 'x-yuri-gui-code'].includes(name) || name in headers || typeof text !== 'string'
      || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)
      || (name === 'x-yuri-file-exists' && text !== 'true' && text !== 'false')
      || (name === 'x-yuri-gui-revision' && !/^[a-f0-9]{64}$/.test(text))
      || (name === 'x-yuri-gui-code' && !['cached', 'full'].includes(text))) throw new Error('GUI_PLUGIN_INVALID_RESPONSE_HEADERS');
    headers[name] = text;
  }
  return Object.freeze(headers);
}

/** Exact existing official GUI GET/RPC wire, not a general Host request proxy. */
export function validateGuiPluginWireRequest(input: GuiPluginWireRequest): GuiPluginWireRequest {
  const url = new URL(input.route, 'https://scope.invalid');
  if (!input.route.startsWith('/api/') || input.route.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(input.route)
    || url.origin !== 'https://scope.invalid' || url.hash || url.pathname !== input.route.split('?', 1)[0]
    || [...url.searchParams].some(([name, value]) => forbiddenQuery.test(name) || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('GUI_PLUGIN_INVALID_REQUEST');
  const read = input.method === 'GET' && ['/api/plugin', '/api/plugin/gui', '/api/fs/stat', '/api/fs/read', '/api/fs/list', '/api/fs/find'].includes(url.pathname);
  const rpc = input.method === 'POST' && /^\/api\/rpc\/[^/]+\/[^/]+$/.test(url.pathname);
  if (!read && !rpc) throw new Error('GUI_PLUGIN_UNSUPPORTED');
  const decoded = decodeURIComponent(url.pathname);
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) throw new Error('GUI_PLUGIN_INVALID_REQUEST');
  if ((read && input.body !== undefined) || (input.body !== undefined && new TextEncoder().encode(input.body).length > GUI_PLUGIN_REPLY_LIMIT)) throw new Error('GUI_PLUGIN_INVALID_REQUEST');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    const name = key.toLowerCase();
    if (!allowedHeaders.has(name) || /[\r\n\u0000]/.test(value) || name in headers) throw new Error('GUI_PLUGIN_INVALID_HEADERS');
    headers[name] = value;
  }
  return Object.freeze({ method: input.method, route: input.route, headers: Object.freeze(headers), ...(input.body === undefined ? {} : { body: input.body }) });
}

/** Use as the actual official SDK's fetch option. No SDK method is reconstructed;
 * headers, query, UTF-8 JSON body, status and error bytes retain their wire form. */
export function createGuiPluginFetch(input: {
  scope: RuntimeScope;
  origin: string;
  sender: GuiPluginCapturedSender;
  signal: AbortSignal;
}): typeof fetch {
  const scope = runtimeScopeFrom(input.scope);
  if (!scope) throw new Error('scope_required');
  const parsed = new URL(input.origin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname) || !parsed.hostname) throw new Error('GUI_PLUGIN_INVALID_ORIGIN');
  const base = parsed.protocol + '//' + parsed.host;
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted(); input.signal.throwIfAborted();
    if (!input.sender.isCurrent(scope)) throw new Error('runtime_host_scope_stale');
  };
  check(input.signal);
  return async (requestInput, init) => {
    const request = new Request(requestInput, init);
    const signal = AbortSignal.any([input.signal, request.signal]);
    check(signal);
    const target = new URL(request.url);
    if (target.protocol + '//' + target.host !== base || target.username || target.password || target.hash) throw new Error('GUI_PLUGIN_INVALID_ORIGIN');
    const method = request.method;
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();
    check(signal);
    const wire = validateGuiPluginWireRequest({ method, route: target.pathname + target.search, headers: Object.fromEntries(request.headers), ...(body === undefined ? {} : { body }) });
    const result = await input.sender.send(scope, wire, signal);
    check(signal);
    let headers: Readonly<Record<string, string>>;
    try { headers = guiPluginResponseHeaders(result.headers); }
    catch (error) { await result.stream?.cancel(); throw error; }
    if (result.stream) {
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || (result.status >= 300 && result.status < 400) || /[\r\n\u0000]/.test(result.mime)) throw new Error('GUI_PLUGIN_INVALID_RESPONSE');
      if ([204, 205].includes(result.status)) { await result.stream.cancel(); check(signal); return new Response(null, { status: result.status, headers }); }
      return new Response(result.stream, { status: result.status, headers: { ...headers, 'Content-Type': result.mime, 'Cache-Control': 'no-store' } });
    }
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || (result.status >= 300 && result.status < 400)
      || typeof result.mime !== 'string' || /[\r\n\u0000]/.test(result.mime) || typeof result.base64 !== 'string'
      || result.base64.length > Math.ceil(GUI_PLUGIN_REPLY_LIMIT / 3) * 4 || result.base64.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(result.base64)) throw new Error('GUI_PLUGIN_INVALID_RESPONSE');
    const binary = atob(result.base64);
    if (binary.length > GUI_PLUGIN_REPLY_LIMIT) throw new Error('GUI_PLUGIN_REPLY_TOO_LARGE');
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new Response([204, 205, 304].includes(result.status) ? null : bytes, { status: result.status, headers: { ...headers, 'Content-Type': result.mime, 'Cache-Control': 'no-store' } });
  };
}

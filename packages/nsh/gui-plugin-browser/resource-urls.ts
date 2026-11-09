/** Browser-owned URLs use the existing native resource/preview transports,
 * never the official SDK lane or a phone-local HTTP connection. */
const resourceFailure = (code: string) => Object.assign(new Error(code), { code });
type FetchInput = { value: string; method?: string; headers?: Headers; signal?: AbortSignal };
function nativeGetter(prototype: object, key: string): (candidate: unknown) => unknown {
  for (let current: object | null = prototype; current; current = Object.getPrototypeOf(current)) {
    const getter = Object.getOwnPropertyDescriptor(current, key)?.get;
    if (getter) return candidate => Reflect.apply(getter, candidate, []);
  }
  throw resourceFailure('GUI_RESOURCE_INVALID_INPUT');
}
function captureFetchGetters(realm: Window & typeof globalThis) {
  return {
    href: nativeGetter(realm.URL.prototype, 'href'),
    url: nativeGetter(realm.Request.prototype, 'url'),
    method: nativeGetter(realm.Request.prototype, 'method'),
    headers: nativeGetter(realm.Request.prototype, 'headers'),
    signal: nativeGetter(realm.Request.prototype, 'signal'),
  };
}
function fetchInput(candidate: unknown, brands: ReturnType<typeof captureFetchGetters>[]): FetchInput {
  if (typeof candidate === 'string') return { value: candidate };
  for (const brand of brands) {
    try { const href = brand.href(candidate); if (typeof href === 'string') return { value: href }; } catch { /* Not a native URL in this realm. */ }
    try {
      const value = brand.url(candidate), method = brand.method(candidate), headers = brand.headers(candidate), signal = brand.signal(candidate);
      if (typeof value === 'string' && typeof method === 'string' && headers && typeof headers === 'object' && signal && typeof signal === 'object') {
        return { value, method, headers: headers as Headers, signal: signal as AbortSignal };
      }
    } catch { /* Not a native Request in this realm. */ }
  }
  throw resourceFailure('GUI_RESOURCE_INVALID_INPUT');
}
export function rewriteGuiPluginSrcset(value: string, resolve: (url: string) => string): string {
  const candidates: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    let url = value.slice(start, index);
    if (!url) break;
    if (url.endsWith(',')) { url = url.replace(/,+$/, ''); candidates.push(resolve(url)); continue; }
    const descriptors = index;
    let parentheses = 0;
    while (index < value.length) {
      if (value[index] === ',' && parentheses === 0) break;
      if (value[index] === '(') parentheses++;
      if (value[index] === ')') parentheses = Math.max(0, parentheses - 1);
      index++;
    }
    candidates.push(resolve(url) + value.slice(descriptors, index)); index++;
  }
  return candidates.join(', ');
}
export function guiPluginResourceURL(value: string, input: { origin: string; directory: string; path: string }): string {
  if (!value || /^(?:#|data:|blob:|about:blank$)/i.test(value)) return value;
  const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const base = input.origin + '/__gui/files' + encodePath(input.path);
  const url = new URL(value, base);
  if (url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:authorization|access_token|oc_client_token|yuri_client_token|yuri_url_token|yuri_preview_token|token)$/i.test(key))) throw resourceFailure('GUI_RESOURCE_CREDENTIAL_URL');
  if (url.origin === new URL(input.origin).origin && url.protocol === new URL(input.origin).protocol && url.host === new URL(input.origin).host) {
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/__gui/') || url.pathname.startsWith('/api/preview/proxy/')) return url.href;
    if (url.pathname.startsWith('/api/fs/serve/')) {
      const path = decodeURIComponent(url.pathname.slice('/api/fs/serve'.length));
      if (!(path.startsWith(input.directory.replace(/\/$/, '') + '/') || input.directory === '/')) throw resourceFailure('GUI_RESOURCE_OUTSIDE_WORKSPACE');
      if (url.search) throw resourceFailure('GUI_RESOURCE_UNSUPPORTED_QUERY');
      return input.origin + '/__gui/files' + encodePath(path) + url.hash;
    }
    throw resourceFailure('GUI_RESOURCE_ROUTE_UNSUPPORTED');
  }
  if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) {
    const origin = btoa(url.origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return input.origin + '/__gui/loopback/' + origin + url.pathname + url.search + url.hash;
  }
  if (['http:', 'https:'].includes(url.protocol) && url.pathname.startsWith('/api/fs/serve/')) {
    if (url.search) throw resourceFailure('GUI_RESOURCE_UNSUPPORTED_QUERY');
    const encoded = btoa(url.origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return input.origin + '/__gui/host/' + encoded + url.pathname + url.hash;
  }
  throw resourceFailure(['ws:', 'wss:'].includes(url.protocol) ? 'GUI_RESOURCE_WEBSOCKET_CORE_GAP' : 'GUI_RESOURCE_EXTERNAL_ORIGIN_CORE_GAP');
}

export function installGuiPluginResourceURLs(input: { window: Window; directory: string; path: string }) {
  const origin = input.window.location.protocol + '//' + input.window.location.host;
  const parentGetters = captureFetchGetters(input.window as Window & typeof globalThis);
  const observers: MutationObserver[] = [];
  const releaseFetch: (() => void)[] = [];
  const watched = new WeakSet<Document>();
  const errors: { code: string }[] = [];
  const resolve = (value: string) => guiPluginResourceURL(value, { ...input, origin });
  const resolveFor = (value: string, document: Document) => {
    const scoped = document.baseURI.startsWith(origin + '/__gui/') || document.baseURI.startsWith(origin + '/api/preview/proxy/');
    return resolve(scoped ? new URL(value, document.baseURI).href : value);
  };
  const map = (node: Element) => {
    for (const attribute of ['src', 'href', 'poster', 'srcset']) {
      if (attribute === 'href' && !['LINK', 'IMAGE', 'USE'].includes(node.tagName)) continue;
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        const next = attribute === 'srcset' ? rewriteGuiPluginSrcset(value, url => resolveFor(url, node.ownerDocument)) : resolveFor(value, node.ownerDocument);
        if (next !== value) node.setAttribute(attribute, next);
      }
      catch (error) {
        if (errors.length === 32) errors.shift(); errors.push({ code: error instanceof Error ? error.message : 'GUI_RESOURCE_INVALID' });
        node.setAttribute('data-gui-resource-error', errors.at(-1)!.code);
        node.dispatchEvent(new CustomEvent('yuri.gui.resource.error', { detail: errors.at(-1) }));
      }
    }
  };
  const visit = (root: Element) => { map(root); root.querySelectorAll('[src],[href],[poster],[srcset]').forEach(map); };
  const watch = (document: Document) => {
    if (watched.has(document)) return;
    watched.add(document);
    const realm = document.defaultView;
    if (realm?.fetch) {
      const brands = [captureFetchGetters(realm as Window & typeof globalThis), parentGetters];
      const original = realm.fetch;
      const wrapped: typeof fetch = async (request, options) => {
        const value = fetchInput(request, brands);
        const requestedMethod = options?.method ?? value.method ?? 'GET';
        if (typeof requestedMethod !== 'string') throw resourceFailure('GUI_RESOURCE_INVALID_INPUT');
        const method = requestedMethod.toUpperCase();
        if (method !== 'GET') throw resourceFailure('GUI_RESOURCE_METHOD_CORE_GAP');
        const target = resolveFor(value.value, document);
        return original.call(realm, target, { ...options, method, headers: options?.headers ?? value.headers, signal: options?.signal ?? value.signal, credentials: 'omit', redirect: 'error' });
      };
      realm.fetch = wrapped;
      releaseFetch.push(() => { if (realm.fetch === wrapped) realm.fetch = original; });
    }
    const Observer = MutationObserver;
    const observer = new Observer(rows => {
      for (const row of rows) {
        if (row.type === 'attributes') map(row.target as Element);
        for (const added of row.addedNodes) if (added.nodeType === 1) visit(added as Element);
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster', 'srcset'] });
    observers.push(observer);
    if (document.documentElement) visit(document.documentElement);
  };
  const loaded = (event: Event) => {
    const frame = event.target;
    if (frame instanceof HTMLIFrameElement) { try { if (frame.contentDocument) watch(frame.contentDocument); } catch { /* Cross-origin frames have no native device bridge. */ } }
  };
  input.window.document.addEventListener('load', loaded, true);
  watch(input.window.document);
  return { resolve, errors, close() { observers.forEach(observer => observer.disconnect()); releaseFetch.forEach(release => release()); input.window.document.removeEventListener('load', loaded, true); } };
}

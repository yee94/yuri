import type { RuntimeScope } from './runtime-scope';
import { sameRuntimeScope } from './runtime-scope';
import { resourceWebPreviewIntent, type ResourceWebPreviewIntent } from './resource-web-preview';

export const desktopBrowserComponent = 'yuri.desktop.browser';
export type DesktopBrowserIntent = ResourceWebPreviewIntent | { kind: 'browser'; url: string };
export type DesktopBrowserRequest = { kind: 'browser'; url: string } | { kind: 'preview'; path: string };
export type DesktopBrowserState = {
  phase: string; url: string; canBack: boolean; canForward: boolean; error: string | null;
};
export type DesktopBrowserReceipt = { owner: string; expectedHost: RuntimeScope; generation: number };
export type DesktopBrowserBinding = DesktopBrowserReceipt & { active: boolean; intent: DesktopBrowserIntent };
const unsafe = /[\\\u0000-\u0020\u007f]/;

/** browserPaneNavigation semantics (trim, https default, same-tab no-op), without
 * URL, which NSH QuickJS does not provide. Native repeats stricter URL admission. */
export function desktopBrowserAddress(value: string): DesktopBrowserIntent {
  const url = value.trim().includes('://') ? value.trim() : `https://${value.trim()}`;
  if (!value.trim() || unsafe.test(url) || url.length > 8192 || !/^[\x21-\x7e]+$/.test(url)) throw new Error('browser_invalid_url');
  const match = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?([/?#].*)?$/i.exec(url);
  if (!match || match[3] && (+match[3] < 1 || +match[3] > 65535)) throw new Error('browser_invalid_url');
  let decoded: string;
  try { decoded = decodeURIComponent(match[4] ?? ''); } catch { throw new Error('browser_invalid_url'); }
  if (/[\\%\u0000-\u001f\u007f]/.test(decoded) || /(?:[?&])(?:oc_client_token|yuri_client_token|yuri_url_token|yuri_preview_token|authorization|access_token|token|password|secret)=/i.test(decoded)) throw new Error('browser_invalid_url');
  const host = match[2].toLowerCase();
  const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(host);
  if (local) {
    const decision = resourceWebPreviewIntent({ directory: '/', href: url });
    if (!decision.supported) throw new Error('browser_invalid_loopback');
    return decision.intent;
  }
  if (host.endsWith('.localhost') || host.endsWith('.') || host.startsWith('[') || /^[\d.]+$/.test(host) || host.startsWith('0x')) throw new Error('browser_ambiguous_ip');
  return { kind: 'browser', url };
}

/** One retained panel tab, not a window or a global browser singleton. */
export function createDesktopBrowserBinding(options: {
  scope: RuntimeScope; owner: string; directory: string; current: () => boolean;
  command: (name: string, receipt: DesktopBrowserReceipt) => void;
  changed: (state: DesktopBrowserState) => void;
}) {
  const expectedHost = Object.freeze({ ...options.scope });
  let generation = 0, active = false, disposed = false;
  let intent: DesktopBrowserIntent | null = null;
  let state: DesktopBrowserState = { phase: 'idle', url: '', canBack: false, canForward: false, error: null };
  const receipt = () => ({ owner: options.owner, expectedHost, generation });
  const publish = (next: DesktopBrowserState) => { state = next; options.changed(next); };
  return {
    snapshot: () => state,
    binding(): DesktopBrowserBinding | null { return intent && !disposed ? { ...receipt(), active: active && options.current(), intent } : null; },
    update(value: boolean) { active = value && options.current() && !disposed; },
    request(request: DesktopBrowserRequest) {
      if (!active || disposed || !options.current()) return false;
      const decision = request.kind === 'preview' ? resourceWebPreviewIntent({ directory: options.directory, path: request.path }) : null;
      const next = request.kind === 'browser' ? desktopBrowserAddress(request.url) : decision?.supported ? decision.intent : null;
      if (!next) throw new Error('browser_invalid_html_scope');
      const nextURL = next.kind === 'html' ? next.path : next.url;
      if (intent && state.url === nextURL) return false;
      intent = next; generation++;
      publish({ phase: 'preparing', url: nextURL, canBack: state.canBack, canForward: state.canForward, error: null });
      return true;
    },
    event(value: unknown) {
      if (disposed || !active || !options.current() || !value || typeof value !== 'object' || Array.isArray(value)) return false;
      const event = value as Record<string, unknown>, scope = event.expectedHost as RuntimeScope | null;
      if (event.owner !== options.owner || event.generation !== generation || !scope || !sameRuntimeScope(scope, expectedHost)
        || typeof event.phase !== 'string' || typeof event.url !== 'string' || event.url.length > 8192 || typeof event.canBack !== 'boolean' || typeof event.canForward !== 'boolean' || event.error !== null && (typeof event.error !== 'string' || !/^browser_[a-z_]+$/.test(event.error))) return false;
      // Only native validated display URLs/Host file paths are accepted; custom routes
      // and short-lived proxy credentials never become the editable address bar.
      if (event.url && !event.url.startsWith('/')) { try { desktopBrowserAddress(event.url); } catch { return false; } }
      publish({ phase: event.phase, url: event.url, canBack: event.canBack, canForward: event.canForward, error: event.error as string | null });
      return true;
    },
    command(name: 'back' | 'forward' | 'reload' | 'stop' | 'external') {
      if (!active || disposed || !options.current() || !intent) return false;
      if (name === 'external') {
        try { if (desktopBrowserAddress(state.url).kind !== 'browser') return false; } catch { return false; }
      }
      options.command(name, receipt()); return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; active = false;
      // Cleanup keeps the captured old receipt even after props/current Host changes.
      if (intent) options.command('close', receipt());
    },
  };
}

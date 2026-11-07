import { createGuiPluginBrowser } from './gui-plugin-browser';
import { createGuiPluginFetch, type GuiPluginCapturedSender } from './gui-plugin-transport';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

type BrowserInput = Parameters<typeof createGuiPluginBrowser>[0];
type CapturedBrowser = Pick<BrowserInput, 'host' | 'appearance' | 'enabled' | 'captureClient'> & {
  /** Generated current Host theme CSS, not a copied/default palette. */
  themeCSS: string;
  dispose(): void;
};

/** A browser composition boundary for the real host, QueryClient, FilesAPI and
 * SDK singletons. Modules are constructed by the injected browser-only factory;
 * QuickJS never imports the Web implementation. */
export function createGuiPluginComposition(input: {
  scope: RuntimeScope;
  origin: string;
  sender: GuiPluginCapturedSender;
  intent: BrowserInput['intent'];
  content: HTMLElement;
  actions: HTMLElement;
  changed: BrowserInput['changed'];
  capture(input: { expectedHost: RuntimeScope; fetch: typeof fetch; signal: AbortSignal }): CapturedBrowser;
}) {
  const captured = runtimeScopeFrom(input.scope);
  if (!captured) throw new Error('scope_required');
  const expectedHost: RuntimeScope = captured;
  const lifetime = new AbortController();
  const fetch = createGuiPluginFetch({ scope: expectedHost, origin: input.origin, sender: input.sender, signal: lifetime.signal });
  let dependencies: CapturedBrowser;
  try { dependencies = input.capture({ expectedHost, fetch, signal: lifetime.signal }); }
  catch (error) { lifetime.abort(); throw error; }
  if (!input.sender.isCurrent(expectedHost)) { lifetime.abort(); dependencies.dispose(); throw new Error('runtime_host_scope_stale'); }
  const document = input.content.ownerDocument;
  const style = document.createElement('style');
  style.dataset.nshGuiTheme = '';
  style.textContent = dependencies.themeCSS;
  document.head.append(style);
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true; lifetime.abort(); style.remove();
    window.removeEventListener('pagehide', release);
    dependencies.dispose();
  };
  let browser: ReturnType<typeof createGuiPluginBrowser>;
  try { browser = createGuiPluginBrowser({
    host: dependencies.host, scope: expectedHost, appearance: dependencies.appearance,
    captureClient: dependencies.captureClient, enabled: dependencies.enabled,
    intent: input.intent, content: input.content, actions: input.actions,
    isCurrent: scope => !lifetime.signal.aborted && input.sender.isCurrent(scope),
    changed: state => { if (state.phase === 'closed') release(); input.changed(state); },
  }); } catch (error) {
    try { dependencies.host.dispose(); } finally { release(); }
    throw error;
  }
  window.addEventListener('pagehide', release, { once: true });
  return {
    refresh: browser.refresh,
    source: browser.source,
    setAppearance(appearance: CapturedBrowser['appearance'], themeCSS: string) {
      if (closed || !input.sender.isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
      style.textContent = themeCSS; dependencies.host.setAppearance({ ...appearance, narrow: true });
    },
    close() { try { browser.close(); } finally { release(); } },
  };
}

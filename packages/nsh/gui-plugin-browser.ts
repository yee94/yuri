import { createGuiPluginPreview, type GuiPluginPreviewBundle, type GuiPluginPreviewHost, type GuiPluginPreviewIntent, type GuiPluginPreviewState } from './gui-plugin-preview';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

type GuiClient = {
  plugin: {
    list(input: undefined, options: { signal: AbortSignal }): Promise<{ data: unknown }>;
    gui(input: { id: string }, options: { signal: AbortSignal }): Promise<{ data: GuiPluginPreviewBundle }>;
  };
};

/** Browser-only content entry. Bundle separately, never import into QuickJS/App.
 * The composition root must supply real captured SDK/files/storage adapters;
 * missing adapters are an integration gap, not a static preview fallback. */
export function createGuiPluginBrowser(input: {
  /** Construct with the real GuiPluginHost({ narrow: true, ...capturedAdapters }).
   * The native/QuickJS graph must never import that browser implementation. */
  host: GuiPluginPreviewHost;
  scope: RuntimeScope;
  appearance: { locale: string; mode: 'light' | 'dark' };
  /** Called once with the immutable admission scope, never at send time. */
  captureClient(expectedHost: RuntimeScope): GuiClient;
  intent: GuiPluginPreviewIntent;
  content: HTMLElement;
  actions: HTMLElement;
  enabled(id: string): boolean;
  isCurrent(expectedHost: RuntimeScope): boolean;
  changed(state: GuiPluginPreviewState): void;
}) {
  const expectedHost = runtimeScopeFrom(input.scope);
  if (!expectedHost) throw new Error('scope_required');
  if (!input.isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
  const client = input.captureClient(expectedHost);
  input.host.setAppearance({ ...input.appearance, narrow: true });
  const preview = createGuiPluginPreview({
    ...input, scope: expectedHost,
    list: async signal => (await client.plugin.list(undefined, { signal })).data,
    bundle: async (id, signal) => (await client.plugin.gui({ id }, { signal })).data,
  });
  const close = () => { window.removeEventListener('pagehide', close); preview.close(); };
  window.addEventListener('pagehide', close, { once: true });
  return { ...preview, close };
}

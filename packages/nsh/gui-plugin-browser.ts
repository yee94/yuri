import { createGuiPluginPreview, type GuiPluginPreviewJson, type GuiPluginPreviewHost, type GuiPluginPreviewIntent, type GuiPluginPreviewState } from './gui-plugin-preview';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

type GuiClient = {
  plugin: {
    list(input: undefined, options: { signal: AbortSignal }): Promise<unknown>;
    gui(input: { id: string }, options: { signal: AbortSignal }): Promise<unknown>;
  };
};
const json = (value: unknown): value is GuiPluginPreviewJson => value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(json)
  || typeof value === 'object' && value !== null && Object.values(value).every(json);
const options = (value: unknown): value is Record<string, GuiPluginPreviewJson> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(json);

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
    list: signal => client.plugin.list(undefined, { signal }),
    bundle: async (id, signal) => {
      const bundle = await client.plugin.gui({ id }, { signal });
      if (!bundle || typeof bundle !== 'object' || !('code' in bundle) || typeof bundle.code !== 'string'
        || !('revision' in bundle) || typeof bundle.revision !== 'string' || !('options' in bundle) || !options(bundle.options)) throw new Error('GUI_PLUGIN_INVALID_BUNDLE');
      return { code: bundle.code, revision: bundle.revision, options: bundle.options };
    },
  });
  const close = () => { window.removeEventListener('pagehide', close); preview.close(); };
  window.addEventListener('pagehide', close, { once: true });
  return { ...preview, close };
}

import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { validateGuiPluginNativeContext, type GuiPluginNativeContext } from './gui-plugin-native-context';

export type GuiPluginPreviewIntent = { sessionId: string; directory: string; path: string };
export type GuiPluginPreviewState = Readonly<{
  phase: 'loading' | 'mounted' | 'source' | 'unmatched' | 'error' | 'closed';
  refreshing: boolean;
  failure?: 'inventory' | 'invalid-inventory' | 'bundle' | 'plugin' | 'mount';
}>;
export type GuiPluginPreviewJson = string | number | boolean | null | GuiPluginPreviewJson[] | { [key: string]: GuiPluginPreviewJson };
export type GuiPluginPreviewBundle = { code: string; revision: string; options: Record<string, GuiPluginPreviewJson> };
export type GuiPluginPreviewHost = {
  setSession(session: { id: string; directory: string } | undefined): void;
  setAppearance(input: { locale: string; mode: 'light' | 'dark'; narrow: boolean }): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { plugins: readonly { id: string; revision: string; status: 'active' | 'failed' }[]; sessionKey?: string };
  install(id: string, bundle: GuiPluginPreviewBundle): void;
  uninstall(id: string): void;
  registerFileView(path: string, base?: string): () => void;
  openLink(link: { href: string; base?: string; exact?: boolean }): boolean;
  filePanel(path: string, base?: string): { key: string; pluginId: string } | undefined;
  mountPanel(key: string, element: HTMLElement, actions?: HTMLElement): () => void;
  dispose(): void;
};
type InventoryEntry = { id: string; features: { gui: boolean }; state: { status: string } };
class InvalidInventory extends Error {}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The upstream SDK permits id?: string. A GUI owner cannot safely adopt that
 * row: rejecting the whole authority preserves prior instances on malformed data. */
export function readGuiPluginInventory(value: unknown): InventoryEntry[] {
  if (!Array.isArray(value)) throw new InvalidInventory('GUI_PLUGIN_INVALID_INVENTORY');
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || item.id.length > 1024 || /[\u0000-\u001f\u007f]/.test(item.id)
      || ids.has(item.id) || !record(item.features) || (item.features.gui !== undefined && typeof item.features.gui !== 'boolean') || !record(item.state)
      || typeof item.state.status !== 'string' || !['active', 'failed'].includes(item.state.status)) throw new InvalidInventory('GUI_PLUGIN_INVALID_INVENTORY');
    ids.add(item.id);
    return { id: item.id, features: { gui: item.features.gui === true }, state: { status: item.state.status } };
  });
}

/** No suffix table: only the current Host's real LinkHandler/Panel registry decides. */
export function validateGuiPluginPreviewIntent(value: GuiPluginPreviewIntent): GuiPluginPreviewIntent {
  const path = (input: string) => typeof input === 'string' && input.length > 0 && input.length <= 8192
    && !/[\u0000-\u001f\u007f]/.test(input)
    && (!/^[a-z][a-z\d+.-]*:/i.test(input) || /^file:/i.test(input) || /^[a-z]:[\\/]/i.test(input));
  if (!value || !path(value.directory) || !path(value.path) || typeof value.sessionId !== 'string'
    || !value.sessionId || value.sessionId.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.sessionId)) throw new Error('GUI_PLUGIN_INVALID_INPUT');
  return { sessionId: value.sessionId, directory: value.directory, path: value.path };
}

/** Mount-only orchestration. The injected host is the existing SDK/Solid host,
 * never a replacement registry, file model, parser, or plugin context. */
export function createGuiPluginPreview(input: {
  host: GuiPluginPreviewHost;
  scope: RuntimeScope;
  intent: GuiPluginPreviewIntent;
  content: HTMLElement;
  actions: HTMLElement;
  list(signal: AbortSignal, expectedHost: RuntimeScope): Promise<unknown>;
  bundle(id: string, signal: AbortSignal, expectedHost: RuntimeScope): Promise<GuiPluginPreviewBundle>;
  enabled(id: string): boolean;
  isCurrent(expectedHost: RuntimeScope): boolean;
  changed(state: GuiPluginPreviewState): void;
}) {
  const intent = validateGuiPluginPreviewIntent(input.intent);
  const captured = runtimeScopeFrom(input.scope);
  if (!captured) throw new Error('scope_required');
  const expectedHost: RuntimeScope = captured;
  if (!input.isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
  const lifetime = new AbortController();
  let attempt = 0, ended = false, source = false, refreshing = false, scheduled = false;
  let failure: GuiPluginPreviewState['failure'];
  let phase: GuiPluginPreviewState['phase'] = 'loading';
  let flight: AbortController | undefined;
  let releaseFile: (() => void) | undefined;
  let unmount: (() => void) | undefined;
  let mounted: string | undefined;
  let dispatched: string | undefined;
  let stopObserve = () => {};
  const installed = new Set<string>();
  const publish = () => input.changed(Object.freeze({ phase, refreshing, ...(failure ? { failure } : {}) }));
  const clearMount = () => {
    const stop = unmount; unmount = undefined; mounted = undefined;
    try { stop?.(); } finally { input.content.replaceChildren(); input.actions.replaceChildren(); }
  };
  const clearFile = () => { const stop = releaseFile; releaseFile = undefined; stop?.(); };
  const current = () => !ended && !lifetime.signal.aborted && input.isCurrent(expectedHost);
  function close() {
    if (ended) return;
    ended = true; attempt++; lifetime.abort(); flight?.abort(); stopObserve();
    try { clearMount(); } finally {
      try { clearFile(); } finally { input.host.dispose(); installed.clear(); phase = 'closed'; refreshing = false; failure = undefined; publish(); }
    }
  }
  const reconcile = () => {
    if (!current()) { close(); return; }
    if (source) return;
    const snapshot = input.host.getSnapshot();
    const ready = JSON.stringify(snapshot.plugins.map(plugin => [plugin.id, plugin.revision, plugin.status]));
    try {
      releaseFile ??= input.host.registerFileView(intent.path, intent.directory);
      if (ready !== dispatched) {
        dispatched = ready;
        input.host.openLink({ href: intent.path, base: intent.directory, exact: true });
      }
      const panel = input.host.filePanel(intent.path, intent.directory);
      const plugin = panel && snapshot.plugins.find(item => item.id === panel.pluginId);
      if (panel && plugin?.status === 'active') {
        const identity = JSON.stringify([panel.key, plugin.id, plugin.revision, snapshot.sessionKey]);
        if (identity !== mounted) {
          clearMount(); mounted = identity;
          unmount = input.host.mountPanel(panel.key, input.content, input.actions);
        }
        phase = 'mounted';
      } else {
        clearMount();
        if (snapshot.plugins.some(item => item.status === 'failed')) { failure = 'plugin'; phase = 'error'; }
        else phase = refreshing ? 'loading' : failure ? 'error' : 'unmatched';
      }
    } catch { clearMount(); failure = 'mount'; phase = 'error'; }
    publish();
  };
  const schedule = () => {
    if (scheduled || ended) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!ended) reconcile(); });
  };
  input.host.setSession({ id: intent.sessionId, directory: intent.directory });
  stopObserve = input.host.subscribe(schedule);
  async function refresh() {
    if (!current()) { close(); return; }
    flight?.abort();
    const controller = new AbortController(); flight = controller;
    const revision = ++attempt;
    const fresh = () => current() && !controller.signal.aborted && revision === attempt;
    refreshing = true; failure = undefined; publish();
    try {
      // Never interpret a failed inventory as successful empty/uninstall.
      const inventory = readGuiPluginInventory(await input.list(controller.signal, expectedHost));
      if (!fresh()) return;
      const active = inventory.filter(item => item.features.gui && item.state.status === 'active' && input.enabled(item.id));
      const wanted = new Set(active.map(item => item.id));
      for (const id of installed) if (!wanted.has(id)) { input.host.uninstall(id); installed.delete(id); }
      // Match the existing host's two-lane download budget; successful plugins apply independently.
      let index = 0;
      await Promise.all([0, 1].map(async () => {
        while (fresh() && index < active.length) {
          const item = active[index++];
          try {
            const bundle = await input.bundle(item.id, controller.signal, expectedHost);
            if (!fresh()) return;
            input.host.install(item.id, bundle); installed.add(item.id); reconcile();
          } catch { if (fresh()) { failure = 'bundle'; publish(); } }
        }
      }));
    } catch (error) { if (fresh()) failure = error instanceof InvalidInventory ? 'invalid-inventory' : 'inventory'; }
    finally {
      if (fresh()) { refreshing = false; flight = undefined; if (source) publish(); else reconcile(); }
      else if (!ended && !input.isCurrent(expectedHost)) close();
    }
  }
  publish();
  return {
    refresh,
    source(show: boolean) {
      if (!current()) { close(); return; }
      if (source === show) return;
      source = show;
      if (show) { clearMount(); clearFile(); phase = 'source'; publish(); }
      else { dispatched = undefined; reconcile(); }
    },
    /** Called by the native owner on background, Host change and teardown. */
    close,
  };
}

export async function presentGuiPluginPreview(
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  intent: GuiPluginPreviewIntent,
  scope: RuntimeScope,
  isCurrent: (expectedHost: RuntimeScope) => boolean,
  owner: string,
  context?: GuiPluginNativeContext,
): Promise<{ closed: true }> {
  const expectedHost = runtimeScopeFrom(scope);
  if (!expectedHost) throw new Error('scope_required');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('GUI_PLUGIN_INVALID_OWNER');
  if (!isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
  const presentation = context === undefined ? undefined : validateGuiPluginNativeContext(context, expectedHost);
  const result = await call('plugins.preview.present', { ...validateGuiPluginPreviewIntent(intent), expectedHost, owner, ...(presentation ? { context: presentation } : {}) });
  if (!isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
  if (!result || typeof result !== 'object' || !('closed' in result) || result.closed !== true) throw new Error('GUI_PLUGIN_INVALID_OUTPUT');
  return { closed: true };
}

/** Parent captures the scope once; every open and cleanup has a unique owner.
 * Exact closes are also sent for timeout/rejection and close-before-admission. */
export function bindGuiPluginPreview(
  scope: RuntimeScope,
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  identify: () => string,
  isCurrent: (expectedHost: RuntimeScope) => boolean,
  context?: GuiPluginNativeContext,
) {
  const expectedHost = runtimeScopeFrom(scope);
  if (!expectedHost) throw new Error('scope_required');
  const presentation = context === undefined ? undefined : validateGuiPluginNativeContext(context, expectedHost);
  const pending = new Set<string>(), used = new Set<string>();
  const closing = new Map<string, Promise<void>>();
  const closeOwner = (owner: string): Promise<void> => {
    const existing = closing.get(owner);
    if (existing) return existing;
    const flight = Promise.resolve().then(async () => {
      try {
        const result = await call('plugins.preview.close', { expectedHost, owner });
        if (result !== true) throw new Error('GUI_PLUGIN_INVALID_OUTPUT');
        pending.delete(owner);
      } finally { closing.delete(owner); }
    });
    closing.set(owner, flight); return flight;
  };
  return {
    async close() { await Promise.all([...pending].map(closeOwner)); },
    async present(intent: GuiPluginPreviewIntent) {
      const owner = identify();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner) || used.has(owner)) throw new Error('GUI_PLUGIN_INVALID_OWNER');
      used.add(owner); pending.add(owner);
      try { return await presentGuiPluginPreview(call, intent, expectedHost, isCurrent, owner, presentation); }
      finally { if (pending.has(owner)) await closeOwner(owner).catch(() => {}); }
    },
  };
}

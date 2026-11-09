import { captureGuiPluginFactory } from './gui-plugin-factory';
import { createGuiPluginComposition } from './gui-plugin-composition';
import { createGuiPluginChannel, type GuiPluginReplyPort } from './gui-plugin-channel';
import { createGuiPluginStorage } from './gui-plugin-storage';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { validateGuiPluginPreviewIntent } from './gui-plugin-preview';
import { createGuiPluginDevice } from './gui-plugin-browser/device';
import { installGuiPluginResourceURLs } from './gui-plugin-browser/resource-urls';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new Error('GUI_INVALID_BOOTSTRAP'); return value; };

/** The emitted IIFE exports this entry for the native document and synthetic
 * bundle fixture. It never discovers/installs a plugin or loads the main Web UI. */
export async function startGuiPluginPreview(input: {
  window: Window;
  port: GuiPluginReplyPort;
  storagePrompt(prompt: string, request: string): string | null;
}) {
  const bootstrap = await input.port.postMessage({ name: 'bootstrap' });
  if (!record(bootstrap) || !record(bootstrap.intent) || !record(bootstrap.labels)) throw new Error('GUI_INVALID_BOOTSTRAP');
  const scope = runtimeScopeFrom(bootstrap.intent.expectedHost);
  if (!scope || bootstrap.intent.sessionId !== undefined && typeof bootstrap.intent.sessionId !== 'string' || typeof bootstrap.intent.directory !== 'string' || typeof bootstrap.intent.path !== 'string') throw new Error('GUI_INVALID_BOOTSTRAP');
  const intent = validateGuiPluginPreviewIntent({ ...(bootstrap.intent.sessionId === undefined ? {} : { sessionId: bootstrap.intent.sessionId as string }), directory: bootstrap.intent.directory, path: bootstrap.intent.path });
  const runtimeKey = text(bootstrap.runtimeKey), themeCSS = text(bootstrap.themeCSS), locale = text(bootstrap.locale), preferenceKey = text(bootstrap.preferenceKey);
  const mode = bootstrap.mode;
  if (mode !== 'light' && mode !== 'dark') throw new Error('GUI_INVALID_BOOTSTRAP');
  const labels = { loading: text(bootstrap.labels.loading), failed: text(bootstrap.labels.failed), retry: text(bootstrap.labels.retry), source: text(bootstrap.labels.source), preview: text(bootstrap.labels.preview) };
  const origin = input.window.location.protocol + '//' + input.window.location.host;
  const document = input.window.document;
  const root = document.getElementById('gui-plugin-root');
  if (!root || root.childNodes.length) throw new Error('GUI_INVALID_CONTAINER');
  let current = true;
  const isCurrent = (expected: RuntimeScope) => current && expected.hostID === scope.hostID && expected.lease === scope.lease;
  const channel = createGuiPluginChannel({ scope, port: input.port, isCurrent });
  const device = createGuiPluginDevice({ scope, window: input.window, port: input.port, isCurrent: () => current, prompt: input.storagePrompt });
  const resources = installGuiPluginResourceURLs({ window: input.window, directory: intent.directory, path: intent.path });
  const storage = createGuiPluginStorage({ scope, isCurrent, transact(expectedHost, operation) {
    const value = input.storagePrompt('yuri.gui.storage.v1', JSON.stringify({ expectedHost, operation }));
    if (value === null) throw new Error('GUI_STORAGE_UNAVAILABLE');
    const response: unknown = JSON.parse(value);
    if (!record(response) || response.ok !== true || !Object.hasOwn(response, 'value')) throw new Error('GUI_STORAGE_WRITE_FAILED');
    return response.value;
  } });
  const toolbar = document.createElement('div'), actions = document.createElement('div');
  const content = document.createElement('section'), source = document.createElement('pre'), status = document.createElement('p');
  const retry = document.createElement('button'), toggle = document.createElement('button');
  toolbar.className = 'gui-toolbar'; content.className = 'gui-content'; source.className = 'gui-source';
  actions.className = 'gui-actions'; status.className = 'gui-status'; status.setAttribute('role', 'status');
  retry.textContent = labels.retry; toggle.textContent = labels.source; status.textContent = labels.loading;
  source.hidden = true; retry.hidden = true; toolbar.append(actions, toggle, retry); root.append(toolbar, status, source, content);
  let factory: ReturnType<typeof captureGuiPluginFactory> | undefined;
  let sourceMode = false, revision = 0;
  const composition = createGuiPluginComposition({ scope, origin, sender: channel.sender, intent, content, actions,
    changed(state) {
      status.textContent = state.phase === 'loading' ? labels.loading : state.failure || state.phase === 'error' || state.phase === 'unmatched' ? labels.failed : '';
      retry.hidden = !state.failure && state.phase !== 'error' && state.phase !== 'unmatched';
      const phase = state.refreshing && (state.phase === 'error' || state.phase === 'unmatched') ? 'loading' : state.phase;
      void channel.state(phase).catch(() => { close(); });
    },
    capture({ expectedHost, fetch, signal }) {
      factory = captureGuiPluginFactory({ expectedHost, origin, runtimeKey, directory: intent.directory, fetch, signal, storage, appearance: { locale, mode }, themeCSS, preferenceKey, ...device });
      return factory;
    },
  });
  function close() {
    if (!current) return;
    current = false; revision++; input.window.removeEventListener('pagehide', close);
    try { composition.close(); } finally { resources.close(); device.close(); channel.close(); root?.replaceChildren(); }
  }
  retry.onclick = () => { factory?.readPreferences(); void composition.refresh(); };
  toggle.onclick = () => {
    sourceMode = !sourceMode; const attempt = ++revision;
    composition.source(sourceMode); source.hidden = !sourceMode; content.hidden = sourceMode;
    toggle.textContent = sourceMode ? labels.preview : labels.source;
    if (!sourceMode) return;
    source.textContent = labels.loading;
    void factory?.files.readFile?.(intent.path, { directory: intent.directory }).then(value => {
      if (current && sourceMode && revision === attempt) source.textContent = value.content;
    }).catch(() => { if (current && sourceMode && revision === attempt) source.textContent = labels.failed; });
  };
  input.window.addEventListener('pagehide', close, { once: true });
  await composition.refresh();
  return { close, refresh: composition.refresh, setEnabled(id: string, enabled: boolean) {
    if (!current) throw new Error('runtime_host_scope_stale'); factory?.setEnabled(id, enabled); return composition.refresh();
  } };
}

/** Explicit property validation keeps the global registration narrow and typed. */
export function nativeGuiPluginPort(window: Window): GuiPluginReplyPort {
  const webkit: unknown = Reflect.get(window, 'webkit');
  if (!record(webkit) || !record(webkit.messageHandlers) || !record(webkit.messageHandlers.guiPluginPreview)) throw new Error('GUI_NATIVE_PORT_UNAVAILABLE');
  const handler = webkit.messageHandlers.guiPluginPreview;
  if (typeof handler.postMessage !== 'function') throw new Error('GUI_NATIVE_PORT_UNAVAILABLE');
  const postMessage = handler.postMessage;
  return { async postMessage(input) { return await Reflect.apply(postMessage, handler, [input]); } };
}

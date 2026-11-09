/// <reference path="../ui/src/types/desktop.d.ts" />
import { OpenCode } from '../ui/node_modules/@yuriai/opencode-gui-client/dist/promise/index.js';
import { GuiPluginHost } from '../ui/src/lib/gui-plugins/host';
import { queryClient } from '../ui/src/lib/queryRuntime';
import { guiPreferencesKey, readDisabledPlugins, writePluginEnabled } from '../ui/src/lib/gui-plugins/preferences';
import type { FilesAPI } from '../ui/src/lib/api/types';
import type { ViewExportAPI } from '../ui/src/lib/view-export/types';
import type { RuntimeScope } from './runtime-scope';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const factoryOwners = new Set<symbol>();
const documentAppearance = (root: HTMLElement) => ({ dark: root.classList.contains('dark'), light: root.classList.contains('light'), theme: root.getAttribute('data-theme'), lang: root.getAttribute('lang'), scheme: root.style.colorScheme });
type DocumentAppearance = ReturnType<typeof documentAppearance>;
type AppearanceOwners = { base: DocumentAppearance; layers: { owner: symbol; value: DocumentAppearance }[] };
const appearanceOwners = new WeakMap<HTMLElement, AppearanceOwners>();
function applyDocumentAppearance(root: HTMLElement, value: DocumentAppearance) {
  root.classList.toggle('dark', value.dark); root.classList.toggle('light', value.light);
  for (const [key, text] of [['data-theme', value.theme], ['lang', value.lang]] as const) { if (text === null) root.removeAttribute(key); else root.setAttribute(key, text); }
  root.style.colorScheme = value.scheme;
}

/** This module is a browser build entry dependency, never a QuickJS dependency.
 * SDK/Solid/GUI context instances are exactly the existing host's instances. */
export function captureGuiPluginFactory(input: {
  expectedHost: RuntimeScope;
  origin: string;
  runtimeKey: string;
  directory: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  storage: Storage;
  appearance: { locale: string; mode: 'light' | 'dark' };
  themeCSS: string;
  preferenceKey: string;
  viewExport?: ViewExportAPI;
  system?: ConstructorParameters<typeof GuiPluginHost>[0]['system'];
  toasts?: ConstructorParameters<typeof GuiPluginHost>[0]['toasts'];
}) {
  const client = OpenCode.make({ baseUrl: input.origin, fetch: input.fetch });
  const checkedFetch = async (route: string, headers: Record<string, string> = {}) => {
    input.signal.throwIfAborted();
    const result = await input.fetch(new URL(route, input.origin), { signal: input.signal, headers });
    if (!result.ok) throw new Error(`GUI file HTTP ${result.status}`);
    return result;
  };
  const directoryHeaders = (directory = input.directory) => ({ 'x-opencode-directory': directory });
  const fileRoute = (route: string, path: string, options?: { directory?: string; optional?: boolean; fingerprint?: boolean; allowOutsideWorkspace?: boolean; outsideFileGrant?: string }) => {
    const query = new URLSearchParams({ path });
    if (options?.optional) query.set('optional', 'true');
    if (options?.fingerprint) query.set('fingerprint', 'true');
    if (options?.allowOutsideWorkspace) query.set('allowOutsideWorkspace', 'true');
    if (options?.outsideFileGrant) query.set('outsideFileGrant', options.outsideFileGrant);
    return checkedFetch(route + '?' + query, directoryHeaders(options?.directory));
  };
  const files: FilesAPI = {
    async listDirectory(path, options) {
      const query = new URLSearchParams({ path });
      if (options?.respectGitignore) query.set('respectGitignore', 'true');
      const data: unknown = await (await checkedFetch('/api/fs/list?' + query, directoryHeaders())).json();
      if (!record(data) || !Array.isArray(data.entries)) throw new Error('GUI_INVALID_DIRECTORY');
      const entries = data.entries.map((entry: unknown) => {
        if (!record(entry) || typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.isDirectory !== 'boolean') throw new Error('GUI_INVALID_DIRECTORY');
        return { name: entry.name, path: entry.path, isDirectory: entry.isDirectory };
      });
      return { directory: typeof data.directory === 'string' ? data.directory : path, entries };
    },
    async search(payload, options) {
      const result = await client.file.find({ location: { directory: payload.directory }, query: payload.query, type: 'file', limit: payload.maxResults }, { signal: AbortSignal.any([input.signal, ...(options?.signal ? [options.signal] : [])]) });
      return result.data.map(entry => ({ path: entry.path }));
    },
    async createDirectory() { throw new Error('GUI_PLUGIN_UNSUPPORTED: createDirectory'); },
    async readFile(path, options) {
      const response = await fileRoute('/api/fs/read', path, options);
      const exists = response.headers.get('x-yuri-file-exists');
      if (options?.optional && exists !== 'true' && exists !== 'false') {
        await response.body?.cancel();
        throw new Error('GUI_INVALID_FILE_EXISTENCE');
      }
      return { path, content: await response.text(), ...(options?.optional ? { exists: exists === 'true' } : {}) };
    },
    async statFile(path, options) {
      const data: unknown = await (await fileRoute('/api/fs/stat', path, options)).json();
      if (!record(data) || typeof data.isFile !== 'boolean' || typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0) throw new Error('GUI_INVALID_STAT');
      return { path, isFile: data.isFile, size: data.size,
        ...(typeof data.mtimeMs === 'number' ? { mtimeMs: data.mtimeMs } : {}),
        ...(typeof data.isBinary === 'boolean' ? { isBinary: data.isBinary } : {}),
        ...(typeof data.sha256 === 'string' ? { sha256: data.sha256 } : {}),
        ...(typeof data.mimeType === 'string' ? { mimeType: data.mimeType } : {}),
      };
    },
  };
  const preferenceKey = guiPreferencesKey(input.runtimeKey);
  if (preferenceKey !== input.preferenceKey) throw new Error('GUI_INVALID_PREFERENCE_SCOPE');
  let disabled = readDisabledPlugins(input.storage, preferenceKey);
  const host = new GuiPluginHost({ client, files, queryClient, storage: input.storage,
    transport: input.runtimeKey, ...input.appearance, narrow: true, viewExport: input.viewExport, system: input.system, toasts: input.toasts });
  const root = document.documentElement, owner = Symbol('gui-appearance');
  const owners: AppearanceOwners = appearanceOwners.get(root) ?? { base: documentAppearance(root), layers: [] };
  const value = { dark: input.appearance.mode === 'dark', light: input.appearance.mode === 'light', theme: input.appearance.mode, lang: input.appearance.locale, scheme: input.appearance.mode };
  owners.layers.push({ owner, value }); appearanceOwners.set(root, owners); factoryOwners.add(owner);
  applyDocumentAppearance(root, value);
  let disposed = false;
  return {
    host, client, files, appearance: input.appearance, themeCSS: input.themeCSS,
    captureClient: () => client,
    enabled: (id: string) => !disabled.includes(id),
    readPreferences() { disabled = readDisabledPlugins(input.storage, preferenceKey); },
    setEnabled(id: string, enabled: boolean) { disabled = writePluginEnabled(input.storage, preferenceKey, id, enabled); },
    dispose() {
      if (disposed) return; disposed = true; factoryOwners.delete(owner);
      // The real owning QueryClient is shared within this document/realm. An
      // old factory cannot retire another active factory's queries or cache.
      if (!factoryOwners.size) { void queryClient.cancelQueries(); if (!factoryOwners.size) queryClient.clear(); }
      const index = owners.layers.findIndex(layer => layer.owner === owner);
      if (index >= 0) owners.layers.splice(index, 1);
      applyDocumentAppearance(root, owners.layers.at(-1)?.value ?? owners.base);
      if (!owners.layers.length) appearanceOwners.delete(root);
    },
  };
}

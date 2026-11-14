import { resourcePath, resourceResolve } from './resources-model';
import type { RuntimeScope } from './runtime-scope';
import type { ChangesSource } from './chat-changes-model';
import { desktopBrowserAddress } from './desktop-browser-core';
import type { DesktopPanelChatTarget } from './desktop-panel-chat';

/** Shell owns effective-directory/session authority; never infer it from a tab. */
export type DesktopPanelScope = Readonly<{
  host: RuntimeScope;
  /** Stable, non-secret connection/origin/authorization identity, never a lease or credential. */
  authorityKey: string;
  sessionID: string | null;
  directory: string;
}>;
export type DesktopPanelStoredScope = Omit<DesktopPanelScope, 'host'> & { readonly host: Readonly<{ hostID: string }> };
export type DesktopPanelFileSource = Readonly<{ directory: string; sessionID: string }>;
export type DesktopPanelIntent =
  | { kind: 'file'; path: string; targetLine?: number; source?: DesktopPanelFileSource }
  | { kind: 'diff'; source: ChangesSource }
  | { kind: 'file-diff'; source: Extract<ChangesSource, { kind: 'turn' }> & { path: string } }
  | { kind: 'browser'; url: string }
  | { kind: 'preview'; path: string; source?: DesktopPanelFileSource }
  | { kind: 'chat'; target: DesktopPanelChatTarget }
  | { kind: 'btw'; sessionID: string }
  | { kind: 'context' };
export type DesktopPanelTab = DesktopPanelIntent & { id: string };
export type DesktopPanelRail = 'git' | 'files' | null;
export type DesktopPanelSnapshot = Readonly<{ tabs: readonly DesktopPanelTab[]; selectedID: string | null; rail: DesktopPanelRail; activeView: 'rail' | 'preview' }>;
export type DesktopPanelMetadataIntent = Exclude<DesktopPanelIntent, { kind: 'diff' | 'file-diff' }> | { kind: 'diff'; source: Extract<ChangesSource, { kind: 'workspace' }> };
export type DesktopPanelMetadata = { scope: DesktopPanelStoredScope; tabs: Array<DesktopPanelMetadataIntent & { id: string }>; selectedID: string | null; rail: DesktopPanelRail; activeView: 'rail' | 'preview' };
const empty: DesktopPanelSnapshot = Object.freeze({ tabs: Object.freeze([]), selectedID: null, rail: 'git', activeView: 'rail' });
export const DESKTOP_PANEL_SCOPE_LIMIT = 20;
export const desktopPanelRailWidth = (width = 420) => Number.isFinite(width) ? Math.min(860, Math.max(240, width)) : 420;
export function desktopPanelVisibility(value: DesktopPanelSnapshot, width: number) {
  const hasTab = value.tabs.some(tab => tab.id === value.selectedID), compact = !Number.isFinite(width) || width < 400;
  const rail = !hasTab || value.rail !== null && (!compact || value.activeView !== 'preview');
  return { compact, rail, preview: hasTab && (!compact || !rail) };
}

/** A refreshed lease fences requests, but does not erase this Host's tab selection. */
export function desktopPanelScopeKey(scope: DesktopPanelStoredScope): string {
  if (!scope.host.hostID || typeof scope.authorityKey !== 'string' || !scope.authorityKey.trim() || scope.sessionID !== null && !scope.sessionID) throw new Error('Invalid desktop panel scope');
  return JSON.stringify([scope.host.hostID, scope.authorityKey, scope.sessionID, resourcePath(scope.directory)]);
}

export function desktopPanelFilePath(directory: string, path: string): string {
  const root = resourcePath(directory), resolved = resourceResolve(path, root);
  if (resolved === root) throw new Error('File outside panel workspace');
  return resolved;
}

function fileSource(value: unknown): DesktopPanelFileSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop_panel_invalid_file_source');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || !Object.hasOwn(source, 'directory') || !Object.hasOwn(source, 'sessionID')) throw new Error('desktop_panel_invalid_file_source');
  const field = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('desktop_panel_invalid_file_source');
    return value;
  };
  return { directory: resourcePath(field(source.directory)), sessionID: field(source.sessionID) };
}

/** Only content location changes. Native Host, public authority and lease stay parent-owned. */
export function desktopPanelFileScope<T extends DesktopPanelStoredScope>(parent: T, intent: { source?: DesktopPanelFileSource }): T {
  if (intent.source === undefined) return parent;
  const source = fileSource(intent.source);
  return { ...parent, directory: source.directory, sessionID: source.sessionID };
}

/** Root calls only after checking its exact source-current receipt. Never navigates Chat. */
export function createSourceFileIntent(parent: DesktopPanelStoredScope, source: DesktopPanelFileSource, path: string, targetLine?: number): Extract<DesktopPanelIntent, { kind: 'file' | 'preview' }> {
  const intent = normalizeDesktopPanelIntent(parent, { kind: 'file', source: fileSource(source), path, targetLine });
  if (intent.kind !== 'file' && intent.kind !== 'preview') throw new Error('desktop_panel_invalid_file_source');
  return intent;
}

export function normalizeDesktopPanelIntent(scope: DesktopPanelStoredScope, intent: DesktopPanelIntent): DesktopPanelIntent {
  if (intent.kind === 'btw') {
    if (typeof intent.sessionID !== 'string' || !intent.sessionID.trim() || intent.sessionID.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(intent.sessionID) || intent.sessionID !== scope.sessionID) throw new Error('desktop_panel_content_session_mismatch');
    return { kind: 'btw', sessionID: intent.sessionID };
  }
  if (intent.kind === 'file-diff') {
    const source = intent.source;
    const valid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 8192 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
    if (!source || source.kind !== 'turn' || !valid(source.directory) || !valid(source.sessionID) || !valid(source.messageID) || !valid(source.path) || !Array.isArray(source.files) || !source.files.length) throw new Error('desktop_panel_invalid_historical_target');
    const directory = resourcePath(source.directory);
    const paths = new Set<string>();
    const files = source.files.map(file => {
      if (!file || !valid(file.path) || file.patch !== undefined && typeof file.patch !== 'string'
        || file.before !== undefined && typeof file.before !== 'string' || file.after !== undefined && typeof file.after !== 'string'
        || file.isBinary !== undefined && typeof file.isBinary !== 'boolean'
        || !file.patch && !(typeof file.before === 'string' && typeof file.after === 'string') && file.isBinary !== true) throw new Error('desktop_panel_historical_snapshot_required');
      const path = desktopPanelFilePath(directory, file.path);
      if (paths.has(path)) throw new Error('desktop_panel_invalid_historical_target');
      paths.add(path);
      return { path, ...(file.patch === undefined ? {} : { patch: file.patch }), ...(file.before === undefined ? {} : { before: file.before }), ...(file.after === undefined ? {} : { after: file.after }), ...(file.isBinary === undefined ? {} : { isBinary: file.isBinary }) };
    });
    const path = desktopPanelFilePath(directory, source.path);
    if (!files.some(file => desktopPanelFilePath(directory, file.path) === path)) throw new Error('Historical file unavailable');
    if (source.targetLine !== undefined && (!Number.isSafeInteger(source.targetLine) || source.targetLine < 1)) throw new Error('desktop_panel_invalid_historical_target');
    if (source.revision !== undefined && !(typeof source.revision === 'string' && valid(source.revision) || typeof source.revision === 'number' && Number.isFinite(source.revision))) throw new Error('desktop_panel_invalid_historical_target');
    return { kind: 'file-diff', source: { kind: 'turn', directory, sessionID: source.sessionID, messageID: source.messageID, files, path,
      ...(source.targetLine === undefined ? {} : { targetLine: source.targetLine }), ...(source.revision === undefined ? {} : { revision: source.revision }) } };
  }
  if (intent.kind === 'chat') {
    const value: unknown = intent.target;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop_panel_invalid_chat_target');
    const target = value as Record<string, unknown>;
    if (!Object.hasOwn(target, 'sessionID') || !Object.hasOwn(target, 'directory') || Object.keys(target).some(key => !['sessionID', 'directory', 'title', 'messageID'].includes(key))) throw new Error('desktop_panel_invalid_chat_target');
    const field = (value: unknown): string => {
      if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('desktop_panel_invalid_chat_target');
      return value;
    };
    return { kind: 'chat', target: { sessionID: field(target.sessionID), directory: resourcePath(field(target.directory)),
      ...(target.title === undefined ? {} : { title: field(target.title) }), ...(target.messageID === undefined ? {} : { messageID: field(target.messageID) }) } };
  }
  if (intent.kind === 'file' || intent.kind === 'preview') {
    const own = desktopPanelFileScope(scope, intent), path = desktopPanelFilePath(own.directory, intent.path);
    const source = intent.source === undefined || own.directory === resourcePath(scope.directory) && own.sessionID === scope.sessionID ? {} : { source: fileSource(intent.source) };
    if (intent.kind === 'file' && intent.targetLine !== undefined && (!Number.isSafeInteger(intent.targetLine) || intent.targetLine < 1)) throw new Error('desktop_panel_invalid_file_line');
    if (intent.kind === 'preview' || /\.html?$/i.test(path)) {
      if (!/\.html?$/i.test(path)) throw new Error('desktop_panel_preview_format_unavailable');
      return { kind: 'preview', path, ...source };
    }
    return { kind: 'file', path, ...source, ...(intent.targetLine === undefined ? {} : { targetLine: intent.targetLine }) };
  }
  if (intent.kind === 'browser') {
    if (intent.url === '') return { kind: 'browser', url: '' };
    const address = desktopBrowserAddress(intent.url);
    if (address.kind === 'html') throw new Error('desktop_panel_invalid_browser');
    const url = address.url.replace(/^(https?):\/\/([^/?#]+)(.*)$/i, (_: string, scheme: string, authority: string, suffix: string) => {
      const protocol = scheme.toLowerCase(), host = authority.toLowerCase().replace(protocol === 'https' ? /:443$/ : /:80$/, '');
      return protocol + '://' + host + (!suffix || /^[?#]/.test(suffix) ? '/' + suffix : suffix);
    });
    return { kind: 'browser', url };
  }
  if (intent.kind !== 'diff') return intent;
  const source = intent.source, directory = resourcePath(scope.directory);
  if (resourcePath(source.directory) !== directory) throw new Error('Diff outside panel workspace');
  if (source.kind === 'turn' && source.sessionID !== scope.sessionID) throw new Error('Historical diff outside panel session');
  if (source.path) desktopPanelFilePath(directory, source.path);
  // Copy the historical snapshot. Callers cannot later turn it into current Git.
  if (source.kind === 'turn') {
    const files = source.files.map(file => { desktopPanelFilePath(directory, file.path); return { ...file }; });
    const path = source.path ? files.find(file => desktopPanelFilePath(directory, file.path) === desktopPanelFilePath(directory, source.path!))?.path : undefined;
    if (source.path && !path) throw new Error('Historical file unavailable');
    return { kind: 'diff', source: { ...source, directory, files, path } };
  }
  return { kind: 'diff', source: { ...source, directory } };
}

/** Different tool snapshots in one message must not overwrite each other.
 * For thin snapshots the caller should supply revision = exact tool/snapshot ID. */
function sameHistoricalSnapshot(left: ChangesSource, right: ChangesSource, fixed = false): boolean {
  if (left.kind !== 'turn' || right.kind !== 'turn') return false;
  if (!fixed && (left.revision !== undefined || right.revision !== undefined)) return left.revision === right.revision;
  return left.loadFile === right.loadFile && left.files.length === right.files.length && left.files.every((file, index) => {
    const other = right.files[index];
    return file.path === other.path && file.patch === other.patch && file.before === other.before && file.after === other.after && file.isBinary === other.isBinary;
  });
}

export function desktopPanelTabKey(intent: DesktopPanelIntent): string {
  if (intent.kind === 'file' || intent.kind === 'preview') return JSON.stringify(intent.source ? [intent.kind, intent.source.directory, intent.source.sessionID, intent.path] : [intent.kind, intent.path]);
  if (intent.kind === 'browser') return 'desktop-browser';
  if (intent.kind === 'context') return 'context';
  if (intent.kind === 'btw') return JSON.stringify(['btw', intent.sessionID]);
  if (intent.kind === 'chat') return JSON.stringify(['chat', intent.target.directory, intent.target.sessionID]);
  if (intent.kind === 'file-diff') return JSON.stringify(['file-diff', intent.source.directory, intent.source.sessionID, intent.source.messageID, intent.source.revision ?? null, desktopPanelFilePath(intent.source.directory, intent.source.path)]);
  const source = intent.source;
  return JSON.stringify(source.kind === 'workspace'
    ? ['workspace', source.path ? desktopPanelFilePath(source.directory, source.path) : null, source.staged === true]
    : ['turn', source.sessionID, source.messageID, source.revision ?? null, source.path ? desktopPanelFilePath(source.directory, source.path) : null]);
}

/** v1 URL-keyed browser rows collapse at startup, never by replaying opens.
 * Selection is authoritative; otherwise the last browser in saved tab order wins.
 * Keep that row's position and all unrelated file/source metadata. */
export function normalizeDesktopPanelMetadata(row: DesktopPanelMetadata): DesktopPanelMetadata {
  const normalized = row.tabs.map(tab => { const intent = normalizeDesktopPanelIntent(row.scope, tab); return { ...intent, id: desktopPanelTabKey(intent) } as DesktopPanelMetadata['tabs'][number]; });
  const selected = row.tabs.findIndex(tab => tab.id === row.selectedID);
  const browser = normalized[selected]?.kind === 'browser' ? selected : normalized.findLastIndex(tab => tab.kind === 'browser');
  const tabs = normalized.filter((tab, index) => tab.kind !== 'browser' || index === browser);
  const selectedID = normalized[selected]?.id ?? tabs.at(-1)?.id ?? null;
  return { ...row, tabs, selectedID, rail: tabs.length ? row.rail : row.rail ?? 'git', activeView: tabs.length ? row.activeView : 'rail' };
}

/** Per-window UI owner. No network, persistence, global cache or shell navigation.
 * Keep this owner above route switches; dispose it with the window. The 20 most
 * recently accessed scopes are retained, matching the Web workspace scope limit.
 * Editor policy pins scopes with unsaved or unconfirmed work. Callbacks take
 * the captured scope so an old button cannot mutate the newly selected session. */
export function createDesktopPanelTabs(notify: () => void = () => {}, policy: {
  scopeProtected?: (scopeKey: string) => boolean;
  /** Defaults to scopeProtected; an owner may distinguish cold recovery from live edits. */
  scopeRestoreProtected?: (scopeKey: string) => boolean;
  tabProtected?: (scope: DesktopPanelStoredScope, tab: DesktopPanelTab) => boolean;
  canClose?: (scope: DesktopPanelScope, tab: DesktopPanelTab) => boolean;
} = {}) {
  const scopes = new Map<string, DesktopPanelSnapshot>();
  const identities = new Map<string, DesktopPanelStoredScope>();
  const listeners = new Set<() => void>();
  const protectedScope = (key: string) => policy.scopeProtected?.(key) || scopes.get(key)?.tabs.some(tab => policy.tabProtected?.(identities.get(key)!, tab));
  const publish = () => { notify(); for (const listener of listeners) { try { listener(); } catch { /* Observers cannot roll back an adopted tab action. */ } } };
  let historicalSerial = 0;
  const snapshot = (scope: DesktopPanelScope) => {
    const key = desktopPanelScopeKey(scope), value = scopes.get(key);
    if (value) { scopes.delete(key); scopes.set(key, value); }
    return value ?? empty;
  };
  const update = (scope: DesktopPanelScope, value: DesktopPanelSnapshot) => {
    const key = desktopPanelScopeKey(scope);
    if (!scopes.has(key) && scopes.size >= DESKTOP_PANEL_SCOPE_LIMIT) {
      const oldest = [...scopes.keys()].find(candidate => !protectedScope(candidate));
      if (oldest === undefined) throw new Error('desktop_panel_scope_capacity');
      scopes.delete(oldest);
      identities.delete(oldest);
    }
    scopes.delete(key); scopes.set(key, value);
    identities.set(key, { host: { hostID: scope.host.hostID }, authorityKey: scope.authorityKey, sessionID: scope.sessionID, directory: resourcePath(scope.directory) });
    publish();
  };
  return {
    snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Metadata only. Historical snapshots/closures remain live in this owner;
     * without an authoritative historical resolver they must not become fake restored tabs. */
    metadata(): DesktopPanelMetadata[] {
      return [...scopes].map(([key, value]) => {
        const tabs: DesktopPanelMetadata['tabs'] = [];
        for (const tab of value.tabs) {
          if (tab.kind === 'file') tabs.push({ id: tab.id, kind: 'file', path: tab.path, ...(tab.source ? { source: { ...tab.source } } : {}), ...(tab.targetLine === undefined ? {} : { targetLine: tab.targetLine }) });
          else if (tab.kind === 'preview') tabs.push({ id: tab.id, kind: 'preview', path: tab.path, ...(tab.source ? { source: { ...tab.source } } : {}) });
          else if (tab.kind === 'browser') tabs.push({ id: tab.id, kind: 'browser', url: tab.url });
          else if (tab.kind === 'context') tabs.push({ id: tab.id, kind: 'context' });
          else if (tab.kind === 'btw') tabs.push({ id: tab.id, kind: 'btw', sessionID: tab.sessionID });
          else if (tab.kind === 'chat') tabs.push({ id: tab.id, kind: 'chat', target: { ...tab.target } });
          else if (tab.source.kind === 'workspace') tabs.push({ id: tab.id, kind: 'diff', source: { kind: 'workspace', directory: tab.source.directory, ...(tab.source.path ? { path: tab.source.path } : {}), ...(tab.source.staged === undefined ? {} : { staged: tab.source.staged }) } });
        }
        return { scope: identities.get(key)!, tabs, selectedID: tabs.some(tab => tab.id === value.selectedID) ? value.selectedID : tabs.at(-1)?.id ?? null, rail: value.rail, activeView: tabs.length ? value.activeView : 'rail' };
      });
    },
    /** Startup metadata can only fill absent scopes, never replace live/editor work.
     * Input is validated by the metadata codec. No editor read or dirty guess occurs here. */
    restoreMetadata(rows: readonly DesktopPanelMetadata[]) {
      let changed = false;
      for (const row of rows.slice(-DESKTOP_PANEL_SCOPE_LIMIT).reverse()) {
        const key = desktopPanelScopeKey(row.scope);
        if (scopes.has(key) || (policy.scopeRestoreProtected ?? policy.scopeProtected)?.(key) || scopes.size >= DESKTOP_PANEL_SCOPE_LIMIT) continue;
        const restored = normalizeDesktopPanelMetadata(row);
        const value: DesktopPanelSnapshot = { tabs: restored.tabs, selectedID: restored.selectedID, rail: restored.rail, activeView: restored.activeView };
        // Restored scopes are older than every local action; maintain their LRU order.
        const existing = [...scopes]; scopes.clear(); scopes.set(key, value); for (const entry of existing) scopes.set(...entry);
        identities.set(key, { ...row.scope, host: { ...row.scope.host } }); changed = true;
      }
      if (changed) publish();
      return changed;
    },
    reorder(scope: DesktopPanelScope, activeID: string, overID: string) {
      const value = snapshot(scope), from = value.tabs.findIndex(tab => tab.id === activeID), to = value.tabs.findIndex(tab => tab.id === overID);
      if (from < 0 || to < 0 || from === to) return false;
      const tabs = [...value.tabs], [moved] = tabs.splice(from, 1); tabs.splice(to, 0, moved);
      update(scope, { ...value, tabs }); return true;
    },
    open(scope: DesktopPanelScope, intent: DesktopPanelIntent) {
      const normalized = normalizeDesktopPanelIntent(scope, intent), value = snapshot(scope), key = desktopPanelTabKey(normalized);
      const historical = normalized.kind === 'file-diff' || normalized.kind === 'diff' && normalized.source.kind === 'turn';
      const existing = value.tabs.find(tab => historical
        ? (tab.kind === 'diff' || tab.kind === 'file-diff') && desktopPanelTabKey(tab) === key && (normalized.kind === 'diff' || normalized.kind === 'file-diff') && sameHistoricalSnapshot(tab.source, normalized.source, normalized.kind === 'file-diff')
        : tab.id === key);
      const id = existing?.id ?? (historical && value.tabs.some(tab => desktopPanelTabKey(tab) === key) ? key + ':' + (++historicalSerial) : key);
      if (existing && (existing.kind === 'file' && normalized.kind === 'file' && existing.targetLine !== normalized.targetLine
        || existing.kind === 'browser' && normalized.kind === 'browser' && normalized.url !== '' && existing.url !== normalized.url
        || existing.kind === 'chat' && normalized.kind === 'chat' && (existing.target.title !== normalized.target.title || existing.target.messageID !== normalized.target.messageID)
        || existing.kind === 'file-diff' && normalized.kind === 'file-diff' && existing.source.targetLine !== normalized.source.targetLine)) {
        update(scope, { ...value, activeView: 'preview', selectedID: id, tabs: value.tabs.map(tab => tab.id === id ? { ...normalized, id } : tab) });
      } else if (!existing) update(scope, { ...value, activeView: 'preview', selectedID: id, tabs: [...value.tabs, { ...normalized, id }] });
      else if (value.selectedID !== id || value.activeView !== 'preview') update(scope, { ...value, activeView: 'preview', selectedID: id });
      return id;
    },
    /** A validated, current browser navigation receipt, not address-bar typing or
     * a new open intent. Never steals selection, clears a URL or creates a scope. */
    setBrowserURL(scope: DesktopPanelScope, id: string, url: string) {
      const normalized = normalizeDesktopPanelIntent(scope, { kind: 'browser', url });
      if (normalized.kind !== 'browser' || normalized.url === '') return false;
      const value = snapshot(scope), tab = value.tabs.find(tab => tab.id === id);
      if (tab?.kind !== 'browser' || tab.url === normalized.url) return false;
      update(scope, { ...value, tabs: value.tabs.map(tab => tab.id === id ? { ...normalized, id } : tab) });
      return true;
    },
    select(scope: DesktopPanelScope, id: string) {
      const value = snapshot(scope);
      if ((id !== value.selectedID || value.activeView !== 'preview') && value.tabs.some(tab => tab.id === id)) update(scope, { ...value, activeView: 'preview', selectedID: id });
    },
    close(scope: DesktopPanelScope, id: string) {
      const value = snapshot(scope), index = value.tabs.findIndex(tab => tab.id === id);
      if (index < 0) return true;
      if (policy.canClose?.(scope, value.tabs[index]) === false) return false;
      const tabs = value.tabs.filter(tab => tab.id !== id);
      // Prefer the left neighbor, then the right. Closing a background tab keeps selection.
      const selectedID = value.selectedID === id ? value.tabs[index - 1]?.id ?? value.tabs[index + 1]?.id ?? null : value.selectedID;
      update(scope, { ...value, tabs, selectedID, activeView: tabs.length ? value.activeView : 'rail', rail: tabs.length ? value.rail : value.rail ?? 'git' });
      return true;
    },
    setRail(scope: DesktopPanelScope, rail: DesktopPanelRail) {
      const value = snapshot(scope);
      rail = value.tabs.length ? rail : rail ?? value.rail ?? 'git';
      const activeView = rail === null ? 'preview' : 'rail';
      if (value.rail !== rail || value.activeView !== activeView) update(scope, { ...value, rail, activeView });
    },
    dispose() { if ([...scopes.keys()].some(protectedScope)) return false; scopes.clear(); identities.clear(); publish(); return true; },
  };
}

import { DESKTOP_PANEL_SCOPE_LIMIT, desktopPanelScopeKey, desktopPanelTabKey, normalizeDesktopPanelIntent, normalizeDesktopPanelMetadata, type DesktopPanelMetadata, type DesktopPanelMetadataIntent, type createDesktopPanelTabs } from './desktop-panel-model';

export const DESKTOP_PANEL_METADATA_KEY = 'desktop.panel-tabs.v1';
export const DESKTOP_PANEL_METADATA_LIMITS = { bytes: 512 * 1024, tabsPerScope: 256, string: 8192 };
export type DesktopPanelMetadataStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<unknown>; removeItem(key: string): Promise<unknown> };
export type DesktopPanelMetadataState = { hydrated: boolean; reading: boolean; writing: boolean; pending: boolean; error: '' | 'read' | 'write' | 'conflict' | 'rollback' | 'capacity' };
type Tabs = Pick<ReturnType<typeof createDesktopPanelTabs>, 'subscribe' | 'metadata' | 'restoreMetadata'>;
const invalid = (): never => { throw new Error('desktop_panel_metadata_invalid'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) => { if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid(); };
const text = (value: unknown): string => typeof value === 'string' && !!value.trim() && value.length <= DESKTOP_PANEL_METADATA_LIMITS.string && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid();
function bounded(raw: string) {
  let bytes = 0;
  if (raw.length > DESKTOP_PANEL_METADATA_LIMITS.bytes) throw new Error('desktop_panel_metadata_capacity');
  for (const char of raw) { const code = char.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  if (bytes > DESKTOP_PANEL_METADATA_LIMITS.bytes) throw new Error('desktop_panel_metadata_capacity');
}
/** Strict, versioned whitelist: no lease, text, patch, callbacks, credentials or dirty state. */
export function decodeDesktopPanelMetadata(raw: string): DesktopPanelMetadata[] {
  bounded(raw);
  const root = object(JSON.parse(raw)); exact(root, ['version', 'scopes']);
  if (root.version !== 1 || !Array.isArray(root.scopes) || root.scopes.length > DESKTOP_PANEL_SCOPE_LIMIT) invalid();
  const seen = new Set<string>();
  return (root.scopes as unknown[]).map(value => {
    const row = object(value); exact(row, ['scope', 'tabs', 'selectedID', 'rail', 'activeView']);
    const identity = object(row.scope), host = object(identity.host); exact(identity, ['host', 'authorityKey', 'sessionID', 'directory']); exact(host, ['hostID']);
    const scope: DesktopPanelMetadata['scope'] = { host: { hostID: text(host.hostID) }, authorityKey: text(identity.authorityKey), sessionID: identity.sessionID === null ? null : text(identity.sessionID), directory: text(identity.directory) };
    const key = desktopPanelScopeKey(scope); if (seen.has(key)) invalid(); seen.add(key);
    if (!Array.isArray(row.tabs) || row.tabs.length > DESKTOP_PANEL_METADATA_LIMITS.tabsPerScope || ![null, 'git', 'files'].includes(row.rail as null) || !['rail', 'preview'].includes(String(row.activeView))) invalid();
    const ids = new Set<string>();
    const tabs = (row.tabs as unknown[]).map(value => {
      const tab = object(value); let intent: DesktopPanelMetadataIntent;
      if (tab.kind === 'file' || tab.kind === 'preview') {
        exact(tab, ['id', 'kind', 'path'], tab.kind === 'file' ? ['targetLine', 'source'] : ['source']);
        if (tab.targetLine !== undefined && (!Number.isSafeInteger(tab.targetLine) || Number(tab.targetLine) < 1)) invalid();
        const source = tab.source === undefined ? undefined : object(tab.source);
        if (source) exact(source, ['directory', 'sessionID']);
        intent = { kind: tab.kind, path: text(tab.path), ...(source ? { source: { directory: text(source.directory), sessionID: text(source.sessionID) } } : {}), ...(tab.targetLine === undefined ? {} : { targetLine: Number(tab.targetLine) }) };
      } else if (tab.kind === 'context') { exact(tab, ['id', 'kind']); intent = { kind: 'context' }; }
      else if (tab.kind === 'btw') { exact(tab, ['id', 'kind', 'sessionID']); intent = { kind: 'btw', sessionID: text(tab.sessionID) }; }
      else if (tab.kind === 'chat') {
        exact(tab, ['id', 'kind', 'target']); const target = object(tab.target); exact(target, ['sessionID', 'directory'], ['title', 'messageID']);
        intent = { kind: 'chat', target: { sessionID: text(target.sessionID), directory: text(target.directory),
          ...(target.title === undefined ? {} : { title: text(target.title) }), ...(target.messageID === undefined ? {} : { messageID: text(target.messageID) }) } };
      }
      else if (tab.kind === 'browser') { exact(tab, ['id', 'kind', 'url']); intent = { kind: 'browser', url: tab.url === '' ? '' : text(tab.url) }; }
      else if (tab.kind === 'diff') {
        exact(tab, ['id', 'kind', 'source']); const source = object(tab.source); exact(source, ['kind', 'directory'], ['path', 'staged']);
        if (source.kind !== 'workspace' || source.staged !== undefined && typeof source.staged !== 'boolean') invalid();
        intent = { kind: 'diff', source: { kind: 'workspace', directory: text(source.directory), ...(source.path === undefined ? {} : { path: text(source.path) }), ...(source.staged === undefined ? {} : { staged: source.staged as boolean }) } };
      } else return invalid();
      const normalized = normalizeDesktopPanelIntent(scope, intent), id = desktopPanelTabKey(normalized);
      const storedID = text(tab.id);
      if (id !== storedID && !(normalized.kind === 'browser' && storedID === JSON.stringify(['browser', normalized.url])) || ids.has(storedID)) invalid(); ids.add(storedID);
      return { ...normalized, id: storedID } as DesktopPanelMetadata['tabs'][number];
    });
    if (row.selectedID !== null && (!ids.has(text(row.selectedID))) || row.selectedID === null && tabs.length > 0) invalid();
    return normalizeDesktopPanelMetadata({ scope, tabs, selectedID: row.selectedID as string | null, rail: row.rail as DesktopPanelMetadata['rail'], activeView: row.activeView as DesktopPanelMetadata['activeView'] });
  });
}
export function encodeDesktopPanelMetadata(rows: DesktopPanelMetadata[]): string {
  const raw = JSON.stringify({ version: 1, scopes: rows }); decodeDesktopPanelMetadata(raw); return raw;
}

/** One window, one serialized metadata lane. Storage is NOT a document journal or
 * durability barrier. Failed writes keep live tabs and restore the last observed value;
 * read failures never authorize overwriting an unread prior. Retry is explicit. */
export function createDesktopPanelTabsPersistence(tabs: Tabs, storage: DesktopPanelMetadataStorage, notify: () => void = () => {}) {
  let alive = true, adopting = false, prior: string | null = null, revision = tabs.metadata().length ? 1 : 0, savedRevision = 0;
  let state: DesktopPanelMetadataState = { hydrated: false, reading: false, writing: false, pending: revision > 0, error: '' };
  let readFlight: Promise<boolean> | undefined, writeFlight: Promise<boolean> | undefined;
  const update = (patch: Partial<DesktopPanelMetadataState>) => { state = { ...state, ...patch }; if (alive) notify(); };
  const unsubscribe = tabs.subscribe(() => {
    if (!alive || adopting) return;
    revision++; update({ pending: true });
    if (state.hydrated && !state.error) void flush();
  });
  async function flush(): Promise<boolean> {
    if (writeFlight) return writeFlight;
    if (!alive || !state.hydrated || state.error) return false;
    const work = async () => {
      update({ writing: true });
      try {
        while (alive && savedRevision !== revision) {
          const ticket = revision; let raw: string;
          try { raw = encodeDesktopPanelMetadata(tabs.metadata()); } catch { update({ error: 'capacity', pending: true }); return false; }
          if (raw !== prior) {
            if (await storage.getItem(DESKTOP_PANEL_METADATA_KEY) !== prior) { update({ error: 'conflict', pending: true }); return false; }
            if (!alive) return false;
            try { await storage.setItem(DESKTOP_PANEL_METADATA_KEY, raw); }
            catch {
              try {
                const actual = await storage.getItem(DESKTOP_PANEL_METADATA_KEY);
                if (actual !== prior && actual !== raw) { update({ error: 'conflict', pending: true }); return false; }
                if (actual !== prior) { if (prior === null) await storage.removeItem(DESKTOP_PANEL_METADATA_KEY); else await storage.setItem(DESKTOP_PANEL_METADATA_KEY, prior); }
              } catch { update({ error: 'rollback', pending: true }); return false; }
              update({ error: 'write', pending: true }); return false;
            }
            prior = raw;
          }
          savedRevision = ticket;
        }
        update({ pending: savedRevision !== revision }); return alive;
      } catch { update({ error: 'write', pending: true }); return false; }
      finally { update({ writing: false }); }
    };
    writeFlight = Promise.resolve().then(work).finally(() => { writeFlight = undefined; }); return writeFlight;
  }
  function restore(): Promise<boolean> {
    if (readFlight) return readFlight;
    if (state.hydrated) return Promise.resolve(true);
    readFlight = (async () => {
      update({ reading: true, error: '' });
      try {
        const raw = await storage.getItem(DESKTOP_PANEL_METADATA_KEY), rows = raw === null ? [] : decodeDesktopPanelMetadata(raw);
        if (!alive) return false;
        adopting = true;
        try { tabs.restoreMetadata(rows); } finally { adopting = false; }
        prior = raw; update({ hydrated: true, error: '' });
        // Persist a merge if local actions preceded this read; never replace them.
        if (revision !== savedRevision) return await flush();
        return true;
      } catch { update({ error: 'read' }); return false; }
      finally { update({ reading: false }); }
    })().finally(() => { readFlight = undefined; }); return readFlight;
  }
  return {
    state: () => state, restore, flush,
    async retry() { if (!state.hydrated) return restore(); if (state.error === 'conflict' || state.error === 'rollback') return false; update({ error: '' }); return flush(); },
    dispose() { alive = false; unsubscribe(); },
  };
}

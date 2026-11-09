import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { terminalCatalogFrom, terminalCatalogValue, type TerminalCatalog } from './terminal-catalog';
import { createTerminalPreviewScanner, terminalPreviewURL, terminalActionURL, extractTerminalActionURL } from './terminal-preview';
import { terminalActionInput, type TerminalAction } from './terminal-actions';
import { terminalDirectoryPath } from './terminal-path';
export { terminalDirectory } from './terminal-path';
/** Native-issued opaque snapshot; never infer a lease from a JS generation. */
export type TerminalScope = RuntimeScope;
export type TerminalSize = { cols: number; rows: number };
export type TerminalChunk = { id: number; data: string };
export type TerminalPhase = 'idle' | 'creating' | 'connecting' | 'live' | 'paused' | 'failed' | 'exited' | 'closing';
export type TerminalTab = {
  id: string; directory: string; sessionId?: string; phase: TerminalPhase;
  chunks: TerminalChunk[]; length: number; cursor: number; error?: string;
  exitCode?: number; signal?: number; size?: TerminalSize; createUnknown?: boolean;
  label?: string; iconKey?: string; actionID?: string; actionStatus?: 'armed' | 'sending' | 'running' | 'waiting-for-preview' | 'stopping' | 'unknown';
  previewUrl?: string; previewLocked?: boolean; previewAutoOpened?: boolean; restored?: boolean;
  replayCursor?: number;
};
export type TerminalSnapshot = { directory: string; tabs: readonly TerminalTab[]; activeId?: string; invalidated: boolean; persistenceError?: boolean };
export type TerminalCall = (name: string, body: Record<string, unknown>) => Promise<unknown>;
export type TerminalKey = 'esc' | 'tab' | 'enter' | 'backspace' | 'delete' | 'home' | 'end' | 'page-up' | 'page-down' | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right';
export type TerminalModifier = 'ctrl' | 'cmd' | null;
const sequences: Record<TerminalKey, string> = {
  esc: '\x1b', tab: '\t', enter: '\r', backspace: '\x7f', delete: '\x1b[3~', home: '\x1b[H', end: '\x1b[F',
  'page-up': '\x1b[5~', 'page-down': '\x1b[6~', 'arrow-up': '\x1b[A', 'arrow-down': '\x1b[B', 'arrow-left': '\x1b[D', 'arrow-right': '\x1b[C',
};
export function terminalKeySequence(key: TerminalKey, modifier: TerminalModifier = null): string {
  const arrows: Partial<Record<TerminalKey, string>> = { 'arrow-up': 'A', 'arrow-down': 'B', 'arrow-left': 'D', 'arrow-right': 'C' };
  const suffix = arrows[key];
  return modifier && suffix ? `\x1b[1;${modifier === 'ctrl' ? '5' : '3'}${suffix}` : sequences[key];
}
export function terminalModifiedText(data: string, modifier: TerminalModifier): string {
  return modifier && /^[a-z]/i.test(data) ? String.fromCharCode(data[0].toUpperCase().charCodeAt(0) & 31) : data;
}
export function terminalSize(value: TerminalSize): boolean {
  return Number.isInteger(value.cols) && Number.isInteger(value.rows) && value.cols >= 2 && value.cols <= 1000 && value.rows >= 1 && value.rows <= 1000;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
let nextOwner = 0;
let nextAttachment = 0;
export type TerminalInputOutcome = 'accepted' | 'rejected' | 'unknown';
export function terminalInputBytes(text: string): number {
  let bytes = 0;
  for (const point of text) { const code = point.codePointAt(0)!; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return bytes;
}

/** Retain one workspace above route lifetime. Hiding suspends; closeTab alone kills a PTY. */
export function createTerminalWorkspace(options: {
  scope: TerminalScope; call: TerminalCall; subscribe: (receive: (event: unknown) => void) => () => void;
  changed: (snapshot: TerminalSnapshot) => void;
  catalog?: unknown; persist?: (value: TerminalCatalog) => Promise<void>;
  probePreview?: (url: string) => Promise<boolean>; openPreview?: (directory: string, url: string, mode: 'preview' | 'external') => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const scope = runtimeScopeFrom(options.scope);
  if (!scope) throw new Error('scope_required');
  const prefix = `terminal-${Date.now().toString(36)}-${++nextOwner}-${Math.random().toString(36).slice(2)}-`;
  const directories = new Map<string, { tabs: TerminalTab[]; activeId: string }>();
  const flights = new Map<string, Promise<void>>();
  const resizes = new Set<string>();
  const closing = new Set<string>();
  const scanners = new Map<string, ReturnType<typeof createTerminalPreviewScanner>>();
  const actionInputs = new Map<string, { action: TerminalAction; input: string }>();
  const actionWatches = new Map<string, { tail: string; opened: boolean; preview: boolean }>();
  const stops = new Set<string>(), previewWaits = new Map<string, ReturnType<typeof setTimeout>>();
  const clearPreviewWait = (id: string) => { const timer = previewWaits.get(id); if (timer !== undefined) clearTimeout(timer); previewWaits.delete(id); };
  let nextTab = 0, directory = '', active = false, invalidated = false, disposed = false;
  let attached: string | undefined, epoch = ++nextAttachment;
  let inputPending = false;
  let persistenceError = false, saved = '', saving = Promise.resolve();
  const restored = terminalCatalogFrom(options.catalog, scope.hostID);
  if (options.catalog !== undefined && !restored) throw new Error('invalid_terminal_catalog');
  if (restored) for (const entry of restored.directories) {
    const tabs: TerminalTab[] = entry.tabs.map(tab => ({ id: tab.id, directory: entry.directory, sessionId: tab.sessionId,
      phase: tab.lifecycle === 'exited' ? 'exited' : tab.sessionId ? 'paused' : 'idle', chunks: [], length: 0, cursor: 0,
      label: tab.label, iconKey: tab.iconKey, restored: !!tab.sessionId, createUnknown: tab.createUnknown,
      ...(tab.createUnknown ? { phase: 'failed' as const, error: 'create_unknown' } : {}) }));
    directories.set(entry.directory, { tabs, activeId: entry.activeId });
  }
  const current = () => directories.get(directory);
  const selected = () => current()?.tabs.find(tab => tab.id === current()?.activeId);
  const snapshot = (): TerminalSnapshot => ({ directory, tabs: current()?.tabs.slice() ?? [], activeId: current()?.activeId, invalidated, persistenceError });
  const catalog = () => terminalCatalogValue(scope.hostID, directories);
  const publish = () => {
    if (disposed) return;
    options.changed(snapshot());
  };
  const persist = () => {
    if (!options.persist || !valid()) return saving;
    const value = catalog(), encoded = JSON.stringify(value);
    if (encoded === saved && !persistenceError) return saving;
    saved = encoded;
    saving = saving.then(async () => {
      if (!valid()) return;
      try { await options.persist!(value); if (valid()) { persistenceError = false; publish(); } }
      catch { if (valid()) { persistenceError = true; publish(); } }
    });
    return saving;
  };
  const valid = () => !disposed && !invalidated;
  const body = (tab: TerminalTab) => ({ expectedHost: scope, owner: tab.id, directory: tab.directory, sessionId: tab.sessionId });
  const fail = (tab: TerminalTab, code: string) => { if (!valid()) return; tab.phase = 'failed'; tab.error = code; publish(); };
  const find = (id: string) => { for (const entry of directories.values()) { const tab = entry.tabs.find(value => value.id === id); if (tab) return tab; } };
  const detach = () => {
    const id = attached, attachment = epoch; attached = undefined; const stoppedEpoch = epoch = ++nextAttachment;
    const tab = id && find(id);
    if (tab) {
      if (tab.phase === 'live' || tab.phase === 'connecting') tab.phase = 'paused';
      void options.call('terminal.detach', { expectedHost: scope, owner: tab.id, attachment }).catch(() => { if (epoch === stoppedEpoch) fail(tab, 'detach_failed'); });
    }
  };
  const fresh = (path: string): TerminalTab => ({ id: `${prefix}${++nextTab}`, directory: path, phase: 'idle', chunks: [], length: 0, cursor: 0 });
  async function preview(tab: TerminalTab, url: string, automatic = false, mode: 'preview' | 'external' = 'preview') {
    if (!valid() || !active || selected() !== tab || !options.openPreview || !terminalActionURL(url)) return false;
    try { await options.openPreview(tab.directory, url, mode); if (valid() && automatic) tab.previewAutoOpened = true; return valid(); }
    catch { if (valid()) { tab.error = 'preview_failed'; publish(); } return false; }
  }
  function scan(tab: TerminalTab, data: string) {
    const watch = actionWatches.get(tab.id);
    if (watch && !watch.opened && !tab.previewLocked) {
      const combined = watch.tail + data, url = extractTerminalActionURL(combined); watch.tail = combined.slice(-512);
      if (url) {
        watch.opened = true; clearPreviewWait(tab.id); tab.actionStatus = 'running';
        if (watch.preview) { tab.previewUrl = url; tab.previewLocked = true; }
        void preview(tab, url, true, watch.preview ? 'preview' : 'external');
      }
    }
    if (tab.previewLocked || !options.probePreview) return;
    let scanner = scanners.get(tab.id);
    if (!scanner) { scanner = createTerminalPreviewScanner(); scanners.set(tab.id, scanner); }
    const candidate = scanner.push(data);
    if (!candidate || candidate === tab.previewUrl) return;
    const session = tab.sessionId, token = epoch;
    void options.probePreview(candidate).then(ok => {
      if (!valid() || !active || token !== epoch || find(tab.id) !== tab || tab.sessionId !== session || !ok || tab.previewLocked) return;
      tab.previewUrl = candidate;
      if (tab.actionStatus === 'waiting-for-preview') { clearPreviewWait(tab.id); tab.actionStatus = 'running'; void preview(tab, candidate, true); }
      publish();
    }).catch(() => { if (valid() && token === epoch) { tab.error = 'preview_probe_failed'; publish(); } });
  }
  async function dispatchAction(tab: TerminalTab) {
    const pending = actionInputs.get(tab.id);
    if (!pending || tab.actionStatus !== 'armed' || selected() !== tab || tab.phase !== 'live' || !active) return;
    actionInputs.delete(tab.id); tab.actionStatus = 'sending'; publish();
    if (pending.action.autoOpenUrl) actionWatches.set(tab.id, { tail: '', opened: !!pending.action.openUrl, preview: pending.action.id === '__yuri_auto_discover_preview__' });
    try {
      await options.call('terminal.input', { ...body(tab), data: pending.input });
      if (!valid()) return;
      tab.actionStatus = pending.action.autoOpenUrl && !pending.action.openUrl && !actionWatches.get(tab.id)?.opened ? 'waiting-for-preview' : 'running';
      if (tab.actionStatus === 'waiting-for-preview') {
        clearPreviewWait(tab.id);
        previewWaits.set(tab.id, setTimeout(() => { previewWaits.delete(tab.id); if (valid() && tab.actionStatus === 'waiting-for-preview') { tab.actionStatus = 'running'; publish(); } }, 15_000));
      }
      if (pending.action.autoOpenUrl && pending.action.openUrl) {
        const url = terminalActionURL(pending.action.openUrl);
        if (url) { tab.previewUrl = url; tab.previewLocked = true; void preview(tab, url, true); }
        else tab.error = 'invalid_preview_url';
      }
    } catch { if (valid()) { tab.actionStatus = 'unknown'; tab.error = 'action_input_unknown'; } }
    publish();
  }
  async function resizeLive(tab: TerminalTab) {
    if (resizes.has(tab.id) || !tab.size || tab.phase !== 'live' || !active || attached !== tab.id || !valid()) return;
    resizes.add(tab.id);
    const startEpoch = epoch;
    try {
      let previous: TerminalSize;
      do {
        previous = tab.size!;
        await options.call('terminal.resize', { ...body(tab), ...previous });
      } while (valid() && active && attached === tab.id && epoch === startEpoch && tab.phase === 'live' && tab.size !== previous);
    } catch { if (epoch === startEpoch) fail(tab, 'resize_failed'); }
    finally { resizes.delete(tab.id); if (epoch !== startEpoch) void resizeLive(tab); }
  }
  function attach(tab: TerminalTab) {
    if (!valid() || !active || selected() !== tab || !tab.size || attached === tab.id || !tab.sessionId || ['failed', 'exited', 'closing'].includes(tab.phase)) return;
    detach(); attached = tab.id; tab.phase = 'connecting'; tab.error = undefined; publish();
    const startEpoch = epoch;
    void (async () => {
      if (tab.restored) await options.call('terminal.restore', body(tab));
      if (!valid() || !active || attached !== tab.id || startEpoch !== epoch) return;
      await options.call('terminal.attach', { ...body(tab), cursor: tab.replayCursor ?? tab.cursor, attachment: epoch });
    })().catch(() => {
      if (attached === tab.id && epoch === startEpoch) { attached = undefined; fail(tab, 'connection_failed'); }
    });
  }
  function ensure(tab: TerminalTab) {
    if (!valid() || !active || selected() !== tab || !tab.size || flights.has(tab.id) || ['failed', 'exited', 'closing'].includes(tab.phase)) return;
    if (tab.sessionId) { attach(tab); return; }
    tab.phase = 'creating'; tab.error = undefined; publish();
    const flight = (async () => {
      try {
        tab.createUnknown = true;
        await persist();
        if (persistenceError || !valid()) throw new Error('create_not_admitted');
        if (closing.has(tab.id)) { tab.createUnknown = false; return; }
        const result = record(await options.call('terminal.create', { ...body(tab), ...tab.size }));
        if (typeof result.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.sessionId)) throw new Error('invalid_response');
        tab.sessionId = result.sessionId; tab.createUnknown = false; tab.phase = closing.has(tab.id) ? 'closing' : 'paused';
        void persist();
        if (valid()) attach(tab);
      } catch {
        // /create has no idempotency key. Unknown completion MUST NOT silently spawn a second shell.
        tab.createUnknown = true; if (!closing.has(tab.id)) fail(tab, 'create_unknown'); void persist();
      } finally { flights.delete(tab.id); publish(); }
    })();
    flights.set(tab.id, flight);
  }
  const unsubscribe = options.subscribe(value => {
    const event = record(value);
    let eventScope: RuntimeScope | null;
    try { eventScope = runtimeScopeFrom(event.expectedHost); } catch { return; }
    if (!valid() || !sameRuntimeScope(eventScope, scope) || typeof event.owner !== 'string') return;
    const tab = find(event.owner);
    if (!tab || tab.phase === 'closing' || event.sessionId !== tab.sessionId || event.attachment !== epoch || !active) return;
    if (event.type === 'resume') { if (tab.phase === 'paused') ensure(tab); return; }
    if (event.owner !== attached) return;
    if (event.type === 'connected') { tab.phase = 'live'; tab.error = event.replayUnavailable === true ? 'replay_unavailable' : undefined; void resizeLive(tab); void dispatchAction(tab); }
    else if (event.type === 'data') {
      if (typeof event.data !== 'string' || event.data.length > 1_000_000 || !Number.isSafeInteger(event.id) || Number(event.id) <= tab.cursor) return;
      const id = Number(event.id);
      // Presentation IDs may skip frames emitted just before detach; only the
      // native server replay cursor can prove a wire gap on current bridges.
      if (event.replayGap === true || event.cursor === undefined && id > tab.cursor + 1) { tab.error = 'replay_gap'; }
      if (Number.isSafeInteger(event.cursor)) tab.replayCursor = Number(event.cursor);
      tab.cursor = id; tab.chunks.push({ id, data: event.data }); tab.length += event.data.length;
      while (tab.length > 1_000_000 && tab.chunks.length > 1) tab.length -= tab.chunks.shift()!.data.length;
      scan(tab, event.data);
    } else if (event.type === 'exit') {
      tab.phase = 'exited'; tab.exitCode = typeof event.exitCode === 'number' ? event.exitCode : undefined;
      tab.signal = typeof event.signal === 'number' ? event.signal : undefined;
      tab.error = 'session_ended'; attached = undefined;
      clearPreviewWait(tab.id); tab.sessionId = undefined; tab.actionStatus = undefined; void persist();
    } else if (event.type === 'error') {
      attached = undefined;
      if (event.code === 'session_not_found' && tab.restored) {
        tab.restored = false; tab.sessionId = undefined; tab.phase = 'idle'; tab.cursor = 0; tab.replayCursor = 0; tab.chunks = []; tab.length = 0;
        void persist(); ensure(tab);
      } else fail(tab, typeof event.code === 'string' ? event.code : 'connection_failed');
    } else if (event.type === 'paused') {
      attached = undefined; if (tab.phase === 'live' || tab.phase === 'connecting') tab.phase = 'paused';
    } else return;
    publish();
  });
  return {
    snapshot,
    setDirectory(path: string) {
      const normalized = terminalDirectoryPath(path);
      if (!valid() || normalized === null) return false;
      path = normalized;
      if (!directories.has(path) && directories.size >= 128) return false;
      if (path !== directory) detach();
      directory = path;
      if (!current()) { const tab = fresh(path); directories.set(path, { tabs: [tab], activeId: tab.id }); }
      const tab = selected(); if (tab) ensure(tab); publish(); void persist(); return true;
    },
    setActive(value: boolean, authority: TerminalScope = scope) {
      if (!valid()) return;
      if (!sameRuntimeScope(authority, scope)) {
        detach(); active = false; invalidated = true; previewWaits.forEach(clearTimeout); previewWaits.clear(); publish(); return;
      }
      active = value;
      if (!value) detach(); else { const tab = selected(); if (tab) ensure(tab); }
      publish();
    },
    resize(size: TerminalSize) {
      const tab = selected(); if (!valid() || !tab || !terminalSize(size)) return;
      if (tab.size?.cols === size.cols && tab.size.rows === size.rows) return;
      tab.size = { ...size };
      if (tab.phase === 'live') void resizeLive(tab); else ensure(tab);
    },
    createTab() {
      if (!valid() || !current() || current()!.tabs.length >= 64) return;
      detach(); const tab = fresh(directory); current()!.tabs.push(tab); current()!.activeId = tab.id; publish(); void persist(); return tab.id;
    },
    selectTab(id: string) {
      if (!valid() || !current()?.tabs.some(tab => tab.id === id) || current()!.activeId === id) return;
      detach(); current()!.activeId = id; const tab = selected(); if (tab) ensure(tab); publish(); void persist();
    },
    retry() {
      const tab = selected();
      if (!valid() || !active || !tab || tab.createUnknown || tab.phase !== 'failed') return;
      if (tab.error === 'close_unconfirmed') return;
      detach();
      tab.phase = 'paused'; tab.error = undefined; ensure(tab); publish();
    },
    async closeTab(id: string) {
      const tab = find(id); if (!valid() || !tab || tab.phase === 'closing') return false;
      closing.add(id);
      if (attached === id) detach(); tab.phase = 'closing'; publish();
      await flights.get(id);
      if (!valid()) return false;
      try {
        // Native registry owns late create receipts; omit sessionId when create result is unknown.
        const result = tab.sessionId || tab.createUnknown ? record(await options.call('terminal.close', body(tab))) : { closed: true };
        if (result.closed !== true) throw new Error('close_unconfirmed');
        const entry = directories.get(tab.directory)!; const index = entry.tabs.indexOf(tab);
        entry.tabs.splice(index, 1);
        clearPreviewWait(id); actionInputs.delete(id); actionWatches.delete(id); scanners.delete(id);
        if (!entry.tabs.length) entry.tabs.push(fresh(tab.directory));
        if (entry.activeId === id) entry.activeId = entry.tabs[Math.min(index, entry.tabs.length - 1)].id;
        const next = selected(); if (next) ensure(next); publish(); void persist(); return true;
      } catch { fail(tab, 'close_unconfirmed'); return false; }
      finally { closing.delete(id); }
    },
    catalog,
    flushPersistence: () => persist(),
    reorder(activeId: string, overId: string) {
      if (!valid() || !current()) return false;
      const tabs = current()!.tabs, from = tabs.findIndex(tab => tab.id === activeId), to = tabs.findIndex(tab => tab.id === overId);
      if (from < 0 || to < 0 || from === to) return false;
      tabs.splice(to, 0, tabs.splice(from, 1)[0]); publish(); void persist(); return true;
    },
    renameTab(id: string, label: string, iconKey?: string) {
      const tab = find(id); if (!valid() || !tab || !label.trim() || label.length > 256) return false;
      tab.label = label.trim(); tab.iconKey = iconKey; publish(); void persist(); return true;
    },
    runAction(action: TerminalAction) {
      if (!valid() || !active || !current()) return false;
      const input = terminalActionInput(action);
      if (!input) return false;
      let tab = current()!.tabs.find(value => value.actionID === action.id);
      if (tab?.actionStatus) return false;
      if ((!tab || tab.phase === 'exited' || tab.createUnknown) && current()!.tabs.length >= 64) return false;
      if (!tab || tab.phase === 'exited' || tab.createUnknown) { tab = fresh(directory); current()!.tabs.push(tab); }
      detach(); current()!.activeId = tab.id; tab.actionID = action.id; tab.label = `Action: ${action.name}`; tab.iconKey = action.icon || 'play';
      tab.actionStatus = 'armed'; actionInputs.set(tab.id, { action: { ...action }, input });
      ensure(tab); publish(); void persist(); return true;
    },
    async stopAction(id: string) {
      const tab = find(id); if (!valid() || !active || !tab?.sessionId || !tab.actionStatus || stops.has(id)) return false;
      stops.add(id); clearPreviewWait(id); const sessionId = tab.sessionId;
      tab.actionStatus = 'stopping'; publish();
      try {
        try { await options.call('terminal.input', { ...body(tab), data: '\x03' }); } catch { /* Stop continues to the same explicit force-kill, never replays Ctrl-C. */ }
        await (options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
        if (!valid() || !active) { if (valid()) { tab.actionStatus = 'unknown'; tab.error = 'action_stop_interrupted'; publish(); } return false; }
        if (tab.phase === 'exited' || tab.sessionId !== sessionId) return true;
        const result = record(await options.call('terminal.forceKill', body(tab))); if (result.closed !== true) throw new Error('unconfirmed');
        if (!valid()) return false; tab.phase = 'exited'; tab.sessionId = undefined; tab.actionStatus = undefined; actionInputs.delete(id); if (attached === id) detach(); publish(); void persist(); return true;
      } catch { if (valid()) { tab.actionStatus = 'unknown'; tab.error = 'action_stop_unknown'; publish(); } return false; }
      finally { stops.delete(id); }
    },
    openPreview(id: string, url?: string, mode: 'preview' | 'external' = 'preview') {
      const tab = find(id), candidate = url ?? tab?.previewUrl;
      const normalized = candidate && terminalActionURL(candidate);
      return tab && normalized && (mode === 'preview' || mode === 'external') ? preview(tab, normalized, false, mode) : Promise.resolve(false);
    },
    async restart() {
      const tab = selected(); if (!valid() || !active || !tab || tab.phase === 'creating' || tab.phase === 'closing') return false;
      const path = directory, size = tab.size;
      const closed = await this.closeTab(tab.id);
      if (!closed || !valid() || directory !== path || !active) return false;
      if (size) this.resize(size);
      return true;
    },
    async inputOutcome(data: string, modifier: TerminalModifier = null): Promise<TerminalInputOutcome> {
      const tab = selected();
      if (!valid() || !active || !tab || tab.phase !== 'live' || attached !== tab.id || !data) return 'rejected';
      const text = terminalModifiedText(data, modifier);
      if (inputPending || terminalInputBytes(text) > 65_536) {
        tab.error = inputPending ? 'input_backpressure' : 'input_too_large'; publish(); return 'rejected';
      }
      const startEpoch = epoch;
      inputPending = true;
      try {
        const result = await options.call('terminal.input', { ...body(tab), data: text });
        if (result === true) return 'accepted';
        if (epoch === startEpoch) fail(tab, 'input_unknown'); return 'unknown';
      } catch { if (epoch === startEpoch) fail(tab, 'input_unknown'); return 'unknown'; }
      finally { inputPending = false; }
    },
    async input(data: string, modifier: TerminalModifier = null) {
      const startEpoch = epoch;
      const outcome = await this.inputOutcome(data, modifier);
      return outcome === 'accepted' && valid() && active && epoch === startEpoch && selected()?.phase === 'live';
    },
    dispose() { if (disposed) return; detach(); disposed = true; active = false; previewWaits.forEach(clearTimeout); previewWaits.clear(); unsubscribe(); },
  };
}
export type TerminalWorkspace = ReturnType<typeof createTerminalWorkspace>;

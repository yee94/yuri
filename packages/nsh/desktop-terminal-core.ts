import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { terminalDirectory, terminalSize, type TerminalCall, type TerminalSnapshot, type TerminalWorkspace } from './terminal-core';
import { createTerminalPresentation } from './terminal-presentation';
import { terminalDirectoryPath } from './terminal-path';

export const desktopTerminalRenderer = 'yuri.terminal.viewport';
export type DesktopTerminalWorkspace = { controller: TerminalWorkspace; snapshot: () => TerminalSnapshot };
export type DesktopTerminalState = {
  phase: 'idle' | 'checking' | 'mounting' | 'opening' | 'ready' | 'unavailable' | 'failed' | 'retired';
  generation: number; error?: string; inputPending?: boolean; focused?: boolean; composing?: boolean;
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Terminal-specific native HOST contract, not an NSH built-in. The Mac leaf
   * implements it; Windows uses a child-HWND WebView2 leaf. A native host must
 * register this inline component AND implement the
 * handshake, VT rendering, IME/clipboard/bracketed paste, selection, host theme,
 * measured cells (including on every selected key), acknowledged output and
 * globally increasing, single-flight retained input receipts before it may
 * advertise this capability. Commands render/focus/inputResult and every event
 * carry owner+generation+expectedHost; output ACK is exact key+serial+cursor.
 * Render's key change resets VT state then replays that key's bounded chunks.
 * inputResult accepted/rejected/unknown includes the exact key+receipt; only a
 * confirmed PTY close sends {key,status:'closed'} to discard that key's journal.
 * suspended settles an undispatched receipt after hide/tab switch as a draft.
 * Native input must never convert Meta letters to Ctrl, replay input on remount,
 * or lose rejected/backpressured/IME/pasted text. A transport-only iOS capability
 * is insufficient. */
export function desktopTerminalCapability(value: unknown, scope: RuntimeScope) {
  const entry = record(value);
  let authority: RuntimeScope | null;
  try { authority = runtimeScopeFrom(entry.expectedHost); } catch { return false; }
  return sameRuntimeScope(authority, scope) && entry.component === desktopTerminalRenderer && entry.version === 1
    && ['native', 'inline', 'vt', 'inputReceipts', 'outputAcknowledgements', 'hostAppearance', 'selection', 'ime', 'bracketedPaste'].every(key => entry[key] === true);
}

let nextOwner = 0;
/** Presentation/lifetime binding only. PTY sessions, catalogs, attachment IDs,
 * transport and unknown mutation outcomes remain in the existing workspace. */
export function createDesktopTerminalBinding(options: {
  scope: RuntimeScope; current: () => boolean; call: TerminalCall;
  createWorkspace: () => Promise<DesktopTerminalWorkspace>;
  command: (name: 'render' | 'focus' | 'inputResult', body: Record<string, unknown>) => void;
  changed: (state: DesktopTerminalState) => void;
  shortcut?: (actionId: string, keystroke: string) => void;
  timeout?: number;
}) {
  const parsed = runtimeScopeFrom(options.scope);
  if (!parsed) throw new Error('scope_required');
  const scope: RuntimeScope = parsed;
  const owner = `desktop-terminal-${++nextOwner}`;
  const presentation = createTerminalPresentation();
  let state: DesktopTerminalState = { phase: 'idle', generation: 0 }, workspace: DesktopTerminalWorkspace | undefined;
  let active = false, directory = '', disposed = false, ready = false, attempt = 0, inputUnknown: string | undefined;
  let lastReceipt = 0, awaitingAck = false, nativeAllowed = false, inputPending = false;
  let focused = false, composing = false;
  let opening: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined; };
  const current = () => !disposed && options.current();
  const demand = () => current() && active;
  const emit = (phase: DesktopTerminalState['phase'], error?: string) => {
    state = { phase, generation: state.generation, ...(error ? { error } : {}), ...(inputPending ? { inputPending: true } : {}), ...(focused ? { focused: true } : {}), ...(composing ? { composing: true } : {}) }; options.changed(state);
  };
  const pause = () => { workspace?.controller.setActive(false); };
  const fail = (error: string) => { attempt++; clear(); ready = false; focused = false; composing = false; pause(); emit('failed', error); };
  const arm = (code: string) => { clear(); deadline = setTimeout(() => { if (current()) fail(code); }, options.timeout ?? 10_000); };
  const envelope = () => ({ expectedHost: scope, owner, generation: state.generation });
  function command(name: Parameters<typeof options.command>[0], body: Record<string, unknown> = {}) {
    try { options.command(name, { ...envelope(), ...body }); return true; }
    catch { fail('native_renderer_command_failed'); return false; }
  }
  function synchronize() {
    if (!workspace) return;
    pause();
    if (!workspace.controller.setDirectory(directory)) { fail('invalid_terminal_directory'); return; }
    workspace.controller.setActive(demand() && ready && !inputUnknown && state.phase === 'ready', scope);
  }
  async function check() {
    if (!demand() || !terminalDirectory(directory) || ['checking', 'mounting', 'opening', 'ready', 'retired'].includes(state.phase)) return;
    const token = ++attempt;
    nativeAllowed = false;
    state = { phase: 'checking', generation: state.generation + 1 }; options.changed(state);
    arm('native_capability_timeout');
    try {
      const capability = await options.call('terminal.desktop.capabilities', { expectedHost: scope });
      if (!demand() || token !== attempt) return;
      clear();
      if (!desktopTerminalCapability(capability, scope)) { emit('unavailable', 'native_desktop_terminal_renderer_unavailable'); return; }
      nativeAllowed = true;
      emit('mounting'); arm('native_renderer_ready_timeout');
    } catch { if (demand() && token === attempt) { clear(); emit('unavailable', 'native_desktop_terminal_renderer_unavailable'); } }
  }
  function retire() {
    if (state.phase === 'retired') return;
    attempt++; clear(); ready = false; focused = false; composing = false; pause(); workspace?.controller.dispose(); workspace = undefined; emit('retired', 'runtime_changed');
  }
  return {
    owner, scope, state: () => state, workspace: () => workspace, canMount: () => nativeAllowed && state.phase !== 'retired',
    update(value: { active: boolean; directory: string; scope: RuntimeScope }) {
      if (disposed) return;
      if (!options.current() || !sameRuntimeScope(scope, value.scope)) { retire(); return; }
      const changedActive = active !== value.active;
      active = value.active;
      if (!active) {
        focused = false; composing = false;
        if (['checking', 'mounting', 'opening'].includes(state.phase)) { attempt++; nativeAllowed = false; emit('idle'); }
        clear(); pause(); emit(state.phase, state.error); return;
      }
      const nextDirectory = terminalDirectoryPath(value.directory);
      if (nextDirectory === null) { fail('invalid_terminal_directory'); return; }
      const changedDirectory = directory !== nextDirectory;
      directory = nextDirectory;
      if (state.phase === 'idle') void check();
      else if (state.phase === 'mounting') arm('native_renderer_ready_timeout');
      else if (changedDirectory || changedActive) { synchronize(); if (awaitingAck) arm('native_renderer_ack_timeout'); }
    },
    retry() {
      if (!demand() || state.phase === 'retired') return;
      if (state.phase === 'failed' || state.phase === 'unavailable') {
        // Unknown input belongs to the native receipt journal; remounting must
        // never discard it or replay it. Only explicit PTY close/restart resolves it.
        if (inputUnknown || inputPending) return;
        clear(); ready = false; awaitingAck = false; lastReceipt = 0; presentation.reset(); pause(); emit('idle'); void check();
      } else if (state.phase === 'ready' && workspace) { workspace.controller.retry(); void workspace.controller.flushPersistence(); }
    },
    present(snapshot: TerminalSnapshot) {
      if (!current() || !ready || state.phase !== 'ready') return;
      const tab = snapshot.tabs.find(tab => tab.id === snapshot.activeId);
      const message = presentation.next(tab?.id ?? '', tab?.chunks ?? [], demand() && !inputUnknown && tab?.phase === 'live');
      if (!message) return;
      if (command('render', message) && message.chunks.length) { awaitingAck = true; if (demand()) arm('native_renderer_ack_timeout'); }
    },
    focus() { if (demand() && ready && state.phase === 'ready' && !inputUnknown) command('focus'); },
    async closeTab(id: string) {
      if (!demand() || !['ready', 'failed'].includes(state.phase) || !workspace || inputPending) return false;
      // This is an explicit destructive action, never a resend of unknown input.
      const closed = await workspace.controller.closeTab(id);
      if (closed && current()) {
        command('inputResult', { key: id, status: 'closed' });
        if (inputUnknown === id) {
          inputUnknown = undefined;
          if (ready) { emit('ready'); synchronize(); } else emit(state.phase, state.error);
        }
      }
      return closed;
    },
    async restart() {
      if (!demand() || state.phase !== 'ready' || !workspace || inputPending) return false;
      const id = workspace.snapshot().activeId;
      workspace.controller.setActive(true, scope);
      const restarted = await workspace.controller.restart();
      if (restarted && current()) {
        command('inputResult', { key: id, status: 'closed' });
        if (inputUnknown === id) {
          inputUnknown = undefined;
          if (ready) { emit('ready'); synchronize(); } else emit(state.phase, state.error);
        }
      }
      return restarted;
    },
    async event(raw: unknown) {
      const event = record(raw);
      let authority: RuntimeScope | null;
      try { authority = runtimeScopeFrom(event.expectedHost); } catch { return; }
      if (!current() || event.owner !== owner || event.generation !== state.generation || !sameRuntimeScope(authority, scope)) return;
      if (event.type === 'ready') {
        if (!demand() || state.phase !== 'mounting' || event.version !== 1) return;
        clear(); emit('opening'); arm('terminal_workspace_open_timeout');
        const token = attempt;
        // Share a pending metadata recovery across renderer retry. It must not
        // create a parallel workspace or read a catalog with different authority.
        opening ??= (async () => {
          const value = await options.createWorkspace();
          if (!current()) { value.controller.dispose(); return; }
          workspace = value;
        })();
        try {
          await opening;
          if (!current() || token !== attempt) return;
          clear();
          ready = true; presentation.reset(); emit('ready'); synchronize();
        } catch { opening = undefined; if (current() && token === attempt) fail('terminal_workspace_open_failed'); }
        return;
      }
      if (event.type === 'error') { fail('native_renderer_failed'); return; }
      if (!ready || state.phase !== 'ready' || !workspace) return;
      if (event.type === 'shortcut' && demand() && !composing && typeof event.actionId === 'string' && typeof event.keystroke === 'string') {
        options.shortcut?.(event.actionId, event.keystroke); return;
      }
      if (event.type === 'focus' && typeof event.focused === 'boolean') {
        focused = demand() && event.focused; if (!focused) composing = false;
        emit(state.phase, state.error); return;
      }
      if (event.type === 'composition' && typeof event.composing === 'boolean') {
        composing = demand() && event.composing; emit(state.phase, state.error); return;
      }
      if (event.type === 'ack') {
        if (presentation.acknowledge({ key: event.key, cursor: event.cursor, serial: event.serial })) { awaitingAck = false; clear(); options.changed({ ...state }); }
        return;
      }
      const snapshot = workspace.snapshot();
      if (event.type === 'input' && typeof event.key === 'string' && Number.isSafeInteger(event.receipt) && Number(event.receipt) > lastReceipt
        && (!demand() || event.key !== snapshot.activeId)) {
        lastReceipt = Number(event.receipt);
        command('inputResult', { key: event.key, receipt: event.receipt, status: 'suspended' });
        return;
      }
      if (!demand()) return;
      if (event.key !== snapshot.activeId) return;
      if (event.type === 'openPreview' && typeof event.key === 'string' && typeof event.url === 'string' && (event.mode === 'preview' || event.mode === 'external')) {
        await workspace.controller.openPreview(event.key, event.url, event.mode);
      } else if (event.type === 'resize' && typeof event.cols === 'number' && typeof event.rows === 'number' && terminalSize({ cols: event.cols, rows: event.rows })) {
        workspace.controller.resize({ cols: event.cols, rows: event.rows });
      } else if (event.type === 'input' && typeof event.data === 'string' && Number.isSafeInteger(event.receipt) && Number(event.receipt) > 0) {
        if (inputUnknown || Number(event.receipt) <= lastReceipt) return;
        lastReceipt = Number(event.receipt);
        if (inputPending) { command('inputResult', { key: event.key, receipt: event.receipt, status: 'rejected' }); return; }
        const key = event.key, receipt = event.receipt, generation = state.generation;
        inputPending = true; emit(state.phase, state.error);
        const outcome = await workspace.controller.inputOutcome(event.data);
        inputPending = false;
        if (!current() || generation !== state.generation) return;
        command('inputResult', { key, receipt, status: outcome });
        if (outcome === 'unknown') { inputUnknown = String(key); pause(); emit(state.phase, ready ? 'input_unknown' : state.error); }
        else emit(state.phase, state.error);
      }
    },
    dispose() { if (disposed) return; disposed = true; attempt++; clear(); workspace?.controller.dispose(); workspace = undefined; },
  };
}

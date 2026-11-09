import type { NativeBtwScope, NativeBtwSelection, NativeBtwStore } from './desktop-btw';
import type { NativeLocalCommandAction, NativeLocalCommandInvocation } from './composer-local-commands';

export type NativeDesktopBtwHandle = {
  readonly scope: NativeBtwScope;
  current: () => boolean;
  ask: (question: string) => boolean;
  retry: () => boolean;
  cancel: () => boolean;
  addQuote: (text: string) => boolean;
  setSelection: (selection: NativeBtwSelection) => boolean;
  close: () => boolean;
};

/** Admission only. No second sender, selection source, turn store, or transport. */
export function createNativeDesktopBtwHandle(options: {
  store: NativeBtwStore; scope: NativeBtwScope;
  current: () => boolean; active: () => boolean; interactive: () => boolean; visible: () => boolean;
  onClose: () => void;
  onReset?: () => void;
}): NativeDesktopBtwHandle & { dispose: () => void } {
  const { store } = options, scope = store.captureScope(options.scope);
  let alive = true, closed = false;
  const current = () => alive && !closed && store.current(scope) && options.current() && options.active();
  const interactive = () => current() && options.interactive();
  const sendable = () => interactive() && options.visible() && store.available() && !store.entry(scope).turns.some(turn => turn.pending);
  return {
    scope, current,
    ask(question) {
      if (!question.trim() || !sendable()) return false;
      void store.ask(scope, question); return true;
    },
    retry() {
      if (!sendable() || !store.entry(scope).turns.length) return false;
      options.onReset?.();
      void store.retry(scope); return true;
    },
    cancel() { if (!interactive()) return false; store.cancel(scope); return true; },
    addQuote(text) { if (!text.trim() || !interactive()) return false; store.addQuote(scope, text); return true; },
    setSelection(selection) {
      if (!interactive() || !selection.providerID || !selection.modelID) return false;
      store.setSelection(scope, selection); return true;
    },
    close() {
      if (!interactive()) return false;
      options.onReset?.();
      closed = true; store.clear(scope); options.onClose(); return true;
    },
    dispose() { if (!alive) return; alive = false; store.cancel(scope); },
  };
}

/** Opening may await the actual mounted onHandle publisher. Bare /btw opens without generating. */
export function createNativeDesktopBtwAction(options: {
  open: (invocation: NativeLocalCommandInvocation) => NativeDesktopBtwHandle | null | Promise<NativeDesktopBtwHandle | null>;
}): NativeLocalCommandAction {
  return { async run(invocation) {
    if (!invocation.current() || invocation.command !== 'btw' || invocation.snapshot.target.kind !== 'session' || invocation.snapshot.hasReferences) return { status: 'rejected' };
    const target = invocation.snapshot.target;
    let handle: NativeDesktopBtwHandle | null;
    try { handle = await options.open(invocation); } catch { return { status: 'rejected' }; }
    if (!invocation.current() || !handle?.current() || handle.scope.sessionId !== target.id || handle.scope.directory !== target.directory) return { status: 'rejected' };
    if (invocation.tail && !handle.ask(invocation.tail)) return { status: 'rejected' };
    return { status: 'accepted' };
  } };
}

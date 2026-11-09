import { createNativeBtwStore, type NativeBtwRuntime, type NativeBtwScope, type NativeBtwSelection, type NativeBtwRequestScope } from './desktop-btw';
import { createNativeDesktopBtwAction, type NativeDesktopBtwHandle } from './desktop-btw-panel-core';
import { createDesktopBtwRuntime, type DesktopBtwRuntime, type DesktopBtwResponseError } from './desktop-btw-runtime';
import type { DesktopHttpGrant, DesktopHttpError } from './desktop-http-core';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { NativeLocalCommandInvocation } from './composer-local-commands';
import type { RuntimeScope } from './runtime-scope';

const identity = (scope: DesktopPanelScope) => JSON.stringify([scope.host.hostID, scope.host.lease, scope.authorityKey, scope.directory, scope.sessionID]);
const sideScope = (scope: DesktopPanelScope, runtime: NativeBtwRuntime): NativeBtwScope => ({ sessionId: scope.sessionID!, directory: scope.directory, runtime: { ...runtime } });

/** One window store and one captured active-target HTTP port. Product mounts publish
 * the only usable handle; opening never manufactures a reader or starts a model. */
export function createDesktopBtwWorkbench(options: {
  grant: () => DesktopHttpGrant | undefined;
  runtime: () => NativeBtwRuntime;
  runtimeScope: () => RuntimeScope | null;
  scope: () => DesktopPanelScope | null;
  current: (scope: DesktopPanelScope) => boolean;
  interactive: () => boolean;
  selection: (scope: NativeBtwScope) => NativeBtwSelection | null;
  open: (scope: DesktopPanelScope) => boolean;
  present: (scope: DesktopPanelScope) => boolean;
  onIssue: (error: DesktopHttpError | DesktopBtwResponseError) => void;
}) {
  let alive = true, runtime = { ...options.runtime() };
  let port: { key: string; owner: DesktopBtwRuntime } | undefined;
  let mounted: { key: string; handle: NativeDesktopBtwHandle } | undefined;
  let opening: { key: string; invocation: NativeLocalCommandInvocation; settle: (handle: NativeDesktopBtwHandle | null) => void } | undefined;
  let opened: DesktopPanelScope | undefined;
  let retained = false;
  const current = (scope: DesktopPanelScope) => alive && !!scope.sessionID && options.current(scope);
  const requestPort = (scope: NativeBtwRequestScope) => {
    const selected = options.scope();
    if (!selected || scope.sessionID !== selected.sessionID || scope.directory !== selected.directory
      || scope.runtime.transport !== options.runtime().transport || scope.runtime.generation !== options.runtime().generation
      || port?.key !== identity(selected) || !port.owner.current()) throw new Error('desktop_btw_target_retired');
    return port.owner;
  };
  const store = createNativeBtwStore({
    runtime: options.runtime, resolveSelection: options.selection, rememberSelection: () => {},
    applySelection: (scope, selection, request) => requestPort(scope).applySelection(scope, selection, request),
    generate: (scope, body, request) => requestPort(scope).generate(scope, body, request),
  });
  const settleOpening = (handle: NativeDesktopBtwHandle | null) => { const ticket = opening; opening = undefined; ticket?.settle(handle); };
  const cancelOpening = () => settleOpening(null);
  function retirePort() { const previous = port; port = undefined; if (previous) void previous.owner.dispose(); }
  function ensurePort(scope: DesktopPanelScope) {
    if (!current(scope) || !options.grant()) return false;
    const key = identity(scope);
    if (port?.key === key && port.owner.current()) return true;
    retirePort();
    const owner = createDesktopBtwRuntime({ grant: options.grant(), scope: sideScope(scope, options.runtime()), expectedHost: scope.host,
      runtime: options.runtime, runtimeScope: options.runtimeScope, current: () => current(scope), onIssue: options.onIssue });
    if (!owner) return false;
    port = { key, owner }; return true;
  }
  const action = createNativeDesktopBtwAction({ open(invocation) {
    const scope = options.scope(), target = invocation.snapshot.target;
    if (!scope || !invocation.current() || !options.interactive() || target.kind !== 'session'
      || target.id !== scope.sessionID || target.directory !== scope.directory || opening || !ensurePort(scope)) return null;
    const captured = { ...scope, host: { ...scope.host } }, key = identity(captured);
    // Install before opening: an actual synchronous mount may publish immediately.
    const pending = new Promise<NativeDesktopBtwHandle | null>(settle => { opening = { key, invocation, settle }; });
    opened = captured;
    try { if (!options.open(captured)) { cancelOpening(); return null; } }
    catch { cancelOpening(); return null; }
    retained = options.present(captured);
    if (mounted?.key === key && mounted.handle.current()) {
      settleOpening(mounted.handle);
    }
    return pending;
  } });
  function reconcile() {
    const next = options.runtime();
    if (next.transport !== runtime.transport || next.generation !== runtime.generation) {
      cancelOpening(); retirePort(); mounted = undefined; opened = undefined; store.reset(); runtime = { ...next }; return;
    }
    if (opened && !current(opened)) {
      const captured = sideScope(opened, runtime);
      cancelOpening(); retirePort(); mounted = undefined; opened = undefined;
      store.cancel(captured);
    }
    if (opened) {
      const present = options.present(opened);
      if (retained && !present) { cancelOpening(); store.clear(sideScope(opened, runtime)); }
      retained = present;
    }
    if (opening && (!opening.invocation.current() || !options.interactive())) cancelOpening();
  }
  return {
    store, action,
    available() { const scope = options.scope(); return alive && !!options.grant() && !!scope && current(scope); },
    scope(scope: DesktopPanelScope) { return store.captureScope(sideScope(scope, options.runtime())); },
    /** Restored metadata does not imply mounted runtime support or model execution. */
    admit(scope: DesktopPanelScope) {
      if (!ensurePort(scope)) return false;
      opened = { ...scope, host: { ...scope.host } }; retained = options.present(scope); return true;
    },
    publish(scope: DesktopPanelScope, handle: NativeDesktopBtwHandle) {
      if (!current(scope) || !handle.current() || !store.current(handle.scope) || handle.scope.sessionId !== scope.sessionID || handle.scope.directory !== scope.directory) return () => {};
      const binding = { key: identity(scope), handle }; mounted = binding;
      const ticket = opening;
      if (ticket?.key === binding.key) { opening = undefined; ticket.settle(handle); }
      return () => { if (mounted === binding) mounted = undefined; };
    },
    reconcile,
    dispose() { if (!alive) return; alive = false; cancelOpening(); retirePort(); mounted = undefined; store.dispose(); },
  };
}
export type DesktopBtwWorkbench = ReturnType<typeof createDesktopBtwWorkbench>;

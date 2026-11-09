import { cleanup, effect, host, lifecycle, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { createDesktopConnectionOnlyRemoteConnections } from './desktop-remote-connections';
import { loadNativeDesktopRemoteConnections } from './desktop-remote-connections-native';
import type { NativeDesktopRemoteConnectionsPort } from './desktop-remote-connections-native-core';
import { publishSettingsEditor } from './desktop-settings-publisher';
import type { NativeRemoteConnectionsSlot } from './settings-remote-instances';
import { settingsAction } from './settings-controls';
import { t } from './i18n';
import { desktopHeaderRemoteState, desktopHeaderSameSshTarget, type DesktopHeaderRemoteConnectionsSource, type DesktopHeaderRemoteState } from './desktop-header-instances-root-core';
import type { DesktopRemoteConnectionsState, DesktopSshConnectionAdmission, DesktopSshInstance } from './desktop-remote-connections-core';
import type { DesktopHeaderServiceIntent, DesktopHeaderServiceResult } from './desktop-header-services';

/** Stable window-root slot. Discovery is read-only; an unavailable service is
 * visible, not an invented port. Settings visibility never retires native SSH. */
export function createNativeDesktopRemoteConnectionsRoot(options: { current(): boolean; runtimeReady(): boolean;
  /** Shared Header + Settings admission. Must prepare ALL owners, await old writer release,
   * dispatch once, and retain its own recovery fence until selected Host/writer reconciliation. */
  connectionMutation?: DesktopSshConnectionAdmission;
  /** Optional ORIGINAL confirmation + leave/close admission. No producer means Header Connect is unavailable.
   * The admission must retain original unknown/pending protections until the owning controller settles. */
  connectFromHeader?: (target: Readonly<DesktopSshInstance>, intent: DesktopHeaderServiceIntent, commit: () => Promise<DesktopHeaderServiceResult>) => Promise<DesktopHeaderServiceResult>;
}) {
  type Owner = ReturnType<typeof createDesktopConnectionOnlyRemoteConnections>;
  const owner = signal<Owner | null>(null), discovering = signal(false);
  const identity = {}, call = host.call, available = host.available;
  let alive = true, visible = false, presented = false, demand = 0, operation = 0;
  let cached: NativeDesktopRemoteConnectionsPort | undefined;
  let pending: Promise<void> | undefined;
  const headerListeners = new Set<() => void>();
  const headerIdentity = {};
  let headerPrevious: DesktopRemoteConnectionsState | null = null, headerState: DesktopHeaderRemoteState | null = null;
  let stopHeaderOwner: (() => void) | undefined, headerConnecting = false, slotMounts = 0;
  const notifyHeader = () => { for (const listener of headerListeners) { try { listener(); } catch { /* Retired observers do not affect the original owner. */ } } };
  const current = () => {
    if (!alive) return false;
    try { alive = options.current() && host.call === call && host.available === available; }
    catch { alive = false; }
    return alive;
  };
  const ready = () => {
    try { return current() && lifecycle() === 'active' && options.runtimeReady(); }
    catch { return false; }
  };
  function adopt(port: NativeDesktopRemoteConnectionsPort) {
    if (owner() || !visible || !ready() || !port.current() || !port.ready()) { port.dispose(); return; }
    const next = createDesktopConnectionOnlyRemoteConnections(port, {
      connectionAvailable: source => source === 'header' ? !!options.connectionMutation || !!options.connectFromHeader : !!options.connectionMutation,
      connectionMutation: mutation => {
        if (options.connectionMutation) return options.connectionMutation(mutation);
        if (mutation.source === 'header' && options.connectFromHeader) return options.connectFromHeader(mutation.target, Object.freeze({ current: mutation.current }), mutation.dispatch);
        return Promise.resolve({ status: 'unsupported' });
      },
    });
    owner.set(next);
    stopHeaderOwner = next.controller.subscribe(notifyHeader);
    notifyHeader();
  }
  function demandChanged(active: boolean) {
    if (visible === active) return;
    visible = active; ++demand;
    if (!active) return;
    presented = true;
    if (cached) { const port = cached; cached = undefined; adopt(port); }
  }
  async function discover(startup = false): Promise<void> {
    if (!ready() || !startup && !visible) return;
    const existing = owner();
    if (existing) { await existing.controller.refresh(); return; }
    if (pending) return pending;
    const capturedDemand = demand, capturedOperation = ++operation, firstPresentation = startup && !presented;
    discovering.set(true);
    const work = Promise.resolve().then(async () => {
      let port: NativeDesktopRemoteConnectionsPort | undefined;
      try {
        port = await loadNativeDesktopRemoteConnections({ current, runtimeReady: ready });
        if (!current() || capturedOperation !== operation || owner()) { port?.dispose(); return; }
        if (!port) return;
        if (startup && !presented && !visible) { cached = port; return; }
        const samePresentation = capturedDemand === demand || firstPresentation && demand === capturedDemand + 1;
        if (!visible || !samePresentation || !ready()) { port.dispose(); return; }
        adopt(port);
      } finally {
        if (capturedOperation === operation) { pending = undefined; discovering.set(false); }
      }
    });
    pending = work;
    return work;
  }
  function Fallback(props: { active: boolean }) {
    const active = () => props.active && ready();
    publishSettingsEditor({ current: active, scope: () => identity, dirty: () => false, pending: () => false, stamp: () => [] });
    return <View testID="desktop-ssh-discovery" class="gap-3">
      <Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.native.security')}</Text>
      <Text testID="desktop-ssh-unavailable" class="text-sm text-muted-foreground">{t('settings.view.unavailable.title')}</Text>
      <View class="flex-row flex-wrap gap-2">
        <Button testID="desktop-ssh-add" class={settingsAction} disabled><Text>{t('settings.remoteInstances.sidebar.actions.addSshInstance')}</Text></Button>
        <Button testID="desktop-ssh-discovery-retry" class={settingsAction} disabled={!active() || discovering()} onPress={() => { void discover(); }}><Text>{t('chat.questionDelegate.retry')}</Text></Button>
      </View>
    </View>;
  }
  function RootSlot(props: { active: boolean }) {
    slotMounts++; notifyHeader();
    cleanup(() => { slotMounts--; notifyHeader(); });
    effect(() => { const active = props.active && ready(); untracked(() => demandChanged(active)); });
    cleanup(() => demandChanged(false));
    return <If when={owner()} else={<Fallback active={props.active} />}>{() => owner()!.slot({ get active() { return props.active; } })}</If>;
  }
  const slot: NativeRemoteConnectionsSlot = context => <RootSlot active={context.active} />;
  const header: DesktopHeaderRemoteConnectionsSource = {
    projection() {
      const controller = owner()?.controller;
      const next = controller?.state() || null;
      if (next !== headerPrevious) { headerPrevious = next; headerState = next ? desktopHeaderRemoteState(next) : null; }
      return { owner: controller ? headerIdentity : null, state: headerState,
        available: !!controller && ready() && controller.current() && controller.ready(),
        connectAvailable: !slotMounts && !headerConnecting && !!controller && !!next?.snapshot && next.ready && !next.failed && controller.connectionAvailable('header') && controller.canLeave() && ready() && controller.ready() };
    },
    subscribe(listener) { if (!current()) return () => {}; headerListeners.add(listener); return () => { headerListeners.delete(listener); }; },
    async connect(target, intent) {
      const controller = owner()?.controller;
      if (!controller || !header.projection().connectAvailable || !intent.current()) return { status: 'unsupported' };
      const exact = () => {
        const state = controller.state(), row = state.snapshot?.instances.find(row => row.id === target.id), status = state.snapshot?.statuses.find(row => row.id === target.id);
        return current() && ready() && owner()?.controller === controller && !slotMounts && intent.current() && controller.ready() && !state.failed && !state.busy && !state.unknown && state.sync?.phase !== 'unknown' && !state.snapshot?.saving && !!row && desktopHeaderSameSshTarget(row, target) && (!status || status.phase === 'idle') && !status?.running;
      };
      if (!exact()) return { status: 'stale' };
      headerConnecting = true; notifyHeader();
      try {
        const result = await controller.connect(target, { source: 'header', current: exact });
        // A modal opening, a void callback, or returning accepted without commit
        // is not a native acknowledgement. The original controller owns unknown.
        return result;
      } catch { return { status: 'failed' }; }
      finally { headerConnecting = false; notifyHeader(); }
    },
  };
  const guard = Object.freeze({ current,
    canLeave: () => owner()?.controller.canLeave() ?? true,
    canWindowClose: () => owner()?.controller.canLeave() ?? true,
    requestWindowClose: async () => owner()?.controller.canLeave() ?? true,
  });
  const connectFromHeader = header.connect.bind(header);
  const connectFromSettings = (target: DesktopSshInstance, intent: DesktopHeaderServiceIntent): Promise<DesktopHeaderServiceResult> => {
    const controller = owner()?.controller;
    if (!controller || !ready() || !options.connectionMutation) return Promise.resolve({ status: 'unsupported' });
    return controller.connect(target, { source: 'settings', current: () => ready() && intent.current() });
  };
  Object.freeze(header);
  void discover(true);
  return Object.freeze({
    slot,
    header,
    guard, connectFromHeader, connectFromSettings,
    /** Synchronous existing-owner state only. Never discover/read to satisfy a projection. */
    snapshot() {
      const controller = owner()?.controller;
      return Object.freeze({ current: current(), ready: !!controller && ready() && controller.ready(), snapshotReady: !!controller?.state().snapshot,
        state: controller?.state() ?? null, connection: controller?.connectionOperation() ?? null });
    },
    subscribe: header.subscribe,
    /** Explicit read-only result recovery, never triggered by Header demand/input/popup lifetime. */
    async refresh() {
      const controller = owner()?.controller;
      if (!controller || !ready()) return;
      await controller.readConnectionResult();
    },
    dispose() {
      alive = false; visible = false; ++demand; ++operation;
      stopHeaderOwner?.(); headerListeners.clear();
      cached?.dispose(); cached = undefined; owner()?.dispose(); pending = undefined;
    },
  });
}

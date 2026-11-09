import { cleanup, effect, host, lifecycle, signal, untracked, View, Text, type Accessor } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { runtimeScopeFrom, sameRuntimeScope } from './runtime-scope';
import { createTerminalWorkspace, terminalKeySequence, type TerminalKey, type TerminalModifier, type TerminalScope, type TerminalSnapshot, type TerminalWorkspace } from './terminal-core';
import type { TerminalPalette } from './terminal-renderer';
import type { TerminalAction } from './terminal-actions';
import { createTerminalPresentation } from './terminal-presentation';
import { discoverTerminalAction, terminalAutoDiscoverID } from './terminal-discovery';

/** Async native metadata recovery is completed before a page is allowed to create a PTY. */
export async function createNativeTerminalWorkspace(input: TerminalScope, openPreview: (scope: TerminalScope, directory: string, url: string, mode: 'preview' | 'external') => Promise<void>) {
  const scope = runtimeScopeFrom(input);
  if (!scope) throw new Error('scope_required');
  const capability = await host.call('terminal.capabilities', { expectedHost: scope });
  if (!capability || typeof capability !== 'object' || !('scope' in capability) || capability.scope !== 'native-opaque'
    || !('wsVersion' in capability) || capability.wsVersion !== 2 || !('durableMetadata' in capability) || capability.durableMetadata !== true) throw new Error('terminal_unavailable');
  const catalog = await host.call('terminal.catalog.read', { expectedHost: scope });
  const snapshot = signal<TerminalSnapshot>({ directory: '', tabs: [], invalidated: false });
  const controller = createTerminalWorkspace({ scope, catalog,
    call: (name, body) => host.call(name, body), subscribe: listener => host.on('terminal.event', listener), changed: value => snapshot.set(value),
    persist: async value => { if (await host.call('terminal.catalog.write', { expectedHost: scope, catalog: value }) !== true) throw new Error('catalog_write_failed'); },
    probePreview: async url => await host.call('terminal.probe', { expectedHost: scope, url }) === true,
    openPreview: (directory, url, mode) => openPreview(scope, directory, url, mode),
  });
  const discover = async (directory: string, actions: readonly TerminalAction[]) => {
    if (!('actionDiscovery' in capability) || capability.actionDiscovery !== true) throw new Error('action_discovery_unavailable');
    return discoverTerminalAction({ directory, actions, name: t('projectActions.actions.autoDiscover'),
      read: async file => { const result = await host.call('terminal.discovery.file', { expectedHost: scope, directory, file }); if (result !== null && typeof result !== 'string') throw new Error('invalid_discovery_file'); return result; },
      freePort: async () => { const result = await host.call('terminal.discovery.port', { expectedHost: scope }); if (result !== null && typeof result !== 'number') throw new Error('invalid_discovery_port'); return result; },
    });
  };
  return { controller, snapshot, discover };
}

let nextSurface = 0;
const keys = [
  ['esc', 'terminalView.quickKeys.escape'], ['tab', 'terminalView.quickKeys.tabAria'],
  ['arrow-up', 'terminalView.quickKeys.arrowUpAria'], ['arrow-left', 'terminalView.quickKeys.arrowLeftAria'],
  ['arrow-down', 'terminalView.quickKeys.arrowDownAria'], ['arrow-right', 'terminalView.quickKeys.arrowRightAria'],
  ['enter', 'terminalView.quickKeys.enterAria'],
] as const;

/** Native modal terminal surface. NO NSH WebView and NO generic main bridge.
 * Root captures a native RuntimeScope once. NativeTerminalPreview owns the one
 * fixed offline document, navigation gates and UIKit controls. */
export function NativeTerminalPage(props: {
  workspace: { controller: TerminalWorkspace; snapshot: Accessor<TerminalSnapshot>; discover: (directory: string, actions: readonly TerminalAction[]) => Promise<TerminalAction | null> };
  scope: TerminalScope; directory: string; active: boolean;
  palette: TerminalPalette; fontFamily: string; fontSize: number; actions?: readonly TerminalAction[]; onClose: () => void;
}) {
  const { controller, snapshot } = props.workspace, scope = runtimeScopeFrom(props.scope);
  if (!scope) throw new Error('scope_required');
  const owner = `terminal-surface-${scope.lease.slice(0, 8)}-${++nextSurface}`;
  const ready = signal(false), failed = signal(false), revision = signal(0), openingRevision = signal(0), modifier = signal<TerminalModifier>(null);
  const presentation = createTerminalPresentation();
  let disposed = false, opened = false, operation = 0, lastChrome = '', timer: ReturnType<typeof setTimeout> | undefined;
  let surfaceOwner = owner;
  let discovering = false;
  const actionError = signal<string | undefined>(undefined);
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const tab = () => snapshot().tabs.find(value => value.id === snapshot().activeId);
  const current = () => !disposed && sameRuntimeScope(scope, props.scope) && !snapshot().invalidated;
  const call = (name: string, body: Record<string, unknown> = {}) => host.call(name, { owner: surfaceOwner, expectedHost: scope, ...body });
  const finish = () => { operation++; opened = false; clearTimer(); ready.set(false); presentation.reset(); controller.setActive(false); void host.call('terminal.preview.finish', { owner: surfaceOwner }).catch(() => { if (!disposed) failed.set(true); }); };
  effect(() => {
    const active = props.active && lifecycle() === 'active', directory = props.directory, actual = props.scope;
    const palette = props.palette, fontFamily = props.fontFamily, fontSize = props.fontSize;
    openingRevision();
    untracked(() => {
      if (!sameRuntimeScope(scope, actual)) controller.setActive(false, actual);
      if (!active || !current()) { finish(); return; }
      controller.setDirectory(directory);
      if (opened) return;
      controller.setActive(false);
      const token = ++operation; surfaceOwner = `${owner}-${token}`; const openingOwner = surfaceOwner; failed.set(false); lastChrome = ''; opened = true;
      void call('terminal.preview.open', { palette, fontFamily, fontSize, inputLabel: t('terminalView.viewport.inputAria') }).then(() => {
        if (disposed || operation !== token || !current()) { void host.call('terminal.preview.finish', { owner: openingOwner }); return; }
      }).catch(() => { if (!disposed && operation === token) { opened = false; failed.set(true); controller.setActive(false); } });
    });
  });
  effect(() => {
    const active = props.active && lifecycle() === 'active' && ready() && !failed(), actual = props.scope;
    untracked(() => controller.setActive(active, actual));
  });
  effect(() => {
    const fontPreferences = { fontSize: props.fontSize, fontFamily: props.fontFamily };
    if (!props.active || lifecycle() !== 'active' || !ready() || !opened || !current()) return;
    if (!Number.isFinite(fontPreferences.fontSize) || fontPreferences.fontSize < 9 || fontPreferences.fontSize > 52) { failed.set(true); controller.setActive(false); return; }
    void call('terminal.preview.render', { fontPreferences }).catch(() => { if (!disposed) { failed.set(true); controller.setActive(false); } });
  });
  const unsubscribe = host.on('terminal.preview.event', raw => {
    if (!raw || typeof raw !== 'object') return;
    const value = raw as Record<string, unknown>;
    let eventScope: TerminalScope | null; try { eventScope = runtimeScopeFrom(value.expectedHost); } catch { return; }
    if (value.owner !== surfaceOwner || !sameRuntimeScope(scope, eventScope) || !current()) return;
    if (value.type === 'closed') { const userClosed = opened; finish(); if (userClosed) props.onClose(); return; }
    if (value.type === 'ready') { presentation.reset(); ready.set(true); return; }
    if (value.type === 'ack') { if (presentation.acknowledge({ key: value.key, cursor: value.cursor, serial: value.serial })) { clearTimer(); revision.set(revision() + 1); } return; }
    if (value.type === 'error') { failed.set(true); controller.setActive(false); return; }
    if (!props.active || lifecycle() !== 'active') return;
    if (value.type === 'resize' && value.key === snapshot().activeId && typeof value.cols === 'number' && typeof value.rows === 'number') controller.resize({ cols: value.cols, rows: value.rows });
    else if (value.type === 'input' && typeof value.key === 'string' && typeof value.data === 'string' && Number.isSafeInteger(value.receipt)) {
      const key = value.key, receipt = value.receipt, capturedOwner = surfaceOwner;
      const outcome = key === snapshot().activeId ? controller.inputOutcome(value.data, modifier()) : Promise.resolve('rejected' as const);
      modifier.set(null);
      void outcome.then(status => {
        if (current() && surfaceOwner === capturedOwner) {
          if (status === 'accepted' && actionError()?.startsWith('input_')) actionError.set(undefined);
          return call('terminal.preview.render', { inputResult: { key, receipt, status } });
        }
      }).catch(() => { if (current()) { failed.set(true); controller.setActive(false); } });
    }
    else if (value.type === 'inputRejected') actionError.set(['input_unknown', 'input_too_large', 'input_backpressure'].includes(String(value.code)) ? String(value.code) : 'input_not_accepted');
    else if (value.type === 'select' && typeof value.id === 'string') controller.selectTab(value.id);
    else if (value.type === 'closeTab' && typeof value.id === 'string') void controller.closeTab(value.id);
    else if (value.type === 'newTab') controller.createTab();
    else if (value.type === 'retry') { if (failed()) { finish(); openingRevision.set(openingRevision() + 1); } else { controller.retry(); void controller.flushPersistence(); } }
    else if (value.type === 'restart') void controller.restart();
    else if (value.type === 'preview' && typeof value.id === 'string') void controller.openPreview(value.id);
    else if (value.type === 'action') {
      const action = props.actions?.find(action => action.id === value.id);
      if (action) controller.runAction(action);
      else if (value.id === terminalAutoDiscoverID && !discovering) {
        discovering = true; const directory = props.directory, capturedOwner = surfaceOwner; actionError.set(undefined);
        void props.workspace.discover(directory, props.actions ?? []).then(action => {
          if (!current() || !props.active || props.directory !== directory || surfaceOwner !== capturedOwner) return;
          if (action) controller.runAction(action); else actionError.set('no_dev_server');
        }).catch(() => { if (current()) actionError.set('action_discovery_failed'); }).finally(() => { discovering = false; });
      }
    }
    else if (value.type === 'stopAction' && typeof value.id === 'string') void controller.stopAction(value.id);
    else if (value.type === 'key' && typeof value.key === 'string') {
      if (value.key === 'ctrl' || value.key === 'cmd') modifier.set(modifier() === value.key ? null : value.key);
      else if (keys.some(([key]) => key === value.key)) { void controller.input(terminalKeySequence(value.key as TerminalKey, modifier())); modifier.set(null); }
    }
  });
  effect(() => {
    const state = snapshot(), value = tab(), live = props.active && lifecycle() === 'active' && ready() && !failed() && value?.phase === 'live'; revision();
    if (!ready() || !opened || !current()) return;
    const chrome = { activeKey: value?.id, live, modifier: modifier(), tabs: state.tabs.map((tab, index) => ({ id: tab.id, label: tab.label || `${t('layout.mainTab.terminal')} ${index + 1}` })),
      closeLabel: t('terminalView.tabs.closeTabTitle'), newLabel: t('terminalView.tabs.newTabTitle'), previewLabel: t('terminalView.preview.open'), hasPreview: !!value?.previewUrl,
      retryLabel: t('terminalView.actions.retry'), status: failed() ? t('remoteDesktop.unsupported') : actionError() ? t('terminalView.error.connectionFailed', { message: actionError()! }) : value?.error ? t('terminalView.error.connectionFailed', { message: value.error }) : state.persistenceError ? t('terminalView.error.connectionFailed', { message: 'catalog_write_failed' }) : '',
      keys: [{ key: 'ctrl', label: t('terminalView.quickKeys.controlLabel') }, { key: 'cmd', label: '⌘' }, ...keys.map(([key, label]) => ({ key, label: t(label) }))],
      actions: [{ id: terminalAutoDiscoverID, name: t('projectActions.actions.autoDiscover') }, ...(props.actions ?? []).map(action => ({ id: action.id, name: action.name }))], activeAction: value?.actionStatus ? value.id : undefined,
      stopLabel: t('projectActions.actions.stopNamedAria', { name: value?.label ?? t('layout.mainTab.terminal') }) };
    const restart = value?.phase === 'failed' || value?.phase === 'exited' ? t('terminalView.actions.hardRestart') : undefined;
    const chromeWithRestart = { ...chrome, restartLabel: restart };
    const encoded = JSON.stringify(chromeWithRestart), render = presentation.next(value?.id ?? '', value?.chunks ?? [], live);
    if (!render && encoded === lastChrome) return; lastChrome = encoded;
    void call('terminal.preview.render', { ...chromeWithRestart, render: render ?? { type: 'render', key: value?.id ?? '', chunks: [], live, serial: 0 } }).catch(() => { if (!disposed) { failed.set(true); controller.setActive(false); } });
    if (render?.chunks.length) { clearTimer(); timer = setTimeout(() => { failed.set(true); controller.setActive(false); }, 10_000); }
  });
  cleanup(() => { disposed = true; unsubscribe(); finish(); });
  return <View testID="terminal-native-route" class="flex-1 bg-background">
    <If when={failed()}><View class="p-4 gap-3"><Text class="text-destructive">{t('remoteDesktop.unsupported')}</Text>
      <Button class="rounded-xl bg-secondary px-3 py-2" onPress={() => { finish(); openingRevision.set(openingRevision() + 1); }}><Text class="text-foreground">{t('terminalView.actions.retry')}</Text></Button>
      <Button onPress={props.onClose}><Text class="text-foreground">{t('header.actions.backAria')}</Text></Button>
    </View></If>
  </View>;
}

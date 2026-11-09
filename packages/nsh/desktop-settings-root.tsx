import { cleanup, computed, effect, lifecycle, signal, untracked } from 'nsh';
import { app } from './state';
import { createPageOperations } from './page-operations';
import { NativeDesktopSettingsWindow } from './desktop-settings';
import { NativeDesktopSettingsContent, type DesktopSettingsContentNavigationState, type NativeDesktopSettingsContentProps } from './desktop-settings-content';
import { createDesktopSettingsRootOwner, type DesktopSettingsRootSnapshot } from './desktop-settings-root-core';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import type { RetentionController } from './settings-retention-controller';

export function createNativeDesktopSettingsRoot(options: { callbacks: Omit<SettingsCallbacks, 'onOpen' | 'onBack'>; retention: () => RetentionController | undefined;
  shortcuts?: Parameters<typeof NativeDesktopSettingsContent>[0]['shortcuts']; codeTypographyReady?: boolean;
  remoteConnections?: NativeDesktopSettingsContentProps['remoteConnections']; desktopGitHub?: NativeDesktopSettingsContentProps['desktopGitHub']; desktopAbout?: NativeDesktopSettingsContentProps['desktopAbout']; onError: (error: unknown) => void }) {
  const state = signal<DesktopSettingsRootSnapshot>({ routes: [], revision: 0, busy: false });
  const routes = computed(() => state().routes), route = computed(() => routes().at(-1));
  const protection = signal<DesktopSettingsContentNavigationState | null>(null);
  const owner = createDesktopSettingsRootOwner(next => { const changedRoute = state().revision !== next.revision; state.set(next); if (changedRoute) protection.set(null); }, options.onError);
  const identity = () => { const host = app.connection(); return JSON.stringify([host?.id, host?.url, host?.authorizationID]); };
  let mountedIdentity = identity();
  effect(() => {
    const next = identity();
    if (next !== mountedIdentity) { mountedIdentity = next; untracked(owner.retire); }
  });
  cleanup(owner.dispose);
  const commitExternal = (callback: (() => void) | undefined) => { owner.commitClose(); callback?.(); };
  const callbacks: SettingsCallbacks = {
    onOpen: owner.commitNavigate,
    onBack: owner.commitBack,
    onConnect: () => commitExternal(options.callbacks.onConnect),
    onEditConnection: (id, mode) => commitExternal(() => options.callbacks.onEditConnection?.(id, mode)),
    onProjects: () => owner.commitNavigate({ page: 'projects' }),
    onAssistants: () => commitExternal(options.callbacks.onAssistants),
    onManageQuotaCredentials: (provider, name, directory) => commitExternal(() => options.callbacks.onManageQuotaCredentials?.(provider, name, directory)),
    onAppearanceChange: mode => options.callbacks.onAppearanceChange?.(mode),
  };
  function Content() {
    const operations = createPageOperations(() => !!routes().length);
    const report = (revision: number, value: DesktopSettingsContentNavigationState) => {
      owner.report(revision, value);
      if (state().revision !== revision) return;
      if (value.status !== 'retired' || protection()?.owner === value.owner) protection.set(value.status === 'retired' ? null : value);
    };
    return <NativeDesktopSettingsWindow open={!!routes().length} active={lifecycle() === 'active'} route={route()!}
      scopeKey={identity()} pending={state().busy || protection()?.pending === true} dirty
      nestedPickerOpen={protection()?.nestedPickerOpen === true}
      confirmDiscard={() => protection()?.requestLeave() ?? false} onGuardError={options.onError}
      onClose={owner.commitClose} onNavigate={owner.commitNavigate}
      renderPage={context => {
        const revision = untracked(() => state().revision);
        return <NativeDesktopSettingsContent route={context.route} active={context.active} callbacks={callbacks}
          retention={options.retention()} operationToken={operations.operation()} shortcuts={options.shortcuts}
          codeTypographyReady={options.codeTypographyReady} remoteConnections={options.remoteConnections} desktopGitHub={options.desktopGitHub} desktopAbout={options.desktopAbout} onNavigationState={value => report(revision, value)} />;
      }} />;
  }
  function Root() {
    return <If when={!!routes().length}><Each of={[identity()]}>{() => <Content />}</Each></If>;
  }
  return { open: (route: SettingsRoute) => owner.open(route), close: owner.close,
    requestWindowClose: () => routes().length ? owner.leave(() => {}) : Promise.resolve(true),
    isOpen: () => !!routes().length, Root };
}

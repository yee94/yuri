import { cleanup, effect, lifecycle, signal, untracked } from 'nsh';
import { AlertDialog } from 'nsh/base';
import { SettingsPageContent, type SettingsCallbacks, type SettingsPageContentProps, type SettingsRoute } from './settings';
import type { RetentionController } from './settings-retention-controller';
import type { SettingsHostOperation } from './settings-controls';
import { desktopSettingsRouteKey } from './desktop-settings-core';
import { createDesktopSettingsContentProtection, requestDesktopSettingsContentLeave, type DesktopSettingsContentNavigationState } from './desktop-settings-content-core';
import { DesktopSettingsPublisher } from './desktop-settings-publisher';
import { t } from './i18n';

export type { DesktopSettingsContentNavigationState } from './desktop-settings-content-core';
export { requestDesktopSettingsContentLeave } from './desktop-settings-content-core';
export { desktopSettingsIntegratedPages } from './desktop-settings-content-core';

export type NativeDesktopSettingsContentProps = {
  route: SettingsRoute;
  active: boolean;
  /** Commit callbacks, not NavStack.pop/reset called before checking the guard.
   * Adapter-owned navigation actions also pass through the strict guard. */
  callbacks: SettingsCallbacks;
  retention?: RetentionController;
  operationToken?: SettingsHostOperation | null;
  /** Mount the root's existing shortcut preferences/actions inside this publisher. */
  shortcuts?: SettingsPageContentProps['desktopShortcuts'];
  /** Opt in only after Editor/Diff consumers scale lineHeight with the code font. */
  codeTypographyReady?: boolean;
  /** Reuse the root's local SSH/network owners; no second connection engine. */
  remoteConnections?: SettingsPageContentProps['remoteConnections'];
  desktopGitHub?: SettingsPageContentProps['desktopGitHub'];
  desktopAbout?: SettingsPageContentProps['desktopAbout'];
  /** Publish this to the Window's route owner. Retired reports may clear only
   * the matching owner identity, never a newer page's protection. */
  onNavigationState: (state: DesktopSettingsContentNavigationState) => void;
};

/** Embeds the very same SettingsPage contents, without a mobile NavPage/header.
 * No draft is reconstructed here, and unknown page protection fails closed. */
export function NativeDesktopSettingsContent(props: NativeDesktopSettingsContentProps) {
  return <Each of={[desktopSettingsRouteKey(props.route)]}>{() => <DesktopSettingsContentRoute {...props} />}</Each>;
}

function DesktopSettingsContentRoute(props: NativeDesktopSettingsContentProps) {
  const revision = signal(0);
  const protection = createDesktopSettingsContentProtection({ page: props.route.page, active: () => props.active && lifecycle() === 'active',
    changed: () => untracked(() => revision.set(revision() + 1)), unavailable: async () => {
      await AlertDialog.show({ title: t('common.unavailable'), description: t('settings.view.unavailable.description'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }] });
    },
  });
  let published: DesktopSettingsContentNavigationState | undefined;
  effect(() => {
    revision();
    const state = protection.snapshot();
    if (published && published.status === state.status && published.blocked === state.blocked && published.pending === state.pending && published.dirty === state.dirty && published.nestedPickerOpen === state.nestedPickerOpen && published.missing.join(',') === state.missing.join(',')) return;
    published = state;
    untracked(() => props.onNavigationState(state));
  });
  cleanup(() => { protection.dispose(); props.onNavigationState(protection.snapshot()); });
  const leave = (commit: () => void) => { void requestDesktopSettingsContentLeave(protection.snapshot(), commit); };
  const callbacks: SettingsCallbacks = {
    onOpen: route => leave(() => props.callbacks.onOpen(route)),
    // Projects calls onBack only after its real owner guard has approved. Do not
    // ask it a second time or programmatically pop before that approval.
    onBack: () => { if (props.route.page === 'projects') { if (props.active && lifecycle() === 'active') props.callbacks.onBack(); } else leave(() => props.callbacks.onBack()); },
    onConnect: () => leave(() => props.callbacks.onConnect()),
    onEditConnection: props.callbacks.onEditConnection ? (id, mode) => leave(() => props.callbacks.onEditConnection?.(id, mode)) : undefined,
    onProjects: props.callbacks.onProjects ? () => leave(() => props.callbacks.onProjects?.()) : undefined,
    onAssistants: props.callbacks.onAssistants ? () => leave(() => props.callbacks.onAssistants?.()) : undefined,
    onManageQuotaCredentials: props.callbacks.onManageQuotaCredentials ? (provider, name, directory) => leave(() => props.callbacks.onManageQuotaCredentials?.(provider, name, directory)) : undefined,
    onAppearanceChange: mode => props.callbacks.onAppearanceChange?.(mode),
  };
  return <DesktopSettingsPublisher.Provider value={protection}>
    <SettingsPageContent {...callbacks} {...props.route} active={props.active && lifecycle() === 'active'} retention={props.retention} operationToken={props.operationToken} desktopShortcuts={props.shortcuts} codeTypographyReady={props.codeTypographyReady} remoteConnections={props.remoteConnections} desktopGitHub={props.desktopGitHub} desktopAbout={props.desktopAbout} />
  </DesktopSettingsPublisher.Provider>;
}

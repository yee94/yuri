import { cleanup, context } from 'nsh';
import { AlertDialog } from 'nsh/base';
import { t } from './i18n';
import { createSettingsNavigationOwner, type SettingsNavigationOwner, type SettingsNavigationPublisher } from './desktop-settings-content-core';

/** Optional native scope: existing mobile pages have no desktop publisher. */
export const DesktopSettingsPublisher = context<SettingsNavigationPublisher | null>(null);
export function publishSettingsNavigationOwner(owner: SettingsNavigationOwner) {
  const publisher = DesktopSettingsPublisher();
  if (publisher) cleanup(publisher.registerOwner(owner));
}
export function publishSettingsPending(read: () => boolean) {
  const publisher = DesktopSettingsPublisher();
  if (publisher) cleanup(publisher.registerPending(read));
}
export function publishSettingsPicker(read: () => boolean) {
  const publisher = DesktopSettingsPublisher();
  if (publisher) cleanup(publisher.registerPicker(read));
}

/** State belongs to the actual editor, including a popup's unsaved input. The
 * optional desktop context changes no mobile routing or form ownership. */
export function publishSettingsEditor(options: Omit<Parameters<typeof createSettingsNavigationOwner>[0], 'confirm' | 'nestedPickerOpen'> & { nestedPickerOpen?: () => boolean }) {
  const owner = createSettingsNavigationOwner({ ...options, nestedPickerOpen: options.nestedPickerOpen ?? (() => false), confirm: async () => {
    const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
      { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
    ] });
    return answer.action === 'discard';
  } });
  publishSettingsNavigationOwner(owner);
  return owner;
}

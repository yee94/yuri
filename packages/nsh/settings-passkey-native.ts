import type { I18nKey } from '../ui/src/lib/i18n/messages/en';

export function passkeyManagementLabels(translate: (key: I18nKey) => string) {
  return {
    title: translate('sessionAuth.locked.unlockTitle'),
    cancel: translate('settings.common.actions.cancel'),
    submit: translate('sessionAuth.actions.unlockAria'),
    passwordPlaceholder: translate('sessionAuth.password.placeholder'),
  };
}

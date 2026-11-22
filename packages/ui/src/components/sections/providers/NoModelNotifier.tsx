import * as React from 'react';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const NO_MODEL_TOAST_ID = 'no-usable-model';
// Startup recovery retries an empty catalog for a while; only announce once it has stayed empty.
const SETTLE_MS = 8000;

/**
 * Guides the user to configure a provider when the connected runtime exposes
 * no usable model. Built-in OpenCode models are blocked, so a fresh install
 * lands here until a provider is added.
 */
export const NoModelNotifier: React.FC = () => {
  const { t } = useI18n();
  const mobileActions = useMobileAppActions();
  const isConnected = useConfigStore((state) => state.isConnected);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const hasUsableModel = useConfigStore((state) => state.providers.some((provider) => provider.models.length > 0));
  const missing = isConnected && isInitialized && !hasUsableModel;

  const openProviderSettings = useEvent(() => {
    if (mobileActions) {
      mobileActions.openSettings('providers');
      return;
    }
    const ui = useUIStore.getState();
    ui.setSettingsPage('providers');
    ui.setSettingsDialogOpen(true);
  });

  React.useEffect(() => {
    if (!missing) {
      toast.dismiss(NO_MODEL_TOAST_ID);
      return;
    }
    const timer = window.setTimeout(() => {
      toast.message(t('settings.providers.noModel.toast'), {
        id: NO_MODEL_TOAST_ID,
        duration: Infinity,
        icon: <Icon name="sparkling" weight="medium" className="yuri-toast-status-icon size-5" />,
        action: {
          label: t('settings.providers.noModel.configure'),
          onClick: openProviderSettings,
        },
      });
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [missing, openProviderSettings, t]);

  return null;
};

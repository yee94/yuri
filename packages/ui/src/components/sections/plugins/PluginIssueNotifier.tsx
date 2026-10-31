import * as React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from '@/components/ui/toast';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePluginIssues } from './usePluginIssues';

const PLUGIN_ISSUE_TOAST_ID = 'plugin-load-issue';

/**
 * Announces plugins that failed to load. The action opens Settings → Plugins
 * with the failed plugin selected; a plugin already announced with the same
 * error stays quiet until it recovers or fails differently.
 */
export const PluginIssueNotifier: React.FC = () => {
  const { t } = useI18n();
  const issues = usePluginIssues();
  const mobileActions = useMobileAppActions();
  const announcedRef = React.useRef('');

  const openPluginSettings = useEvent((id: string) => {
    usePluginsStore.getState().setSelected(id);
    if (mobileActions) {
      mobileActions.openSettings('plugins');
      return;
    }
    const ui = useUIStore.getState();
    ui.setSettingsPage('plugins');
    ui.setSettingsDialogOpen(true);
  });

  const signature = issues.map((issue) => `${issue.id}\u0000${issue.error}`).join('\u0001');
  React.useEffect(() => {
    if (signature === announcedRef.current) return;
    announcedRef.current = signature;
    if (issues.length === 0) {
      toast.dismiss(PLUGIN_ISSUE_TOAST_ID);
      return;
    }
    const [first] = issues;
    toast.message(
      issues.length === 1
        ? t('settings.plugins.issue.toast', { name: first.label })
        : t('settings.plugins.issue.toastMany', { count: issues.length }),
      {
        id: PLUGIN_ISSUE_TOAST_ID,
        action: {
          label: t('settings.plugins.issue.view'),
          onClick: () => openPluginSettings(first.id),
        },
      },
    );
  }, [issues, openPluginSettings, signature, t]);

  return null;
};

import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { FilePreviewError } from '@/components/ui/FilePreviewError';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { guiPluginIcon } from './icons';

/**
 * Visible as soon as the authoritative inventory has an enabled GUI plugin, so the
 * entry does not wait for bundles or networking. Page cards come from real `yuri.page`
 * registrations; loading and failure are shown inside the sheet.
 */
export function MobileGuiApps() {
  const { host, snapshot, inventory, loading, error, requested, requestLoad, refresh } = useGuiPlugins();
  const { t } = useI18n();
  const [opened, setOpened] = React.useState<{ host: typeof host } | null>(null);
  const enabled = inventory.some(plugin => plugin.enabled);
  if (!enabled && !snapshot.pages.length) return null;
  const open = opened !== null && opened.host === host;
  const failed = Boolean(error) || inventory.some(plugin => plugin.enabled && plugin.error);
  return <>
    <Button variant="mobileGlass" size="mobileIcon" aria-label={t('guiPlugins.apps')} onClick={() => {
      if (!requested) requestLoad();
      setOpened({ host });
    }}>
      <Icon name="apps-2-ai" className="size-5" />
    </Button>
    <MobileResizableSheet id="gui-apps" open={open} onOpenChange={value => setOpened(value ? { host } : null)} title={t('guiPlugins.apps')}
      ariaLabel={t('guiPlugins.apps')} closeAriaLabel={t('guiPlugins.close')} resizeAriaLabel={t('guiPlugins.resize')}>
      {snapshot.pages.length ? <div className="grid grid-cols-2 content-start gap-3 overflow-y-auto p-4" data-gui-apps>
        {snapshot.pages.map(page => <Button key={page.key} size="lg"
          className="h-auto min-w-0 flex-col items-start gap-4 rounded-2xl p-4 text-left"
          onClick={() => useUIStore.getState().openGuiPage(page.key)}>
          <Icon name={guiPluginIcon(page.icon) ?? 'window'} className="size-8" />
          <span className="line-clamp-2 w-full whitespace-normal break-words typography-ui-label">{page.title}</span>
        </Button>)}
      </div> : loading || !requested || (!host && !failed) ? <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground" data-gui-apps-loading>
        <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" />{t('guiPlugins.loading')}
      </div> : <div className="flex min-h-40 flex-col items-center justify-center" data-gui-apps-empty>
        <FilePreviewError message={t(failed ? 'guiPlugins.error' : 'guiPlugins.mobile.noApps')} />
        {failed ? <Button className="mb-4" onClick={refresh}>{t('guiPlugins.mobile.retry')}</Button> : null}
      </div>}
    </MobileResizableSheet>
  </>;
}

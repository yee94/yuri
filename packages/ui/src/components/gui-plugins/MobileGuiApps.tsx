import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { guiPluginIcon } from './icons';

/** Page registrations, including pages whose desktop titlebar action is hidden on phones. */
export function MobileGuiApps() {
  const { host, snapshot } = useGuiPlugins();
  const { t } = useI18n();
  const [openedHost, setOpenedHost] = React.useState(host);
  const [open, setOpen] = React.useState(false);
  if (!host || !snapshot.pages.length) return null;
  return <>
    <Button variant="mobileGlass" size="mobileIcon" aria-label={t('guiPlugins.apps')} onClick={() => { setOpenedHost(host); setOpen(true); }}>
      <Icon name="apps-2-ai" className="size-5" />
    </Button>
    <MobileResizableSheet id="gui-apps" open={open && openedHost === host} onOpenChange={setOpen} title={t('guiPlugins.apps')}
      ariaLabel={t('guiPlugins.apps')} closeAriaLabel={t('guiPlugins.close')} resizeAriaLabel={t('guiPlugins.resize')}>
      <div className="grid grid-cols-2 content-start gap-3 overflow-y-auto p-4" data-gui-apps>
        {snapshot.pages.map(page => <Button key={page.key} size="lg"
          className="h-auto min-w-0 flex-col items-start gap-4 rounded-2xl p-4 text-left"
          onClick={() => useUIStore.getState().openGuiPage(page.key)}>
          <Icon name={guiPluginIcon(page.icon) ?? 'window'} className="size-8" />
          <span className="line-clamp-2 w-full whitespace-normal break-words typography-ui-label">{page.title}</span>
        </Button>)}
      </div>
    </MobileResizableSheet>
  </>;
}

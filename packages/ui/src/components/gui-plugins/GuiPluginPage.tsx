import React from 'react';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useUIStore } from '@/stores/useUIStore';
import { GuiPluginMount } from './GuiPluginMount';
import { FilePreviewError } from '@/components/ui/FilePreviewError';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { WorkspaceSurface } from '@/components/ui/WorkspaceSurface';
import { guiPagePluginId } from '@/lib/gui-plugins/pages';
import { isCapacitorApp } from '@/lib/platform';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

/** A placement only: content uses the same Solid bridge as file previews/settings. */
export function GuiPluginPage() {
  const { host, snapshot, inventory, error, loading, requested, requestLoad, refresh } = useGuiPlugins();
  const { t } = useI18n();
  const key = useUIStore((state) => state.activeGuiPage);
  const isMobile = useUIStore((state) => state.isMobile);
  React.useEffect(() => { if (!requested) requestLoad(); }, [requested, requestLoad]);
  const page = snapshot.pages.find((entry) => entry.key === key);
  const revision = snapshot.plugins.find((entry) => entry.id === page?.pluginId)?.revision;
  const pluginId = guiPagePluginId(key);
  const failed = snapshot.plugins.some((entry) => entry.id === pluginId && entry.status === 'failed')
    || inventory.some((entry) => entry.id === pluginId && entry.error)
    || (!page && Boolean(error));
  if (isMobile) return <div data-gui-plugin-page className="flex min-h-0 min-w-0 flex-1 flex-col" data-mobile-edge-to-edge-preview="true">
    {!isCapacitorApp() || error === 'unsupported' ? <FilePreviewError message={t('guiPlugins.mobile.unsupported')} />
      : host && page ? <ErrorBoundary key={JSON.stringify([page.key, revision])} fallback={<FilePreviewError message={t('guiPlugins.error')} />}>
      <GuiPluginMount host={host} kind="page" contributionKey={page.key} revision={revision} />
      </ErrorBoundary>
      : failed ? <>
        <FilePreviewError message={t(error === 'relay_required' ? 'guiPlugins.mobile.relayRequired' : error === 'relay_unavailable' ? 'guiPlugins.mobile.networkFailed' : 'guiPlugins.error')} />
        {error ? <Button className="m-4 self-center" onClick={refresh}>{t('guiPlugins.mobile.retry')}</Button> : null}
      </> : loading || !requested ? <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" />{t('guiPlugins.loading')}
      </div> : null}
  </div>;
  return <div data-gui-plugin-page className="flex h-full min-h-0 min-w-0 flex-col py-1.5 pl-1 pr-1.5 text-foreground">
    <WorkspaceSurface data-gui-plugin-page-surface>
    {host && page ? <ErrorBoundary key={JSON.stringify([page.key, revision])} fallback={<FilePreviewError message={t('guiPlugins.error')} />}>
      <GuiPluginMount host={host} kind="page" contributionKey={page.key} revision={revision} />
    </ErrorBoundary> : failed ? <FilePreviewError message={t('guiPlugins.error')} /> : null}
    </WorkspaceSurface>
  </div>;
}

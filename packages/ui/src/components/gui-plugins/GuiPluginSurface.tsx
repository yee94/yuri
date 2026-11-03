import React from 'react';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPluginWindow } from './GuiPluginWindow';
import { guiPluginReadinessKey } from './readiness';
import { GuiPreviewActions } from './GuiPreviewActions';
import { useDeviceInfo } from '@/lib/device';

export function GuiPluginSurface() {
  const { host, snapshot } = useGuiPlugins();
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [actions] = React.useState(() => document.createElement('div'));
  const active = snapshot.panels.find((panel) => panel.key === snapshot.activePanel && !panel.inline);
  return (
    <GuiPluginWindow id="gui-plugin-panel" open={Boolean(host && active)} title={active?.title ?? t('guiPlugins.title')} onClose={() => host?.hidePanel()}
      actions={isMobile && active ? <GuiPreviewActions target={actions} /> : null}>
      {host && active ? <>
      <div className="flex shrink-0 flex-wrap gap-1" aria-label={t('guiPlugins.panels')}>
        {snapshot.panels.map((panel) => (
          <div key={panel.key} className="flex min-w-0 items-center gap-1">
            <Button variant="chip" size="sm" aria-pressed={panel.key === active.key}
              onClick={() => host.selectPanel(panel.key)} className="max-w-64 truncate">{panel.title}</Button>
            <Button variant="ghost" size="xs" aria-label={t('guiPlugins.closePanel', { title: panel.title })}
              onClick={() => host.closePanel(panel.key)}>{t('guiPlugins.close')}</Button>
          </div>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-mobile-edge-to-edge-preview="true">
        <GuiPluginMount host={host} contributionKey={active.key} kind="panel" actions={isMobile ? actions : undefined} revision={guiPluginReadinessKey(snapshot.plugins, active.pluginId)} />
      </div>
      </> : null}
    </GuiPluginWindow>
  );
}

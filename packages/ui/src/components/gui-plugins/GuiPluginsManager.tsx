import React from 'react';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '@/components/sections/shared/SettingsGroup';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPluginWindow } from './GuiPluginWindow';
import { guiPluginReadinessKey } from './readiness';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';

export function GuiPluginsManager({ pluginIds, disabled = false }: { pluginIds?: readonly string[]; disabled?: boolean } = {}) {
  const { host, snapshot, inventory, error, loading, requested, requestLoad, setEnabled, refresh } = useGuiPlugins();
  const { t } = useI18n();
  const [selected, setSelected] = React.useState<{ host: typeof host; key: string } | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const settings = selected?.host === host ? snapshot.settings.find((item) => item.key === selected?.key) : undefined;
  const selectionExists = Boolean(settings);
  const inventoryItems = inventory.filter((plugin) => !pluginIds || pluginIds.includes(plugin.id));
  const belongsToSelection = (item: { pluginId?: string }) => !pluginIds || Boolean(item.pluginId && pluginIds.includes(item.pluginId));
  const commands = snapshot.commands.filter(belongsToSelection);
  const panels = snapshot.panels.filter(belongsToSelection);
  const menuItems = snapshot.menuItems.filter(belongsToSelection);
  const settingItems = snapshot.settings.filter(belongsToSelection);
  React.useEffect(() => { if (!requested) requestLoad(); }, [requested, requestLoad]);
  React.useEffect(() => {
    if (selected && (selected.host !== host || !selectionExists)) setSelected(null);
  }, [host, selected, selectionExists]);
  const statuses = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));
  const act = async (action: () => void | Promise<void>) => {
    setActionError(null);
    try { await action(); } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('guiPlugins.error'));
    }
  };

  return (
    <div className="yuri-settings-section-stack" data-plugin-gui-controls>
      {pluginIds ? inventoryItems.map((plugin) => {
        const status = statuses.get(plugin.id);
        const failure = plugin.error || status?.error;
        const active = plugin.enabled && !failure && status?.status === 'active';
        return <div key={plugin.id} className="yuri-plugin-gui-control" data-gui-plugin-id={plugin.id}>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="shrink-0 text-foreground">{t('guiPlugins.interface')}</span>
            {loading && plugin.enabled && !failure ? <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-muted-foreground" />
              : <span className={`size-1.5 shrink-0 rounded-full ${failure ? 'bg-[var(--status-error)]' : active ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/50'}`} aria-hidden />}
            <span className="min-w-0 truncate text-muted-foreground/80" title={failure || undefined} role={failure ? 'alert' : 'status'}>
              {failure || t(!plugin.enabled ? 'guiPlugins.off' : active ? 'guiPlugins.active' : loading ? 'common.loading' : 'guiPlugins.pending')}
            </span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground/60">{t('guiPlugins.interface.description')}</p>
          </div>
          <Switch checked={plugin.enabled} disabled={disabled || loading} aria-label={t('guiPlugins.enable', { id: plugin.id })}
            onCheckedChange={(enabled) => void act(() => setEnabled(plugin.id, enabled))} />
        </div>;
      }) : <SettingsGroup label={t('guiPlugins.title')} actions={
        <Button size="sm" disabled={loading} onClick={() => void act(refresh)}>{t('guiPlugins.refresh')}</Button>
      }>
        {loading ? <SettingsRow label={t('common.loading')}><span role="status" aria-busy /></SettingsRow> : null}
        {inventory.length === 0 && !loading ? <SettingsRow label={t('guiPlugins.empty')}>{null}</SettingsRow> : null}
        {inventory.map((plugin) => {
          const status = statuses.get(plugin.id);
          const failure = plugin.error || status?.error;
          return <SettingsToggleRow key={plugin.id} label={plugin.id}
            ariaLabel={t('guiPlugins.enable', { id: plugin.id })} checked={plugin.enabled} disabled={loading}
            onChange={(enabled) => void act(() => setEnabled(plugin.id, enabled))}
            description={failure ? <span role="alert" className="text-[var(--status-error)]">{failure}</span>
              : t(!plugin.enabled ? 'guiPlugins.disabled' : status?.status === 'active' ? 'guiPlugins.active' : status?.status === 'failed' ? 'guiPlugins.failed' : 'guiPlugins.pending')} />;
        })}
      </SettingsGroup>}
      {error || actionError ? <div role="alert" className="text-[var(--status-error)]">{actionError || error}</div> : null}
      {commands.length ? <SettingsGroup label={t('guiPlugins.commands')}>
        {commands.map((command) => <SettingsRow key={command.key} label={command.title} description={command.description}>
          <Button size="sm" disabled={!host} onClick={() => void act(() => host?.runCommand(command.key))}>{t('guiPlugins.run')}</Button>
        </SettingsRow>)}
      </SettingsGroup> : null}
      {panels.length || menuItems.length ? <SettingsGroup label={t('guiPlugins.panels')}>
        {menuItems.map((item) => <SettingsRow key={`menu:${item.key}`} label={item.title} description={item.description}>
          <Button size="sm" disabled={!host} onClick={() => void act(item.run)}>{t('guiPlugins.open')}</Button>
        </SettingsRow>)}
        {panels.map((panel) => <SettingsRow key={`panel:${panel.key}`} label={panel.title}>
          <Button size="sm" disabled={!host} onClick={() => void act(() => host?.selectPanel(panel.key))}>{t('guiPlugins.open')}</Button>
        </SettingsRow>)}
      </SettingsGroup> : null}
      {settingItems.length ? <SettingsGroup label={t('guiPlugins.settings')}>
        {settingItems.map((item) => <SettingsRow key={item.key} label={item.title}>
          <Button size="sm" disabled={!host} onClick={() => setSelected({ host, key: item.key })}>{t('guiPlugins.open')}</Button>
        </SettingsRow>)}
      </SettingsGroup> : null}
      <GuiPluginWindow id="gui-plugin-settings" open={Boolean(host && settings)} title={settings?.title ?? t('guiPlugins.settings')} onClose={() => setSelected(null)}>
        {host && settings ? <GuiPluginMount host={host} contributionKey={settings.key} kind="settings" revision={guiPluginReadinessKey(snapshot.plugins, settings.pluginId)} /> : null}
      </GuiPluginWindow>
    </div>
  );
}

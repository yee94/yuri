import { Button } from '@/components/ui/button';
import { useEventListener } from '@reactuses/core';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '@/components/sections/shared/SettingsGroup';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useRemoteDesktopSetup } from '@/queries/remoteDesktopSetupQueries';

function RemoteDesktopSettingsContent() {
  const { t } = useI18n();
  const { query, mutation } = useRemoteDesktopSetup();
  useEventListener('focus', () => {
    if (!mutation.isPending) void query.refetch({ cancelRefetch: false });
  }, () => window);
  const status = query.data;
  const busy = mutation.isPending || query.isFetching;
  const permissionState = (granted: boolean | undefined) => granted === undefined
    ? t('common.loading') : granted ? t('settings.remoteDesktop.granted') : t('settings.remoteDesktop.required');
  return (
    <SettingsGroup label={t('remoteDesktop.title')} description={t('settings.remoteDesktop.devices')}
      actions={<Button size="sm" disabled={busy} onClick={() => { mutation.reset(); void query.refetch(); }}>{t('settings.remoteDesktop.recheck')}</Button>}>
      <SettingsToggleRow itemId="remote-instances.remote-desktop" label={t('settings.remoteDesktop.enable')}
        ariaLabel={t('settings.remoteDesktop.enable')} description={t('settings.remoteDesktop.description')}
        checked={status?.enabled === true} disabled={busy || !status || (!status.enabled && !status.ready)}
        onChange={enabled => mutation.mutate({ type: 'enabled', enabled })} />
      {status?.supported === false ? (
        <SettingsRow label={t('settings.remoteDesktop.status')}><span>{t('remoteDesktop.unsupported')}</span></SettingsRow>
      ) : <>
        <SettingsRow itemId="remote-instances.remote-desktop-screen" label={t('settings.remoteDesktop.screen')}
          description={t('settings.remoteDesktop.screenHint')}>
          <span className="typography-meta text-muted-foreground">{permissionState(status ? status.screenRecording === 'granted' : undefined)}</span>
          {status && status.screenRecording !== 'granted' && <Button size="sm" disabled={busy}
            onClick={() => mutation.mutate({ type: 'permission', permission: 'screen' })}>{t('settings.remoteDesktop.authorize')}</Button>}
        </SettingsRow>
        <SettingsRow itemId="remote-instances.remote-desktop-accessibility" label={t('settings.remoteDesktop.accessibility')}
          description={t('settings.remoteDesktop.accessibilityHint')}>
          <span className="typography-meta text-muted-foreground">{permissionState(status?.accessibility)}</span>
          {status && !status.accessibility && <Button size="sm" disabled={busy}
            onClick={() => mutation.mutate({ type: 'permission', permission: 'accessibility' })}>{t('settings.remoteDesktop.authorize')}</Button>}
        </SettingsRow>
        <SettingsRow label={t('settings.remoteDesktop.helper')} description={t('settings.remoteDesktop.helperHint')}>
          <span className="typography-meta text-muted-foreground">{status ? t(status.helperAvailable ? 'settings.remoteDesktop.installed' : 'settings.remoteDesktop.reinstall') : t('common.loading')}</span>
        </SettingsRow>
      </>}
      {(query.error || mutation.error) && <SettingsRow label={t('settings.remoteDesktop.status')}>
        <span role="alert" className="typography-meta text-[var(--status-error)]">{t('settings.remoteDesktop.failed')}</span>
      </SettingsRow>}
    </SettingsGroup>
  );
}

export function RemoteDesktopSettings() {
  if (!isDesktopShell() || !isDesktopLocalOriginActive()) return null;
  return <RemoteDesktopSettingsContent />;
}

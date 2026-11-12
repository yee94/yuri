import React from 'react';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';

/** A leaf subscription: a host change never enumerates projects or input catalogs. */
export const RemoteHostIndicator = React.memo(function RemoteHostIndicator({ registry, hostId, remoteState, composer = false, unsupported = false, showName = false }: {
  registry: HostRuntimeRegistry;
  hostId: string;
  remoteState?: RemoteProject['remoteState'];
  composer?: boolean;
  unsupported?: boolean;
  showName?: boolean;
}) {
  const { t } = useI18n();
  const host = useRemoteHost(registry, hostId);
  const status = unsupported ? t('remoteProjects.unsupported') : remoteState && remoteState !== 'ok'
    ? t(`remoteProjects.${remoteState}`)
    : t(`remoteProjects.state.${host?.state ?? 'offline'}`);
  const available = !unsupported && host?.state === 'connected' && (!remoteState || remoteState === 'ok');
  const details = [host?.name ?? hostId, status,
    host?.lastSyncedAt ? t('remoteProjects.lastSync', { time: new Date(host.lastSyncedAt).toLocaleString() }) : null,
    host?.lastError?.message,
  ].filter(Boolean).join(' · ');
  return <span title={details} aria-label={details} data-remote-host={hostId} className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground">
    <Icon name="computer" className="size-3 shrink-0" />
    {composer ? <span className="truncate">{host?.name ?? hostId} · {status}{!available ? ` · ${t('remoteProjects.sendBlocked')}` : ''}</span> : showName ? <span className="truncate">{host?.name ?? hostId}</span> : null}
  </span>;
});

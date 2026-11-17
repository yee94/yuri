import React from 'react';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { RemoteHostErrorIndicator } from './RemoteHostErrorIndicator';

const compactHostName = (name: string, ssh: boolean): string => ssh && /^[^\s@]+@[^\s@]+$/.test(name) ? name.slice(name.indexOf('@') + 1) : name;

/** Host tag before a registry exists: same icon + name tag, the icon becomes a spinner while the catalog loads. */
export function PendingRemoteHostIndicator({ hostId, name, loading, status, error }: { hostId: string; name: string; loading: boolean; status: string; error?: string }) {
  return <Tooltip delayDuration={600}><TooltipTrigger asChild>
    <span aria-label={`${name} · ${status}`} aria-busy={loading || undefined} data-remote-host={hostId} className="inline-flex h-5 min-w-0 max-w-48 items-center gap-1 align-middle text-[11px] leading-5 text-foreground/70">
      <Icon name={loading ? 'loader-4' : 'computer'} className={cn('block size-3 shrink-0', loading && 'animate-spin')} />
      <span className="truncate">{compactHostName(name, true)}</span>
    </span>
  </TooltipTrigger><TooltipContent side="top" sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))] text-left [overflow-wrap:anywhere]">
    <div className="space-y-1.5 py-0.5">
      <div className="font-medium">{name}</div>
      <ul className="space-y-1 text-xs leading-5 text-muted-foreground">
        <li className="flex items-start gap-2"><span aria-hidden="true" className={cn('mt-2 size-1.5 shrink-0 rounded-full', loading ? 'bg-[var(--status-warning)] animate-pulse' : 'bg-muted-foreground')} /><span>{status}</span></li>
        {error ? <li className="flex items-start gap-2 text-[var(--status-error)]"><span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-current" /><span>{error}</span></li> : null}
      </ul>
    </div>
  </TooltipContent></Tooltip>;
}

/** A leaf subscription: a host change never enumerates projects or input catalogs. */
export const RemoteHostIndicator = React.memo(function RemoteHostIndicator({ registry, hostId, remoteState, composer = false, unsupported = false, showName = false, nameOnlyTip = false, compactName = false, isolateLongPress = false }: {
  registry: HostRuntimeRegistry;
  hostId: string;
  remoteState?: RemoteProject['remoteState'];
  composer?: boolean;
  unsupported?: boolean;
  showName?: boolean;
  nameOnlyTip?: boolean;
  compactName?: boolean;
  isolateLongPress?: boolean;
}) {
  const { t } = useI18n();
  const host = useRemoteHost(registry, hostId);
  const status = unsupported ? t('remoteProjects.unsupported') : remoteState && remoteState !== 'ok'
    ? t(`remoteProjects.${remoteState}`)
    : t(`remoteProjects.state.${host?.state ?? 'offline'}`);
  const available = !unsupported && host?.state === 'connected' && (!remoteState || remoteState === 'ok');
  const lastSync = host?.lastSyncedAt ? t('remoteProjects.lastSync', { time: new Date(host.lastSyncedAt).toLocaleString() }) : null;
  const details = [host?.name ?? hostId, status,
    lastSync,
    host?.lastError?.message,
  ].filter(Boolean).join(' · ');
  const tip = nameOnlyTip ? host?.name ?? hostId : details;
  const name = host?.name ?? hostId;
  const compactLabel = compactHostName(name, host?.source === 'ssh');
  return <span className="inline-flex min-w-0 items-center gap-1"><Tooltip delayDuration={600}><TooltipTrigger asChild onPointerDown={(event) => {
    if (isolateLongPress && (event.pointerType === 'touch' || event.pointerType === 'pen')) event.stopPropagation();
  }}><span aria-label={tip} data-remote-host={hostId} onContextMenuCapture={isolateLongPress ? (event) => { event.preventDefault(); event.stopPropagation(); } : undefined} className={cn('inline-flex items-center gap-1 align-middle', compactName ? 'h-5 min-w-0 max-w-48 text-[11px] leading-5 text-foreground/70' : ['h-4 justify-center text-xs leading-none text-muted-foreground', composer || showName ? 'min-w-0' : 'w-4 shrink-0'])}>
    <Icon name="computer" className="block size-3 shrink-0" />
    {composer ? <span className="truncate">{name} · {status}{!available ? ` · ${t('remoteProjects.sendBlocked')}` : ''}</span> : compactName || showName ? <span className="truncate">{compactName ? compactLabel : name}</span> : null}
  </span></TooltipTrigger><TooltipContent side="top" sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))] text-left [overflow-wrap:anywhere]">
    {nameOnlyTip ? name : <div className="space-y-1.5 py-0.5">
      <div className="font-medium">{name}</div>
      <ul className="space-y-1 text-xs leading-5 text-muted-foreground">
        <li className="flex items-start gap-2"><span aria-hidden="true" className={cn('mt-2 size-1.5 shrink-0 rounded-full', available ? 'bg-[var(--status-success)]' : 'bg-muted-foreground')} /><span>{status}</span></li>
        {lastSync ? <li className="flex items-start gap-2"><span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" /><span>{lastSync}</span></li> : null}
        {host?.lastError?.message ? <li className="flex items-start gap-2 text-[var(--status-error)]"><span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-current" /><span>{host.lastError.message}</span></li> : null}
      </ul>
    </div>}
  </TooltipContent></Tooltip>{!nameOnlyTip ? <RemoteHostErrorIndicator registry={registry} hostId={hostId} connectionError={host?.lastError?.message} /> : null}</span>;
});

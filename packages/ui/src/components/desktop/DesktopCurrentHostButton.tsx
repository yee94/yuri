import * as React from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { canManageDesktopHosts, isDesktopLocalOriginActive } from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, isVisibleDesktopHost, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { desktopSshInstancesGet } from '@/lib/desktopSsh';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { desktopHostConnectionIcon } from './desktopHostConnectionIcon';

const hostInventoryOptions = (transport: string, runtimeKey: string, apiUrl: string) => queryOptions({
  queryKey: ['desktop-host-inventory', transport],
  queryFn: async ({ signal }) => {
    const config = await desktopHostsGet();
    const sshIds = new Set(config.sshHostIds ?? []);
    if (config.sshHostIds === undefined && canManageDesktopHosts()) {
      const ssh = await desktopSshInstancesGet();
      for (const instance of ssh.instances) sshIds.add(instance.id);
    }
    signal.throwIfAborted();
    const hosts = config.hosts.filter(host => isVisibleDesktopHost(host, sshIds)
      || runtimeKey === `host:${host.id}`
      || Boolean(apiUrl && locationMatchesHost(apiUrl, getDesktopHostApiUrl(host))));
    return { hosts, sshIds };
  },
});

export function DesktopCurrentHostButton({ onClick, open }: { onClick: () => void; open: boolean }) {
  const { t } = useI18n();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const settingsOpen = useUIStore(state => state.isSettingsDialogOpen);
  const runtimeKey = getRuntimeKey();
  const apiUrl = getRuntimeApiBaseUrl();
  const isLocal = isDesktopLocalOriginActive();
  const { data } = useQuery({ ...hostInventoryOptions(transport, runtimeKey, apiUrl), enabled: !settingsOpen });
  const hostId = runtimeKey.startsWith('host:') ? runtimeKey.slice(5) : null;
  const current = data?.hosts.find(host => hostId ? host.id === hostId : Boolean(apiUrl && locationMatchesHost(apiUrl, getDesktopHostApiUrl(host))));
  if (isLocal && !data?.hosts.length && !data?.sshIds.size) return null;
  const label = current ? redactSensitiveUrl(current.label) : t(isLocal ? 'desktopHostSwitcher.instance.local' : 'desktopHostSwitcher.title');
  const icon = desktopHostConnectionIcon({
    isLocal,
    isSsh: Boolean(current && data?.sshIds.has(current.id)),
    isRelay: transport.startsWith('relay:'),
  });
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="sm" className="app-region-no-drag h-7 w-12 gap-0 self-center rounded-md border border-border/40 px-1 py-0 text-muted-foreground hover:text-foreground" aria-label={t('header.actions.sessionMenu.servicesWithInstance', { current: label })} aria-expanded={open} aria-haspopup="menu" onClick={onClick}>
        <span className="inline-flex h-full w-7 items-center justify-center"><Icon name={icon} className="size-5" /></span>
        <span className="inline-flex h-full w-3 items-center justify-center"><Icon name="arrow-down-s" className="size-2.5" /></span>
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

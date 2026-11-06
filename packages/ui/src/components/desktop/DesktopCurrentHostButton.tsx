import * as React from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { canManageDesktopHosts } from '@/lib/desktop';
import { desktopHostProbe, desktopHostsGet, getDesktopHostApiUrl, isVisibleDesktopHost, locationMatchesHost, probeRelayDesktopHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { desktopSshInstancesGet, desktopSshStatus } from '@/lib/desktopSsh';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { desktopHostConnectionIcon } from './desktopHostConnectionIcon';

const hostInventoryOptions = (transport: string) => queryOptions({
  queryKey: ['desktop-host-inventory', transport],
  queryFn: async ({ signal }) => {
    const [config, ssh, sshStatuses] = await Promise.all([
      desktopHostsGet(),
      canManageDesktopHosts() ? desktopSshInstancesGet() : Promise.resolve({ instances: [] }),
      canManageDesktopHosts() ? desktopSshStatus() : Promise.resolve([]),
    ]);
    const sshIds = new Set(ssh.instances.map(instance => instance.id));
    signal.throwIfAborted();
    const hosts = config.hosts.filter(host => isVisibleDesktopHost(host, sshIds));
    const availability = await Promise.allSettled(hosts.map(async host => {
      if (sshIds.has(host.id)) return sshStatuses.some(status => status.id === host.id && status.phase === 'ready');
      if (!host.relay || host.apiUrl) {
        const result = await desktopHostProbe(getDesktopHostApiUrl(host), { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch(error => {
          if (!host.relay) throw error;
          return null;
        });
        if (result?.status === 'ok' || result?.status === 'update-recommended') return true;
      }
      if (!host.relay) return false;
      signal.throwIfAborted();
      const result = await probeRelayDesktopHost(host.relay, { clientToken: host.clientToken || null });
      return result.status === 'ok' || result.status === 'update-recommended';
    }));
    signal.throwIfAborted();
    return { hosts, sshIds, onlineIds: new Set(hosts.filter((_, index) => {
      const result = availability[index];
      return result.status === 'fulfilled' && result.value;
    }).map(host => host.id)) };
  },
});

export function DesktopCurrentHostButton({ onClick, open }: { onClick: () => void; open: boolean }) {
  const { t } = useI18n();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const settingsOpen = useUIStore(state => state.isSettingsDialogOpen);
  const isConnected = useConfigStore(state => state.isConnected);
  const { data } = useQuery({ ...hostInventoryOptions(transport), enabled: !settingsOpen });
  const runtimeKey = getRuntimeKey();
  const apiUrl = getRuntimeApiBaseUrl();
  const hostId = runtimeKey.startsWith('host:') ? runtimeKey.slice(5) : null;
  const current = data?.hosts.find(host => hostId ? host.id === hostId : Boolean(apiUrl && locationMatchesHost(apiUrl, getDesktopHostApiUrl(host))));
  if (!data?.hosts.length) return null;
  const onlineIds = new Set(data.onlineIds);
  // The desktop owns a local backend; the active remote's live connection wins over probes.
  onlineIds.add('local');
  if (current && isConnected) onlineIds.add(current.id);
  if (current && !isConnected) onlineIds.delete(current.id);
  if (!current && !isConnected) onlineIds.delete('local');
  if (onlineIds.size < 2) return null;
  const label = current ? redactSensitiveUrl(current.label) : t(hostId ? 'desktopHostSwitcher.title' : 'desktopHostSwitcher.instance.local');
  const icon = desktopHostConnectionIcon({
    isLocal: !hostId && !current && !transport.startsWith('relay:'),
    isSsh: Boolean(current && data.sshIds.has(current.id)),
    isRelay: transport.startsWith('relay:'),
  });
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="sm" className="app-region-no-drag gap-1 text-muted-foreground" aria-label={t('header.actions.sessionMenu.servicesWithInstance', { current: label })} aria-expanded={open} aria-haspopup="menu" onClick={onClick}>
        <Icon name={icon} className="size-6" />
        <Icon name="arrow-down-s" className="size-3" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { readInstanceScopedItem, writeInstanceScopedItem } from '@/lib/instanceScopedStorage';
import { desktopHostsGet } from '@/lib/desktopHosts';
import { isDesktopShell } from '@/lib/desktop';
import type { HostCatalog } from './types';

const HOST_NAMES_KEY = 'remoteHostNames';

const readNames = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(readInstanceScopedItem(HOST_NAMES_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
};

/** Display names survive reloads so a Remote Project row can name its machine before the catalog resolves. */
export const rememberRemoteHostNames = (catalog: HostCatalog): void => {
  if (!catalog.supported || !catalog.hosts.length) return;
  const names = readNames();
  let changed = false;
  for (const host of catalog.hosts) {
    if (host.name && names[host.id] !== host.name) { names[host.id] = host.name; changed = true; }
  }
  if (!changed) return;
  try { writeInstanceScopedItem(HOST_NAMES_KEY, JSON.stringify(names)); } catch { /* ignored */ }
};

/** Last known name: catalog cache first, then the desktop SSH/Relay host label sharing the same id. */
export const useRemoteHostDisplayName = (hostId: string): string | undefined => {
  const cached = readNames()[hostId];
  const desktop = useQuery({
    queryKey: ['desktop-hosts', 'labels'],
    queryFn: async () => Object.fromEntries((await desktopHostsGet()).hosts.map((host) => [host.id, host.label])),
    enabled: !cached && isDesktopShell(),
    staleTime: 30_000,
  }, queryClient);
  return cached ?? desktop.data?.[hostId];
};

import { queryOptions } from '@tanstack/react-query';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { readRemoteResponse } from './remoteProjectQueries';

type Directory = { name: string; path: string };

export function assertRemoteDirectoryScope(registry: HostRuntimeRegistry, entry: HostRuntimeEntry) {
  registry.assertCurrent();
  if (registry.resolve(entry.location) !== entry) throw new Error('Remote Host connection changed during request');
}

export function remoteDirectoryHomeOptions(registry: HostRuntimeRegistry, entry: HostRuntimeEntry) {
  return queryOptions({
    queryKey: [...entry.queryScope, 'project-picker', 'home'],
    queryFn: async ({ signal }) => {
      const payload = await readRemoteResponse(await entry.fetch('/api/fs/home', { signal }));
      assertRemoteDirectoryScope(registry, entry);
      if (!payload || typeof payload !== 'object' || !('home' in payload) || typeof payload.home !== 'string') throw new Error('Invalid home directory response');
      return payload.home;
    },
  });
}

export function remoteDirectoryListOptions(registry: HostRuntimeRegistry, entry: HostRuntimeEntry, directory: string) {
  return queryOptions({
    queryKey: [...entry.queryScope, 'project-picker', 'list', directory],
    queryFn: async ({ signal }): Promise<Directory[]> => {
      const payload = await readRemoteResponse(await entry.fetch('/api/fs/list', { query: { path: directory }, signal }));
      assertRemoteDirectoryScope(registry, entry);
      if (!payload || typeof payload !== 'object' || !('entries' in payload) || !Array.isArray(payload.entries)) throw new Error('Invalid directory response');
      return payload.entries.flatMap((child: unknown) => {
        if (!child || typeof child !== 'object' || !('isDirectory' in child) || !child.isDirectory) return [];
        if (!('name' in child) || typeof child.name !== 'string' || !('path' in child) || typeof child.path !== 'string') throw new Error('Invalid directory entry');
        return [{ name: child.name, path: child.path }];
      });
    },
  });
}

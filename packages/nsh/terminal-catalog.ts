import type { TerminalTab } from './terminal-core';
import { terminalDirectoryPath } from './terminal-path';

export type TerminalCatalog = { schema: 1; hostID: string; directories: { directory: string; activeId: string; tabs: {
  id: string; sessionId?: string; label?: string; iconKey?: string; lifecycle: 'idle' | 'running' | 'exited'; createUnknown?: boolean;
}[] }[] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Retains Web's metadata-only persistence contract, adds Host partition; leases/output/commands are never durable. */
export function terminalCatalogValue(hostID: string, directories: ReadonlyMap<string, { activeId: string; tabs: readonly TerminalTab[] }>): TerminalCatalog {
  return { schema: 1, hostID, directories: [...directories].map(([directory, state]) => ({ directory, activeId: state.activeId,
    tabs: state.tabs.map(tab => ({ id: tab.id,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}), ...(tab.label !== undefined ? { label: tab.label } : {}),
      ...(tab.iconKey !== undefined ? { iconKey: tab.iconKey } : {}), ...(tab.createUnknown ? { createUnknown: true } : {}),
      lifecycle: tab.phase === 'exited' ? 'exited' : tab.sessionId ? 'running' : 'idle' })) })) };
}
export function terminalCatalogFrom(value: unknown, hostID: string): TerminalCatalog | null {
  const data = object(value);
  if (data.schema !== 1 || data.hostID !== hostID || !Array.isArray(data.directories) || data.directories.length > 128) return null;
  const result: TerminalCatalog = { schema: 1, hostID, directories: [] }, allIDs = new Set<string>(), paths = new Set<string>();
  for (const item of data.directories) {
    const entry = object(item), path = typeof entry.directory === 'string' ? terminalDirectoryPath(entry.directory) : null;
    if (path === null
      || paths.has(path) || !Array.isArray(entry.tabs) || !entry.tabs.length || entry.tabs.length > 64) return null;
    paths.add(path);
    const tabs: TerminalCatalog['directories'][number]['tabs'] = [];
    for (const raw of entry.tabs) {
      const tab = object(raw);
      if (typeof tab.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tab.id) || allIDs.has(tab.id)
        || tab.sessionId !== undefined && (typeof tab.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tab.sessionId))
        || tab.label !== undefined && (typeof tab.label !== 'string' || tab.label.length > 256)
        || tab.iconKey !== undefined && (typeof tab.iconKey !== 'string' || tab.iconKey.length > 64)
        || !['idle', 'running', 'exited'].includes(String(tab.lifecycle))) return null;
      allIDs.add(tab.id);
      tabs.push({ id: tab.id, sessionId: tab.sessionId as string | undefined, label: tab.label as string | undefined, iconKey: tab.iconKey as string | undefined,
        lifecycle: tab.lifecycle as 'idle' | 'running' | 'exited', createUnknown: tab.createUnknown === true });
    }
    result.directories.push({ directory: path, tabs, activeId: tabs.some(tab => tab.id === entry.activeId) ? String(entry.activeId) : tabs[0].id });
  }
  return result;
}

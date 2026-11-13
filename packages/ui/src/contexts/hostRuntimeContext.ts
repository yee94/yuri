import { createContext } from 'react';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { HostContentDemand } from '@/lib/remote-projects/content-demand';

export interface HostRuntimeContextValue {
  registry: HostRuntimeRegistry;
  entry: HostRuntimeEntry;
  demand: HostContentDemand;
  connectionError?: Error | null;
  reconnect?: () => Promise<void>;
}

export const HostRuntimeContext = createContext<HostRuntimeContextValue | null>(null);

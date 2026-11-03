import { createContext, useContext } from 'react';
import type { GuiPluginHost } from './host';
import type { PluginSource } from '@yuriai/opencode-gui-client';

type Snapshot = ReturnType<GuiPluginHost['getSnapshot']>;
export const GuiFileIconsContext = createContext<Pick<GuiPluginHost['fileIcons'], 'subscribe' | 'get'> | null>(null);
const emptySnapshot: Snapshot = { plugins: [], commands: [], titlebarItems: [], panels: [], pages: [], settings: [], menuItems: [], activePanel: null };
export const getEmptySnapshot = () => emptySnapshot;

export interface GuiPluginsContextValue {
  host: GuiPluginHost | null;
  snapshot: Snapshot;
  inventory: readonly { id: string; source?: PluginSource; enabled: boolean; error?: string }[];
  error: string | null;
  loading: boolean;
  requested: boolean;
  requestLoad(): void;
  setEnabled(id: string, enabled: boolean): void;
  refresh(): void;
}

export const GuiPluginsContext = createContext<GuiPluginsContextValue>({
  host: null, snapshot: emptySnapshot, inventory: [], error: null, loading: false, requested: false,
  requestLoad: () => {}, setEnabled: () => {}, refresh: () => {},
});

export const useGuiPlugins = () => useContext(GuiPluginsContext);

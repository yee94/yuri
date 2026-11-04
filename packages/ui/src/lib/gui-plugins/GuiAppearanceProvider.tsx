import React from 'react';
import { ThemeSystemContext } from '@/contexts/theme-system-context';
import { EMPTY_GUI_APPEARANCE } from './appearance';
import { GuiAppearanceContext } from './appearance-context';
import type { GuiPluginHost } from './host';

const empty = () => EMPTY_GUI_APPEARANCE;
const noopSubscribe = () => () => {};

/** This leaf subscribes only to appearance contributions, never streaming/session snapshots. */
export function GuiAppearanceProvider({ host, children }: { host: GuiPluginHost | null; children: React.ReactNode }) {
    const catalog = host?.appearanceCatalog;
    const snapshot = React.useSyncExternalStore(catalog?.subscribe ?? noopSubscribe, catalog?.getSnapshot ?? empty, empty);
    const theme = React.useContext(ThemeSystemContext);
    const registerThemes = theme?.registerPluginThemes;
    const mode = theme?.currentTheme.metadata.variant ?? 'dark';
    React.useEffect(() => registerThemes?.(snapshot.themes), [registerThemes, snapshot.themes]);
    const logo = snapshot.branding.find((entry) => entry.logo)?.logo?.[mode];
    const dock = snapshot.branding.find((entry) => entry.native && entry.dockIcon);
    const dockImage = dock?.dockIcon?.[mode];
    React.useEffect(() => {
        if (!host || !dock || !dockImage) return;
        void host.setDockIcon(dock.pluginId, dockImage).catch(() => {});
        return () => { void host.setDockIcon(dock.pluginId, null).catch(() => {}); };
    }, [host, dock, dockImage]);
    const value = React.useMemo(() => ({ logo }), [logo]);
    return <GuiAppearanceContext.Provider value={value}>
        {children}
    </GuiAppearanceContext.Provider>;
}

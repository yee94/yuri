import React from 'react';

import { Button } from '@/components/ui/button';
import { GitView } from '@/components/views/GitView';
import { Icon } from "@/components/icon/Icon";
import { useGitStore } from '@/lib/api/useProjectGitStore';
import { useUIStore, type RightSidebarTab } from '@/stores/useUIStore';
import { useProjectRuntimeAPIs } from '@/lib/api/useProjectRuntimeAPIs';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { shouldShowBrowserProviderRail } from '@/lib/browser-provider/contract';
import { useBrowserProviderCatalogQuery } from '@/queries/browserProviderQueries';
import { BrowserProviderRail } from './BrowserProviderRail';
import { SidebarFilesTree } from './SidebarFilesTree';
import { visibleRightSidebarTabs } from './visibleRightSidebarTabs';

const isBrowserActive = (): boolean => {
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  return true;
};

/**
 * Keeps git status fresh while the right sidebar's Git tab is the visible
 * consumer. Replaces the GitPollingProvider removed in commit b2d5ccb4.
 *
 * Gating rules (mirror the right-sidebar render policy):
 *   - sidebar must be open
 *   - right tab must be 'git' (otherwise GitView is not the visible consumer)
 *   - main tab must not be 'git' (otherwise secondaryView's GitView handles
 *     refresh and this poll would duplicate work)
 *   - browser must be visible + online
 *
 * Any condition flip resets the interval so the next tick starts fresh.
 */
function useRightSidebarGitSync(
  directory: string | undefined,
  isSidebarOpen: boolean,
  rightTab: RightSidebarTab | undefined,
  mainTab: string | undefined
) {
  const { git } = useProjectRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  const shouldPoll = Boolean(
    directory && git && isSidebarOpen && rightTab === 'git' && mainTab !== 'git'
  );

  React.useEffect(() => {
    if (!shouldPoll || !directory || !git) return;

    void ensureStatus(directory, git);

    const POLL_INTERVAL = 10_000;
    const id = window.setInterval(() => {
      if (!isBrowserActive()) return;
      void ensureStatus(directory, git);
    }, POLL_INTERVAL);

    return () => window.clearInterval(id);
  }, [shouldPoll, directory, git, ensureStatus]);
}

export const RightSidebarToolbar: React.FC<{
  railVisible?: boolean;
}> = ({ railVisible }) => {
  const { t } = useI18n();
  const isOpen = useUIStore((state) => state.isRightSidebarOpen);
  const preferredTab = useUIStore((state) => state.rightSidebarTab);
  const setOpen = useUIStore((state) => state.setRightSidebarOpen);
  const setTab = useUIStore((state) => state.setRightSidebarTab);
  const mainTab = useUIStore((state) => state.activeMainTab);
  const host = useHostRuntime();
  const browserCatalog = useBrowserProviderCatalogQuery({ enabled: !host?.entry.location.hostId });
  const tabs = visibleRightSidebarTabs({ hideGit: mainTab === 'git', showBrowser: !host?.entry.location.hostId && shouldShowBrowserProviderRail(browserCatalog.data) });
  const activeTab = tabs.includes(preferredTab) ? preferredTab : tabs[0] ?? 'files';
  return (
    <div role="group" aria-label={t('header.actions.toggleRightSidebarAria')} className="inline-flex h-7 items-center overflow-hidden rounded-md border border-border/40 divide-x divide-border/40">
      {tabs.map((tab) => {
        const selected = (railVisible ?? isOpen) && activeTab === tab;
        const label = t(tab === 'git' ? 'layout.rightSidebar.git' : tab === 'files' ? 'contextPanel.actions.toggleFileTree' : 'layout.rightSidebar.browser');
        return <Button key={tab} type="button" variant="ghost" size="icon"
          className={cn('h-full w-7 !rounded-none text-muted-foreground hover:text-foreground focus-visible:z-10 focus-visible:ring-inset', selected && 'bg-interactive-selection text-interactive-selection-foreground')}
          aria-pressed={selected} aria-label={label} title={label}
          onClick={() => { setTab(tab); setOpen(!selected); }}>
          <Icon name={tab === 'git' ? 'git-branch' : tab === 'files' ? 'list-unordered' : 'global'} className="size-4" />
        </Button>;
      })}
    </div>
  );
};

export const RightSidebarTabs: React.FC<{ isActive: boolean }> = ({ isActive }) => {
  const preferredTab = useUIStore((state) => state.rightSidebarTab);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const directory = useEffectiveDirectory();
  const host = useHostRuntime();
  const browserCatalog = useBrowserProviderCatalogQuery({ enabled: !host?.entry.location.hostId });
  const selectedProvider = browserCatalog.data?.providers.find((provider) => provider.id === browserCatalog.data?.selectedId) ?? null;
  const showBrowser = !host?.entry.location.hostId && shouldShowBrowserProviderRail(browserCatalog.data);

  // When the main view already hosts a right-tab equivalent (e.g. main tab
  // 'git' renders GitView in the secondary slot), the right sidebar's
  // matching tab is hidden to avoid two live GitView instances running
  // effects. The browser tab exists only while a provider is actually selected.
  const hideGit = activeMainTab === 'git';
  const visibleTabs = React.useMemo(
    () => visibleRightSidebarTabs({ hideGit, showBrowser }),
    [hideGit, showBrowser],
  );

  // Resolve unavailable saved choices before rendering without overwriting the preference.
  const rightSidebarTab = visibleTabs.includes(preferredTab) ? preferredTab : visibleTabs[0] ?? 'files';
  useRightSidebarGitSync(directory, isActive, rightSidebarTab, activeMainTab);

  const isRightGitTabActive = isActive && rightSidebarTab === 'git' && !hideGit;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn('h-full', rightSidebarTab !== 'git' && 'hidden')}>
          <GitView isActive={isRightGitTabActive} />
        </div>
        <div className={cn('h-full', rightSidebarTab !== 'files' && 'hidden')}>
          <SidebarFilesTree />
        </div>
        {showBrowser && selectedProvider ? (
          <div className={cn('h-full', rightSidebarTab !== 'browser' && 'hidden')}>
            <BrowserProviderRail provider={selectedProvider} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

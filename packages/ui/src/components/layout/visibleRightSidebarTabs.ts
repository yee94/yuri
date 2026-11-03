import type { RightSidebarTab } from '@/stores/useUIStore';

export const visibleRightSidebarTabs = (input: {
  hideGit: boolean;
  showBrowser: boolean;
}): RightSidebarTab[] => {
  const tabs: RightSidebarTab[] = [];
  if (!input.hideGit) tabs.push('git');
  tabs.push('files');
  if (input.showBrowser) tabs.push('browser');
  return tabs;
};

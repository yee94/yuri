import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SidebarProjectsList } from './SidebarProjectsList';

const counters = vi.hoisted(() => ({ headers: 0 }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/projectMeta', () => ({ PROJECT_COLOR_MAP: {}, PROJECT_ICON_MAP: {}, ProjectIconImage: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef<HTMLElement, { children: React.ReactNode }>(function Overlay({ children }, ref) {
    return <div ref={ref as React.Ref<HTMLDivElement>}>{children}</div>;
  }),
}));
// The real SortableContext stays: its context value is what re-renders headers.
vi.mock('./sortableItems', async (importOriginal) => {
  const { useSortable } = await import('@dnd-kit/sortable');
  return {
    ...await importOriginal<typeof import('./sortableItems')>(),
    SortableProjectItem: React.memo(function SortableProjectItem({ id, children }: { id: string; children?: React.ReactNode }) {
      useSortable({ id });
      counters.headers += 1;
      return <div data-project={id}>{children}</div>;
    }),
  };
});
vi.mock('@/stores/useGlobalSessionsStore', async () => {
  const { create } = await import('zustand');
  return { useGlobalSessionsStore: create(() => ({ loadingDirectories: new Set<string>(), refreshingDirectories: new Set<string>() })) };
});
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({ availableWorktreesByProject: new Map() })) };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host); counters.headers = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

it('keeps every project header still across list re-renders until the project order really changes', async () => {
  const noop = () => {};
  const sections = ['a', 'b', 'c'].map((id) => ({ project: { id, normalizedPath: `/${id}` }, groups: [] }));
  const props: React.ComponentProps<typeof SidebarProjectsList> = {
    hasLeadingSection: false, sectionsForRender: sections, projectSections: sections, activeProjectId: 'a',
    showOnlyMainWorkspace: false, hasSessionSearchQuery: false, emptyState: null, searchEmptyState: null,
    renderGroupSessions: () => null, homeDirectory: null, collapsedProjects: new Set(), hideDirectoryControls: false,
    projectRepoStatus: new Map(), mobileVariant: false, alwaysShowActions: true, toggleProject: noop,
    setActiveProjectIdOnly: noop, setActiveMainTab: noop, setSessionSwitcherOpen: noop, openNewSessionDraft: noop,
    openNewWorktreeDialog: noop, syncProjectSessions: noop, openProjectEditDialog: noop, removeProject: noop,
    reorderProjects: noop, projectSortOrder: 'manual', getOrderedGroups: (_id, groups) => groups,
    setGroupOrderByProject: noop, openSidebarMenuKey: null, setOpenSidebarMenuKey: noop, isInlineEditing: false,
  };
  await act(async () => root.render(<SidebarProjectsList {...props} projectOrderIds={['a', 'b', 'c']} topContent={<span>0</span>} />));
  expect(host.querySelectorAll('[data-project]')).toHaveLength(3);
  const initial = counters.headers;
  for (let index = 1; index <= 30; index += 1) {
    await act(async () => root.render(
      <SidebarProjectsList {...props} sectionsForRender={[...sections]} projectOrderIds={['a', 'b', 'c']} topContent={<span>{index}</span>} />,
    ));
  }
  expect(counters.headers).toBe(initial);
  await act(async () => root.render(<SidebarProjectsList {...props} projectOrderIds={['c', 'b', 'a']} />));
  expect(Array.from(host.querySelectorAll('[data-project]'), (node) => node.getAttribute('data-project'))).toEqual(['c', 'b', 'a']);
  expect(counters.headers).toBeGreaterThan(initial);
});

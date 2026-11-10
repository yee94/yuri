import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SidebarProjectsList } from './SidebarProjectsList';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import * as focusedRowScroll from './scrollFocusedSessionRow';

const counters = vi.hoisted(() => ({ project: 0 }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/projectMeta', () => ({ PROJECT_COLOR_MAP: {}, PROJECT_ICON_MAP: {}, ProjectIconImage: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef<HTMLElement, { children: React.ReactNode }>(function Overlay({ children }, ref) {
    return <div ref={ref as React.Ref<HTMLDivElement>}>{children}</div>;
  }),
}));
vi.mock('@dnd-kit/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@dnd-kit/core')>(),
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: () => null,
}));
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: ({ id }: { id: string }) => {
    if (id === 'project') counters.project += 1;
    return { attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, transition: undefined, isDragging: false };
  },
  arrayMove: (items: unknown[]) => items,
  sortableKeyboardCoordinates: () => {}, verticalListSortingStrategy: () => {},
}));
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
  root = createRoot(host); counters.project = 0;
  useGlobalSessionsStore.setState({ loadingDirectories: new Set(), refreshingDirectories: new Set() });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  host.remove(); vi.unstubAllGlobals();
});

it('skips project hook and body work across 50 unrelated parent commits, and invokes current actions', async () => {
  const noop = () => {};
  const renderGroupSessions = vi.fn(() => <span data-session>Session</span>);
  const section = {
    project: { id: 'project', normalizedPath: '/project' },
    groups: [{ id: 'root', label: 'Root', branch: null, description: null, isMain: true, worktree: null, directory: '/project', sessions: [] }],
  };
  const onNewSession = vi.fn();
  const props: React.ComponentProps<typeof SidebarProjectsList> = {
    hasLeadingSection: false, sectionsForRender: [section], projectSections: [section], activeProjectId: 'project',
    showOnlyMainWorkspace: false, hasSessionSearchQuery: false, emptyState: null, searchEmptyState: null,
    renderGroupSessions, homeDirectory: null, collapsedProjects: new Set(), hideDirectoryControls: false,
    projectRepoStatus: new Map(), mobileVariant: false,
    alwaysShowActions: true, toggleProject: noop, setActiveProjectIdOnly: noop, setActiveMainTab: noop,
    setSessionSwitcherOpen: noop, openNewSessionDraft: onNewSession, openNewWorktreeDialog: noop,
    syncProjectSessions: noop, openProjectEditDialog: noop, removeProject: noop,
    reorderProjects: noop, projectSortOrder: 'manual',
    getOrderedGroups: (_id, groups) => groups, setGroupOrderByProject: noop, openSidebarMenuKey: null,
    setOpenSidebarMenuKey: noop, isInlineEditing: false,
  };
  await act(async () => root.render(<SidebarProjectsList {...props} topContent={<span>0</span>} />));
  const initial = counters.project;
  for (let index = 1; index <= 50; index += 1) {
    await act(async () => root.render(<SidebarProjectsList {...props} topContent={<span>{index}</span>} />));
  }
  expect(counters.project - initial).toBe(0);
  expect(renderGroupSessions).toHaveBeenCalledTimes(1);
  const row = host.querySelector('[data-session]');
  for (let index = 0; index < 50; index += 1) {
    await act(async () => useGlobalSessionsStore.setState({
      loadingDirectories: new Set([`/other-${index}`]),
      refreshingDirectories: new Set([`/other-${index}`]),
    }));
  }
  expect(counters.project - initial).toBe(0);
  expect(renderGroupSessions).toHaveBeenCalledTimes(1);
  await act(async () => useGlobalSessionsStore.setState({ loadingDirectories: new Set(['/project']) }));
  expect(counters.project).toBeGreaterThan(initial);
  expect(renderGroupSessions).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-session]')).toBe(row);
  const latestAction = vi.fn();
  await act(async () => root.render(<SidebarProjectsList {...props} openNewSessionDraft={latestAction} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="sessions.sidebar.project.actions.newSession"]')!.click());
  expect(latestAction).toHaveBeenCalledWith({ directoryOverride: '/project' });
  expect(onNewSession).not.toHaveBeenCalled();
});

const buildRevealProps = (): React.ComponentProps<typeof SidebarProjectsList> => {
  const noop = () => {};
  const sections = Array.from({ length: 51 }, (_, index) => ({
    project: { id: `project-${index}`, normalizedPath: `/project-${index}` }, groups: [],
  }));
  return {
    hasLeadingSection: false, sectionsForRender: sections, projectSections: sections, activeProjectId: 'project-50',
    showOnlyMainWorkspace: false, hasSessionSearchQuery: false, emptyState: null, searchEmptyState: null,
    renderGroupSessions: vi.fn(() => null), homeDirectory: null, collapsedProjects: new Set(['project-50']),
    hideDirectoryControls: false, projectRepoStatus: new Map(), mobileVariant: false, alwaysShowActions: true,
    toggleProject: vi.fn(), setActiveProjectIdOnly: vi.fn(), setActiveMainTab: noop, setSessionSwitcherOpen: noop,
    openNewSessionDraft: vi.fn(), openNewWorktreeDialog: noop, syncProjectSessions: vi.fn(), openProjectEditDialog: noop,
    removeProject: noop, reorderProjects: vi.fn(), projectSortOrder: 'manual', getOrderedGroups: (_id, groups) => groups,
    setGroupOrderByProject: noop, openSidebarMenuKey: null, setOpenSidebarMenuKey: noop, isInlineEditing: false,
  };
};

it('reveals only the routed project header once per intent, preserving collapse, order and session demand', async () => {
  const props = buildRevealProps();
  const scroll = vi.spyOn(focusedRowScroll, 'scrollFocusedSessionRowIntoView').mockImplementation(() => {});
  await act(async () => root.render(<SidebarProjectsList {...props} />));
  expect(scroll).not.toHaveBeenCalled();
  const target = { projectId: 'project-50', revision: 1 };
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={target} />));
  const header = host.querySelector('[data-sidebar-project-header="project-50"]');
  expect(header).not.toBeNull();
  expect(scroll).toHaveBeenCalledExactlyOnceWith(header);
  scroll.mockClear();
  for (let index = 0; index < 50; index++) {
    await act(async () => {
      useGlobalSessionsStore.setState({ loadingDirectories: new Set([`/project-${index}`]) });
      root.render(<SidebarProjectsList {...props} projectRevealTarget={{ ...target }} sectionsForRender={[...props.sectionsForRender]} topContent={<span>{index}</span>} />);
    });
  }
  expect(scroll).not.toHaveBeenCalled();
  expect(host.querySelector('[data-sidebar-project-header="project-50"]')).toBe(header);
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={{ ...target, revision: 2 }} />));
  expect(scroll).toHaveBeenCalledExactlyOnceWith(header);
  expect(props.toggleProject).not.toHaveBeenCalled();
  expect(props.reorderProjects).not.toHaveBeenCalled();
  expect(props.setActiveProjectIdOnly).not.toHaveBeenCalled();
  expect(props.syncProjectSessions).not.toHaveBeenCalled();
  expect(props.openNewSessionDraft).not.toHaveBeenCalled();
  expect(props.collapsedProjects.has('project-50')).toBe(true);
});

it('waits for a missing target header and a cleared sidebar filter without selecting another project', async () => {
  const props = buildRevealProps();
  const target = { projectId: 'project:late-50', revision: 3 };
  const sections = [{ project: { id: target.projectId, normalizedPath: '/late-project' }, groups: [] }];
  const scroll = vi.spyOn(focusedRowScroll, 'scrollFocusedSessionRowIntoView').mockImplementation(() => {});
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={target} />));
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={target} sectionsForRender={sections} hasSessionSearchQuery />));
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={target} sectionsForRender={sections} />));
  const header = host.querySelector('[data-sidebar-project-header]');
  expect(header?.getAttribute('data-sidebar-project-header')).toBe(target.projectId);
  expect(scroll).toHaveBeenCalledExactlyOnceWith(header);
  scroll.mockClear();
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={null} sectionsForRender={sections} />));
  await act(async () => root.render(<SidebarProjectsList {...props} projectRevealTarget={target} sectionsForRender={sections} />));
  expect(scroll).toHaveBeenCalledExactlyOnceWith(header);
});

it.each([{ mobileVariant: true }, { showOnlyMainWorkspace: true }])('does not reveal in the separate $mobileVariant/$showOnlyMainWorkspace layout', async (layout) => {
  const props = buildRevealProps();
  const scroll = vi.spyOn(focusedRowScroll, 'scrollFocusedSessionRowIntoView').mockImplementation(() => {});
  await act(async () => root.render(<SidebarProjectsList {...props} {...layout} projectRevealTarget={{ projectId: 'project-50', revision: 1 }} />));
  expect(scroll).not.toHaveBeenCalled();
});

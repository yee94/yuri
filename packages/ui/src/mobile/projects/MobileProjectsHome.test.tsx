import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useMobileProjectsHomeModel } from './useMobileProjectsHomeModel';

import {
  MobileProjectsHome,
  type MobileProjectHomeItem,
  type MobileProjectsHomeProps,
} from './MobileProjectsHome';

const fixtures = vi.hoisted(() => ({
  sessions: [],
  pinned: new Set<string>(),
  running: new Set<string>(),
  iconFetch: vi.fn(async (_path: string) => new Response(new Blob(['logo'], { type: 'image/png' }))),
}));
vi.mock('@/lib/runtime-fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-fetch')>(),
  runtimeFetch: fixtures.iconFetch,
}));
vi.mock('@/hooks/useSessionOrderSync', () => ({ useSessionOrderSync: () => {} }));
vi.mock('@/stores/useDirectoryStore', async () => {
  const { create } = await import('zustand');
  return { useDirectoryStore: create(() => ({ currentDirectory: '' })) };
});
vi.mock('@/queries/sessionIndexPinQueries', () => ({ usePinnedSessionIds: () => fixtures.pinned }));
vi.mock('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds')>(),
  useRunningSessionIds: () => fixtures.running,
}));
vi.mock('@/sync/sync-context', () => ({
  useAllLiveSessions: () => fixtures.sessions,
  useSessionActivity: () => false,
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
}));

const homeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MobileProjectsHome.tsx'),
  'utf8',
);

const noop = () => undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projects: MobileProjectHomeItem[] = [{
  id: 'project-1',
  name: 'Yuri',
  path: '/code/yuri',
  sessionCount: 2,
  expanded: true,
  worktrees: [{
    id: 'main',
    name: 'Main workspace',
    path: '/code/yuri',
    kind: 'main',
    sessionCount: 1,
    sessions: [{ id: 'main-session', kind: 'pagination', title: 'Main session' }],
  }, {
    id: 'feature',
    name: 'Feature branch',
    path: '/code/yuri-feature',
    kind: 'worktree',
    sessionCount: 1,
    expanded: true,
    sessions: [{ id: 'feature-session', kind: 'pagination', title: 'Feature session' }],
  }],
}];

const props: MobileProjectsHomeProps = {
  projects,
  pinnedSessions: [{
    id: 'global-pinned-session',
    kind: 'pagination',
    title: 'Global pinned session',
    subtitle: 'Yuri',
    pinned: true,
  }],
  onAddProject: noop,
  onNewSession: noop,
  onToggleProject: noop,
  onOpenProjectActions: noop,
  onToggleWorktree: noop,
  onNewWorktreeSession: noop,
  onOpenWorktreeActions: noop,
  onDeleteWorktree: noop,
  onSelectSession: noop,
  onPinSession: noop,
  onArchiveSession: noop,
  onOpenSessionActions: noop,
};

test.each(['custom', 'auto'] as const)('mobile home project circle uses the configured %s logo from the project store', async (source) => {
  const previousProjects = useProjectsStore.getState().projects;
  const project = { id: `home-${source}`, path: '/project', label: 'Logo project', icon: 'rocket', iconImage: { mime: 'image/png', updatedAt: 1, source } };
  useProjectsStore.setState({ projects: [project] });
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue(`blob:home-${source}`);
  fixtures.iconFetch.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Home() {
    const model = useMobileProjectsHomeModel();
    return <MobileProjectsHome {...props} projects={model.projects} pinnedSessions={[]} />;
  }
  const circle = () => host.querySelector('.yuri-mobile-project-icon')!;
  try {
    await act(async () => root.render(<I18nProvider><Home /></I18nProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(circle().querySelector('img')?.getAttribute('src')).toBe(`blob:home-${source}`);
    expect(circle().querySelector('use')).toBeNull();
    expect(fixtures.iconFetch.mock.calls.map(([path]) => path)).toEqual([`/api/projects/${project.id}/icon`]);
    for (let i = 0; i < 50; i++) {
      await act(async () => root.render(<I18nProvider><Home /></I18nProvider>));
    }
    expect(fixtures.iconFetch).toHaveBeenCalledTimes(1);
    await act(async () => circle().querySelector('img')!.dispatchEvent(new Event('error')));
    expect(circle().querySelector('img')).toBeNull();
    expect(circle().querySelector('use')?.getAttribute('href')).toBe('#yuri-rocket');
    await act(async () => useProjectsStore.setState({ projects: [{ ...project, iconImage: { ...project.iconImage, updatedAt: 2 } }] }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(fixtures.iconFetch).toHaveBeenCalledTimes(2);
    expect(circle().querySelector('img')).not.toBeNull();
    await act(async () => useProjectsStore.setState({ projects: [{ ...project, iconImage: undefined }] }));
    expect(circle().querySelector('img')).toBeNull();
    expect(circle().querySelector('use')?.getAttribute('href')).toBe('#yuri-rocket');
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState({ projects: previousProjects });
    createUrl.mockRestore(); host.remove();
  }
});

describe('MobileProjectsHome session row isolation', () => {
  test('live rows and session lists use default React.memo against parent identity churn', () => {
    expect(homeSource).toContain('const MobileLiveSessionRow = React.memo(MobileLiveSessionRowImpl)');
    expect(homeSource).toContain('const SessionList = React.memo(SessionListImpl)');
    expect(homeSource).not.toContain('areMobileSessionRowPropsEqual');
  });
});

describe('MobileProjectsHome workspace groups', () => {
  test('renders one global pinned project card before projects', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    expect(html).toContain('Global pinned session');
    expect(html).toContain('Yuri');
    expect(html).toContain('yuri-mobile-project-shell');
    expect(html.indexOf('Global pinned session')).toBeLessThan(html.indexOf('Main session'));
    expect(html.match(/aria-label="Pinned \/ In progress"/g)).toHaveLength(1);
    expect(html).toContain('yuri-mobile-project-card');
  });

  test('groups pinned sessions above in-progress sessions without extra labels', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          inProgressSessions={[{
            id: 'running-session',
            kind: 'pagination',
            title: 'Running session',
            subtitle: 'Yuri',
          }]}
        />
      </I18nProvider>,
    );

    expect(html.indexOf('Global pinned session')).toBeLessThan(html.indexOf('Running session'));
    expect(html.indexOf('Running session')).toBeLessThan(html.indexOf('Main session'));
  });

  test('renders unread attention sessions with the ordinary unread row chrome', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          pinnedSessions={[]}
          inProgressSessions={[{
            id: 'unread-session',
            title: 'Unread session',
            unread: true,
          }]}
          projects={[{
            id: 'project-with-unread',
            name: 'Unread project',
            path: '/code/unread-project',
            sessionCount: 1,
            expanded: true,
            worktrees: [{
              id: 'main',
              name: 'Main workspace',
              path: '/code/unread-project',
              kind: 'main',
              sessionCount: 1,
              sessions: [{
                id: 'ordinary-unread-session',
                title: 'Ordinary unread session',
                unread: true,
              }],
            }],
          }]}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Unread session');
    expect(html).toContain('aria-label="Pinned / In progress"');
    expect(html.match(/data-session-status="completed-unread"/g)).toHaveLength(2);
    expect(html.match(/bg-\[var\(--status-info\)\]/g)).toHaveLength(2);
    expect(html).toMatch(/data-session-status="completed-unread"[\s\S]*yuri-mobile-session-title truncate font-semibold[^>]*>Unread session/);
    expect(html).toMatch(/data-session-status="completed-unread"[\s\S]*yuri-mobile-session-title truncate font-semibold[^>]*>Ordinary unread session/);
  });

  test('renders main sessions directly and keeps linked worktree headers', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    expect(html).toContain('Main session');
    expect(html).not.toContain('Main workspace');
    expect(html).toContain('Feature branch');
    expect(html).toContain('Feature session');
    // Worktree name is secondary to the project title — not the same
    // semibold ui-label treatment, or it visually outranks the project.
    expect(html).toMatch(/yuri-mobile-entity-title[^"]*font-semibold[^"]*text-foreground[^>]*>Feature branch/);
  });

  test('wires worktree action affordances on linked worktree headers', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    // Swipe rail + trailing overflow menu (session-row parity; no always-on +).
    expect(html).toContain('yuri-mobile-worktree-actions');
    expect(html).toContain('yuri-mobile-worktree-more');
    expect(html).toContain('yuri-mobile-worktree-label-trigger');
    expect(html).not.toContain('yuri-mobile-worktree-new-session');
  });
});

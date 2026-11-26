import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import type { ProjectEntry } from '@/lib/api/types';

const fixture = vi.hoisted(() => ({
  current: 'repository-branch' as string | undefined,
  worktreeBranch: 'feature/live' as string | undefined,
  projects: [] as ProjectEntry[],
  fetch: vi.fn(async () => Response.json({ home: '/workspace', data: [] })),
}));
vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
vi.mock('@/stores/useGitStore', () => ({
  useGitStore: (select: (state: unknown) => unknown) => select({
    directories: new Map([
      ['/repo', { status: { current: fixture.current } }],
      ['/repo/.worktrees/wt-slug', { status: { current: fixture.worktreeBranch } }],
    ]),
  }),
}));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (select: (state: { projects: ProjectEntry[] }) => unknown) => select({ projects: fixture.projects }),
}));
vi.mock('@/stores/useConfigStore', () => ({
  getConfigDirectoryKey: (directory: string) => directory,
  useConfigStore: (select: (state: unknown) => unknown) => select({
    directoryScoped: {
      '/repo': { providers: [{ id: 'provider', models: [{ id: 'model', name: 'Model display name' }] }] },
    },
  }),
}));
vi.mock('@/lib/runtime-switch', async (original) => ({
  ...await original<typeof import('@/lib/runtime-switch')>(),
  getRuntimeTransportIdentity: () => 'hover-test',
  getRuntimeKey: () => 'host:machine',
  getRuntimeApiBaseUrl: () => '',
}));
vi.mock('@/lib/desktop', async (original) => ({
  ...await original<typeof import('@/lib/desktop')>(),
  isDesktopLocalOriginActive: () => false,
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: { branch: string }) => `${key}${params ? ` ${params.branch}` : ''}` }),
}));

import { SessionHoverDetails } from './SessionHoverDetails';
import { queryClient } from '@/lib/queryRuntime';

const host = document.createElement('div');
const root = createRoot(host);
const session = { id: 'session', model: { id: 'model', providerID: 'provider' } } as Session;

afterEach(async () => {
  await act(async () => root.render(null));
  queryClient.clear();
  fixture.current = 'repository-branch';
  fixture.worktreeBranch = 'feature/live';
  fixture.projects = [];
});

test('a different directory never borrows another project model catalog', async () => {
  await act(async () => root.render(
    <SessionHoverDetails session={session} title="Other project" directory="/other" time="1h" />,
  ));
  expect(host.textContent).toContain('model');
  expect(host.textContent).not.toContain('Model display name');
});
afterAll(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

test('hover card shows the row project and actual worktree branch with no branch warning or request', async () => {
  vi.stubGlobal('fetch', fixture.fetch);
  fixture.projects = [
    { id: 'project', path: '/repo', label: 'File tree project' },
    { id: 'other', path: '/other', label: 'Other project' },
  ];
  queryClient.setQueryData(['desktop-host-inventory', 'hover-test'], {
    hosts: [{ id: 'machine', label: 'Build machine' }],
  });
  const before = fixture.fetch.mock.calls.length;
  await act(async () => root.render(
    <SessionHoverDetails
      session={{ ...session, metadata: { yuri: { workspaceId: 'other' } } }}
      title="A long full task title"
      projectId="project"
      branch="repository-branch"
      worktree={{ branch: 'feature/old', name: 'wt-slug', label: 'wt-slug', path: '/repo/.worktrees/wt-slug' }}
      directory="/repo"
      time="1h"
    />,
  ));
  for (const text of [
    'A long full task title',
    'File tree project',
    'Build machine',
    'feature/live',
    '/repo/.worktrees/wt-slug',
    'Model display name',
  ]) {
    expect(host.textContent).toContain(text);
  }
  for (const text of ['Other project', 'repository-branch', 'feature/old', 'differentBranch']) {
    expect(host.textContent).not.toContain(text);
  }
  expect(fixture.fetch.mock.calls.length).toBe(before);
});

test.each(['task-branch', undefined])('matching or unknown checkout branch (%s) shows the sidebar branch', async (current) => {
  fixture.current = current;
  await act(async () => root.render(
    <SessionHoverDetails session={{ id: 'empty' } as Session} title="Title" projectLabel="Project" branch="task-branch" directory="/repo" time="1h" />,
  ));
  expect(host.textContent).toContain('task-branch');
  expect(host.textContent).not.toContain('differentBranch');
  expect(host.textContent).not.toContain('Model display name');
  expect(host.querySelector('use[href="#yuri-computer"]')).toBeNull();
});

test.each([
  [undefined, 'feature/saved'],
  ['HEAD', 'gitView.branch.detachedHead'],
] as const)('worktree with cached Git branch %s shows %s, never the project checkout', async (current, shown) => {
  fixture.worktreeBranch = current;
  await act(async () => root.render(
    <SessionHoverDetails session={session} title="Session" directory="/repo" time="1h" branch="repository-branch"
      worktree={{ branch: 'feature/saved', name: 'wt-slug', label: 'wt-slug', path: '/repo/.worktrees/wt-slug' }} />,
  ));
  expect(host.textContent).toContain(shown);
  expect(host.textContent).not.toContain('repository-branch');
});

test('shows one workspace icon and lists every attached path in the directory row', async () => {
  fixture.projects = [
    { id: 'ws_multi', label: 'Multi project', path: '/repo', paths: ['/repo', '/repo/packages/web', '/unregistered'] },
    { id: 'root', path: '/repo', icon: 'code' },
    { id: 'web', path: '/repo/packages/web', icon: 'globe' },
  ];
  const scopedSession = { ...session, metadata: { yuri: { workspaceId: 'ws_multi' } } };
  await act(async () => root.render(
    <SessionHoverDetails session={scopedSession} title="Session" projectId="web" projectLabel="web" directory="/repo/packages/web" time="1h" />,
  ));
  expect(host.textContent).toContain('Multi project');
  const pathRows = Array.from(host.querySelectorAll('[data-session-hover-path]'));
  expect(pathRows.map((row) => row.textContent)).toEqual(['/repo', '/repo/packages/web', '/unregistered']);
  expect(pathRows.every((row) => row.querySelectorAll('use').length === 1)).toBe(true);
  const projectRow = host.querySelector('[data-session-hover-details]')?.children[1];
  expect(Array.from(projectRow?.querySelectorAll('use') ?? [], (icon) => icon.getAttribute('href'))).toEqual(['#yuri-folders']);

  await act(async () => root.render(
    <SessionHoverDetails session={session} title="Session" projectId="ws_multi" directory="/repo/packages/web/src" time="1h" />,
  ));
  expect(Array.from(host.querySelectorAll('[data-session-hover-path]'), (row) => row.textContent))
    .toEqual(['/repo', '/repo/packages/web', '/unregistered', '/repo/packages/web/src']);
});

test.each([
  { projectId: 'ws_multi', indexedWorkspaceId: null, liveWorkspaceId: 'web' },
  { projectId: 'web', indexedWorkspaceId: 'ws_multi', liveWorkspaceId: 'web' },
  { projectId: 'ws_multi', indexedWorkspaceId: null, liveWorkspaceId: 'missing' },
])('keeps workspace name then branch, with every pwd in one directory row for row $projectId / live $liveWorkspaceId', async ({
  projectId, indexedWorkspaceId, liveWorkspaceId,
}) => {
  fixture.projects = [
    { id: 'ws_multi', label: 'Workspace name', path: '/repo/packages/web', paths: ['/repo/packages/web', '/repo/packages/ui'] },
    { id: 'web', path: '/repo/packages/web' },
  ];
  const live = { ...session, metadata: { yuri: { workspaceId: liveWorkspaceId } } };
  await act(async () => root.render(
    <SessionHoverDetails session={live} title="Session" projectId={projectId} indexedWorkspaceId={indexedWorkspaceId}
      projectLabel="web" branch="main" directory="/repo/packages/web" time="1h" />,
  ));
  const card = host.querySelector('[data-session-hover-details]')!;
  expect(card.children[1]?.textContent).toBe('Workspace name');
  expect(card.children[2]?.textContent).toBe('main');
  expect(Array.from(card.querySelectorAll('[data-session-hover-path]'), (row) => row.textContent))
    .toEqual(['/repo/packages/web', '/repo/packages/ui']);
});

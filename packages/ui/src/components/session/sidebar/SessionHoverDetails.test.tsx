import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

const fixture = vi.hoisted(() => ({
  current: 'other-branch' as string | undefined,
  fetch: vi.fn(async () => Response.json({ home: '/workspace', data: [] })),
}));
vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
vi.mock('@/stores/useGitStore', () => ({
  useGitStore: (select: (state: unknown) => unknown) => select({
    directories: new Map([['/repo', { status: { current: fixture.current } }]]),
  }),
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
  fixture.current = 'other-branch';
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

test('hover card shows known project, machine, branch and model without making a request', async () => {
  vi.stubGlobal('fetch', fixture.fetch);
  queryClient.setQueryData(['desktop-host-inventory', 'hover-test'], {
    hosts: [{ id: 'machine', label: 'Build machine' }],
  });
  const before = fixture.fetch.mock.calls.length;
  await act(async () => root.render(
    <SessionHoverDetails session={session} title="A long full task title" projectLabel="Project" branch="task-branch" directory="/repo" time="1h" />,
  ));
  for (const text of ['A long full task title', 'Project', 'Build machine', 'task-branch', 'Model display name', 'other-branch']) {
    expect(host.textContent).toContain(text);
  }
  expect(host.textContent).toContain('sessions.sidebar.session.hover.differentBranch');
  expect(fixture.fetch.mock.calls.length).toBe(before);
});

test.each(['task-branch', undefined])('matching or unknown checkout branch (%s) does not invent a mismatch', async (current) => {
  fixture.current = current;
  await act(async () => root.render(
    <SessionHoverDetails session={{ id: 'empty' } as Session} title="Title" projectLabel="Project" branch="task-branch" directory="/repo" time="1h" />,
  ));
  expect(host.textContent).not.toContain('differentBranch');
  expect(host.textContent).not.toContain('Model display name');
  expect(host.querySelector('use[href="#yuri-computer"]')).toBeNull();
});

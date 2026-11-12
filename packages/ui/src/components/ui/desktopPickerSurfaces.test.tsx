import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubIntegrationDialog } from '../session/GitHubIntegrationDialog';
import { StashesDialog } from '../views/git/StashesDialog';
import { ArchivedSessionsDialog } from '../sections/yuri/ArchivedSessionsDialog';

const f = vi.hoisted(() => ({
  project: { id: 'project', path: '/workspace/project', label: 'Example project' },
  projects: [{ id: 'project', path: '/workspace/project', label: 'Example project' }],
  archived: [{ id: 'session-1', title: 'Archived conversation', directory: '/workspace/project', time: { created: 1000, updated: 2000, archived: 3000 } }],
  stashList: vi.fn(), apply: vi.fn(), pop: vi.fn(), drop: vi.fn(), create: vi.fn(),
  issues: vi.fn(), prs: vi.fn(), validate: vi.fn(), unarchive: vi.fn(), preview: vi.fn(),
  setArchiveOpen: vi.fn(), setSettingsOpen: vi.fn(), setSettingsPage: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  auth: { data: { connected: true }, isFetched: true },
}));

vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  const value = { t: (key: keyof typeof dict, args?: Record<string, string | number>) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(args?.[name] ?? name)) };
  return { useI18n: () => value, getCurrentIntlLocale: () => 'en-US' };
});
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: {
  isMobile: boolean; isArchivedSessionsDialogOpen: boolean; setArchivedSessionsDialogOpen: typeof f.setArchiveOpen;
  setSettingsDialogOpen: typeof f.setSettingsOpen; setSettingsPage: typeof f.setSettingsPage;
}) => unknown) => select({ isMobile: false, isArchivedSessionsDialogOpen: true, setArchivedSessionsDialogOpen: f.setArchiveOpen, setSettingsDialogOpen: f.setSettingsOpen, setSettingsPage: f.setSettingsPage }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: { projects: typeof f.projects; activeProjectId: string; getActiveProject: () => typeof f.project }) => unknown) => select({ projects: f.projects, activeProjectId: f.project.id, getActiveProject: () => f.project }) }));
vi.mock('@/stores/useGlobalSessionsStore', () => ({
  ensureFullGlobalSessionsLoaded: async () => {},
  resolveGlobalSessionDirectory: (session: { directory: string }) => session.directory,
  useGlobalSessionsStore: (select: (state: { archivedSessions: typeof f.archived }) => unknown) => select({ archivedSessions: f.archived }),
}));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: { setCurrentSession: typeof f.preview }) => unknown) => select({ setCurrentSession: f.preview }) }));
vi.mock('@/sync/session-actions', () => ({ unarchiveSession: f.unarchive }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchInput: false }) }));
vi.mock('@/components/ui', () => ({ toast: f.toast }));
vi.mock('@/queries/githubAuthQueries', () => ({
  useGitHubAuthQuery: () => f.auth,
  githubAuthQueryOptions: () => ({ queryKey: ['desktop-picker-github-auth'], queryFn: async () => f.auth.data, staleTime: 0, gcTime: Infinity, retry: false }),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => {
  const runtime = { github: { issuesList: f.issues, prsList: f.prs } };
  return { useRuntimeAPIs: () => runtime };
});
vi.mock('@/lib/worktrees/worktreeManager', () => ({ validateWorktreeCreate: f.validate }));
vi.mock('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: ({ items, onSelect }: {
  items: Array<{ id: string; label: string }>; onSelect: (id: string) => void;
}) => <div className="flex gap-2">{items.map(item => <button type="button" key={item.id} data-tab={item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div> }));
vi.mock('@/lib/gitApi', () => ({
  listGitStashes: f.stashList, countGitStashFiles: async () => ({ counts: { 'stash@{0}': 3 } }),
  applyGitStash: f.apply, popGitStash: f.pop, dropGitStash: f.drop, stashGitChanges: f.create,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  f.stashList.mockResolvedValue({ stashes: [{ ref: 'stash@{0}', message: 'Before refactor', relativeTime: '2 hours ago' }] });
  f.apply.mockResolvedValue({});
  f.create.mockResolvedValue({ created: true });
  f.unarchive.mockResolvedValue(true);
  f.issues.mockResolvedValue({ connected: true, issues: [{ number: 123, title: 'A selected issue', url: 'https://example.com/issue/123' }], hasMore: false });
  f.prs.mockResolvedValue({ connected: true, prs: [{ number: 456, title: 'A selected pull request', head: 'feature', base: 'main', url: 'https://example.com/pull/456' }], hasMore: false });
  f.validate.mockResolvedValue({ errors: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const evidence = (name: string) => {
  if (!process.env.YURI_TEST_EVIDENCE_DIR) return;
  mkdirSync(process.env.YURI_TEST_EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, name), document.body.innerHTML);
};
const textButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;

test('GitHub association preserves issue selection and explicit confirmation in the real desktop portal', async () => {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  await act(async () => root.render(<GitHubIntegrationDialog open onOpenChange={onOpenChange} onSelect={onSelect} />));
  expect(document.querySelector('[data-slot="dialog-content"]')?.getAttribute('data-presentation')).toBe('picker');
  await vi.waitFor(() => expect(document.querySelector('.yuri-picker-row')).not.toBeNull());
  await act(async () => document.querySelector<HTMLButtonElement>('.yuri-picker-row')!.click());
  expect(onSelect).not.toHaveBeenCalled();
  evidence('picker-github.html');
  await act(async () => textButton('Select').click());
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'issue', item: expect.objectContaining({ number: 123 }) }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('GitHub PR tab keeps branch validation and include-diff selection', async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(<GitHubIntegrationDialog open onOpenChange={() => {}} onSelect={onSelect} />));
  await act(async () => document.querySelector<HTMLButtonElement>('[data-tab="prs"]')!.click());
  await vi.waitFor(() => expect(f.validate).toHaveBeenCalled());
  await vi.waitFor(() => expect(document.querySelector('.yuri-picker-row')).not.toBeNull());
  await act(async () => document.querySelector<HTMLButtonElement>('.yuri-picker-row')!.click());
  await act(async () => textButton('Select').click());
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'pr', includeDiff: false }));
});

test('stash list retains apply and reports index changes without a nested card', async () => {
  const onChanged = vi.fn();
  await act(async () => root.render(<StashesDialog open onOpenChange={() => {}} directory="/workspace/project" hasUncommittedChanges uncommittedFileCount={3} onChanged={onChanged} />));
  evidence('picker-stashes.html');
  expect(document.querySelector('.yuri-picker-form')?.className).not.toMatch(/border|bg-|shadow/);
  const apply = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(button => button.getAttribute('aria-label') === 'Apply')!;
  await act(async () => apply.click());
  expect(f.apply).toHaveBeenCalledWith('/workspace/project', { ref: 'stash@{0}' });
  expect(onChanged).toHaveBeenCalledWith({ affectsIndex: true });
});

test('archived-session browser keeps project drilldown, restore and preview actions', async () => {
  await act(async () => root.render(<ArchivedSessionsDialog />));
  await act(async () => document.querySelector<HTMLButtonElement>('.yuri-picker-row')!.click());
  expect(document.querySelector('.yuri-picker-label')?.textContent).toBe('Archived conversation');
  evidence('picker-archives.html');
  await act(async () => textButton('Restore').click());
  expect(f.unarchive).toHaveBeenCalledWith('session-1');
  await act(async () => textButton('Preview').click());
  expect(f.preview).toHaveBeenCalledWith('session-1', '/workspace/project');
  expect(f.setArchiveOpen).toHaveBeenCalledWith(false);
});

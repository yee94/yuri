import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { DraftWorkspaceDirectories } from './DraftWorkspaceDirectories';

const query = vi.hoisted(() => vi.fn((directory: string) => directory.endsWith('/web')
  ? { data: { current: 'main', all: ['main', 'feature/web'] }, isError: false, isPending: false }
  : { data: undefined, isError: false, isPending: false }));
vi.mock('@/queries/gitBranchQueries', () => ({ useGitBranchesQuery: query }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
vi.mock('@/stores/useGitStore', () => ({ useIsGitRepo: (directory: string) => directory.endsWith('/web') }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: { count?: number }) => params?.count === undefined ? key : `${key}:${params.count}` }) }));

test('lists each directory with path, primary marker and current branch for Git repos only, querying only while open', async () => {
  const directories = ['/repo/packages/web', '/work/outputs'];
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = () => act(async () => root.render(<DraftWorkspaceDirectories directories={directories} />));
  try {
    for (let i = 0; i < 20; i += 1) await render();
    expect(query).not.toHaveBeenCalled();
    const trigger = host.querySelector('button')!;
    expect(trigger.textContent).toContain('workspace.paths.count:2');
    expect(trigger.querySelector('use')?.getAttribute('href')).toBe('#yuri-folders');
    await act(async () => trigger.click());
    const popup = document.querySelector('[role="dialog"][aria-label="workspace.paths.count:2"]')!;
    const rows = Array.from(popup.querySelectorAll('[data-workspace-directory]'));
    expect(rows.map((row) => row.textContent)).toEqual([
      'web· workspace.paths.primaryBadgemain/repo/packages/web',
      'outputs/work/outputs',
    ]);
    expect(popup.querySelectorAll('[data-workspace-directory-branch]')).toHaveLength(1);
    expect(popup.textContent).not.toContain('feature/web');
    expect(popup.textContent).not.toContain('notGitRepository');
    expect(popup.querySelectorAll('button, [role="menuitem"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

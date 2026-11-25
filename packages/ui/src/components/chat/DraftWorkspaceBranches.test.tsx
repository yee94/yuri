import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { DraftWorkspaceBranches } from './DraftWorkspaceBranches';

const query = vi.hoisted(() => vi.fn((directory: string) => directory.endsWith('/web')
  ? { data: { current: 'main', all: ['main', 'feature/web'] }, isError: false, isPending: false }
  : { data: { current: 'develop', all: ['develop', 'feature/ui'] }, isError: true, isPending: false }));
vi.mock('@/queries/gitBranchQueries', () => ({ useGitBranchesQuery: query }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
vi.mock('@/stores/useGitStore', () => ({ useIsGitRepo: () => true }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test('opens a read-only list for each workspace directory and does no branch work while closed', async () => {
  const directories = ['/repo/web', '/repo/ui'];
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = () => act(async () => root.render(<DraftWorkspaceBranches directories={directories} />));
  try {
    await render();
    for (let i = 0; i < 50; i += 1) await render();
    expect(query).not.toHaveBeenCalled();
    const trigger = host.querySelector('button')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(new Set(query.mock.calls.map(([directory]) => directory))).toEqual(new Set(directories));
    const popup = document.querySelector('[role="dialog"][aria-label="chat.chatInput.branch"]')!;
    for (const branch of ['main', 'develop', 'feature/web', 'feature/ui', 'common.unavailable']) {
      expect(popup.textContent).toContain(branch);
    }
    expect(popup.querySelectorAll('button, [role="menuitem"]')).toHaveLength(0);
    await act(async () => trigger.click());
    query.mockClear();
    for (let i = 0; i < 50; i += 1) await render();
    expect(query).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

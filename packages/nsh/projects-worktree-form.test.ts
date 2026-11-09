import { expect, test, vi } from 'vitest';
vi.mock('nsh', () => ({ signal: (initial: unknown) => { let value = initial; return Object.assign(() => value, { set(next: unknown) { value = next; } }); }, effect: vi.fn(), cleanup: vi.fn(), untracked: vi.fn(), Storage: { setItem: vi.fn() } }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));
import { Storage } from 'nsh';
import { createWorktreeForm, uniqueWorktreeName } from './projects-worktree-form';
import type { PageOperation } from './page-operations';

test('known worktree and branch names are skipped without renaming a user draft', () => {
  const candidates = ['busy-tree', 'busy-branch', 'available'];
  expect(uniqueWorktreeName(new Set(['busy-tree', 'busy-branch']), () => candidates.shift()!)).toBe('available');
});
test('ten random collisions use a checked deterministic suffix instead of an unchecked timestamp', () => {
  const generate = vi.fn(() => 'collision');
  expect(uniqueWorktreeName(new Set(['collision', 'collision-1', 'collision-2']), generate)).toBe('collision-3');
  expect(generate).toHaveBeenCalledTimes(11);
});

test('a failed preference save retries only the confirmed preference, never the acknowledged creation', async () => {
  const operation = { current: () => true } as PageOperation;
  const form = createWorktreeForm({ directory: '/repo', hostKey: 'isolated-host', active: () => true, current: () => true, capture: () => operation, worktrees: () => [] });
  form.ready.set(true); form.source.set('main');
  const create = vi.fn(async () => '/isolated/created');
  vi.mocked(Storage.setItem).mockRejectedValueOnce(new Error('Isolated preference disk failure'));
  expect(await form.submit(create)).toBeUndefined();
  expect(form.confirmedPath()).toBe('/isolated/created');
  expect(form.errors().request).toBe('Isolated preference disk failure');
  vi.mocked(Storage.setItem).mockResolvedValueOnce(undefined);
  expect(await form.submit(create)).toBe('/isolated/created');
  expect(create).toHaveBeenCalledTimes(1);
  expect(Storage.setItem).toHaveBeenLastCalledWith('worktree-source-v1:isolated-host', 'main');
});

test('a context that never became ready cannot submit a worktree through the core form owner', async () => {
  const form = createWorktreeForm({ directory: '/repo', hostKey: 'other-host', active: () => true, current: () => true, capture: () => { throw new Error('must not capture'); }, worktrees: () => [] });
  const create = vi.fn(async () => '/unexpected');
  expect(await form.submit(create)).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
});

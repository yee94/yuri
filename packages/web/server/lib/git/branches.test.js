import { afterEach, expect, test, vi } from 'vitest';

const { git } = vi.hoisted(() => ({ git: {
  raw: vi.fn(), branch: vi.fn(), getRemotes: vi.fn(),
} }));
vi.mock('simple-git', () => ({ default: () => git }));
import { getBranches } from './service.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

test('branch listing never contacts remotes and enriches locally known refs with offline recency', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/ssh-agent');
  git.raw.mockImplementation(async (args) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return '/repo\n';
    if (args[0] === 'for-each-ref') {
      return [
        'refs/heads/main\t1700000100',
        'refs/heads/feature/local\t1700000500',
        'refs/remotes/origin/main\t1700000050',
      ].join('\n');
    }
    if (args[0] === 'reflog') {
      return [
        '1700000900\tcheckout: moving from main to feature/local',
        '1700000200\tcheckout: moving from feature/local to main',
      ].join('\n');
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  git.getRemotes.mockRejectedValue(new Error('offline'));
  const branches = {
    all: ['main', 'feature/local', 'remotes/origin/main', 'remotes/origin/feature/remote', 'remotes/origin/HEAD'],
    current: 'main',
    branches: {
      main: { current: true, name: 'main', commit: 'abc', label: 'main' },
      'feature/local': { current: false, name: 'feature/local', commit: 'def', label: 'feature/local' },
      'remotes/origin/main': { current: false, name: 'remotes/origin/main', commit: 'abc', label: 'remotes/origin/main' },
    },
  };
  git.branch.mockResolvedValue(branches);
  const result = await getBranches('/repo');
  expect(result.all).toEqual(['main', 'feature/local', 'remotes/origin/main', 'remotes/origin/feature/remote']);
  expect(result.branches.main.lastUsedAt).toBe(1700000200 * 1000);
  expect(result.branches['feature/local'].lastUsedAt).toBe(1700000900 * 1000);
  expect(result.branches['remotes/origin/main'].lastUsedAt).toBe(1700000050 * 1000);
  expect(git.getRemotes).not.toHaveBeenCalled();
  expect(git.raw.mock.calls.every(([args]) => ['rev-parse', 'for-each-ref', 'reflog'].includes(args[0]))).toBe(true);
  git.branch.mockResolvedValue({ ...branches, all: ['main', 'remotes/origin/new'] });
  expect((await getBranches('/repo')).all).toEqual(['main', 'remotes/origin/new']);
});

test('offline recency probe failures degrade gracefully without failing branch listing', async () => {
  git.raw.mockImplementation(async (args) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return '/repo\n';
    throw new Error('reflog unavailable');
  });
  git.branch.mockResolvedValue({
    all: ['main'],
    current: 'main',
    branches: { main: { current: true, name: 'main', commit: 'abc', label: 'main' } },
  });
  const result = await getBranches('/repo');
  expect(result).toEqual({
    all: ['main'],
    current: 'main',
    branches: { main: { current: true, name: 'main', commit: 'abc', label: 'main' } },
  });
});

test('branch failures remain errors instead of an authoritative empty list', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/ssh-agent');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  git.raw.mockResolvedValue('/repo\n');
  git.branch.mockRejectedValue(new Error('repository unavailable'));
  await expect(getBranches('/repo')).rejects.toThrow('repository unavailable');
});

test('detached HEAD has no current branch even when simple-git returns a pseudo label', async () => {
  git.raw.mockResolvedValue('/repo\n');
  git.branch.mockResolvedValue({ all: ['main'], current: 'HEAD detached at abc123', detached: true, branches: {} });
  expect(await getBranches('/repo')).toEqual({ all: ['main'], current: '', branches: {} });
});

test('a confirmed non-repository returns an empty snapshot, not a transport failure', async () => {
  git.raw.mockRejectedValue(new Error('fatal: not a git repository (or any of the parent directories): .git'));
  git.branch.mockRejectedValue(new Error('fatal: not a git repository'));
  expect(await getBranches('/plain')).toEqual({ all: [], current: '', branches: {} });
});

test('an unborn branch uses its real symbolic HEAD name without inventing a default', async () => {
  git.raw.mockImplementation(async (args) => args[0] === 'symbolic-ref' ? 'trunk\n' : '/repo\n');
  git.branch.mockResolvedValue({ all: [], current: '', detached: false, branches: {} });
  expect(await getBranches('/repo')).toEqual({ all: [], current: 'trunk', branches: {} });
});

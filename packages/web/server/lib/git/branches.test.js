import { afterEach, expect, test, vi } from 'vitest';

const { git } = vi.hoisted(() => ({ git: {
  raw: vi.fn(), branch: vi.fn(), getRemotes: vi.fn(),
} }));
vi.mock('simple-git', () => ({ default: () => git }));
import { getBranches } from './service.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

test('branch listing never contacts remotes and keeps locally known refs while offline', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/ssh-agent');
  git.raw.mockImplementation(async (args) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return '/repo\n';
    throw new Error('Unexpected remote command');
  });
  git.getRemotes.mockRejectedValue(new Error('offline'));
  const branches = {
    all: ['main', 'feature/local', 'remotes/origin/main', 'remotes/origin/feature/remote', 'remotes/origin/HEAD'],
    current: 'main',
    branches: { main: { current: true, name: 'main', commit: 'abc', label: 'main' } },
  };
  git.branch.mockResolvedValue(branches);
  expect(await getBranches('/repo')).toEqual({
    ...branches, all: branches.all.filter((name) => name !== 'remotes/origin/HEAD'),
  });
  expect(git.getRemotes).not.toHaveBeenCalled();
  expect(git.raw.mock.calls).toEqual([[['rev-parse', '--show-toplevel']]]);
  git.branch.mockResolvedValue({ ...branches, all: ['main', 'remotes/origin/new'] });
  expect((await getBranches('/repo')).all).toEqual(['main', 'remotes/origin/new']);
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

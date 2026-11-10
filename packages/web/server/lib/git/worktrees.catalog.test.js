import { afterEach, expect, test, vi } from 'vitest';

const { raw, execute } = vi.hoisted(() => ({ raw: vi.fn(), execute: vi.fn() }));
vi.mock('simple-git', () => ({ default: () => ({ raw }) }));
vi.mock('child_process', () => {
  const execFile = vi.fn();
  execFile[Symbol.for('nodejs.util.promisify.custom')] = execute;
  return { execFile };
});
import { getWorktrees } from './service.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

test('Git command failure remains unavailable rather than clearing the worktree catalog', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/agent');
  raw.mockResolvedValue(process.cwd());
  execute.mockRejectedValue(Object.assign(new Error('catalog unavailable'), { stderr: 'catalog unavailable', code: 128 }));
  await expect(getWorktrees(process.cwd())).rejects.toThrow('catalog unavailable');
});

test('permission failures are not an authoritative empty catalog', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/agent');
  raw.mockRejectedValue(new Error('permission denied'));
  await expect(getWorktrees(process.cwd())).rejects.toThrow('permission denied');
});

test('a confirmed non-repository has no worktrees', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/agent');
  raw.mockRejectedValue(new Error('fatal: not a git repository'));
  expect(await getWorktrees(process.cwd())).toEqual([]);
});

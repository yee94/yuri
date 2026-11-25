import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { getDiff, getStatus } from './service.js';

const execFileAsync = promisify(execFile);
const tempDirs = [];

const runGit = async (cwd, args) => {
  await execFileAsync('git', args, { cwd });
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('git getStatus & getDiff monorepo subdirectory pathspec isolation', () => {
  it('isolates status files, diffStats, and diff output to the requested subdirectory', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-git-subdir-'));
    tempDirs.push(repoDir);

    await runGit(repoDir, ['init', '-b', 'main']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);

    const pkgA = path.join(repoDir, 'packages', 'alpha');
    const pkgB = path.join(repoDir, 'packages', 'beta');
    await Promise.all([
      fs.mkdir(pkgA, { recursive: true }),
      fs.mkdir(pkgB, { recursive: true }),
    ]);

    await fs.writeFile(path.join(pkgA, 'a.txt'), 'line1\nline2\n', 'utf8');
    await fs.writeFile(path.join(pkgB, 'b.txt'), 'hello\nworld\n', 'utf8');
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'initial']);

    // Modify both subdirectories + add untracked file in beta
    await fs.writeFile(path.join(pkgA, 'a.txt'), 'line1\nline2-edited\nline3\n', 'utf8');
    await fs.writeFile(path.join(pkgB, 'b.txt'), 'hello\n', 'utf8');
    await fs.writeFile(path.join(pkgB, 'new.txt'), 'one\ntwo\nthree\n', 'utf8');

    const statusA = await getStatus(pkgA);
    expect(statusA.files.map((f) => f.path)).toEqual(['packages/alpha/a.txt']);
    expect(statusA.diffStats?.['packages/alpha/a.txt']).toEqual({ insertions: 2, deletions: 1 });
    expect(statusA.diffStats?.['packages/beta/b.txt']).toBeUndefined();

    const statusB = await getStatus(pkgB);
    expect(statusB.files.map((f) => f.path).sort()).toEqual(['packages/beta/b.txt', 'packages/beta/new.txt']);
    expect(statusB.diffStats?.['packages/beta/b.txt']).toEqual({ insertions: 0, deletions: 1 });
    expect(statusB.diffStats?.['packages/beta/new.txt']).toEqual({ insertions: 3, deletions: 0 });
    expect(statusB.diffStats?.['packages/alpha/a.txt']).toBeUndefined();

    // Whole repo root still sees all changes
    const statusRoot = await getStatus(repoDir);
    expect(statusRoot.files.map((f) => f.path).sort()).toEqual([
      'packages/alpha/a.txt',
      'packages/beta/b.txt',
      'packages/beta/new.txt',
    ]);

    // Diff without explicit file path scopes to subdirectory
    const diffA = await getDiff(pkgA);
    expect(diffA).toContain('packages/alpha/a.txt');
    expect(diffA).not.toContain('packages/beta/b.txt');
  });
});

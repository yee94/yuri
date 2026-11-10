import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorktreeDialogProject } from './newWorktreeDialogProject';

const projects = [
  { id: 'alpha', path: '/projects/alpha' },
  { id: 'beta', path: '/projects/beta' },
];

describe('NewWorktreeDialog project resolution', () => {
  test('the dialog waits on the Git checkout root but creates its session in the scoped cwd', async () => {
    const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'NewWorktreeDialog.tsx'), 'utf8');
    expect(source).toContain('await waitForWorktreeBootstrap(metadata.worktreeRoot ?? metadata.path)');
    expect(source).toContain('sessionActions.createSession(sessionTitle, metadata.path, null)');
  });
  test('resolves an explicit project independently of the active project', () => {
    expect(resolveWorktreeDialogProject(projects, 'alpha', 'beta')).toBe(projects[1]);
  });

  test('uses the active project when the explicit project is omitted', () => {
    expect(resolveWorktreeDialogProject(projects, 'alpha')).toBe(projects[0]);
  });

  test('returns no project for an unavailable explicit project', () => {
    expect(resolveWorktreeDialogProject(projects, 'alpha', 'missing')).toBeNull();
  });
});

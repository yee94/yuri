import { describe, expect, test } from 'vitest';
import { resolveTurnChangedFileOpenTarget } from './openTurnChangedFile';

describe('resolveTurnChangedFileOpenTarget', () => {
  test('keeps in-project paths on the turn-diff path', () => {
    expect(resolveTurnChangedFileOpenTarget(
      '/Users/dev/Code/github/yuri',
      'packages/ui/src/app.ts',
    )).toEqual({
      kind: 'diff',
      path: 'packages/ui/src/app.ts',
    });

    expect(resolveTurnChangedFileOpenTarget(
      '/Users/dev/Code/github/yuri',
      '/Users/dev/Code/github/yuri/packages/ui/src/app.ts',
    )).toEqual({
      kind: 'diff',
      path: 'packages/ui/src/app.ts',
    });
  });

  test('degrades outside-workspace absolute paths to file preview with notice', () => {
    expect(resolveTurnChangedFileOpenTarget(
      '/Users/dev/Code/github/yuri',
      '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md',
    )).toEqual({
      kind: 'file',
      path: '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md',
      notice: 'turn-diff-outside-workspace',
    });
  });

  test('keeps secondary attached repository files on the turn-diff path in multi-path workspaces', () => {
    const workspaceDirs = ['/workspace/app-node', '/workspace/mmbizwxaaiagent'];

    expect(resolveTurnChangedFileOpenTarget(
      '/workspace/app-node',
      '/workspace/mmbizwxaaiagent/src/tablekv.cc',
      workspaceDirs,
    )).toEqual({
      kind: 'diff',
      path: 'mmbizwxaaiagent/src/tablekv.cc',
    });

    expect(resolveTurnChangedFileOpenTarget(
      '/workspace/app-node',
      'mmbizwxaaiagent/src/tablekv.cc',
      workspaceDirs,
    )).toEqual({
      kind: 'diff',
      path: 'mmbizwxaaiagent/src/tablekv.cc',
    });

    expect(resolveTurnChangedFileOpenTarget(
      '/workspace/app-node',
      '/outside/other/file.ts',
      workspaceDirs,
    )).toEqual({
      kind: 'file',
      path: '/outside/other/file.ts',
      notice: 'turn-diff-outside-workspace',
    });
  });
});

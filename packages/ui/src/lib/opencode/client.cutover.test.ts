import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeConfigDocuments, projectSession } from './v2-types';
import type { ConfigEntry, SessionInfo } from './v2-types';

const here = dirname(fileURLToPath(import.meta.url));

describe('Phase 7 UI client cutover', () => {
  test('search, diagnostics and startup never call removed OpenCode routes', () => {
    const root = join(here, '../../../..');
    const files = [
      'ui/src/lib/openCodeStatus.ts',
      'web/src/api/files.ts',
      'web/server/lib/opencode/network-runtime.js',
      'web/server/lib/opencode/lifecycle.js',
      'web/server/lib/opencode/native-goal.js',
      'vscode/src/extension.ts',
      'vscode/src/opencode-sidecar.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).not.toMatch(/['"]\/(?:api\/)?(?:find\/(?:file|text|symbol)|config\/providers|project\/current|session\/status|global\/health|path)['"]/);
    }
  });

  test('client facade files do not mention the 1.18 SDK or createOpencodeClient', () => {
    const files = ['client.ts', 'v2-types.ts'];
    for (const file of files) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toContain('@opencode-ai/sdk');
      expect(source).not.toContain('createOpencodeClient');
    }
  });

  test('mergeConfigDocuments folds v2 config documents and later entries win', () => {
    const entries = [
      { type: 'document', info: { model: 'old/model', username: 'a' } },
      { type: 'document', info: { model: 'new/model' } },
    ] as ConfigEntry[];
    expect(mergeConfigDocuments(entries)).toEqual({
      model: 'new/model',
      username: 'a',
    });
  });

  test('projectSession exposes location.directory for existing callers', () => {
    const info = {
      id: 'ses_1',
      projectID: 'prj_1',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      location: { directory: '/workspace/project' },
    } as SessionInfo;
    expect(projectSession(info).directory).toBe('/workspace/project');
  });
});

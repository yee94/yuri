import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

test('actual desktop TaskEditor on macOS/Windows headless models, not native windows', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'task-editor-desktop-engine.test.tsx', '--web-host', 'tests/task-editor-desktop-host.js'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);

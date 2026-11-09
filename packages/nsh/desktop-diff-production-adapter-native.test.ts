import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('actual desktop panel diff consumer installs the unique Changes reader/list adapter on Mac and Windows', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'diff-production-adapter-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Diff production adapter', id: 'example.yuri.diff-adapter', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['runtime.request'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-diff-production/Adapter.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Adapter.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-diff-production/Adapter.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Adapter.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);

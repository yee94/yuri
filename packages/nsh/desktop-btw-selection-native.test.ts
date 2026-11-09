import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real readonly BTW model label on NSH 0.4 desktop platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-btw-selection-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'BTW selection tests', id: 'example.yuri.btwselection', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['btw.fixture', 'runtime.request'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-btw-selection-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Selection.test.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-btw-selection-scenarios.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Selection.test.tsx', ...(process.env.NSH_SELECTION_FILTER ? ['--filter', process.env.NSH_SELECTION_FILTER] : [])], { cwd: directory, encoding: 'utf8', timeout: 150_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 160_000);

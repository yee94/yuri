import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('explicit full context uses the production reader and retained NSH DiffView on both desktop models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-diff-full-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Full context fixture', id: 'example.yuri.desktop-diff-full', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['connection.list', 'runtime.request', 'desktop.diff.audit'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-diff-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Mobile.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-diff-mobile-compat.fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Full.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-diff-full-context/Full.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Full.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native help uses a stable independent Dialog on both desktop platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-help-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Desktop help fixture', id: 'example.yuri.desktop-help', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['desktop.help.test'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-help-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Help.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-help/Help.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Help.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 90_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 100_000);

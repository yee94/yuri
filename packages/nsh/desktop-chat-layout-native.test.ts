import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('desktop Chat layout uses actual NSH engine slots on both desktop platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-chat-layout-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Chat layout fixture', id: 'example.yuri.desktop-chat-layout', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-chat-layout-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Layout.test.tsx'), readFileSync(path.join(root, 'tests/desktop-chat-layout/Layout.test.tsx'), 'utf8').replaceAll("'../../desktop-chat-layout-fixture.tsx'", JSON.stringify(path.join(root, 'desktop-chat-layout-fixture.tsx'))));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Layout.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);

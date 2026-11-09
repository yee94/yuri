import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('full Context workbench real NSH renderer on macOS/Windows platform models in an isolated temporary config', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-context-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Desktop Context fixture', id: 'example.yuri.desktop.context.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1, appearance: 'dark', theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['desktop.context.audit'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-context-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Context.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-context/Context.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Context.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 110_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

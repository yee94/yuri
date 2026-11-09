import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('actual native writer dispatches compact control receipts and never replays unknown outcomes', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'native-local-compact-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8')); config.id = 'example.yuri.local-compact'; config.theme = path.join(root, 'theme.json');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config)); writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/local-compact-writer/Root.tsx'))};\n`);
    for (const file of ['Root.tsx', 'Compact.test.tsx']) writeFileSync(path.join(directory, file), `import ${JSON.stringify(path.join(root, 'tests/local-compact-writer', file))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Compact.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b6 tests: 6 passed\b/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 135_000);

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real YuriNativeApp Changes entry and retained Sheet regressions on macOS and Windows', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'native-changes-root-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.changes-production-root'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('changes.application.gate');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    for (const file of ['Root.tsx', 'Changes.test.tsx']) writeFileSync(path.join(directory, file), `import ${JSON.stringify(path.join(root, 'tests/desktop-changes-application', file))};\n`);
    writeFileSync(path.join(directory, 'App.tsx'), 'import "./Root";\n');
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Changes.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    const output = result.stdout + result.stderr;
    console.log(output);
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output, output).toMatch(/\b20 tests: 20 passed\b/);
    expect(output, output).not.toMatch(/\b[1-9]\d* failed\b/);
    const passed = output.split('\n').filter(line => line.startsWith('✓ Changes.test.tsx › '));
    expect(passed, output).toHaveLength(20);
    for (const platform of ['macos', 'windows']) for (const title of ['actual project action', 'actual historical edit button', 'actual composer Changes Sheet', 'actual selected-worktree project Changes Sheet', 'actual project dirty draft', 'actual project pending commit survives', 'actual project pending commit vetoes', 'actual project unknown commit survives', 'actual project unknown commit vetoes', 'actual project Changes preview']) expect(passed.some(line => line.startsWith('✓ Changes.test.tsx › ' + platform + ' ' + title)), output).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 190_000);

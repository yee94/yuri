import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real native WorkStatus components and projection on Mac/Windows engine models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-work-status-native-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'WorkStatus synthetic fixture', id: 'example.yuri.work-status', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['work.status.audit'] } }));
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': [path.join(root, '../ui/src/*')] } } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-work-status/Fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'WorkStatus.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-work-status/WorkStatus.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'WorkStatus.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const report = result.stdout + result.stderr;
    expect(result.error, report).toBeUndefined(); expect(result.status, report).toBe(0); expect(report).toContain('8 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);

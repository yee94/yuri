import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('original createChat workStatus source runs in the real NSH Mac/Windows reactive graph', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'work-status-source-native-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Synthetic original Chat source', id: 'example.yuri.work-status-source', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop', 'work.status.source.audit'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-work-status-source/Fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Source.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-work-status-source/Source.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Source.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const report = result.stdout + result.stderr;
    expect(result.error, report).toBeUndefined(); expect(result.status, report).toBe(0); expect(report).toContain('6 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);

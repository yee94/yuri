import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('production SettingsUsage uses one native desktop workspace owner on both desktop platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-usage-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Desktop Usage fixture', id: 'example.yuri.desktop-usage', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['desktop.usage.test'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-usage-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Usage.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-usage-ui/Usage.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Usage.test.tsx', ...(process.env.NSH_USAGE_FILTER ? ['--filter', process.env.NSH_USAGE_FILTER] : [])], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = result.stdout + result.stderr;
    if (!process.env.NSH_USAGE_FILTER) {
      for (const platform of ['macos', 'windows']) {
        expect(report).toContain(platform + ' workspace keeps');
        expect(report).toContain(platform + ' real model/header controls');
        expect(report).toContain(platform + ' pending unknown write');
        expect(report).toContain(platform + ' thousands of account windows');
      }
      expect(report).toContain('8 passed');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);

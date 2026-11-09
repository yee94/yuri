import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('actual YuriNativeApp Settings navigation consumes desktop Usage under strict synthetic native Host', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-usage-application-'));
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    expect(Array.isArray(manifest.capabilities.host)).toBe(true);
    manifest.capabilities.host = [...manifest.capabilities.host, 'usage.application.test'];
    manifest.theme = path.join(root, 'theme.json'); manifest.id = 'example.yuri.usage-application';
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(manifest));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    writeFileSync(path.join(directory, 'DelayedRoot.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-usage-application/DelayedRoot.tsx'))};\n`);
    const source = readFileSync(path.join(root, 'tests/desktop-usage-application/Application.test.tsx'), 'utf8')
      .replace("from './Host.js'", `from ${JSON.stringify(path.join(root, 'tests/desktop-usage-application/Host.js'))}`);
    writeFileSync(path.join(directory, 'Application.test.tsx'), source);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Application.test.tsx', ...(process.env.NSH_USAGE_APPLICATION_FILTER ? ['--filter', process.env.NSH_USAGE_APPLICATION_FILTER] : [])], {
      cwd: directory, encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
    });
    const report = result.stdout + result.stderr;
    expect(result.error, report).toBeUndefined(); expect(result.status, report).toBe(0);
    if (!process.env.NSH_USAGE_APPLICATION_FILTER) expect(report).toContain('8 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 165_000);

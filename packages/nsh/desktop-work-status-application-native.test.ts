import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('actual retained Chat binds native WorkStatus to its original source, layout and child workbench', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'native-work-status-root-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.work-status-production-root'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('work.status.application.gate');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-work-status-application/Root.tsx'))};\n`);
    for (const file of ['Root.tsx', 'WorkStatus.test.tsx']) writeFileSync(path.join(directory, file), `import ${JSON.stringify(path.join(root, 'tests/desktop-work-status-application', file))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'WorkStatus.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real NSH root/AssistantHome/sidebar and first folder admission, with isolated output', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'desktop-sidebar-authority-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8')); config.id = 'example.yuri.sidebar-authority'; config.theme = path.join(root, 'theme.json');
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-sidebar-authority-fixture.tsx'))};\n`);
    writeFileSync(path.join(temporary, 'Authority.test.tsx'), readFileSync(path.join(root, 'desktop-sidebar-authority.engine.test.tsx'), 'utf8').replaceAll("'./desktop-sidebar-authority-fixture.tsx'", JSON.stringify(path.join(root, 'desktop-sidebar-authority-fixture.tsx'))));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Authority.test.tsx', '--web-host', path.join(root, 'desktop-sidebar-authority-host.js')], { cwd: temporary, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 130_000);

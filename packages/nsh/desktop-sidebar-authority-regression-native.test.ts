import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { bundleDesktopHost } from './tests/bundle-desktop-host';

test('original production App contact Chat wire remains valid on both desktops, with private engine output', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'sidebar-authority-regression-'));
  const host = bundleDesktopHost(path.join(root, 'tests/desktop-application/host.js'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8')); config.id = 'example.yuri.sidebar-authority-regression'; config.theme = path.join(root, 'theme.json');
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    const source = readFileSync(path.join(root, 'tests/desktop-application/App.test.tsx'), 'utf8')
      .replaceAll("'./host.js'", JSON.stringify(path.join(root, 'tests/desktop-application/host.js')))
      .replaceAll("'./ScheduleHost.js'", JSON.stringify(path.join(root, 'tests/desktop-application/ScheduleHost.js')))
      .replaceAll("'../desktop-journal-host.js'", JSON.stringify(path.join(root, 'tests/desktop-journal-host.js')))
      .replaceAll("'../../App.tsx'", JSON.stringify(path.join(root, 'App.tsx')));
    writeFileSync(path.join(temporary, 'AuthorityRegression.test.tsx'), source);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'AuthorityRegression.test.tsx', '--filter', 'actual desktop assistant Chat retains', '--web-host', host.outfile], { cwd: temporary, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { host.dispose(); rmSync(temporary, { recursive: true, force: true }); }
}, 130_000);

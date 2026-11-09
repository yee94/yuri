import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Every invocation has a private NSH config, generated test files and engine output. */
export function runDesktopSidebarEngine(file: string, target?: 'macos') {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-sidebar-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.desktop-sidebar'; config.theme = path.join(root, 'theme.json');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-sidebar-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Sidebar.test.tsx'), readFileSync(path.join(root, file), 'utf8').replace(/(['"])\.\/(desktop-sidebar[^'"]+\.tsx)\1/g, (_, _quote: string, entry: string) => JSON.stringify(path.join(root, entry))));
    return spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Sidebar.test.tsx', ...(process.env.NSH_SIDEBAR_FILTER ? ['--filter', process.env.NSH_SIDEBAR_FILTER] : []), ...(target ? ['--target', target] : ['--web-host', path.join(root, 'desktop-sidebar-host.js')])], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

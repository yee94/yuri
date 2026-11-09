import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { bundleDesktopHost } from './tests/bundle-desktop-host';

test('actual YuriNativeApp contact read receipts on macOS and Windows headless models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const host = bundleDesktopHost(path.join(root, 'tests/desktop-application/host.js'));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-contact-read-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.contact-read-production-root'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('contact-read.test.metric');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    mkdirSync(path.join(directory, 'tests/desktop-application'), { recursive: true });
    writeFileSync(path.join(directory, 'ContactReadRoot.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/ContactReadRoot.tsx'))};\n`);
    writeFileSync(path.join(directory, 'tests/desktop-application/ContactRead.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/ContactRead.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-application/ContactRead.test.tsx', '--web-host', host.outfile], {
      cwd: directory, encoding: 'utf8', timeout: 180_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b22 tests: 22 passed\b/);
  } finally { host.dispose(); rmSync(directory, { recursive: true, force: true }); }
}, 190_000);

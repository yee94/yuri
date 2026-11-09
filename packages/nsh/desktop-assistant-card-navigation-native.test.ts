import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { bundleDesktopHost } from './tests/bundle-desktop-host';

test('actual App contact-card navigation custody boundaries on macOS/Windows headless models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), host = bundleDesktopHost(path.join(root, 'tests/desktop-application/host.js'));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-contact-card-navigation-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    const baseline = [...config.capabilities.host];
    config.id = 'example.yuri.contact-card-navigation'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('contact-card-navigation.test.audit');
    expect(config.capabilities.host.slice(0, -1)).toEqual(baseline);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    writeFileSync(path.join(directory, 'ContactCardNavigationRoot.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/ContactCardNavigationRoot.tsx'))};\n`);
    mkdirSync(path.join(directory, 'tests/desktop-application'), { recursive: true });
    writeFileSync(path.join(directory, 'tests/desktop-application/ContactCardNavigation.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/ContactCardNavigation.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-application/ContactCardNavigation.test.tsx', '--web-host', host.outfile], {
      cwd: directory, encoding: 'utf8', timeout: 240_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b32 tests: 32 passed\b/);
    expect(result.stdout + result.stderr).not.toMatch(/\b[1-9]\d* skipped\b/);
  } finally { host.dispose(); rmSync(directory, { recursive: true, force: true }); }
}, 250_000);

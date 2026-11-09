import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { bundleDesktopHost } from './tests/bundle-desktop-host';

test('production App selects native desktop layout for both platform environments', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), host = bundleDesktopHost(path.join(root, 'tests/desktop-application/host.js'));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'native-application-root-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.application-production-root'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('assistant.test.release');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    mkdirSync(path.join(directory, 'tests/desktop-application'), { recursive: true });
    writeFileSync(path.join(directory, 'tests/desktop-application/App.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/App.test.tsx'))};\n`);
    writeFileSync(path.join(directory, 'AssistantRoot.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/AssistantRoot.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-application/App.test.tsx', '--web-host', host.outfile], {
      cwd: directory, encoding: 'utf8', timeout: 300_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b88 tests: 88 passed\b/);
  } finally { host.dispose(); rmSync(directory, { recursive: true, force: true }); }
}, 310_000);

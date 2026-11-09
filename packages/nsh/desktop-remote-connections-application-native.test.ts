import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('production App → getter SettingsRoot → native SSH slot (isolated exact grants, both headless platforms)', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-ssh-application-'));
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    const sshMethods = ['capabilities', 'read', 'save', 'remove', 'start', 'cancel'].map(name => `desktop.ssh.${name}`);
    expect(Array.isArray(manifest.capabilities.host)).toBe(true);
    const missing = sshMethods.filter(name => !manifest.capabilities.host.includes(name));
    // The temporary grant is test-only evidence, not a claim the production manifest is ready.
    manifest.capabilities.host = [...manifest.capabilities.host, ...missing];
    manifest.theme = path.join(root, 'theme.json'); manifest.id = 'example.yuri.ssh-application';
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(manifest));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    const testSource = readFileSync(path.join(root, 'tests/desktop-remote-connections-application/Application.test.tsx'), 'utf8')
      .replace("from './host.js'", `from ${JSON.stringify(path.join(root, 'tests/desktop-remote-connections-application/host.js'))}`);
    writeFileSync(path.join(directory, 'Application.test.tsx'), testSource);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Application.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('10 passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 165_000);

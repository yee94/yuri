import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('production desktop contact attachment uses the existing native download owner and modal gate', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'native-contact-attachment-root-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.contact-attachment-production-root'; config.theme = path.join(root, 'theme.json');
    config.capabilities.host.push('contact-attachment.test.audit');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    writeFileSync(path.join(directory, 'ContactAttachmentRoot.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/ContactAttachmentRoot.tsx'))};\n`);
    mkdirSync(path.join(directory, 'tests/desktop-application'), { recursive: true });
    writeFileSync(path.join(directory, 'tests/desktop-application/ContactAttachment.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/ContactAttachment.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-application/ContactAttachment.test.tsx'], {
      cwd: directory, encoding: 'utf8', timeout: 240_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b12 tests: 12 passed\b/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 250_000);

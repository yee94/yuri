import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('contact conversation presentation: actual NSH 0.4 engine, macOS and Windows models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-assistant-conversation-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Contact presentation fixture', id: 'example.yuri.contact-presentation', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-assistant-conversation-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Conversation.test.tsx'), readFileSync(path.join(root, 'tests/desktop-assistant-conversation/Conversation.test.tsx'), 'utf8').replaceAll("'../../desktop-assistant-conversation-fixture.tsx'", JSON.stringify(path.join(root, 'desktop-assistant-conversation-fixture.tsx'))));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Conversation.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);

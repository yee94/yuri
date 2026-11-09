import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('navigation feedback safe summaries, exact retry lanes, inactive/busy guards and ten actual locales in NSH headless', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'navigation-feedback-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Navigation feedback', id: 'example.yuri.navigation-feedback', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['navigation.test.feedback'] } }));
    const entry = `import ${JSON.stringify(path.join(root, 'tests/desktop-application/NavigationFeedback.tsx'))};\n`;
    writeFileSync(path.join(directory, 'App.tsx'), entry); writeFileSync(path.join(directory, 'NavigationFeedback.tsx'), entry);
    writeFileSync(path.join(directory, 'Feedback.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-application/NavigationFeedback.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Feedback.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);

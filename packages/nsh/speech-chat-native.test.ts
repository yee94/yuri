import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('production Chat binds one speech owner to assistant actions, not user actions, and fences child navigation (headless)', () => {
  const cwd = path.dirname(fileURLToPath(import.meta.url));
  const directory = mkdtempSync(path.join(tmpdir(), 'nsh-chat-speech-'));
  try {
    const fixture = path.join(directory, 'host.js');
    const bundled = spawnSync('bun', ['build', 'tests/speech-chat-host.js', '--target=browser', '--outfile', fixture], { cwd, encoding: 'utf8' });
    expect(bundled.status, bundled.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', fixture], {
      cwd, encoding: 'utf8', timeout: 60_000,
      input: [
        'await app.waitFor("text:Native conversation");',
        'await app.press("text:Native conversation");',
        'await app.waitFor("id:speech-history-final-answer");',
        'expect(app.shows("id:speech-history-user")).toBe(false);',
        'await app.press("id:speech-history-final-answer");',
        'await app.waitFor("id:speech-error-history-final-answer");',
        'expect(app.texts().join(" ")).not.toContain("Synthetic playback failure");',
        'await app.press("id:body-activity-history-answer");',
        'await app.press("id:tool-session-child-session");',
        'await app.waitFor("id:speech-child-answer");',
        'expect(app.shows("id:speech-error-history-final-answer")).toBe(false);',
        'expect(app.shows("id:speech-settings-retry")).toBe(false);',
      ].join('\n'),
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);

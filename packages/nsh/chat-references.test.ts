import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('production Chat opens and dismisses reference suggestions and sends the captured file sidecar', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-chat-references-'));
  try {
    const fixture = path.join(temporary, 'host.js');
    const build = spawnSync('bun', ['build', 'tests/chat-references-host.js', '--target=browser', '--outfile', fixture], { cwd: directory, encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const steps = [
      'await app.waitFor("text:Native conversation");',
      'await app.press("text:Native conversation");',
      'await app.waitFor("id:composer");',
      'expect(app.shows("id:reference-picker")).toBe(false);',
      'await app.type("id:composer", "Read @src");',
      'await app.waitFor("id:reference-result-file-src/native.ts");',
      'await app.keyboard.press("escape");',
      'expect(app.shows("id:reference-picker")).toBe(false);',
      'await app.type("id:composer", "/native");',
      'await app.waitFor("id:reference-result-file-src/native.ts");',
      'await app.press("id:reference-result-file-src/native.ts");',
      'expect(app.value("id:composer")).toContain("@src/native.ts");',
      'expect(app.shows("id:reference-picker")).toBe(false);',
      'await app.press("id:send");',
      'await app.waitFor("text:Message accepted by native transport");',
      'expect(app.value("id:composer")).toBe("");',
    ].join('\n');
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', fixture], { cwd: directory, input: steps, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);

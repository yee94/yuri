import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
test('native resources navigate directories and render source and Markdown', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'resources-test-app.tsx', '--web-host', 'tests/resources-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.waitFor("text:▸ sub");',
      'await app.press("text:▸ sub");',
      'await app.waitFor("text:note.md");',
      'await app.press("text:note.md");',
      'await app.waitFor("text:Neutral resource fixture");',
      'await app.press("text:Refresh files");',
      'await app.waitFor("text:Error: Neutral fixture offline; retry available");',
      'expect(app.shows("text:Neutral resource fixture")).toBe(true);',
      'await app.press("text:Refresh files");',
      'await app.waitFor("text:Neutral resource fixture");',
      'await app.press("text:Close");',
      'await app.waitFor("text:Parent directory");',
      'await app.press("text:Parent directory");',
      'await app.waitFor("text:source.ts");',
      'await app.press("text:source.ts");',
       'await app.waitFor("text:const neutralFixture = 1;");',
       'await app.press("text:Close");',
       'await app.type("id:resource-search", "source");',
       'await app.waitFor("text:source.ts");',
       'expect(app.shows("text:▸ sub")).toBe(false);',
       'await app.press("text:source.ts");',
       'await app.waitFor("text:const neutralFixture = 1;");',
      'expect(app.texts().join("\\n")).not.toMatch(/Invalid native response|Unexpected resource/);',
       'await app.press("id:open-line-target");',
       'await app.waitFor("id:resource-source-lines");',
       'await app.waitFor("id:resource-line-3");',
       'await app.waitFor("text:target line");',
     ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
test('contact attachment preview keeps content on refresh failure and exposes a close action after lease expiry', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'resources-test-app.tsx', '--web-host', 'tests/resources-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.press("id:open-contact");',
      'await app.waitFor("text:Contact resource fixture");',
      'await app.press("text:Refresh files");',
      'await app.waitFor("text:Error: Neutral fixture offline; retry available");',
      'expect(app.shows("text:Contact resource fixture")).toBe(true);',
      'await app.press("text:Refresh files");',
      'await app.waitFor("text:Contact resource fixture");',
      'await app.press("id:expire-contact");',
      'await app.waitFor("text:This preview has expired. Go back and open the attachment again.");',
      'expect(app.shows("text:Contact resource fixture")).toBe(false);',
      'await app.press("text:Close");',
      'expect(app.shows("text:This preview has expired. Go back and open the attachment again.")).toBe(false);',
      'expect(app.texts().join("\\n")).not.toMatch(/Unexpected contact|Invalid native response/);',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

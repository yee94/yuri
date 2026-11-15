import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('real message paints skill and file actions, fills a slim image once and opens its shared fullscreen viewer', () => {
  const target = process.env.NSH_MESSAGE_MEDIA_TARGET;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const screenshot = (name: string) => target ? ['await app.wait(500);', `await app.screenshot(${JSON.stringify(path.join(directory, '.nsh', `message-media-${target}-${name}.png`))});`] : [];
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'message-media-fixture.tsx', ...(target ? ['--target', target] : [])], {
    cwd: directory, encoding: 'utf8', timeout: target ? 110_000 : 60_000,
    input: [
      'await app.waitFor("text:reads:1");',
      'await app.waitFor("id:attachment-image");',
      ...screenshot('message'),
      'await app.press("id:message-reference-skill");',
      'await app.waitFor("text:opened:review");',
      'await app.press("id:attachment-file-open");',
      'await app.waitFor("text:opened:notes.txt");',
      'await app.press("id:attachment-image");',
      'await app.waitFor("id:image-preview-close");',
      ...screenshot('fullscreen'),
      'await app.press("id:image-preview-close");',
      'await app.waitUntil(() => !app.shows("id:image-preview-close"));',
      'await app.press("id:media-renew");',
      'await app.waitFor("text:authority:renewed-authority");',
      'await app.press("id:attachment-image");',
      'await app.waitFor("id:image-preview-close");',
      'await app.press("id:image-preview-close");',
      'await app.waitUntil(() => !app.shows("id:image-preview-close"));',
      'expect(app.texts()).toContain("reads:1");',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);

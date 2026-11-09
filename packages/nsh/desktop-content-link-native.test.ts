import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
it('production ordinary, UserText and both Reasoning branches report links, errors and inactive admission (headless)', () => {
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'content-link-native-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Synthetic content links', id: 'example.content.links', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: true } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-content-link.fixture.tsx'))};`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', path.join(root, 'tests/host.js')], { cwd: temporary, encoding: 'utf8', timeout: 90_000, input: [
      'await app.waitFor("text:Open");',
      'await app.press("text:Open");', 'await app.waitFor("text:CALLS:1");', 'expect(app.shows("text:LAST:README.md#L12")).toBe(true);',
      'await app.press("id:user");', 'await app.waitFor("text:Open");', 'await app.press("text:Open");', 'await app.waitFor("text:CALLS:2");',
      'await app.press("id:reasoning");', 'await app.waitFor("text:Open");', 'await app.press("text:Open");', 'await app.waitFor("text:CALLS:3");',
      'await app.press("id:fold");', 'await app.waitFor("id:body-reasoning-message:part");', 'await app.press("id:body-reasoning-message:part");',
      'await app.waitFor("text:Open");', 'await app.press("text:Open");', 'await app.waitFor("text:CALLS:4");',
      'await app.press("text:Fail");', 'await app.waitFor("id:body-link-error-message");', 'expect(app.shows("text:CALLS:5")).toBe(true);',
      'await app.press("text:Open");', 'await app.waitFor("text:CALLS:6");', 'expect(app.shows("id:body-link-error-message")).toBe(false);',
      'await app.press("id:inactive");', 'await app.press("text:Open");', 'expect(app.shows("text:CALLS:6")).toBe(true);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 100_000);

it('uninjected iOS/default body keeps NSH open behavior on every TextView', () => {
  const source = readFileSync(path.join(root, 'transcript-body.tsx'), 'utf8');
  const textViews = [...source.matchAll(/<TextView\s[\s\S]*?\/>/g)].map(match => match[0]);
  expect(textViews).toHaveLength(4);
  for (const view of textViews) {
    expect(view).toContain("links={props.body.onOpenLink ? 'report' : 'open'}");
    expect(view).toContain('onLinkPress={event => props.body.openLink(event.url)}');
  }
});

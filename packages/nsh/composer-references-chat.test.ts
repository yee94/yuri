import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

test('production native chat owns durable five-domain references through picker, remount and prompt admission', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const steps = [
    'await app.waitFor("id:reference-chat-composer");',
    'await app.waitFor("text:ready");',
    'await app.type("id:reference-chat-composer", "Read ");',
    ...['file', 'directory', 'agent', 'skill', 'session'].flatMap(kind => {
      const value = kind === 'file' ? 'src/neutral.ts' : kind === 'directory' ? 'src/' : kind === 'agent' ? 'reviewer' : kind === 'skill' ? 'real-skill' : 'prior';
      const query = kind === 'file' ? 'src' : kind === 'directory' ? 'src/' : kind === 'session' ? 'Prior' : value;
      return ['await app.press("id:reference-chat-open");', `await app.type("id:reference-chat-composer", "${query}");`, `await app.waitFor("id:reference-result-${kind}-${value}");`, `await app.press("id:reference-result-${kind}-${value}");`];
    }),
    'expect(app.texts()).toContain("references:5");',
    'await app.press("id:reference-chat-flush");',
    'await app.press("id:reference-chat-toggle");',
    'await app.press("id:reference-chat-toggle");',
    'await app.waitFor("text:ready");',
    'expect(app.texts()).toContain("references:5");',
    'expect(app.value("id:reference-chat-composer")).toContain("@Displayed skill");',
    'await app.press("id:reference-chat-send");',
    'await app.waitFor("text:Five-domain native prompt admitted");',
    'expect(app.value("id:reference-chat-composer")).toBe("");',
    'expect(app.texts()).toContain("references:0");',
  ];
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'composer-references-chat-fixture.tsx', '--web-host', 'tests/composer-references-chat-host.js'], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

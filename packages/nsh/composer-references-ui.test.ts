import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/composer-references-app.tsx'], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('native picker selects file and skill into durable sidecars and real prompt wire', () => {
  run([
    'await app.waitFor("id:reference-composer");',
    'expect(app.texts()).toContain("calls:0");',
    'await app.type("id:reference-composer", "Read ");',
    'for (let i = 0; i < 50; i++) await app.type("id:reference-composer", "x");',
    'expect(app.texts()).toContain("calls:0");',
    'await app.press("id:reference-open");',
    'expect(app.shows("id:reference-query")).toBe(false);',
    'expect(app.shows("id:reference-domain-file")).toBe(false);',
    'await app.type("id:reference-composer", "src");',
    'await app.waitFor("id:reference-result-file-src/neutral.ts");',
    'await app.press("id:reference-result-file-src/neutral.ts");',
    'expect(app.value("id:reference-composer")).toContain("@src/neutral.ts");',
    'expect(app.texts()).toContain("references:1");',
    'const closedCalls = app.texts().find(text => text.startsWith("calls:"));',
    'for (let i = 0; i < 50; i++) await app.type("id:reference-composer", "x");',
    'expect(app.texts()).toContain(closedCalls);',
    'await app.press("id:reference-open");',
    'await app.type("id:reference-composer", "real-skill");',
    'await app.waitFor("id:reference-result-skill-real-skill");',
    'await app.press("id:reference-result-skill-real-skill");',
    'expect(app.value("id:reference-composer")).toContain("@Display skill");',
    'await app.press("id:reference-submit");',
    'await app.waitUntil(() => app.texts().join("\\n").includes("file:///workspace/src/neutral.ts"));',
    'expect(app.texts().join("\\n")).toContain("real-skill");',
    'expect(app.texts().join("\\n")).toContain("[skill:real-skill]");',
  ]);
}, 75_000);

test('native directory agent and session choices preserve independent wire semantics', () => {
  run([
    'await app.waitFor("id:reference-composer");',
    ...['directory', 'agent', 'session'].flatMap(kind => [
      'await app.press("id:reference-open");',
      `await app.type("id:reference-composer", "${kind === 'directory' ? 'src/' : kind === 'agent' ? 'reviewer' : 'Prior'}");`,
      `await app.waitFor("id:reference-result-${kind}-${kind === 'directory' ? 'src/' : kind === 'agent' ? 'reviewer' : 'prior'}");`,
      `await app.press("id:reference-result-${kind}-${kind === 'directory' ? 'src/' : kind === 'agent' ? 'reviewer' : 'prior'}");`,
    ]),
    'expect(app.texts()).toContain("references:3");',
    'await app.press("id:reference-submit");',
    'await app.waitUntil(() => app.texts().join("\\n").includes("session_message"));',
    'expect(app.texts().join("\\n")).toContain("file:///workspace/src");',
    'expect(app.texts().join("\\n")).toContain("reviewer");',
    'expect(app.texts().join("\\n")).toContain("/other");',
  ]);
}, 75_000);

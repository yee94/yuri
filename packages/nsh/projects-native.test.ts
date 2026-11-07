import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

test('projects render through the native engine and open a real session target', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const script = [
    'await app.waitFor("text:Native projects fixture");',
    'await app.waitFor("text:Native projects conversation");',
    'await app.waitFor("text:native-first-branch");',
    'await app.waitFor("text:native-second-branch");',
    'expect(app.texts().indexOf("native-second-branch")).toBeLessThan(app.texts().indexOf("native-first-branch"));',
    'expect(app.texts().join("\\n")).not.toMatch(/Invalid active snapshot|Unexpected projects request/);',
    'const before = app.texts().filter(text => text === "Native projects conversation").length;',
    'await app.press("id:project-session-projects_session >> nth=0");',
    'expect(app.texts().filter(text => text === "Native projects conversation").length).toBeGreaterThan(before);',
  ].join('\n');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'projects-native.fixture.tsx', '--web-host', 'tests/projects-host.js'], { cwd: directory, input: script, encoding: 'utf8', timeout: 45000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60000);

function outerTest(steps: string[]) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'projects-outer.fixture.tsx', '--web-host', 'tests/projects-outer-host.js'], { cwd: directory, input: steps.join('\n'), encoding: 'utf8', timeout: 45000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('native project clone keeps input after registry conflict and retry does not clone twice', () => {
  outerTest([
    'await app.press("id:fixture-directory");',
    'await app.waitFor("id:projects-directory-path");',
    'await app.clear("id:projects-directory-path");',
    'await app.type("id:projects-directory-path", "/workspace/new-repo");',
    'expect(app.value("id:projects-directory-path")).toBe("/workspace/new-repo");',
    'await app.press("id:projects-directory-mode-toggle");',
    'await app.waitFor("id:projects-clone-url");',
    'await app.type("id:projects-clone-url", "https://repo.example/team/repo");',
    'const input = app.value("id:projects-clone-url");',
    'await app.press("id:projects-directory-submit");',
    'await app.waitFor("text:Error: HTTP 409: Fixture registry conflict");',
    'expect(app.value("id:projects-clone-url")).toBe(input);',
    'await app.press("id:projects-directory-submit");',
    'await app.waitFor("text:Draft: /workspace/new-repo");',
    'await app.back();',
    'await app.waitFor("id:fixture-directory");',
  ]);
}, 60000);

test('native global search isolates content failure, retries and forwards the exact message anchor', () => {
  outerTest([
    'await app.press("id:fixture-search");',
    'await app.waitFor("id:projects-global-search");',
    'await app.type("id:projects-global-search", "Native");',
    'await app.waitFor("text:Message search could not load. Other results are still shown.");',
    'expect(app.texts().includes("Native global title hit")).toBe(true);',
    'expect(app.texts().includes("src/native.ts")).toBe(true);',
    'await app.press("id:projects-search-retry");',
    'await app.waitFor("text:Native body match");',
    'await app.press("id:projects-search-message:fixture-session:fixture-message");',
    'await app.waitFor("text:fixture-session:fixture-message");',
    'await app.back();',
    'await app.back();',
    'await app.waitFor("id:fixture-search");',
  ]);
}, 60000);

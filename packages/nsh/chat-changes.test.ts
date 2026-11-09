import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareChangesEngineDriver } from './tests/chat-changes-engine-driver';

const directory = path.dirname(fileURLToPath(import.meta.url));
function run(entry: string, host: string, steps: string[]) {
  const driver = prepareChangesEngineDriver(directory, entry, steps);
  try {
    const fixture = driver.bundleHost(host);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver.testFile, '--web-host', fixture], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { driver.dispose(); }
}

test('Changes expansion and failed refresh leave the native transcript viewport unchanged', () => {
  run('changes-layout-fixture.tsx', 'tests/chat-changes-host.js', [
    'await app.waitFor("text:300 files");',
    'await app.wait(50);',
    'const height = () => app.texts().find(value => value.startsWith("viewport:"));',
    'const before = height();',
    'expect(before === undefined || before === "viewport:0").toBe(false);',
    'expect(app.shows("id:composer-changed-files")).toBe(false);',
    'expect(app.shows("id:composer-change-neutral-0.txt")).toBe(false);',
    'await app.press("id:composer-changes");',
    'await app.waitFor("id:composer-change-neutral-0.txt");',
    'await app.waitFor("text:HTTP 503: Neutral status offline");',
    'await app.wait(50);',
    'expect(height()).toBe(before);',
    'await app.press("id:composer-changes");',
    'await app.wait(50);',
    'expect(height()).toBe(before);',
    'expect(app.shows("id:composer-changed-files")).toBe(false);',
    'expect(app.shows("id:composer-change-neutral-0.txt")).toBe(false);',
  ]);
}, 75_000);

test('isolated workspace actions preserve failed commit input and require revert confirmation', () => {
  run('chat-changes-test-app.tsx', 'chat-changes-actions-fixture-host.js', [
      'await app.press("id:changes-fixture-workspace");',
      'await app.waitFor("text:fixture-branch");',
      'await app.waitFor("id:changes-stage-folder/a.ts");',
      'await app.press("id:changes-stage-folder/a.ts");',
      'await app.waitFor("text:HTTP 400: Fake stage failure");',
      'expect(app.shows("id:changes-working-folder/a.ts")).toBe(true);',
      'await app.press("id:changes-stage-folder/a.ts");',
      'await app.waitFor("id:changes-staged-folder/a.ts");',
      'await app.type("id:changes-commit-message", "Exact fixture commit");',
      'await app.press("id:changes-commit");',
      'await app.waitFor("text:HTTP 400: Fake commit failure");',
      'expect(app.value("id:changes-commit-message")).toBe("Exact fixture commit");',
      'await app.press("id:changes-commit");',
      'await app.waitUntil(() => !app.shows("id:changes-staged-folder/a.ts"));',
      'expect(app.value("id:changes-commit-message")).toBe("");',
      'app.onDialog(() => "Cancel");',
      'await app.press("id:changes-revert-folder/b.ts");',
      'expect(app.dialogs().at(-1).title).toBe("Revert all changes?");',
      'expect(app.shows("id:changes-working-folder/b.ts")).toBe(true);',
      'app.onDialog(() => "Revert all");',
      'await app.press("id:changes-revert-folder/b.ts");',
      'await app.waitFor("text:Working tree clean, no changes to display");',
      'await app.press("id:changes-close");',
      'await app.waitUntil(() => !app.shows("id:native-changes-sheet"));',
    ]);
}, 75_000);

test('isolated Changes native sheet retains draft, failed authority and separate staged/history diff', () => {
  run('chat-changes-test-app.tsx', 'chat-changes-fixture-host.js', [
      'await app.waitFor("text:300 files");',
      'expect(app.shows("id:composer-changed-files")).toBe(false);',
      'await app.type("id:changes-fixture-draft", "Fifty native input characters must not refresh Git status");',
      'expect(app.shows("id:composer-changed-files")).toBe(false);',
      'await app.press("id:composer-changes");',
      'await app.waitFor("text:HTTP 503: Neutral status offline");',
      'expect(app.shows("text:300 files")).toBe(true);',
      'await app.press("id:composer-changes-expanded-retry");',
      'await app.waitUntil(() => !app.shows("text:HTTP 503: Neutral status offline"));',
      'await app.press("id:composer-change-a.ts");',
      'await app.waitFor("id:native-changes-sheet");',
      'await app.waitFor("id:changes-native-diff");',
      'await app.waitFor("text:WORKING_ONLY");',
      'await app.press("id:changes-diff-refresh");',
      'await app.waitFor("text:HTTP 503: Neutral diff offline");',
      'expect(app.shows("text:WORKING_ONLY")).toBe(true);',
      'await app.press("id:changes-diff-refresh");',
      'await app.waitUntil(() => !app.shows("text:HTTP 503: Neutral diff offline"));',
      'await app.press("id:changes-back");',
      'await app.waitFor("id:changes-staged-a.ts");',
      'await app.press("id:changes-staged-a.ts");',
      'await app.waitFor("text:STAGED_ONLY");',
      'await app.press("id:changes-close");',
      'await app.waitUntil(() => !app.shows("id:native-changes-sheet"));',
      'expect(app.value("id:changes-fixture-draft")).toBe("Fifty native input characters must not refresh Git status");',
       'await app.press("id:changes-fixture-history");',
       'await app.waitFor("text:history.ts");',
       'await app.press("text:history.ts");',
      'await app.waitFor("text:HISTORICAL_ONLY");',
      'expect(app.shows("text:WORKING_ONLY")).toBe(false);',
      'await app.press("id:changes-back");',
      'await app.press("text:thin.ts");',
      'await app.waitFor("text:Historical diff body unavailable");',
      'expect(app.shows("text:WORKING_ONLY")).toBe(false);',
      'await app.press("id:changes-close");',
      'await app.waitUntil(() => !app.shows("id:native-changes-sheet"));',
    ]);
}, 75_000);

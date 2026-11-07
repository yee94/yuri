import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

function run(steps: string[], ios = false) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tool-diff-fixture.tsx', ...(ios ? ['--target', 'ios'] : [])], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 90_000,
    input: [`const capture = ${ios && process.env.NSH_TOOL_DIFF_SCREENSHOTS === '1'};`, 'await app.waitFor("text:TOOL DIFF READY");', 'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/tools-chrome-uikit.png");', ...steps].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

const steps = [
  'expect(app.shows("text:example.ts")).toBe(true);',
  'expect(app.shows("id:tool-duration-edit")).toBe(false);',
  'expect(app.shows("id:tool-duration-grep")).toBe(false);',
  'await app.press("id:tool-expand-grep");',
  'await app.waitFor("text:fixture literal **result**");',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/tools-expanded-uikit.png");',
  'expect(app.shows("text:Completed")).toBe(false);',
  'expect(app.shows("text:Output")).toBe(false);',
  'await app.press("id:tool-expand-grep");',
  'await app.press("id:tool-expand-failed");',
  'await app.waitFor("text:fixture request failed");',
  'await app.press("id:tool-expand-failed");',
  'await app.press("id:tool-expand-edit");',
  'await app.waitFor("id:changes-native-diff");',
  'await app.waitFor("text:NEW_WORD");',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/tool-patch-diff-uikit.png");',
  'await app.waitUntil(() => app.enabled("id:changes-first-change"));',
  'await app.press("id:changes-first-change");',
  'await app.press("id:changes-open-preview");',
  'await app.waitFor("text:preview:/fixture/example.ts:9");',
  'await app.press("id:tool-expand-multi");',
  'await app.waitFor("text:FIRST_HISTORY");',
  'await app.press("id:changes-back");',
  'await app.press("text:other.ts");',
  'await app.waitFor("text:OTHER_HISTORY");',
  'expect(app.shows("text:FIRST_HISTORY")).toBe(false);',
  'await app.press("id:changes-open-preview");',
  'await app.waitFor("text:preview:other.ts:4");',
  'await app.press("id:fixture-text-pair");',
  'await app.waitFor("id:changes-native-diff");',
  'await app.waitFor("text:const value = \\\"PAIR_NEW\\\";");',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/tool-pair-diff-uikit.png");',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-delete");',
  'await app.waitFor("text:DELETED_ONLY");',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-binary");',
  'await app.waitUntil(() => app.shows("id:native-changes-sheet"));',
  'expect(app.shows("id:changes-native-diff")).toBe(false);',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-empty");',
  'await app.waitFor("id:changes-native-diff");',
  'await app.waitFor("text:Working tree clean, no changes to display");',
  'expect(app.enabled("id:changes-first-change")).toBe(false);',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-expire");',
  'expect(app.enabled("id:tool-expand-edit")).toBe(false);',
];
test('native tool chrome and built-in diff retain historical bodies, text pairs, deletion, binary and lifecycle', () => run(steps), 105_000);
test.skipIf(process.env.NSH_TOOL_DIFF_IOS !== '1')('UIKit mounts the production NSH DiffView and navigates historical tools without Host/model calls', () => run(steps, true), 105_000);

test('built-in diff virtualizes a 2000-line replacement without app-owned per-line nodes', () => run([
  'await app.press("id:fixture-long");', 'await app.waitFor("id:changes-native-diff");',
  'await app.waitFor("text:old 0");', 'expect(app.texts().length < 500).toBe(true);',
  'await app.press("id:changes-close");',
]), 105_000);

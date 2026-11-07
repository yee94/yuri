import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], ios = false) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'composer-autocomplete-fixture.tsx', ...(ios ? ['--target', 'ios'] : [])], { cwd: directory, encoding: 'utf8', timeout: 90_000, input: ['await app.waitFor("id:autocomplete-input");', ...steps].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
test('production slash adapter handles Tab, tap, soft Enter, no-match Enter, tail preservation and @ switching', () => run([
  'await app.press("id:model");', 'await app.waitFor("id:command-model");',
  'await app.keyboard.press("tab");', 'expect(app.value("id:autocomplete-input")).toBe("/model ");',
  'expect(app.texts().some(text => text.includes("action:none"))).toBe(true);',
  'await app.press("id:middle");', 'await app.waitFor("id:command-model");', 'await app.keyboard.press("tab");',
  'expect(app.value("id:autocomplete-input")).toBe("/model \\nKEEP");',
  'await app.press("id:model");', 'await app.waitFor("id:command-model");', 'await app.submit("id:autocomplete-input");',
  'expect(app.value("id:autocomplete-input")).toBe("");', 'expect(app.texts().some(text => text.includes("action:model"))).toBe(true);',
  'await app.press("id:ordinary");', 'await app.clear("id:autocomplete-input");', 'await app.type("id:autocomplete-input", "/zzzznevermatch");',
  'await app.keyboard.press("enter");', 'expect(app.value("id:autocomplete-input")).toBe("/zzzznevermatch");',
  'await app.keyboard.press("escape");', 'expect(app.shows("id:command-suggestions")).toBe(false);',
  'await app.press("id:mention");', 'await app.waitFor("id:reference-result-file-src/neutral.ts");',
  'await app.press("id:reference-result-file-src/neutral.ts");', 'expect(app.value("id:autocomplete-input")).toBe("@src/neutral.ts ");',
  'await app.press("id:model");', 'await app.waitFor("id:command-model");', 'await app.press("id:command-model");',
  'expect(app.value("id:autocomplete-input")).toBe("");',
]), 100_000);
test('closed/open/closed 300-entry catalog has zero enumeration on 50 ordinary edits and retry is explicit', () => run([
  'await app.type("id:autocomplete-input", "ordinary");',
  'for (let i=0;i<50;i++) await app.type("id:autocomplete-input", "x");',
  'expect(app.texts().some(text => text.includes("calls:0 scans:0"))).toBe(true);',
  'await app.press("id:failure");', 'await app.press("id:slash");', 'await app.waitFor("id:command-retry");',
  'expect(app.texts()).toContain("slash:308 refs:0");',
  'await app.keyboard.press("up");', 'expect(app.shows("id:command-workspace-review")).toBe(true);',
  'await app.keyboard.press("down");', 'expect(app.shows("id:command-model")).toBe(true);',
  'expect(app.texts().some(text => text.includes("calls:1"))).toBe(true);',
  'await app.wait(250);', 'expect(app.texts().some(text => text.includes("calls:1"))).toBe(true);',
  'await app.keyboard.press("mod+f");', 'await app.press("id:command-retry");', 'await app.waitUntil(() => !app.shows("id:command-retry"));',
  'await app.keyboard.press("escape");', 'await app.press("id:ordinary");',
  'const before = app.texts().find(text => text.includes("calls:"));',
  'for (let i=0;i<50;i++) await app.type("id:autocomplete-input", "x");',
  'expect(app.texts()).toContain(before);', 'expect(app.shows("id:command-suggestions")).toBe(false);',
]), 100_000);
test('slash releases keys and candidates during composition, selection, blur, Host/page change and background', () => run([
  'await app.press("id:model");', 'await app.waitFor("id:command-model");',
  'await app.keyboard.press("mod+i");', 'await app.keyboard.press("down");',
  'expect(app.shows("id:command-suggestions")).toBe(false);', 'expect(app.texts().some(text => text.includes("fallback:down"))).toBe(true);',
  'await app.keyboard.press("mod+j");', 'await app.waitFor("id:command-model");',
  'await app.press("id:selection");', 'await app.keyboard.press("enter");', 'expect(app.value("id:autocomplete-input")).toBe("/mo");',
  'await app.press("id:model");', 'await app.type("id:other", "focus");', 'expect(app.shows("id:command-suggestions")).toBe(false);',
  'await app.press("id:model");', 'await app.press("id:host");', 'await app.keyboard.press("tab");', 'expect(app.value("id:autocomplete-input")).toBe("/mo");',
  'await app.press("id:model");', 'await app.press("id:page");', 'expect(app.shows("id:command-suggestions")).toBe(false);',
  'await app.press("id:page");', 'await app.press("id:model");', 'await app.setLifecycle("background");',
  'await app.keyboard.press("enter");', 'expect(app.value("id:autocomplete-input")).toBe("/mo");', 'expect(app.shows("id:command-suggestions")).toBe(false);',
]), 100_000);
test.skipIf(process.env.NSH_COMPOSER_IOS !== '1')('UIKit production glass input and both anchored candidates', () => run([
  'await app.press("id:model");', 'await app.waitFor("id:command-model");',
  'await app.screenshot("../../.scratch/nsh/chat-frames/composer-slash-uikit.png");',
  'await app.press("id:command-model");', 'expect(app.value("id:autocomplete-input")).toBe("");',
  'await app.press("id:mention");', 'await app.waitFor("id:reference-result-file-src/neutral.ts");',
  'await app.screenshot("../../.scratch/nsh/chat-frames/composer-mention-uikit.png");',
  'await app.press("id:reference-result-file-src/neutral.ts");', 'expect(app.value("id:autocomplete-input")).toBe("@src/neutral.ts ");',
], true), 100_000);

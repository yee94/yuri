import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

function run(steps: string[]) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'local-commands-native-'));
  try {
    const entry = path.join(temporary, 'fixture.tsx');
    writeFileSync(entry, `import { mountLocalCommandFixture } from ${JSON.stringify(path.join(directory, 'composer-local-commands-fixture.tsx'))};\nmountLocalCommandFixture();\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', entry], { cwd: directory, encoding: 'utf8', timeout: 90_000,
      input: ['await app.waitFor("id:local-input");', ...steps].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
test('headless production Input/keymap and slash rows: Tab, Enter/click, unbound and nonempty tail', () => run([
  'await app.press("id:fork");', 'await app.waitFor("id:command-fork");', 'await app.keyboard.press("tab");',
  'expect(app.value("id:local-input")).toBe("/fork ");', 'expect(app.texts().some(text => text.includes("action:none"))).toBe(true);',
  'await app.press("id:fork");', 'await app.waitFor("id:command-fork");', 'await app.submit("id:local-input");',
  'expect(app.value("id:local-input")).toBe("");', 'expect(app.texts().some(text => text.includes("action:fork:"))).toBe(true);',
  'await app.press("id:undo");', 'await app.waitFor("id:command-undo");', 'await app.press("id:command-undo");',
  'expect(app.value("id:local-input")).toBe("/undo ");', 'await app.press("id:send");',
  'expect(app.texts().some(text => text.includes("blocked:unbound"))).toBe(true);',
  'await app.press("id:tail");', 'await app.waitFor("id:command-fork");', 'await app.press("id:command-fork");',
  'expect(app.value("id:local-input")).toBe("/fo\\nKEEP");', 'expect(app.texts()).toContain("conflict:selection");',
  'await app.press("id:tail-submit");', 'await app.press("id:send");', 'expect(app.value("id:local-input")).toBe("/fork KEEP");',
  'expect(app.texts()).toContain("conflict:submit");',
  'expect(app.texts().some(text => text.includes("files:1 refs:false"))).toBe(true);',
]), 100_000);
test('headless production adapter: IME, references and stale completion', () => run([
  'await app.press("id:fork");', 'await app.waitFor("id:command-fork");', 'await app.press("id:ime");',
  'expect(app.shows("id:command-suggestions")).toBe(false);', 'await app.keyboard.press("enter");', 'expect(app.texts().some(text => text.includes("action:none"))).toBe(true);',
  'await app.press("id:ime-end");', 'await app.press("id:fork");', 'await app.press("id:references");',
  'await app.press("id:command-fork");', 'expect(app.texts()).toContain("conflict:selection");',
  'expect(app.value("id:local-input")).toBe("/fo");', 'await app.press("id:references");',
  'await app.press("id:defer");', 'await app.press("id:fork");', 'await app.press("id:command-fork");',
  'await app.press("id:ordinary");', 'await app.press("id:host");', 'await app.press("id:finish");',
  'expect(app.value("id:local-input")).toBe("ordinary");', 'expect(app.texts().some(text => text.includes("outcomes:0"))).toBe(true);',
]), 100_000);
test('headless actual target/pending/unknown gates block without Host fallback or receipt replay', () => run([
  'await app.press("id:pending");', 'await app.press("id:fork");', 'await app.press("id:command-fork");',
  'expect(app.value("id:local-input")).toBe("/fork ");', 'expect(app.texts().some(text => text.includes("blocked:pending"))).toBe(true);',
  'await app.press("id:pending");', 'await app.press("id:assistant");', 'await app.press("id:full-fork");', 'await app.press("id:send");',
  'expect(app.texts().some(text => text.includes("blocked:assistant-target"))).toBe(true);',
  'await app.press("id:assistant");', 'await app.press("id:unknown");', 'await app.press("id:fork");', 'await app.press("id:command-fork");',
  'expect(app.value("id:local-input")).toBe("");', 'await app.press("id:fork");', 'await app.press("id:command-fork");',
  'expect(app.value("id:local-input")).toBe("/fork ");', 'expect(app.texts().some(text => text.includes("blocked:unknown outcomes:1"))).toBe(true);',
]), 100_000);
test('headless closed/open/closed 300-command path: 50 input events do zero catalog work', () => run([
  'await app.type("id:local-input", "ordinary");', 'for (let i=0;i<50;i++) await app.type("id:local-input", "x");',
  'expect(app.texts()).toContain("calls:0 scans:0 loads:0");',
  'await app.press("id:model");', 'await app.waitFor("id:command-model");', 'await app.press("id:command-model");',
  'await app.press("id:ordinary");', 'const before = app.texts().find(text => text.includes("calls:"));',
  'for (let i=0;i<50;i++) await app.type("id:local-input", "x");', 'expect(app.texts()).toContain(before);',
  'expect(app.shows("id:command-suggestions")).toBe(false);',
]), 100_000);

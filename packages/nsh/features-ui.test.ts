import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
let temporary: string | undefined;
let dateHost = process.env.FEATURES_DATE_HOST;
beforeAll(() => {
  if (dateHost) return;
  temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-features-date-'));
  const executable = path.join(temporary, 'capture');
  const compiled = spawnSync('xcrun', ['swiftc', 'ios/ScheduleDateBridge.swift', 'tests/features-date-capture.swift', '-o', executable], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
  expect(compiled.error, compiled.stdout + compiled.stderr).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const captured = spawnSync(executable, [], { encoding: 'utf8', timeout: 10_000 });
  expect(captured.error, captured.stdout + captured.stderr).toBeUndefined();
  expect(captured.status, captured.stdout + captured.stderr).toBe(0);
  const capture = path.join(temporary, 'foundation.json');
  writeFileSync(capture, captured.stdout);
  dateHost = path.join(temporary, 'host.js');
  const generated = spawnSync(process.execPath, ['tests/features-date-host.mjs', capture, dateHost], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
  expect(generated.error, generated.stdout + generated.stderr).toBeUndefined();
  expect(generated.status, generated.stdout + generated.stderr).toBe(0);
}, 90_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
// Authored for main's serial engine window; the features worker must not run it.
it('native editor Back/Cancel guard keeps drafts and only explicit discard leaves', () => {
  const steps = [
    'await app.press("id:features-open-bot");',
    'await app.waitFor("id:features-bot-name");',
    ...(process.env.FEATURES_HOST_TRACE === '1' ? ['console.log("[features-host-probe]", JSON.stringify(app.host.calls()));'] : []),
    'await app.waitUntil(() => app.enabled("id:features-model-picker")); await app.press("id:features-model-picker");',
    'await app.waitFor("text:Managed directory verified");',
    'await app.press("id:features-model-close");',
    'await app.waitUntil(() => !app.shows("id:features-model-sheet"));',
    'await app.waitUntil(() => app.enabled("id:features-bot-save"));',
    'console.log("[features-phase] bot picker dismissed; editor dirty Back/Cancel next");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected features|must not write|ReferenceError|TypeError/);',
    'await app.type("id:features-bot-name", "Unsaved Bot");',
    'const botDraft = app.value("id:features-bot-name");',
    'expect(botDraft).toContain("Unsaved Bot");',
    'const botBackDialogs = app.dialogs().length;',
    'app.onDialog(() => "Cancel");',
    'await app.back();',
    'expect(app.shows("id:features-bot-name")).toBe(true);',
    'expect(app.value("id:features-bot-name")).toBe(botDraft);',
    'expect(app.dialogs().length).toBe(botBackDialogs + 1);',
    'app.onDialog(() => "Discard");',
    'await app.press("id:features-bot-cancel");',
    'await app.waitFor("id:features-open-task");',
    'await app.press("id:features-open-task");',
    'await app.waitFor("id:features-goal");',
    'await app.waitUntil(() => app.enabled("id:features-model-picker")); await app.press("id:features-model-picker");',
    'await app.waitFor("text:Task directory verified");',
    'await app.press("id:features-model-close");',
    'await app.waitUntil(() => !app.shows("id:features-model-sheet"));',
    'await app.waitUntil(() => app.enabled("id:features-task-save"));',
    'console.log("[features-phase] task picker dismissed; editor dirty Cancel/Back next");',
    'await app.waitFor("id:features-cron-next-runs");',
    'expect(app.count("id:features-cron-next-run")).toBe(4);',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected features|must not write|ReferenceError|TypeError/);',
    'expect(app.texts().join("\\n")).not.toContain("Invalid cron expression");',
    'await app.type("id:features-task-name", "Unsaved Task");',
    'const taskDraft = app.value("id:features-task-name");',
    'expect(taskDraft).toContain("Unsaved Task");',
    'const taskCancelDialogs = app.dialogs().length;',
    'app.onDialog(() => "Cancel");',
    'await app.press("id:features-task-cancel");',
    'expect(app.shows("id:features-task-name")).toBe(true);',
    'expect(app.value("id:features-task-name")).toBe(taskDraft);',
    'expect(app.dialogs().length).toBe(taskCancelDialogs + 1);',
    'app.onDialog(() => "Discard");',
    'await app.back();',
    'await app.waitFor("id:features-open-task");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected features|must not write|ReferenceError|TypeError/);',
  ].join('\n');
  if (!dateHost) throw new Error('A real Foundation date Host is required');
  const engineDirectory = mkdtempSync(path.join(directory, 'tests', '.features-read-engine-'));
  try {
    const engineTest = path.join(engineDirectory, 'features-engine.test.tsx');
    writeFileSync(engineTest, [
      'import { expect, open, test } from "nsh/test";',
      'test("read-only editor guards on the headless non-iOS surface", async () => {',
      `const app = await open(${JSON.stringify(path.join(directory, 'features-ui-test-app.tsx'))}, { platform: 'macos', storage: {}, network: {} });`,
      'try {', steps, '} finally { app.dispose(); }', '});',
    ].join('\n'));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', engineTest, '--web-host', dateHost], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(engineDirectory, { recursive: true, force: true }); }
}, 75_000);

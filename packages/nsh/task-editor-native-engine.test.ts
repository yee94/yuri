import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const engine = test.skipIf(process.env.NSH_TASK_EDITOR_ENGINE !== '1');
function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'task-editor-native.fixture.tsx', '--web-host', 'task-editor-native.fixture-host.js'], { cwd: directory, encoding: 'utf8', timeout: 60000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}
engine('captured four-tuple, plain command acceptance, failed save and exact retry', () => run([
  'await app.press("id:task-fixture-open");',
  'await app.waitFor("text:Actual model");',
  'await app.type("id:features-task-name", "Fixture task");',
  'await app.type("id:features-task-prompt", "/che");',
  'await app.waitFor("id:task-editor-choice-command-check");',
  'await app.press("id:task-editor-choice-command-check");',
  'expect(app.value("id:features-task-prompt")).toBe("/check ");',
  'await app.press("id:features-task-save");',
  'await app.waitFor("text:HTTP 409: Fixture task save failed; draft retained");',
  'expect(app.value("id:features-task-prompt")).toBe("/check ");',
  'await app.press("id:features-task-save");',
  'await app.waitFor("id:task-fixture-finished");',
]), 75000);
engine('Agent/Skill suggestions insert ordinary Web-boundary text and Cancel retains dirty prompt', () => run([
  'await app.press("id:task-fixture-open");',
  'await app.waitFor("id:features-task-prompt");',
  'await app.type("id:features-task-prompt", "@gen");',
  'await app.waitFor("id:task-editor-choice-agent-general");',
  'await app.waitFor("id:task-editor-choice-skill-generate");',
  'await app.press("id:task-editor-choice-skill-generate");',
  'expect(app.value("id:features-task-prompt")).toContain("@generate");',
  'const draft = app.value("id:features-task-prompt");',
  'app.onDialog(() => "Cancel");',
  'await app.press("id:features-task-cancel");',
  'expect(app.value("id:features-task-prompt")).toBe(draft);',
  'app.onDialog(() => "Discard");',
  'await app.press("id:features-task-cancel");',
  'await app.waitFor("id:task-fixture-open");',
]), 75000);
engine('project change scopes file autocomplete and preserves relative file insertion', () => run([
  'await app.press("id:task-fixture-open");',
  'await app.waitFor("text:Actual project");',
  'await app.press("text:Actual project");',
  'await app.press("text:Other project");',
  'await app.type("id:features-task-prompt", "@src/main");',
  'await app.waitFor("id:task-editor-choice-file-/other/src/main.ts");',
  'await app.press("id:task-editor-choice-file-/other/src/main.ts");',
  'expect(app.value("id:features-task-prompt")).toBe(" @src/main.ts ");',
]), 75000);

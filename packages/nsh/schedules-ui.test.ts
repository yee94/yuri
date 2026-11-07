import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { dict as english } from '../ui/src/lib/i18n/messages/en';

const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = process.env.NSH_BIN || 'nsh';
test('native scheduled tasks support filters, menus, paging, detail and session navigation', () => {
  const steps = [
    'await app.waitFor("text:Native daily schedule");',
    'expect(app.spanStyle("text:Schedule").fontSize).toBe(32);',
    'const beforeSearch = app.host.calls().length;',
    'await app.type("id:scheduled-search", "does-not-match");',
    'expect(app.value("id:scheduled-search")).toBe("does-not-match");',
    `await app.waitFor(${JSON.stringify('text:' + english['sessions.scheduledTasks.workspace.search.noResults'])});`,
    'expect(app.shows("text:Native daily schedule")).toBe(false);',
    'expect(app.host.calls().length).toBe(beforeSearch);',
    'await app.clear("id:scheduled-search");',
    'expect(app.value("id:scheduled-search")).toBe("");',
    'await app.waitFor("text:Native daily schedule");',
    'expect(app.shows("text:Native paused schedule")).toBe(true);',
    `expect(app.shows(${JSON.stringify('text:' + english['sessions.scheduledTasks.workspace.search.noResults'])})).toBe(false);`,
    'expect(app.host.calls().length).toBe(beforeSearch);',
    'await app.press("id:scheduled-filter-paused");',
    'expect(app.shows("text:Native daily schedule")).toBe(false);',
    'expect(app.shows("text:Native paused schedule")).toBe(true);',
    'await app.press("id:scheduled-filter-active");',
    'expect(app.shows("text:Native daily schedule")).toBe(true);',
    'expect(app.shows("text:Native paused schedule")).toBe(false);',
    'await app.press("id:scheduled-filter-all");',
    'app.onDialog(dialog => dialog.buttons.includes("Pause") ? "Pause" : null);',
    'await app.press("label:More actions for Native daily schedule");',
    'await app.waitFor("text:Schedule saved");',
    'app.onDialog(dialog => dialog.buttons.includes("Resume") ? "Resume" : null);',
    'await app.press("label:More actions for Native daily schedule");',
    'await app.press("id:scheduled-history-tab");',
    'await app.waitFor("text:Native history newest");',
    'await app.waitFor("id:scheduled-history-more");',
    'await app.press("id:scheduled-history-more");',
    'await app.waitFor("text:Native history older");',
    'await app.press("text:Open session >> nth=0");',
    'await app.waitFor("text:session-newest");',
    'expect(app.texts()).toContain("/workspace/recorded-worktree");',
    'await app.back();',
    'await app.press("id:scheduled-tasks-tab");',
    'await app.press("text:Native daily schedule");',
    'await app.waitFor("text:Inspect native scheduled task history");',
    'await app.press("text:Run now");',
    'await app.waitFor("text:newly-started");',
    'expect(app.texts()).toContain("/workspace/project");',
    'await app.back();',
    'await app.back();',
    'app.onDialog(dialog => dialog.buttons.includes("Delete") ? "Delete" : null);',
    'await app.press("label:More actions for Native daily schedule");',
    'await app.waitFor("text:Native daily schedule", {state:"gone"});',
    'expect(app.dialogs().length).toBeGreaterThanOrEqual(4);',
    'await app.press("id:scheduled-create");',
    'await app.waitFor("id:editor-done");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected request|Invalid native response/);',
  ].join('\n');
  const result = spawnSync(cli, ['test', 'schedules-test-app.tsx', '--web-host', 'tests/schedules-host.js'], { cwd: directory, input: steps, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

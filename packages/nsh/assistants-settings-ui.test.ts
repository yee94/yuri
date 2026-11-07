import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { dict as english } from '../ui/src/lib/i18n/messages/en';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('native Bot settings collection routes to configuration, transfers channel fields and confirms destructive wipe', () => {
  const steps = [
    'await app.waitFor("text:HTTP 503: fixture_catalog_offline");',
    `await app.waitFor(${JSON.stringify('text:' + english['assistants.actions.retry'])});`,
    'await app.press("id:assistant-settings-retry");',
    'await app.waitFor("id:assistant-settings-edit-bot/a");',
    'await app.press("id:assistant-settings-edit-bot/a");',
    'await app.waitFor("text:Message channels");',
    'expect(app.shows("id:opened-contact")).toBe(false);',
    'await app.press("text:Linked native schedule");',
    'await app.waitFor("text:Fixture linked schedule prompt");',
    'expect(app.texts()).toContain("/workspace/project");',
    'await app.back();',
    'await app.press("id:assistant-channel-feishu");',
    'await app.waitFor("id:assistant-channel-refresh");',
    'await app.press("id:assistant-channel-refresh");',
    'await app.waitFor("text:Currently linked to Previous bot");',
    'app.onDialog(() => "Confirm move");',
    'await app.press("text:Move connection to this bot");',
    'await app.waitFor("text:Connected");',
    'expect(app.value("id:assistant-channel-client")).toBe("imported-client");',
    'expect(app.value("id:assistant-channel-owner")).toBe("imported-owner");',
    'expect(app.value("id:assistant-channel-secret")).toBe("");',
    'await app.press("id:assistant-channel-save");',
    'await app.waitFor("id:assistant-channel-client", {state:"gone"});',
    'app.onDialog(() => "Cancel");',
    'const beforeCancel = app.host.calls().length;',
    'await app.press("id:assistant-clear-history");',
    'expect(app.host.calls().length).toBe(beforeCancel);',
    'app.onDialog(() => "Clear chat history");',
    'await app.press("id:assistant-clear-history");',
    'await app.waitFor("text:HTTP 500: fixture_clear_failed");',
    'expect(app.shows("id:assistant-clear-history")).toBe(true);',
    'await app.press("id:assistant-clear-history");',
    'await app.waitFor("text:Chat history cleared");',
    'expect(app.texts().join("\\n")).not.toContain("Unexpected assistant fixture request");',
    'await app.back();',
    'await app.waitFor("id:assistant-settings-catalog");',
    'await app.press("id:assistant-settings-create");',
    'await app.waitFor("text:Generate a random avatar");',
  ].join('\n');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'assistants-settings-test-app.tsx', '--web-host', 'tests/assistants-settings-host.js'], { cwd: directory, input: steps, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

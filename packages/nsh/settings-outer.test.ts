import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function nativeTest(steps: string[], platform: 'ios' | 'macos' = 'ios') {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'settings-outer-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Outer Settings fixture', id: 'example.yuri.settings-outer', version: '0.1.0', build: 1, theme: path.join(directory, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'notification.status', 'notification.openSettings', 'notification.configure'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(directory, 'settings-outer-test-app.tsx'))};`);
    writeFileSync(path.join(temporary, 'Outer.test.tsx'), `import { expect, open, test } from 'nsh/test';\ntest('outer Settings regression (${platform} headless)', async () => { const app = await open('./App.tsx', { platform: ${JSON.stringify(platform)} });\n${steps.join('\n')}\n});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Outer.test.tsx', '--web-host', path.join(directory, 'tests/settings-outer-host.js')], { cwd: temporary, encoding: 'utf8', timeout: 35_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('project settings has a real list/editor, retains a failed draft and round-trips only its metadata', () => {
  nativeTest([
    'await app.waitFor("text:Projects");',
    'await app.press("text:Projects");',
    'await app.waitFor("text:Native workspace");',
    'await app.press("text:Native workspace");',
    'await app.waitFor("id:settings-project-label");',
    'await app.type("id:settings-project-label", "Edited project");',
    'const draft = app.value("id:settings-project-label");',
    'await app.press("id:settings-project-save");',
    'await app.waitFor("text:HTTP 409: Fixture project conflict");',
    'expect(app.value("id:settings-project-label")).toBe(draft);',
    'await app.press("id:settings-project-save");',
    'await app.waitFor("id:settings-project-done");',
    'await app.press("id:settings-project-done");',
    'await app.waitFor("text:" + draft);',
    'await app.press("text:" + draft);',
    'await app.waitFor("id:settings-project-label");',
    'expect(app.value("id:settings-project-label")).toBe(draft);',
  ]);
}, 45_000);

test('behavior retries only the failed settings write after its document already committed', () => {
  nativeTest([
    'await app.waitFor("text:Behavior");',
    'await app.press("text:Behavior");',
    'await app.waitFor("id:settings-behavior-prompt");',
    'await app.type("id:settings-behavior-prompt", "Native fixture rules");',
    'const draft = app.value("id:settings-behavior-prompt");',
    'await app.press("id:settings-basics-save");',
    'await app.waitFor("text:HTTP 409: Fixture behavior conflict");',
    'expect(app.value("id:settings-behavior-prompt")).toBe(draft);',
    'await app.press("id:settings-basics-save");',
    'await app.waitFor("text:Behavior saved successfully");',
    'await app.back();',
    'await app.press("text:Behavior");',
    'await app.waitFor("id:settings-behavior-prompt");',
    'expect(app.value("id:settings-behavior-prompt")).toBe(draft.endsWith("\\n") ? draft : draft + "\\n");',
  ]);
}, 45_000);

test('built-in skills and supporting files remain readable without exposing writable controls', () => {
  nativeTest([
    'await app.waitFor("text:Skills");',
    'await app.press("text:Skills");',
    'await app.waitFor("text:builtin-fixture");',
    'await app.press("text:builtin-fixture");',
    'await app.waitFor("text:Read only fixture instructions");',
    'expect(app.texts().includes("Save")).toBe(false);',
    'expect(app.texts().includes("Delete")).toBe(false);',
    'await app.press("text:reference.md");',
    'await app.waitFor("text:Read only supporting file");',
    'expect(app.texts().includes("Save")).toBe(false);',
    'expect(app.texts().includes("Delete")).toBe(false);',
    'await app.back();',
    'await app.waitFor("text:Read only fixture instructions");',
  ]);
}, 45_000);

test('native notification permission and explicit saves preserve Web focus and template settings', () => {
  nativeTest([
    'await app.waitFor("text:Notifications");',
    'await app.press("text:Notifications");',
    'await app.waitFor("text:Denied — enable notifications in iOS Settings.");',
    'await app.waitUntil(() => app.enabled("id:notification-enable"));',
    'expect(app.shows("id:settings-notifications-focused")).toBe(false);',
    'await app.waitFor("id:notification-native-policy");',
    'await app.press("id:notification-enable");',
    'await app.waitUntil(() => app.enabled("id:settings-notifications-save"));',
    'await app.press("id:settings-notifications-save");',
    'await app.waitFor("text:Saved");',
    'await app.back();',
    'await app.press("id:settings-outer-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\\"writes\\\":1")));',
    `const off = JSON.parse(app.texts().find(text => text.startsWith(${JSON.stringify('{"enabled":')})));`,
    'expect(off).toEqual({enabled:false,notificationMode:"hidden-only",template:"Preserved Web template",writes:1,configurations:2,authorization:"denied"});',
    'await app.press("text:Notifications");',
    'await app.waitFor("text:Denied — enable notifications in iOS Settings.");',
    'await app.press("id:notification-enable");',
    'await app.waitFor("id:notification-error");',
    'expect(app.enabled("id:settings-notifications-save")).toBe(false);',
    'await app.press("id:notification-settings");',
    'await app.back();',
    'await app.press("text:Notifications");',
    'await app.waitFor("text:Allowed");',
    'await app.press("id:notification-enable");',
    'await app.waitUntil(() => app.enabled("id:settings-notifications-save"));',
    'await app.press("id:settings-notifications-save");',
    'await app.waitFor("text:Saved");',
    'await app.back();',
    'await app.press("id:settings-outer-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\\"writes\\\":2")));',
    `const on = JSON.parse(app.texts().find(text => text.startsWith(${JSON.stringify('{"enabled":')})));`,
    'expect(on).toEqual({enabled:true,notificationMode:"hidden-only",template:"Preserved Web template",writes:2,configurations:3,authorization:"authorized"});',
  ]);
}, 45_000);

test('desktop focused notifications round-trip only their mode and configure the existing native consumer after save', () => {
  nativeTest([
    'await app.waitFor("text:Notifications"); await app.press("text:Notifications"); await app.waitUntil(() => app.enabled("id:settings-notifications-focused"));',
    'expect(app.shows("id:notification-native-policy")).toBe(false); await app.press("id:settings-notifications-focused"); await app.waitUntil(() => app.enabled("id:settings-notifications-save"));',
    'await app.press("id:settings-notifications-save"); await app.waitFor("text:Saved"); await app.back(); await app.press("id:settings-outer-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\\"notificationMode\\\":\\\"always\\\"")));',
    `const audit = JSON.parse(app.texts().find(text => text.startsWith(${JSON.stringify('{"enabled":')})));`,
    'expect(audit).toEqual({enabled:true,notificationMode:"always",template:"Preserved Web template",writes:1,configurations:2,authorization:"denied"});',
    'await app.press("text:Notifications"); await app.waitUntil(() => app.enabled("id:settings-notifications-focused")); expect(app.enabled("id:settings-notifications-save")).toBe(false);',
    'await app.press("id:settings-notifications-focused"); await app.press("id:settings-notifications-save"); await app.waitFor("text:Saved");',
  ], 'macos');
}, 45_000);

test('back from the native model editor dismisses only its Sheet and discards the unsaved edit', () => {
  nativeTest([
    'await app.waitFor("text:Providers");',
    'await app.press("text:Providers");',
    'await app.waitFor("text:Fixture provider");',
    'await app.press("text:Fixture provider");',
    'await app.waitFor("text:Fixture model");',
    'await app.press("text:Fixture model");',
    'await app.waitFor("id:settings-model-name");',
    'await app.type("id:settings-model-name", "Discard this edit");',
    'await app.back();',
    'await app.waitFor("id:settings-provider-toggle-model");',
    'await app.press("text:Fixture model");',
    'await app.waitFor("id:settings-model-name");',
    'expect(app.value("id:settings-model-name")).toBe("Fixture model");',
  ]);
}, 45_000);

test('Provider model add/remove keeps its row on failure and round-trips the shared picker preference', () => {
  nativeTest([
    'await app.waitFor("text:Providers");',
    'await app.press("text:Providers");',
    'await app.waitFor("text:Fixture provider");',
    'await app.press("text:Fixture provider");',
    'await app.waitFor("id:settings-provider-toggle-model");',
    'expect(app.texts().includes("−")).toBe(true);',
    'await app.press("id:settings-provider-toggle-model");',
    'await app.waitFor("text:HTTP 409: Fixture visibility conflict");',
    'expect(app.texts().includes("−")).toBe(true);',
    'await app.press("id:settings-provider-toggle-model");',
    'await app.waitFor("text:Removed model");',
    'expect(app.texts().includes("+")).toBe(true);',
    'await app.back();',
    'await app.press("text:Fixture provider");',
    'await app.waitFor("id:settings-provider-toggle-model");',
    'expect(app.texts().includes("+")).toBe(true);',
    'await app.press("id:settings-provider-toggle-model");',
    'await app.waitFor("text:Models · 1 added");',
    'expect(app.texts().includes("−")).toBe(true);',
  ]);
}, 45_000);

test('model Sheet shows a rejected save in place, preserves the draft and refreshes its catalog after retry', () => {
  nativeTest([
    'await app.waitFor("text:Providers");',
    'await app.press("text:Providers");',
    'await app.waitFor("text:Fixture provider");',
    'await app.press("text:Fixture provider");',
    'await app.waitFor("text:Fixture model");',
    'await app.press("text:Fixture model");',
    'await app.waitFor("id:settings-model-name");',
    'await app.type("id:settings-model-name", "Native model edit");',
    'const draft = app.value("id:settings-model-name");',
    'await app.press("text:Save");',
    'await app.waitFor("text:HTTP 409: Fixture model conflict");',
    'expect(app.value("id:settings-model-name")).toBe(draft);',
    'await app.press("text:Save");',
    'await app.waitFor("id:settings-provider-toggle-model");',
    'await app.waitFor("text:" + draft);',
    'await app.press("text:" + draft);',
    'await app.waitFor("id:settings-model-name");',
    'expect(app.value("id:settings-model-name")).toBe(draft);',
  ]);
}, 45_000);

test('macOS headless Summary AI model edits enable provider mode without rewriting its unrelated prompt', () => {
  nativeTest([
    'await app.waitFor("text:Summary AI");',
    'await app.press("text:Summary AI");',
    'await app.waitFor("id:settings-defaults-model");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-model"));',
    'await app.press("id:settings-defaults-model");',
    'await app.waitFor("text:Fixture provider / Fixture model");',
    'await app.waitUntil(() => app.enabled("text:Fixture provider / Fixture model"));',
    'await app.press("text:Fixture provider / Fixture model");',
    'await app.waitFor("text:Saved");',
    'await app.back();',
    'await app.press("text:Summary AI");',
    'await app.waitFor("id:settings-defaults-model");',
    'await app.waitFor("text:Fixture provider / Fixture model");',
    'expect(app.value("id:settings-basics-summaryCommitPrompt")).toBe("Preserved prompt");',
  ], 'macos');
}, 45_000);

test('Appearance keeps a rejected font draft, retries once and reopens its confirmed Host value', () => {
  nativeTest([
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-fontSize");',
    'await app.clear("id:settings-basics-fontSize");',
    'await app.type("id:settings-basics-fontSize", "125");',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("text:HTTP 409: Fixture preference conflict");',
    'expect(app.value("id:settings-basics-fontSize")).toBe("125");',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("text:Saved");',
    'await app.back();',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-fontSize");',
    'expect(app.value("id:settings-basics-fontSize")).toBe("125");',
  ]);
}, 45_000);

test('Settings field search carries a stable target into the real Chat preference page', () => {
  nativeTest([
    'await app.waitFor("id:settings-search");',
    'await app.type("id:settings-search", "messageStreamTransport");',
    'await app.waitFor("id:settings-search-chat.message-transport");',
    'await app.press("id:settings-search-chat.message-transport");',
    'await app.waitFor("id:settings-target-chat.message-transport");',
    'await app.waitFor("text:Message Stream Transport");',
  ]);
}, 45_000);

test('macOS headless Sessions defaults select real models, variants and visible subagents without free-form IDs', () => {
  nativeTest([
    'await app.waitFor("text:Sessions");',
    'await app.press("text:Sessions");',
    'await app.waitFor("id:settings-defaults-model");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-model"));',
    'await app.press("id:settings-defaults-model");',
    'await app.waitFor("text:Fixture provider / Fixture model");',
    'await app.waitUntil(() => app.enabled("text:Fixture provider / Fixture model"));',
    'await app.press("text:Fixture provider / Fixture model");',
    'await app.waitFor("text:Saved");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-variant"));',
    'await app.press("id:settings-defaults-variant");',
    'await app.waitFor("text:high");',
    'await app.waitUntil(() => app.enabled("text:high"));',
    'await app.press("text:high");',
    'await app.waitFor("text:Saved");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-agent"));',
    'await app.press("id:settings-defaults-agent");',
    'await app.waitFor("text:visible-subagent");',
    'await app.waitUntil(() => app.enabled("text:visible-subagent"));',
    'expect(app.texts().includes("hidden-agent")).toBe(false);',
    'await app.press("text:visible-subagent");',
    'await app.waitFor("text:Saved");',
  ], 'macos');
}, 45_000);

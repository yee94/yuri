import { runSettingsEngineFixture } from './tests/settings-engine-fixture-runner.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function nativeTest(steps: string[]) {
  const result = runSettingsEngineFixture(directory, 'settings-outer-test-app.tsx', 'tests/settings-outer-host.js', steps, 35_000, ['notification.status', 'notification.openSettings', 'notification.configure']);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
const providerAudit = (visibilityAttempts: number, modelAttempts: number) => [
  'await app.press("id:settings-provider-fixture-audit");',
  `await app.waitUntil(() => app.texts().some(text => text.startsWith(${JSON.stringify(`{"visibilityAttempts":${visibilityAttempts},"modelAttempts":${modelAttempts},`)})));`,
];
const providerSnapshot = 'JSON.parse(app.texts().find(text => text.startsWith("{\\"visibilityAttempts\\":")))';

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
    'await app.waitUntil(() => app.enabled("id:settings-provider-toggle-model"));',
    'expect(app.texts().includes("−")).toBe(true);',
    'await app.press("id:settings-provider-fixture-preflight");',
    'await app.waitFor("text:Visibility preflight armed");',
    'await app.press("id:settings-provider-toggle-model");',
    'await app.waitFor("text:HTTP 500: Failed to read settings");',
    'expect(app.texts().includes("−")).toBe(true);',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.hiddenModels).toEqual([{providerID:"unrelated",modelID:"preserved"}]);`,
    'await app.press("id:settings-provider-toggle-model");',
    'await app.waitFor("text:Removed model");',
    'expect(app.texts().includes("+")).toBe(true);',
    ...providerAudit(1, 0),
    `expect(${providerSnapshot}.hiddenModels).toEqual([{providerID:"unrelated",modelID:"preserved"},{providerID:"fixture",modelID:"model"}]);`,
    'await app.back();',
    'await app.press("text:Fixture provider");',
    'await app.waitFor("id:settings-provider-toggle-model");',
    'expect(app.texts().includes("+")).toBe(true);',
    'await app.press("id:settings-provider-toggle-model");',
    'await app.waitFor("text:Models · 1 added");',
    'expect(app.texts().includes("−")).toBe(true);',
    ...providerAudit(2, 0),
    `expect(${providerSnapshot}.hiddenModels).toEqual([{providerID:"unrelated",modelID:"preserved"}]);`,
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
    'await app.press("id:settings-provider-model-save");',
    'await app.waitFor("text:Enter a valid model ID and positive whole-number token limits. Output cannot exceed context.");',
    'expect(app.value("id:settings-model-name")).toBe(draft);',
    'expect(app.shows("text:Edit model")).toBe(true);',
    'expect(app.shows("id:settings-provider-model-id")).toBe(true);',
    'expect(app.value("id:settings-provider-model-id")).toBe("model");',
    'expect(app.shows("id:settings-model-name")).toBe(true);',
    'expect(app.shows("id:settings-provider-model-save")).toBe(true);',
    'await app.waitUntil(() => app.enabled("id:settings-model-name"));',
    ...providerAudit(0, 1),
    `expect(${providerSnapshot}.model.name).toBe("Fixture model");`,
    'await app.press("id:settings-provider-model-save");',
    'await app.waitFor("id:settings-provider-toggle-model");',
    'expect(app.shows("id:settings-model-name")).toBe(false);',
    'await app.waitFor("text:" + draft);',
    ...providerAudit(0, 2),
    `expect(${providerSnapshot}.model.name).toBe(draft.trim());`,
    'await app.press("text:" + draft);',
    'await app.waitFor("id:settings-model-name");',
    'expect(app.value("id:settings-model-name")).toBe(draft);',
  ]);
}, 45_000);

test('Summary AI model edits enable provider mode without rewriting its unrelated prompt', () => {
  nativeTest([
    'await app.waitFor("text:Summary AI");',
    'await app.press("text:Summary AI");',
    'await app.waitFor("id:settings-defaults-model");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-model"));',
    'await app.press("id:settings-defaults-model");',
    'await app.waitFor("text:Fixture provider / Fixture model");',
    'await app.press("text:Fixture provider / Fixture model");',
    'await app.waitFor("text:Saved");',
    'await app.back();',
    'await app.press("text:Summary AI");',
    'await app.waitFor("id:settings-defaults-model");',
    'await app.waitFor("text:Fixture provider / Fixture model");',
    'expect(app.value("id:settings-basics-summaryCommitPrompt")).toBe("Preserved prompt");',
  ]);
}, 45_000);

test('Appearance keeps an unconfirmed font draft across explicit GET retry and reopen without replay or treating equal GET as ACK', () => {
  nativeTest([
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-fontSize");',
    'await app.clear("id:settings-basics-fontSize");',
    'await app.type("id:settings-basics-fontSize", "125");',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("id:settings-preferences-unknown");',
    'expect(app.value("id:settings-basics-fontSize")).toBe("125");',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
    `expect(${providerSnapshot}.fontSize).toBe(125);`,
    `const beforeRetry = ${providerSnapshot}.preferenceReads;`,
    'await app.press("text:Retry");',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceReads).toBeGreaterThan(beforeRetry);`,
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
    'expect(app.shows("id:settings-preferences-unknown")).toBe(true);',
    'expect(app.texts().includes("Saved")).toBe(false);',
    'await app.press("id:settings-preferences-save");',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
    'expect(app.shows("id:settings-preferences-unknown")).toBe(true);',
    'await app.back();',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-preferences-unknown");',
    'expect(app.value("id:settings-basics-fontSize")).toBe("125");',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
    'expect(app.texts().includes("Saved")).toBe(false);',
  ]);
}, 45_000);

test('Appearance confirms an acknowledged font write after explicit GET retry and reopens the confirmed Host value without replay', () => {
  nativeTest([
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-fontSize");',
    ...providerAudit(0, 0),
    `const beforeSave = ${providerSnapshot}.preferenceReads;`,
    'await app.clear("id:settings-basics-fontSize");',
    'await app.type("id:settings-basics-fontSize", "150");',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("text:HTTP 500: Fixture preference confirmation unavailable");',
    'expect(app.value("id:settings-basics-fontSize")).toBe("150");',
    'expect(app.shows("id:settings-preferences-unknown")).toBe(false);',
    'expect(app.texts().includes("Saved")).toBe(false);',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
    `expect(${providerSnapshot}.preferenceConfirmationReads).toBe(0);`,
    'await app.press("text:Retry");',
    'await app.waitFor("text:Saved");',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
    `expect(${providerSnapshot}.preferenceReads).toBeGreaterThan(beforeSave);`,
    `expect(${providerSnapshot}.preferenceConfirmationReads).toBeGreaterThan(0);`,
    `expect(${providerSnapshot}.fontSize).toBe(150);`,
    'expect(app.shows("id:settings-preferences-unknown")).toBe(false);',
    'await app.back();',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-fontSize");',
    'expect(app.value("id:settings-basics-fontSize")).toBe("150");',
    ...providerAudit(0, 0),
    `expect(${providerSnapshot}.preferenceAttempts).toBe(1);`,
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

test('Sessions defaults select real models, variants and visible subagents without free-form IDs', () => {
  nativeTest([
    'await app.waitFor("text:Sessions");',
    'await app.press("text:Sessions");',
    'await app.waitFor("id:settings-defaults-model");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-model"));',
    'await app.press("id:settings-defaults-model");',
    'await app.waitFor("text:Fixture provider / Fixture model");',
    'await app.press("text:Fixture provider / Fixture model");',
    'await app.waitFor("text:Saved");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-variant"));',
    'await app.press("id:settings-defaults-variant");',
    'await app.waitFor("text:high");',
    'await app.press("text:high");',
    'await app.waitFor("text:Saved");',
    'await app.waitUntil(() => app.enabled("id:settings-defaults-agent"));',
    'await app.press("id:settings-defaults-agent");',
    'await app.waitFor("text:visible-subagent");',
    'expect(app.texts().includes("hidden-agent")).toBe(false);',
    'await app.press("text:visible-subagent");',
    'await app.waitFor("text:Saved");',
  ]);
}, 45_000);

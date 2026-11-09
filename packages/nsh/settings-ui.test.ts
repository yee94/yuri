import { runSettingsEngineFixture } from './tests/settings-engine-fixture-runner.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { nativeMagicDefaults } from './settings-magic-defaults';
import { magicPromptGroups } from './settings-magic-state';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('native Appearance editor font size persists locally without overwriting code size or writing Host settings', () => {
  const steps = [
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-editorFontSize");',
    'expect(app.value("id:settings-basics-editorFontSize")).toBe("13");',
    'await app.clear("id:settings-basics-editorFontSize");',
    'await app.type("id:settings-basics-editorFontSize", "24");',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("text:Saved");',
    'expect(app.value("id:settings-basics-codeFontSize")).toBe("100");',
    'await app.back();',
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-editorFontSize");',
    'expect(app.value("id:settings-basics-editorFontSize")).toBe("24");',
    'expect(app.value("id:settings-basics-codeFontSize")).toBe("100");',
    'await app.press("id:settings-preferences-audit");',
    'await app.waitFor(\'text:{"writes":0,"preferences":{"chatRenderMode":"sorted","messageStreamTransport":"sse","diffLayoutPreference":"inline"}}\');',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected preferences patch|Unexpected settings request: PUT/);',
  ].join('\n');
  const result = runSettingsEngineFixture(directory, 'settings-test-app.tsx', 'tests/settings-host.js', [steps], 45_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
test('native Appearance code font size saves only to device storage and survives page reopening', () => {
  const steps = [
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("text:Device code size: 100");',
    'await app.clear("id:settings-basics-codeFontSize");',
    'await app.type("id:settings-basics-codeFontSize", "150");',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("text:Device code size: 150");',
    'await app.waitFor("text:Saved");',
    'await app.press("id:settings-preferences-audit");',
    'await app.waitFor(\'text:{"writes":0,"preferences":{"chatRenderMode":"sorted","messageStreamTransport":"sse","diffLayoutPreference":"inline"}}\');',
    'await app.back();',
    'await app.waitFor("text:Appearance");',
    'await app.press("text:Appearance");',
    'await app.waitFor("id:settings-basics-codeFontSize");',
    'expect(app.value("id:settings-basics-codeFontSize")).toBe("150");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected preferences patch|Unexpected settings request: PUT/);',
  ].join('\n');
  const result = runSettingsEngineFixture(directory, 'settings-test-app.tsx', 'tests/settings-host.js', [steps], 45_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
test('native Chat render cards, transport chips and Diff radios save one exact preference patch', () => {
  const steps = [
    'await app.waitFor("text:Chat");',
    'await app.press("text:Chat");',
    'await app.waitFor("id:settings-preference-chatRenderMode-live");',
    'await app.press("id:settings-preference-chatRenderMode-live");',
    'await app.press("id:settings-preference-messageStreamTransport-ws");',
    'await app.press("id:settings-preference-diffLayoutPreference-side-by-side");',
    'await app.press("id:settings-preferences-audit");',
    'await app.waitFor(\'text:{"writes":0,"preferences":{"chatRenderMode":"sorted","messageStreamTransport":"sse","diffLayoutPreference":"inline"}}\');',
    'await app.press("id:settings-preferences-save");',
    'await app.waitFor("text:Saved");',
    'await app.press("id:settings-preferences-audit");',
    'await app.waitFor(\'text:{"writes":1,"preferences":{"chatRenderMode":"live","messageStreamTransport":"ws","diffLayoutPreference":"side-by-side"}}\');',
    'await app.back();',
    'await app.waitFor("text:Chat");',
    'await app.press("text:Chat");',
    'await app.waitFor("id:settings-preference-chatRenderMode-live");',
    'await app.press("id:settings-preferences-audit");',
    'await app.waitFor(\'text:{"writes":1,"preferences":{"chatRenderMode":"live","messageStreamTransport":"ws","diffLayoutPreference":"side-by-side"}}\');',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected settings|Unexpected preferences/);',
  ].join('\n');
  const result = runSettingsEngineFixture(directory, 'settings-test-app.tsx', 'tests/settings-host.js', [steps], 45_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
test('native Settings navigation edits a real command and keeps the draft after a rejected save', () => {
  const steps = [
    'await app.waitFor("text:Commands");',
    'await app.press("text:Commands");',
    'await app.waitFor("text:review");',
    'await app.press("text:review");',
    'await app.waitFor("id:settings-template");',
    'await app.type("id:settings-template", "Native edited review");',
    'const draft = app.value("id:settings-template");',
    'await app.press("text:Save");',
    'await app.waitFor("text:HTTP 409: Settings revision conflict");',
    'expect(app.value("id:settings-template")).toBe(draft);',
    'await app.press("text:Save");',
    'await app.waitFor("text:Command updated successfully");',
    'expect(app.value("id:settings-template")).toBe(draft);',
    'await app.press("text:Done");',
    'await app.press("id:settings-command-audit");',
    'await app.waitFor("text:Read-back save attempts: 2");',
    'await app.press("text:review");',
    'await app.waitFor("id:settings-template");',
    'expect(app.value("id:settings-template")).toBe(draft);',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected settings|Retry changed|did not send/);',
  ].join('\n');
  const result = runSettingsEngineFixture(directory, 'settings-test-app.tsx', 'tests/settings-host.js', [steps], 45_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);

test('native Magic Prompts saves, reloads, resets one block and resets all using the authoritative Host state', () => {
  const steps = [
    'await app.waitFor("text:Magic Prompts");',
    'await app.press("text:Magic Prompts");',
    'await app.waitFor("id:magic-group-git.commit.generate");',
    'await app.press("id:magic-group-git.commit.generate");',
    'await app.waitFor("id:magic-draft-visible");',
    'expect(app.value("id:magic-draft-visible")).toBe("Fixture visible override");',
    'await app.type("id:magic-draft-visible", "Native edited magic");',
    'const draft = app.value("id:magic-draft-visible");',
    'await app.press("id:magic-save-visible");',
    'await app.waitFor("text:Failed to save magic prompt");',
    'expect(app.value("id:magic-draft-visible")).toBe(draft);',
    'await app.press("id:magic-save-visible");',
    'await app.waitFor("text:Magic prompt saved");',
    'await app.back();',
    'await app.waitFor("id:magic-group-git.commit.generate");',
    'await app.press("id:magic-group-git.commit.generate");',
    'await app.waitFor("id:magic-draft-visible");',
    'expect(app.value("id:magic-draft-visible")).toBe(draft);',
    'expect(app.value("id:magic-draft-instructions")).toBe("Magic writes: 2");',
    'await app.press("id:magic-reset-visible");',
    'await app.waitFor("text:Prompt reset to default");',
    'expect(app.value("id:magic-draft-visible")).toBe("You are generating a Conventional Commits subject line from the diffs of the selected files.");',
    'expect(app.value("id:magic-draft-instructions")).toBe("Magic resets: 1");',
    'await app.press("id:magic-reset-all");',
    'await app.waitFor("text:All prompt overrides reset");',
    'await app.back();',
    'await app.waitFor("id:magic-group-git.commit.generate");',
    'await app.press("id:magic-group-git.commit.generate");',
    'await app.waitFor("id:magic-draft-visible");',
    'expect(app.value("id:magic-draft-visible")).toBe("You are generating a Conventional Commits subject line from the diffs of the selected files.");',
    'expect(app.value("id:magic-draft-instructions")).toMatch(/Return exactly one JSON object/);',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected settings|did not send/);',
  ].join('\n');
  const result = runSettingsEngineFixture(directory, 'settings-test-app.tsx', 'tests/settings-host.js', [steps], 45_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);

test('every Web Magic Prompts group opens both native editors with the exact effective default', () => {
  const steps = ['await app.waitFor("text:Magic Prompts");', 'await app.press("text:Magic Prompts");'];
  for (const entry of magicPromptGroups.flatMap(group => [...group.entries])) {
    steps.push(
      `await app.waitFor(${JSON.stringify('id:magic-group-' + entry.id)});`,
      `await app.press(${JSON.stringify('id:magic-group-' + entry.id)});`,
      'await app.waitFor("id:magic-draft-visible");',
      `expect(app.value("id:magic-draft-visible")).toBe(${JSON.stringify(entry.id === 'git.commit.generate' ? 'Fixture visible override' : nativeMagicDefaults[entry.id + '.visible'])});`,
      `expect(app.value("id:magic-draft-instructions")).toBe(${JSON.stringify(entry.id === 'git.commit.generate' ? 'Fixture instructions' : nativeMagicDefaults[entry.id + '.instructions'])});`,
      'await app.back();',
    );
  }
  const result = runSettingsEngineFixture(directory, 'settings-test-app.tsx', 'tests/settings-host.js', steps, 90_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);

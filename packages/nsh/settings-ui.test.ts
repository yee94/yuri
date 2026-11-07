import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { nativeMagicDefaults } from './settings-magic-defaults';
import { magicPromptGroups } from './settings-magic-state';

const directory = path.dirname(fileURLToPath(import.meta.url));
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
    'await app.waitFor("text:Read-back save attempts: 2");',
    'await app.press("text:review");',
    'await app.waitFor("id:settings-template");',
    'expect(app.value("id:settings-template")).toBe(draft);',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected settings|Retry changed|did not send/);',
  ].join('\n');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'settings-test-app.tsx', '--web-host', 'tests/settings-host.js'], { cwd: directory, input: steps, encoding: 'utf8', timeout: 45_000 });
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
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'settings-test-app.tsx', '--web-host', 'tests/settings-host.js'], { cwd: directory, input: steps, encoding: 'utf8', timeout: 45_000 });
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
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'settings-test-app.tsx', '--web-host', 'tests/settings-host.js'], { cwd: directory, input: steps.join('\n'), encoding: 'utf8', timeout: 90_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);

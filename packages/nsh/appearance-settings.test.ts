import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runSettingsEngineFixture } from './tests/settings-engine-fixture-runner.mjs';

const audit = [
  'await app.press("id:appearance-audit");',
  'await app.waitUntil(() => app.texts().some(text => text.startsWith("{\\"attempts\\":")));',
];
const snapshot = 'JSON.parse(app.texts().find(text => text.startsWith("{\\"attempts\\":")))';

test('real Settings color-mode picker ignores obsolete local light and preserves dark and unknown receipt without replay after failed Host write (headless fixture only)', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
    const result = runSettingsEngineFixture(directory, 'appearance-settings-test-app.tsx', 'appearance-settings-host.ts', [
        'await app.waitFor("text:dark");',
        'await app.waitFor("text:Dark");',
        'expect(app.storage().appearance).toBe("light");',
        'await app.press("text:Dark");',
        'await app.waitFor("text:Light");',
        'await app.press("text:Light");',
        'await app.waitFor("id:appearance-feedback");',
        'await app.waitFor("id:settings-preferences-unknown");',
        'expect(app.texts()).toContain("dark");',
        'expect(app.texts().join("\\n")).not.toContain("raw-sensitive-appearance-save-sentinel");',
        ...audit,
        `expect(${snapshot}.attempts).toBe(1);`,
        `expect(${snapshot}.themeVariant).toBe("dark");`,
        `expect(${snapshot}).toMatchObject({themeId:"jetbrains-dark",themeVariant:"dark",useSystemTheme:false,lightThemeId:"jetbrains-light",darkThemeId:"jetbrains-dark"});`,
        `const beforeRetry = ${snapshot}.reads;`,
        'await app.press("text:Dark");',
        'await app.waitFor("text:Light");',
        'await app.press("text:Light");',
        'await app.press("id:appearance-authority-refresh");',
        'await app.waitUntil(() => !app.shows("id:appearance-feedback"));',
        ...audit,
        `expect(${snapshot}.reads).toBeGreaterThan(beforeRetry);`,
        `expect(${snapshot}.attempts).toBe(1);`,
        `expect(${snapshot}.themeVariant).toBe("dark");`,
        `expect(${snapshot}.themeId).toBe("jetbrains-dark");`,
        'expect(app.shows("id:settings-preferences-unknown")).toBe(true);',
        'expect(app.texts()).toContain("dark");',
        'expect(app.texts()).toContain("Dark");',
        'expect(app.texts().includes("Saved")).toBe(false);',
      ], 60_000, ['appearance.reset', 'appearance.apply']);
    expect(result.error, result.stderr + result.stdout).toBeUndefined(); expect(result.status, result.stderr + result.stdout).toBe(0);
}, 90_000);

test('real Settings color-mode picker confirms acknowledged System and Light writes by GET and keeps canonical theme identity (headless fixture only)', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const result = runSettingsEngineFixture(directory, 'appearance-settings-test-app.tsx', 'appearance-settings-host.ts', [
    'await app.waitFor("text:dark");',
    ...audit,
    `const beforeSystem = ${snapshot}.reads;`,
    'await app.press("text:Dark");',
    'await app.waitFor("text:System");',
    'await app.press("text:System");',
    'await app.waitFor("text:system");',
    'await app.waitFor("text:Saved");',
    ...audit,
    `expect(${snapshot}.attempts).toBe(1);`,
    `expect(${snapshot}.useSystemTheme).toBe(true);`,
    `expect(${snapshot}).toMatchObject({themeId:"jetbrains-light",themeVariant:"light",useSystemTheme:true,lightThemeId:"jetbrains-light",darkThemeId:"jetbrains-dark"});`,
    `expect(${snapshot}.reads).toBeGreaterThan(beforeSystem);`,
    `expect(${snapshot}.confirmationReads).toBeGreaterThan(0);`,
    `const beforeLightConfirmation = ${snapshot}.confirmationReads;`,
    `const beforeLight = ${snapshot}.reads;`,
    'await app.press("text:System");',
    'await app.waitFor("text:Light");',
    'await app.press("text:Light");',
    'await app.waitFor("text:light");',
    'await app.waitFor("text:Saved");',
    ...audit,
    `expect(${snapshot}.attempts).toBe(2);`,
    `expect(${snapshot}.useSystemTheme).toBe(false);`,
    `expect(${snapshot}.themeVariant).toBe("light");`,
    `expect(${snapshot}).toMatchObject({themeId:"jetbrains-light",themeVariant:"light",useSystemTheme:false,lightThemeId:"jetbrains-light",darkThemeId:"jetbrains-dark"});`,
    `expect(${snapshot}.reads).toBeGreaterThan(beforeLight);`,
    `expect(${snapshot}.confirmationReads).toBeGreaterThan(beforeLightConfirmation);`,
    'expect(app.shows("id:settings-preferences-unknown")).toBe(false);',
    'await app.press("id:appearance-authority-refresh");',
    'await app.waitUntil(() => !app.shows("id:appearance-feedback"));',
    'expect(app.texts()).toContain("light");',
    'expect(app.texts()).toContain("Light");',
    'expect(app.texts()).not.toContain("Dark");',
    ...audit,
    `expect(${snapshot}.attempts).toBe(2);`,
    `expect(${snapshot}).toMatchObject({themeId:"jetbrains-light",themeVariant:"light",useSystemTheme:false,lightThemeId:"jetbrains-light",darkThemeId:"jetbrains-dark"});`,
  ], 60_000, ['appearance.reset', 'appearance.apply']);
  expect(result.error, result.stderr + result.stdout).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 90_000);

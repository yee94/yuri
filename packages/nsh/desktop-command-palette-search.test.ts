import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { searchNavigationScript } from './tests/projects-search-navigation';

function headless(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-command-palette-search-fixture.tsx', '--web-host', 'desktop-command-palette-search-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 90_000,
    input: [searchNavigationScript(), 'await app.waitFor("text:ready");', ...steps].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('real Dialog reuses all five search domains, closes before exact message navigation, never pops the product NavStack', () => headless([
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:projects-global-search");',
  'await app.type("id:projects-global-search", "Needle");', 'await app.waitFor("id:projects-search-message:session:exact-message");',
  'await revealSearchResult(app, "id:projects-search-command:c0");',
  'await revealSearchResult(app, "id:projects-search-command:s0");',
  'await revealSearchResult(app, "id:projects-search-project:p1");',
  'await revealSearchResult(app, "id:projects-search-file:/workspace/focus:src/needle.ts");',
  'await revealSearchResult(app, "id:projects-search-message:session:exact-message", -1);',
  'await app.press("id:projects-search-message:session:exact-message");',
  'await app.waitFor("id:projects-global-search", {state:"gone"});',
  'expect(app.texts()).toContain("selected:chat:session:exact-message");',
  'expect(app.texts()).toContain("closedFirst:true");', 'expect(app.shows("id:product-route")).toBe(true);',
]), 100_000);

test('real Dialog keyboard skips headings, chooses commands once, and Escape retains the product route', () => headless([
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:projects-search-session:session");',
  'await app.keyboard.press("down");', 'await app.keyboard.press("enter");',
  'await app.waitFor("id:projects-global-search", {state:"gone"});',
  'expect(app.texts()).toContain("selected:command:0");', 'expect(app.texts()).toContain("closedFirst:true");',
  'expect(app.texts()).toContain("selections:1");',
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:projects-global-search");',
  'await app.keyboard.press("escape");', 'await app.waitFor("id:projects-global-search", {state:"gone"});',
  'expect(app.shows("id:product-route")).toBe(true);',
]), 100_000);

test('same-query partial failure keeps message authority and arrow navigation performs no requests', () => headless([
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:projects-global-search");',
  'await app.type("id:projects-global-search", "Needle");', 'await app.waitFor("id:projects-search-message:session:exact-message");',
  'await app.type("id:projects-global-search", " ");', 'await app.waitFor("id:projects-search-retry");',
  'expect(app.texts()).toContain("Needle body");',
  'await app.press("id:projects-search-retry");', 'await app.waitFor("id:projects-search-retry", {state:"gone"});',
  'for (let i = 0; i < 50; i++) await app.keyboard.press(i % 2 ? "up" : "down");',
  'await app.keyboard.press("escape");', 'await app.waitFor("id:projects-global-search", {state:"gone"});',
  'await app.press("id:palette-audit");', 'await app.waitUntil(() => app.texts().some(text => text.startsWith("{\\"calls\\"")));',
  'const audit = JSON.parse(app.texts().find(text => text.startsWith("{\\"calls\\"")));',
  'expect(audit.calls).toHaveLength(10);',
]), 100_000);

test('close cancels the shared debounce; no-Focus keeps global domains but issues no file search', () => headless([
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:projects-global-search");',
  'await app.type("id:projects-global-search", "cancelled");', 'await app.keyboard.press("escape");',
  'await app.waitFor("id:projects-global-search", {state:"gone"});', 'await app.wait(400);',
  'await app.press("id:palette-focus");',
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:projects-global-search");',
  'await app.type("id:projects-global-search", "Needle");', 'await app.waitFor("id:projects-search-message:session:exact-message");',
  'await app.keyboard.press("escape");', 'await app.waitFor("id:projects-global-search", {state:"gone"});',
  'await app.press("id:palette-audit");', 'await app.waitUntil(() => app.texts().some(text => text.startsWith("{\\"calls\\"")));',
  'const audit = JSON.parse(app.texts().find(text => text.startsWith("{\\"calls\\"")));',
  'expect(audit.calls.some(path => path.includes("cancelled"))).toBe(false);',
  'expect(audit.calls.some(path => path.includes("/api/fs/find"))).toBe(false);',
  'expect(audit.calls.filter(path => path.includes("/api/yuri/content-search"))).toHaveLength(1);',
]), 100_000);

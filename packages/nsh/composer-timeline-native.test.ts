import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'composer-timeline-fixture.tsx'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 90_000,
    input: ['await app.waitFor("id:ordinary");', ...steps].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}
test('production native timeline: closed zero work, full-text search, exact jump failure/success and reopen', () => run([
  'for (let i=0;i<50;i++) await app.type("id:ordinary", "x");', 'expect(app.texts()).toContain("reads:0 calls:0 event:none");',
  'await app.press("id:open");', 'await app.waitFor("id:timeline-search");', 'expect(app.shows("id:timeline-row-assistant")).toBe(false);',
  'await app.type("id:timeline-search", "needle");', 'expect(app.shows("id:timeline-row-z-first")).toBe(true);', 'expect(app.shows("id:timeline-row-b-last")).toBe(false);',
  'await app.type("id:timeline-search", "-no-match");', 'await app.submit("id:timeline-search");', 'expect(app.shows("id:composer-timeline")).toBe(true);',
  'await app.clear("id:timeline-search");', 'await app.type("id:timeline-search", "needle");',
  'await app.host.send("timeline-fixture", {action:"jump-fails"});', 'await app.press("id:timeline-jump-z-first");', 'expect(app.shows("id:composer-timeline")).toBe(true);',
  'await app.host.send("timeline-fixture", {action:"jump-fails"});', 'await app.press("id:timeline-jump-z-first");', 'expect(app.shows("id:composer-timeline")).toBe(false);',
  'const before = app.texts().find(text => text.startsWith("reads:"));', 'for (let i=0;i<50;i++) await app.type("id:ordinary", "x");', 'expect(app.texts()).toContain(before);',
  'await app.press("id:open");', 'await app.waitFor("id:timeline-search");', 'expect(app.value("id:timeline-search")).toBe("needle");',
]), 100_000);
test('production timeline: pending survives close/reopen, unknown needs authority settlement and scope fences late success', () => run([
  'await app.press("id:open");', 'await app.waitFor("id:timeline-row-b-last");', 'await app.press("id:timeline-fork-b-last");',
  'await app.keyboard.press("escape");', 'await app.press("id:open");', 'await app.waitFor("id:timeline-fork-b-last");',
  'expect(app.enabled("id:timeline-fork-b-last")).toBe(false);',
  'await app.host.send("timeline-fixture", {action:"unknown"});', 'expect(app.shows("id:timeline-error")).toBe(true);', 'expect(app.enabled("id:timeline-revert-b-last")).toBe(false);',
  'await app.host.send("timeline-fixture", {action:"resolve"});', 'expect(app.shows("id:composer-timeline")).toBe(false);', 'expect(app.texts().some(text => text.includes("calls:1"))).toBe(true);',
  'await app.press("id:open");', 'await app.press("id:timeline-fork-b-last");', 'await app.host.send("timeline-fixture", {action:"scope"});', 'await app.host.send("timeline-fixture", {action:"finish"});',
  'expect(app.shows("id:composer-timeline")).toBe(true);',
]), 100_000);
test('production timeline: older read errors stay retryable and successful pages retain the same List owner', () => run([
  'await app.press("id:open");', 'await app.host.send("timeline-fixture", {action:"load-fails"});', 'await app.press("id:timeline-load-earlier");', 'expect(app.shows("id:timeline-error")).toBe(true);',
  'await app.host.send("timeline-fixture", {action:"load-fails"});', 'await app.press("id:timeline-load-earlier");', 'await app.host.send("timeline-fixture", {action:"finish-older"});',
  'expect(app.shows("id:timeline-load-earlier")).toBe(false);', 'expect(app.shows("id:timeline-row-older")).toBe(true);',
  'await app.press("id:timeline-latest");', 'expect(app.shows("id:composer-timeline")).toBe(false);',
]), 100_000);

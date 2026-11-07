import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { withProjectsSearchFixture } from './tests/projects-search-runner.js';
import { searchNavigationScript } from './tests/projects-search-navigation';

const root = path.dirname(fileURLToPath(import.meta.url));
const run = (steps: string[]) => withProjectsSearchFixture(root, (fixture: { directory: string; entry: string; host: string }) => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: [searchNavigationScript(), ...steps].join('\n'), encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test('native search previews all five domains, expands independently, preserves failed snapshots and opens exact message/project/file/command targets', () => {
  run([
    'await app.press("id:search-fixture-open");',
    'await app.waitFor("id:projects-global-search");',
    'expect(app.texts().join("\\n")).not.toContain("needle setting");',
    'await app.type("id:projects-global-search", "needle");',
    'await app.waitFor("id:projects-search-message:s0:m9");',
    'expect(app.texts().filter(text=>text==="needle chat 0").length).toBe(1);',
    ...[
      { group: 'sessions', tail: 'message:body-only:exact-body-only', direction: 1 },
      { group: 'commands', tail: 'command:c6', direction: 1 },
      { group: 'settings', tail: 'command:settings:6', direction: 1 },
      { group: 'projects', tail: 'project:p6', direction: 1 },
      { group: 'files', tail: 'file:/fixture/focus:src/needle-7.ts', direction: -1 },
    ].flatMap(({ group, tail, direction }) => [
      `await revealSearchResult(app, "id:projects-search-more:${group}", ${direction});`,
      `await app.press("id:projects-search-more:${group}");`,
      `await revealSearchResult(app, "id:projects-search-${tail}", ${direction});`,
    ]),
    'await revealSearchResult(app, "id:projects-search-message:body-only:exact-body-only", -1);',
    'await app.type("id:projects-global-search", " ");',
    'await app.waitFor("text:Message search could not load. Other results are still shown.");',
    'await revealSearchResult(app, "id:projects-search-message:s0:m9", -1);',
    'expect(app.texts()).toContain("needle latest body");',
    'await app.press("id:projects-search-retry");',
    'await app.waitUntil(()=>!app.texts().includes("Message search could not load. Other results are still shown."));',
    'await revealSearchResult(app, "id:projects-search-message:s0:m9", -1);',
    'await app.press("id:projects-search-message:s0:m9");',
    'await app.waitFor("text:chat:s0:/global/other-project:m9");',
    'await app.back();',
    'await revealSearchResult(app, "id:projects-search-project:p0");',
    'await app.press("id:projects-search-project:p0");',
    'await app.waitFor("text:project:p0:/global/project-0");',
    'await app.back();',
    'await revealSearchResult(app, "id:projects-search-file:/fixture/focus:src/needle-0.ts", -1);',
    'await app.press("id:projects-search-file:/fixture/focus:src/needle-0.ts");',
    'await app.waitFor("text:file:/fixture/focus:src/needle-0.ts");',
    'await app.back();',
    'await revealSearchResult(app, "id:projects-search-command:c0");',
    'await app.press("id:projects-search-command:c0");',
    'await app.waitFor("text:command:0");',
    'await app.press("id:search-fixture-audit");',
    'await app.waitUntil(()=>app.texts().some(text=>text.includes("\\"rejected\\":0")));',
  ]);
}, 150_000);

test('native no-Focus search skips files without narrowing global title/body/project domains', () => {
  run([
    'await app.press("id:search-fixture-focus-toggle");',
    'await app.press("id:search-fixture-open");',
    'await app.type("id:projects-global-search", "needle");',
    'await app.waitFor("id:projects-search-message:s0:m9");',
    'await revealSearchResult(app, "id:projects-search-project:p0");',
    'await app.press("id:search-fixture-audit");',
    'await app.waitUntil(()=>app.texts().some(text=>text.startsWith("{\\"calls\\"")));',
    'const audit=JSON.parse(app.texts().find(text=>text.startsWith("{\\"calls\\"")));',
    'expect(audit.rejected).toBe(0);',
    'expect(audit.calls.some(call=>call.path==="/api/fs/find")).toBe(false);',
    'expect(audit.calls.some(call=>call.path==="/api/yuri/content-search")).toBe(true);',
  ]);
}, 150_000);

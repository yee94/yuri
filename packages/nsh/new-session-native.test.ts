import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { newSessionUIEntry, newSessionUIHost, newSessionUIScenarios } from './new-session-ui-steps';
import { prepareNewSessionNativeFixture } from './tests/new-session-native-runner';

const directory = path.dirname(fileURLToPath(import.meta.url));

/** NSH keys headless Storage by web-host path: never reuse a bundle between scenarios. */
function run(entry: string, hostSource: string, steps: readonly string[]) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'nsh-new-session-'));
  try {
    const { host, test: engineTest } = prepareNewSessionNativeFixture(directory, temporary, entry, steps);
    const build = spawnSync('bun', ['build', hostSource, '--target=browser', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    expect(build.error, build.stdout + build.stderr).toBeUndefined();
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', engineTest, '--web-host', host], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

for (const [name, steps] of Object.entries(newSessionUIScenarios)) {
  test(`native new-session page: ${name} (isolated fake Host and Storage)`, () => {
    run(newSessionUIEntry, newSessionUIHost, ['await app.waitFor("id:new-session-fixture-open");', ...steps]);
  }, 95_000);
}

test('production Projects opens a local new-session page without POST and Back/reopen preserves its draft', () => {
  run('new-session-production.fixture.tsx', 'tests/new-session-production-host.js', [
    'await app.waitFor("text:Native draft project");',
    'await app.press("label:Project menu");',
    'await app.waitFor("id:projects-option-newSession");',
    'await app.press("id:projects-option-newSession");',
    'await app.waitFor("id:new-session-composer");',
    'await app.press("id:new-session-production-audit");',
    'await app.waitFor("text:audit:1 writes:0 creates:0 prompts:0");',
    'await app.type("id:new-session-composer", "Production Projects draft survives Back");',
    'await app.back();',
    'await app.waitFor("label:Project menu");',
    'await app.press("label:Project menu");',
    'await app.waitFor("id:projects-option-newSession");',
    'await app.press("id:projects-option-newSession");',
    'await app.waitFor("id:new-session-composer");',
    'await app.waitUntil(() => app.value("id:new-session-composer") === "Production Projects draft survives Back");',
    'await app.press("id:new-session-production-audit");',
    'await app.waitUntil(() => app.texts().some(value => value === "audit:2 writes:0 creates:0 prompts:0"));',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected new-session|Invalid session|Invalid worktree/);',
  ]);
}, 95_000);

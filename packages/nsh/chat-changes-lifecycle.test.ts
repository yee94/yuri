import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], toolFixture = false) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'changes-lifecycle-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Changes lifecycle fixture', id: 'example.yuri.changes-lifecycle', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'changes.fixture.control'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), toolFixture
      ? `import { loadConnections } from ${JSON.stringify(path.join(root, 'state.ts'))}; void loadConnections().then(() => import(${JSON.stringify(path.join(root, 'tool-diff-fixture.tsx'))}));\n`
      : `import ${JSON.stringify(path.join(root, 'chat-changes-test-app.tsx'))};\n`);
    if (toolFixture) writeFileSync(path.join(directory, 'host.js'), `export function createHost() { return { call(name) {
      if (name !== 'connection.list') throw new Error('Historical fixture must not request Host data: ' + name);
      return { selected: 'history-fixture', runtimeScope: { hostID: 'history-fixture', lease: 'history-fixture-lease' }, connections: [{ id: 'history-fixture', label: 'History fixture', url: 'https://history.example.invalid', lastUsedAt: 1 }] };
    } }; }\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', toolFixture ? 'host.js' : path.join(root, 'chat-changes-actions-fixture-host.js')], {
      cwd: directory, encoding: 'utf8', timeout: 65_000,
      input: [
        ...(toolFixture ? ['await app.waitFor("text:TOOL DIFF READY");'] : [
          'await app.waitFor("text:2 files");',
          'const audit = () => JSON.parse(app.texts().find(value => value.startsWith("changes-audit:")).slice(14));',
        ]),
        ...steps,
      ].join('\n'),
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('retained Changes workspace survives close/reopen and active pause/resume with one bounded status load per opening', () => run([
  'await app.press("id:changes-fixture-workspace");',
  'await app.waitFor("text:fixture-branch");',
  'await app.waitUntil(() => app.enabled("id:changes-stage-folder/a.ts"));',
  'await app.type("id:changes-commit-message", "Retained commit draft");',
  'await app.press("id:changes-view-mode");',
  'expect(app.shows("text:folder/a.ts")).toBe(true);',
  'await app.press("id:changes-close");',
  'await app.waitFor("id:native-changes-sheet", { state: "gone" });',
  'const closed = audit().getReads;',
  'await app.wait(80); expect(audit().getReads).toBe(closed);',
  'await app.press("id:changes-fixture-workspace");',
  'await app.waitUntil(() => app.enabled("id:changes-stage-folder/a.ts"));',
  'expect(app.value("id:changes-commit-message")).toBe("Retained commit draft");',
  'expect(app.shows("text:folder/a.ts")).toBe(true);',
  'expect(audit().getReads).toBe(closed + 1);',
  'await app.press("id:changes-fixture-active");',
  'await app.waitFor("id:native-changes-sheet", { state: "gone" });',
  'const paused = audit().getReads; await app.wait(80); expect(audit().getReads).toBe(paused);',
  'await app.press("id:changes-fixture-active");',
  'expect(app.shows("id:native-changes-sheet")).toBe(false);',
  'await app.press("id:changes-fixture-workspace");',
  'await app.waitUntil(() => app.enabled("id:changes-stage-folder/a.ts"));',
  'expect(app.value("id:changes-commit-message")).toBe("Retained commit draft");',
  'expect(app.shows("text:folder/a.ts")).toBe(true);',
  'await app.wait(80); expect(audit().getReads).toBe(paused + 2);',
]), 75_000);

test('existing tool history fixture with confirmed native initialization renders patch/pairs/deletion/binary/empty/long without any runtime GET', () => run([
  'await app.press("id:tool-expand-edit");',
  'await app.waitFor("text:NEW_WORD");',
  'await app.waitUntil(() => app.enabled("id:changes-first-change"));',
  'await app.press("id:changes-open-preview");',
  'await app.waitFor("text:preview:/fixture/example.ts:9");',
  'await app.press("id:tool-expand-multi");',
  'await app.waitFor("text:FIRST_HISTORY");',
  'await app.press("id:changes-back");',
  'await app.press("text:other.ts");',
  'await app.waitFor("text:OTHER_HISTORY");',
  'expect(app.shows("text:FIRST_HISTORY")).toBe(false);',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-text-pair");',
  'await app.waitFor("text:const value = \\"PAIR_NEW\\";");',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-delete");',
  'await app.waitFor("text:DELETED_ONLY");',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-binary");',
  'await app.waitFor("id:native-changes-sheet");',
  'expect(app.shows("id:changes-native-diff")).toBe(false);',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-empty");',
  'await app.waitFor("text:Working tree clean, no changes to display");',
  'expect(app.enabled("id:changes-first-change")).toBe(false);',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-long");',
  'await app.waitFor("text:old 0");',
  'expect(app.texts().length < 500).toBe(true);',
  'await app.press("id:changes-close");',
  'await app.press("id:fixture-expire");',
  'expect(app.enabled("id:tool-expand-edit")).toBe(false);',
], true), 75_000);

test('failed refresh retains files and commit draft; fifty input events issue zero GET or POST and no refresh loop', () => run([
  'await app.press("id:changes-fixture-seed-staged");',
  'await app.press("id:changes-fixture-workspace");',
  'await app.waitFor("id:changes-staged-folder/a.ts");',
  'await app.waitUntil(() => app.enabled("id:changes-unstage-folder/a.ts"));',
  'const before = audit();',
  'for (let index = 0; index < 50; index++) await app.type("id:changes-commit-message", "x");',
  'await app.wait(80); expect(audit()).toEqual(before);',
  'await app.press("id:changes-fixture-fail-next-status");',
  'await app.press("id:changes-refresh");',
  'await app.waitFor("text:HTTP 503: Lifecycle status failure");',
  'expect(app.value("id:changes-commit-message")).toBe("x".repeat(50));',
  'expect(app.shows("id:changes-staged-folder/a.ts")).toBe(true);',
  'expect(app.enabled("id:changes-commit")).toBe(false);',
  'const failed = audit(); await app.wait(80); expect(audit()).toEqual(failed);',
  'await app.press("id:changes-refresh");',
  'await app.waitUntil(() => app.enabled("id:changes-commit"));',
  'expect(app.value("id:changes-commit-message")).toBe("x".repeat(50));',
  'expect(audit().getReads).toBe(before.getReads + 2); expect(audit().posts).toBe(0);',
]), 75_000);

test('late commit ACK from closed lane cannot clear reopened draft, refresh new lane or unlock/replay unknown write', () => run([
  'await app.press("id:changes-fixture-seed-staged");',
  'await app.press("id:changes-fixture-workspace");',
  'await app.waitFor("id:changes-staged-folder/a.ts");',
  'await app.type("id:changes-commit-message", "Exact fixture commit");',
  'await app.waitUntil(() => app.enabled("id:changes-commit"));',
  'await app.press("id:changes-fixture-hold-commit");',
  'await app.press("id:changes-commit");',
  'await app.waitUntil(() => audit().commitCalls === 1);',
  'expect(app.enabled("id:changes-commit-message")).toBe(false);',
  'await app.press("id:changes-close");',
  'await app.waitFor("id:native-changes-sheet", { state: "gone" });',
  'await app.press("id:changes-fixture-workspace");',
  'await app.waitFor("id:changes-write-unknown");',
  'await app.waitUntil(() => app.enabled("id:changes-refresh"));',
  'expect(app.value("id:changes-commit-message")).toBe("Exact fixture commit");',
  'await app.type("id:changes-commit-message", " new draft");',
  'const reopened = audit();',
  'await app.press("id:changes-fixture-release");',
  'await app.waitUntil(() => audit().commitAcks === 1);',
  'await app.wait(100);',
  'expect(app.value("id:changes-commit-message")).toBe("Exact fixture commit new draft");',
  'expect(app.shows("id:changes-staged-folder/a.ts")).toBe(true);',
  'expect(audit().getReads).toBe(reopened.getReads);',
  'expect(audit().commitCalls).toBe(1); expect(audit().posts).toBe(1);',
  'expect(app.enabled("id:changes-commit")).toBe(false);',
  'await app.press("id:changes-refresh");',
  'await app.waitUntil(() => !app.shows("id:changes-staged-folder/a.ts"));',
  'expect(app.shows("id:changes-write-unknown")).toBe(true);',
  'expect(app.value("id:changes-commit-message")).toBe("Exact fixture commit new draft");',
  'expect(audit().posts).toBe(1); expect(app.enabled("id:changes-sync")).toBe(false);',
]), 75_000);

test('Composer shared reader reacquires write readiness on reopen without replacing its retained workspace draft', () => run([
  'await app.press("id:changes-fixture-seed-staged");',
  'await app.press("id:composer-changes");',
  'await app.waitFor("id:composer-change-folder/a.ts");',
  'await app.press("id:composer-change-folder/a.ts");',
  'await app.waitFor("text:SHARED_READER_ONLY");',
  'await app.press("id:changes-back");',
  'await app.waitFor("id:changes-staged-folder/a.ts");',
  'await app.type("id:changes-commit-message", "Shared reader draft");',
  'await app.waitUntil(() => app.enabled("id:changes-commit"));',
  'await app.press("id:changes-close");',
  'await app.waitFor("id:native-changes-sheet", { state: "gone" });',
  'await app.press("id:composer-changes");',
  'await app.press("id:composer-change-folder/a.ts");',
  'await app.waitFor("text:SHARED_READER_ONLY");',
  'await app.press("id:changes-back");',
  'await app.waitUntil(() => app.enabled("id:changes-commit"));',
  'expect(app.value("id:changes-commit-message")).toBe("Shared reader draft");',
  'expect(audit().posts).toBe(0);',
]), 75_000);

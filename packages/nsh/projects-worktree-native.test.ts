import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { withProjectsNativeFixture } from './tests/projects-native-runner.js';

function run(steps: string[]) {
  withProjectsNativeFixture(path.dirname(fileURLToPath(import.meta.url)), 'worktree', (fixture: { directory: string; entry: string; host: string }) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: steps.join('\n'), encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}
test('worktree modes keep independent drafts, reset names from the shared slug rule, and cancel/reopen never writes', () => {
  run([
    'await app.waitFor("id:projects-worktree-branch");',
    'expect(app.value("id:projects-worktree-branch")).not.toBe("");',
    'await app.clear("id:projects-worktree-branch"); await app.type("id:projects-worktree-branch", "feature/new-mode");',
    'expect(app.value("id:projects-worktree-folder")).toBe("feature-new-mode");',
    'await app.clear("id:projects-worktree-folder"); await app.type("id:projects-worktree-folder", "custom-folder");',
    'await app.press("id:projects-worktree-mode-existing");',
    'expect(app.value("id:projects-worktree-folder")).toBe("");',
    'await app.type("id:projects-worktree-folder", "existing-folder");',
    'await app.press("id:projects-worktree-mode-new");',
    'expect(app.value("id:projects-worktree-branch")).toBe("feature/new-mode");',
    'expect(app.value("id:projects-worktree-folder")).toBe("custom-folder");',
    'await app.press("id:projects-worktree-mode-existing");',
    'expect(app.value("id:projects-worktree-folder")).toBe("existing-folder");',
    'await app.press("id:projects-worktree-mode-new");',
    'await app.press("id:projects-worktree-reset-folder");',
    'expect(app.value("id:projects-worktree-folder")).toBe("feature-new-mode");',
    'await app.press("id:projects-worktree-cancel");',
    'await app.waitFor("id:projects-worktree-branch", { state: "gone" });',
    'await app.press("id:fixture-open-worktree");',
    'await app.waitFor("id:projects-worktree-branch");',
    'expect(app.value("id:projects-worktree-branch")).not.toBe("feature/new-mode");',
    'await app.press("id:fixture-audit-worktree"); await app.waitUntil(() => app.texts().some(text => /validations:\\d+ creates:0/.test(text)));',
  ]);
}, 60000);
test('validation rejection preserves the typed form and explicit retry creates only once in the isolated Host', () => {
  run([
    'await app.waitFor("id:projects-worktree-branch");',
    'await app.clear("id:projects-worktree-branch"); await app.type("id:projects-worktree-branch", "feature/retry");',
    'await app.waitFor("id:projects-worktree-folder-error");',
    'await app.waitFor("text:Isolated directory conflict");',
    'expect(app.value("id:projects-worktree-branch")).toBe("feature/retry");',
    'expect(app.value("id:projects-worktree-folder")).toBe("feature-retry");',
    'await app.press("id:fixture-audit-worktree"); await app.waitFor("text:validations:1 creates:0");',
    'await app.press("id:projects-worktree-validation-retry");',
    'await app.waitFor("id:projects-worktree-folder-error", { state: "gone" });',
    'await app.waitUntil(() => app.enabled("id:projects-worktree-create"));',
    'await app.press("id:projects-worktree-create");',
    'await app.waitFor("text:Created /isolated/created");',
    'await app.press("id:fixture-audit-worktree"); await app.waitFor("text:validations:3 creates:1");',
  ]);
}, 60000);

test('source defaults to the root, a canceled choice is not saved, and a successful choice survives owner reopen', () => {
  run([
    'await app.waitFor("id:fixture-owner"); await app.press("id:fixture-owner");',
    'await app.waitFor("text:source:main");',
    'await app.press("id:owner-develop"); await app.waitFor("text:source:feature/existing");',
    'await app.press("id:fixture-owner"); await app.press("id:fixture-owner");',
    'await app.waitFor("text:source:main");',
    'await app.press("id:owner-develop");',
    'await app.waitFor("text:Isolated directory conflict");',
    'await app.waitUntil(() => app.enabled("id:owner-submit"));',
    'await app.press("id:owner-submit"); await app.waitFor("text:Owner created /isolated/created");',
    'await app.press("id:fixture-owner"); await app.press("id:fixture-owner");',
    'await app.waitFor("text:source:feature/existing");',
  ]);
}, 60000);

test('prevalidation has one in-flight request, coalesces latest edits, ignores old errors, and unrelated state does not poll', () => {
  run([
    'await app.waitFor("id:fixture-owner"); await app.press("id:fixture-owner"); await app.waitFor("text:source:main");',
    'await app.press("id:owner-hold"); await app.waitFor("text:hold armed"); await app.press("id:owner-edit-a");',
    'await app.press("id:owner-audit"); await app.waitUntil(async () => { await app.press("id:owner-audit"); return app.texts().includes("validations:1 creates:0"); });',
    'await app.press("id:owner-edit-b"); await app.press("id:owner-edit-c"); await app.press("id:owner-unrelated");',
    'await app.press("id:owner-release"); await app.waitFor("text:released prior");',
    'await app.waitUntil(async () => { await app.press("id:owner-audit"); return app.texts().includes("validations:2 creates:0"); });',
    'expect(app.texts()).not.toContain("Late prior draft conflict");',
    'await app.press("id:owner-unrelated"); await app.press("id:owner-audit"); await app.waitFor("text:validations:2 creates:0");',
  ]);
}, 60000);

test('late catalog collisions replace untouched random names but never replace a user draft', () => {
  run([
    'await app.waitFor("id:fixture-owner"); await app.press("id:fixture-owner"); await app.waitFor("text:source:main");',
    'const original = app.value("id:owner-branch"); await app.press("id:owner-collision");',
    'expect(app.value("id:owner-branch")).not.toBe(original);',
    'await app.press("id:owner-edit-a"); await app.press("id:owner-collision");',
    'expect(app.value("id:owner-branch")).toBe("feature/a");',
  ]);
}, 60000);

test('branch refresh failure preserves catalog, canonical remote selection and draft; explicit retry distinguishes successful empty', () => {
  run([
    'await app.waitFor("id:fixture-owner"); await app.press("id:fixture-owner"); await app.waitFor("text:branch count:3");',
    'await app.press("id:owner-edit-a"); await app.press("id:owner-existing-remote");',
    'await app.press("id:owner-branches-fail"); await app.waitFor("text:branch mode:fail"); await app.press("id:owner-context-retry");',
    'await app.waitFor("text:HTTP 503: Isolated branches unavailable");',
    'expect(app.texts()).toContain("known branches:3");',
    'expect(app.value("id:owner-branch")).toBe("feature/a");',
    'expect(app.texts()).toContain("existing:remotes/origin/release folder:origin-release");',
    'await app.press("id:owner-branches-audit"); await app.waitFor("text:branches:3 creates:0");',
    'await app.press("id:owner-unrelated"); await app.press("id:owner-branches-audit"); await app.waitFor("text:branches:3 creates:0");',
    'await app.press("id:owner-branches-empty"); await app.waitFor("text:branch mode:empty"); await app.press("id:owner-context-retry");',
    'await app.waitFor("text:branch count:0"); expect(app.texts()).not.toContain("HTTP 503: Isolated branches unavailable");',
    'expect(app.value("id:owner-branch")).toBe("feature/a");',
    'expect(app.texts()).toContain("existing:remotes/origin/release folder:origin-release");',
    'await app.press("id:owner-branches-normal"); await app.waitFor("text:branch mode:normal"); await app.press("id:owner-context-retry"); await app.waitFor("text:branch count:3");',
  ]);
}, 60000);

test('branch context refresh is single-flight and a hidden owner rejects its late response', () => {
  run([
    'await app.waitFor("id:fixture-owner"); await app.press("id:fixture-owner"); await app.waitFor("text:branch count:3");',
    'await app.press("id:owner-branches-hold"); await app.waitFor("text:branch mode:hold"); await app.press("id:owner-context-burst"); await app.waitFor("text:branches loading");',
    'await app.press("id:owner-branches-audit"); await app.waitFor("text:branches:3 creates:0");',
    'await app.press("id:owner-pause"); await app.press("id:owner-branches-release"); await app.waitFor("text:branches released");',
    'expect(app.texts()).toContain("branch count:3");',
    'await app.press("id:owner-branches-normal"); await app.waitFor("text:branch mode:normal"); await app.press("id:owner-pause"); await app.waitFor("text:branch count:3");',
  ]);
}, 60000);

test('first-load branch failure remains unknown until explicit recovery, rather than successful empty', () => {
  run([
    'await app.waitFor("id:fixture-owner"); await app.press("id:fixture-owner"); await app.waitFor("text:branch count:3");',
    'await app.press("id:owner-branches-fail"); await app.waitFor("text:branch mode:fail");',
    'await app.press("id:fixture-owner"); await app.press("id:fixture-owner");',
    'await app.waitFor("text:HTTP 503: Isolated branches unavailable");',
    'expect(app.texts()).toContain("known branches:0"); expect(app.enabled("id:owner-submit")).toBe(false);',
    'await app.press("id:owner-branches-normal"); await app.waitFor("text:branch mode:normal");',
    'await app.press("id:owner-context-retry"); await app.waitFor("text:branch count:3"); await app.waitFor("text:source:main");',
  ]);
}, 60000);

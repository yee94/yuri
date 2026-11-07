import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { withProjectsParityFixture } from './projects-parity-runner.mjs';

// Main is the sole engine scheduler. A normal pure run never starts NSH/UIKit.
const run = process.env.NSH_PROJECTS_PARITY_ENGINE === '1' ? test : test.skip;
const root = path.dirname(fileURLToPath(import.meta.url));
function engine(steps: string[]) {
  withProjectsParityFixture(root, (fixture: { directory: string; entry: string; host: string }) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, encoding: 'utf8', timeout: 60_000, input: [
      'const auditValue = () => JSON.parse(app.texts().find(text => text.startsWith("{\\"auditSequence\\":")) || "null");',
      'const readAudit = async () => { const before = auditValue()?.auditSequence || 0; await app.press("id:projects-fixture-audit"); await app.waitUntil(() => (auditValue()?.auditSequence || 0) > before); return auditValue(); };',
      ...steps,
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}
run('production Projects Undo restores the subtree with zero delete calls and retains menus/change counts', () => {
  engine([
    'await app.waitFor("text:Projects deferred root");',
    'await app.waitFor("text:+12 −3");',
    'app.onDialog(() => "Delete session");',
    'await app.press("id:project-session-menu-root");',
    'await app.waitFor("text:Deleted 3 sessions");',
    'expect(app.dialogs().length).toBe(2); expect(JSON.stringify(app.dialogs().at(-1))).toContain("Delete session?");',
    'await app.waitFor("id:project-session-root", {state:"gone"});',
    'const pending = await readAudit(); expect(pending.writes).toBe(0); expect(pending.attempts).toEqual([]);',
    'await app.press("id:projects-delete-undo-projects-delete-1");',
    'await app.waitFor("id:project-session-root");',
    'const restored = await readAudit(); expect(restored.writes).toBe(0); expect(restored.rejectedRequests).toBe(0);',
    'await app.waitFor("id:project-session-menu-root");',
  ]);
}, 90_000);
run('production Projects expiry retains the failed branch for explicit retry without replaying successful deletes', () => {
  engine([
    'await app.waitFor("id:project-session-root");',
    'app.onDialog(() => "Delete session"); await app.press("id:project-session-menu-root");',
    'await app.waitFor("id:projects-delete-undo-projects-delete-1");',
    'expect(app.dialogs().length).toBe(2); expect(JSON.stringify(app.dialogs().at(-1))).toContain("Delete session?");',
    'const pending = await readAudit(); expect(pending.writes).toBe(0);',
    'await app.waitFor("id:projects-delete-failed-projects-delete-1", {timeout:15000});',
    'await app.waitFor("id:project-session-root"); await app.waitFor("id:project-session-other");',
    'const failed = await readAudit(); expect(failed.attempts).toEqual(["bad", "good"]); expect(failed.removed).toEqual(["good"]);',
    'await app.press("id:projects-delete-failed-projects-delete-1");',
    'await app.waitFor("id:project-session-root", {state:"gone"});',
    'const committed = await readAudit(); expect(committed.attempts).toEqual(["bad", "good", "bad", "root"]); expect(committed.rejectedRequests).toBe(0);',
    'await app.waitFor("id:project-session-other");',
  ]);
}, 90_000);
run('production Projects keeps completed unread in progress and clears it on open via the root viewed seam', () => {
  engine([
    'await app.waitFor("id:project-session-root");',
    'await app.waitFor("text:Root catalog ready");',
    'await app.press("id:projects-fixture-complete");',
    'await app.waitUntil(() => app.texts().filter(text => text === "Projects deferred root").length === 2);',
    'await app.press("id:project-session-root >> nth=0");',
    'await app.waitFor("text:Viewed: root");',
    'await app.waitUntil(() => app.texts().filter(text => text === "Projects deferred root").length === 1);',
    'const audit = await readAudit(); expect(audit.writes).toBe(0); expect(audit.rejectedRequests).toBe(0);',
  ]);
}, 90_000);

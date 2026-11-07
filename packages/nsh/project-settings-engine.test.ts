import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { withProjectSettingsFixture } from './tests/project-settings-runner.js';

// Opt-in only. Main owns engine/UIKit scheduling; pure validation never starts NSH.
const run = process.env.NSH_PROJECT_SETTINGS_ENGINE === '1' ? test : test.skip;
const cwd = path.dirname(fileURLToPath(import.meta.url));
function nativeTest(steps: string[]) {
  withProjectSettingsFixture(cwd, (fixture: { directory: string; entry: string; host: string }) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, encoding: 'utf8', timeout: 60_000, input: [
      'const auditValue = () => JSON.parse(app.texts().find(text => text.startsWith("{\\"writes\\":")) || "null");',
      'const readAudit = async () => { const previous = auditValue()?.auditSequence || 0; await app.press("id:project-fixture-audit"); await app.waitUntil(() => (auditValue()?.auditSequence || 0) > previous); return auditValue(); };',
      ...steps,
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}
run('project actions preserve rejected drafts and retry read-back without replaying the write', () => {
  nativeTest([
    'await app.waitFor("id:project-settings-open");',
    'await app.press("id:project-settings-open");',
    'await app.waitFor("id:project-action-expand-serve");',
    'await app.press("id:project-action-expand-serve");',
    'await app.waitFor("id:project-action-command-serve");',
    'await app.type("id:project-action-command-serve", "edited fixture command");',
    'const draft = app.value("id:project-action-command-serve");',
    'await app.waitFor("text:HTTP 409: Fixture project configuration conflict");',
    'expect(app.value("id:project-action-command-serve")).toBe(draft);',
    'const rejected = await readAudit(); expect(rejected.writes).toBe(1); expect(rejected.commits).toBe(0); expect(rejected.rejectedRequests).toBe(0);',
    'await app.press("id:project-actions-save");',
    'await app.waitFor("text:HTTP 503: Fixture read-back unavailable");',
    'expect(app.value("id:project-action-command-serve")).toBe(draft);',
    'const pending = await readAudit(); expect(pending.writes).toBe(2); expect(pending.commits).toBe(1); expect(pending.rejectedRequests).toBe(0);',
    'await app.press("id:project-actions-save");',
    'await app.waitFor("text:Project actions saved");',
    'const confirmed = await readAudit(); expect(confirmed.writes).toBe(pending.writes); expect(confirmed.commits).toBe(pending.commits); expect(confirmed.rejectedRequests).toBe(0);',
    'await app.back();',
    'await app.waitFor("id:project-settings-open");',
    'await app.press("id:project-settings-open");',
    'await app.waitFor("id:project-action-expand-serve");',
    'await app.press("id:project-action-expand-serve");',
    'await app.waitFor("id:project-action-command-serve");',
    'expect(app.value("id:project-action-command-serve")).toBe(draft.trim());',
    'await app.press("id:project-action-add");',
    'await app.waitFor("text:Untitled action");',
    'app.onDialog(() => "Cancel");',
    'await app.back();',
    'expect(JSON.stringify(app.dialogs().at(-1))).toContain("Unsaved changes");',
    'await app.waitFor("text:Untitled action");',
    'app.onDialog(() => "Discard");',
    'await app.back();',
    'expect(JSON.stringify(app.dialogs().at(-1))).toContain("Unsaved changes");',
    'await app.waitFor("id:project-settings-open");',
    'const afterDiscard = await readAudit(); expect(afterDiscard.writes).toBe(confirmed.writes); expect(afterDiscard.actionCount).toBe(1); expect(afterDiscard.rejectedRequests).toBe(0);',
  ]);
}, 105_000);

run('setup command rows, deletion and wait strategy use the same captured root config without running commands', () => {
  nativeTest([
    'await app.waitFor("id:project-settings-open");',
    'await app.press("id:project-settings-open");',
    'await app.waitFor("id:project-setup-command-0");',
    'await app.clear("id:project-setup-command-0");',
    'await app.type("id:project-setup-command-0", "edited setup fixture");',
    'expect(app.value("id:project-setup-command-0")).toBe("edited setup fixture");',
    'const command = app.value("id:project-setup-command-0");',
    'await app.waitFor("text:HTTP 409: Fixture project configuration conflict");',
    'expect(app.value("id:project-setup-command-0")).toBe(command);',
    'await app.press("id:project-setup-save");',
    'await app.waitFor("text:HTTP 503: Fixture read-back unavailable");',
    'const pending = await readAudit(); expect(pending.writes).toBe(2); expect(pending.commits).toBe(1); expect(pending.rejectedRequests).toBe(0);',
    'await app.press("id:project-setup-save");',
    'await app.waitFor("text:Saved");',
    'const confirmed = await readAudit(); expect(confirmed.writes).toBe(pending.writes); expect(confirmed.commits).toBe(pending.commits); expect(confirmed.rejectedRequests).toBe(0);',
    'await app.press("id:project-setup-add");',
    'await app.waitFor("id:project-setup-command-2");',
    'await app.type("id:project-setup-command-2", "added fixture setup");',
    'expect(app.value("id:project-setup-command-2")).toBe("added fixture setup");',
    'await app.press("id:project-setup-save");',
    'await app.waitFor("text:Saved");',
    'await app.press("id:project-setup-delete-1");',
    'expect(app.value("id:project-setup-command-0")).toBe("edited setup fixture");',
    'expect(app.value("id:project-setup-command-1")).toBe("added fixture setup");',
    'await app.press("id:project-setup-save");',
    'await app.waitFor("text:Saved");',
    'await app.press("id:project-setup-wait");',
    'await app.waitFor("text:Saved");',
    'await app.back();',
    'await app.waitFor("id:project-settings-open");',
    'await app.press("id:project-settings-open");',
    'await app.waitFor("id:project-setup-command-0");',
    'expect(app.value("id:project-setup-command-0")).toBe("edited setup fixture");',
    'expect(app.value("id:project-setup-command-0")).toBe(command);',
    'expect(app.value("id:project-setup-command-1")).toBe("added fixture setup");',
    'const final = await readAudit(); expect(final.commands).toEqual([command, "added fixture setup"]); expect(final.wait).toBe(false); expect(final.actionCount).toBe(1); expect(final.rejectedRequests).toBe(0); expect(final.writes - final.commits).toBe(1);',
  ]);
}, 105_000);

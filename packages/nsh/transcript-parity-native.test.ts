import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], ios = false) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'transcript-parity-fixture.tsx', ...(ios ? ['--target', 'ios'] : ['--web-host', 'tests/host.js'])], {
    cwd: directory, encoding: 'utf8', timeout: 90_000, input: [`const capture = ${ios && process.env.NSH_ACTIVITY_SCREENSHOTS === '1'};`, 'await app.waitFor("text:READY");', ...steps].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
it('production header belongs to the turn, labels array catalogs, and reasoning follows Host preference', () => {
  run([
    'expect(app.texts().filter(text => text === "Catalog GPT").length).toBe(1);',
    'expect(app.shows("text:Catalog Claude")).toBe(false);',
    'expect(app.shows("text:FINAL ANSWER")).toBe(true);',
    'expect(app.shows("text:EARLY TEXT")).toBe(false);',
    'await app.press("id:body-activity-a");', 'await app.waitFor("text:THOUGHT");',
    'expect(app.shows("id:body-part-a:reasoning:0")).toBe(false);',
    'await app.press("id:body-reasoning-a:reasoning:0");', 'await app.waitFor("id:body-part-a:reasoning:0");',
    'await app.press("id:reasoning-off");', 'await app.waitUntil(() => !app.shows("text:THOUGHT"));',
    'expect(app.shows("text:EARLY TEXT")).toBe(true);',
    'await app.press("id:live-mode");', 'await app.waitUntil(() => !app.shows("id:body-activity-a"));',
    'expect(app.shows("text:EARLY TEXT")).toBe(true);',
  ]);
}, 75_000);
it('all Activity segments share the same turn toggle without crossing a visible notice', () => {
  run([
    'await app.press("id:segmented");', 'await app.waitFor("id:body-activity-b");',
    'expect(app.shows("id:body-process:a:read-a")).toBe(false);',
    'expect(app.shows("id:body-process:b:read-b")).toBe(false);',
    'await app.press("id:body-activity-a");',
    'expect(app.shows("id:body-process:a:read-a")).toBe(true);',
    'expect(app.shows("id:body-process:b:read-b")).toBe(true);',
    'await app.press("id:body-activity-b");',
    'await app.waitUntil(() => !app.shows("id:body-process:a:read-a"));',
    'expect(app.shows("id:body-process:a:read-a")).toBe(false);',
    'expect(app.shows("id:body-process:b:read-b")).toBe(false);',
    'expect(app.shows("text:FINAL ANSWER")).toBe(true);',
  ]);
}, 75_000);
it('compaction body folds even without tools and pending header survives the first identity-less packet', () => {
  run([
    'await app.press("id:compact");', 'await app.waitFor("id:body-activity-summary");',
    'expect(app.shows("text:COMPACT SUMMARY")).toBe(false);',
    'await app.press("id:body-activity-summary");', 'await app.waitFor("text:COMPACT SUMMARY");',
    'await app.press("id:body-activity-summary");', 'expect(app.shows("text:COMPACT SUMMARY")).toBe(false);',
    'await app.press("id:pending-header");', 'await app.waitFor("text:Catalog GPT");',
    'await app.press("id:first-packet");', 'await app.waitFor("text:PACKET");',
    'expect(app.texts().filter(text => text === "Catalog GPT").length).toBe(1);',
  ]);
}, 75_000);
it('an incoming partial snapshot does not erase a mounted header identity', () => {
  run([
    'await app.press("id:wire-identity");', 'await app.waitFor("text:Catalog GPT");',
    'await app.press("id:drop-identity");', 'expect(app.shows("text:Catalog GPT")).toBe(true);',
  ]);
}, 75_000);
it('summary preference supplies the automatic default without replacing an explicit turn toggle', () => {
  run([
    'await app.press("id:summary-mode");', 'await app.waitFor("text:THOUGHT");',
    'await app.press("id:body-activity-a");', 'await app.waitUntil(() => !app.shows("text:THOUGHT"));',
    'await app.press("id:reasoning-off");', 'expect(app.shows("text:EARLY TEXT")).toBe(false);',
  ]);
}, 75_000);
it('consecutive Skills retain their own nested disclosure and original three-name overflow summary', () => {
  run([
    'await app.press("id:skills");', 'await app.waitFor("id:body-activity-a");',
    'await app.press("id:body-activity-a");', 'await app.waitFor("id:body-skill:skills:alpha");',
    'expect(app.shows("id:tool-expand-alpha")).toBe(false);',
    'await app.press("id:body-skill:skills:alpha");', 'await app.waitFor("id:tool-expand-alpha");',
    'expect(app.shows("id:tool-expand-delta")).toBe(true);',
    'await app.press("id:body-skill:skills:alpha");', 'await app.waitUntil(() => !app.shows("id:tool-expand-alpha"));',
    'expect(app.shows("text:FINAL ANSWER")).toBe(true);',
  ]);
}, 75_000);
const activitySteps = [
  'await app.press("id:tasks");', 'await app.waitFor("id:activity-agent-child-one");',
  'expect(app.shows("id:activity-agent-child-two")).toBe(true);',
  'expect(app.shows("id:activity-agent-child-three")).toBe(false);',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/activity-agents-uikit.png");',
  'await app.press("id:active-compact");', 'await app.waitFor("id:body-activity-summary");',
  'expect(app.enabled("id:body-activity-summary")).toBe(false);',
  'expect(app.shows("id:body-activity-arrow-summary")).toBe(false);',
  'expect(app.shows("text:STREAMING SUMMARY")).toBe(true);',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/activity-compacting-uikit.png");',
  'await app.press("id:settle");', 'await app.waitUntil(() => app.enabled("id:body-activity-summary"));',
  'await app.press("id:body-activity-summary");', 'await app.waitFor("text:STREAMING SUMMARY");',
  'await app.press("id:body-activity-summary");', 'await app.waitUntil(() => !app.shows("text:STREAMING SUMMARY"));',
  'await app.press("id:slim");', 'await app.waitFor("id:body-activity-slim");',
  'expect(app.shows("text:READS 0")).toBe(true);',
  'await app.press("id:body-activity-slim");', 'await app.waitFor("id:activity-fill-retry-slim");',
  'expect(app.shows("text:READS 1")).toBe(true);',
  'await app.press("id:remount");', 'await app.press("id:remount");',
  'await app.waitFor("id:activity-fill-retry-slim");', 'expect(app.shows("text:READS 1")).toBe(true);',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/activity-fill-error-uikit.png");',
  'await app.press("id:activity-fill-retry-slim");', 'await app.waitFor("text:READS 2");',
  'await app.waitUntil(() => !app.shows("id:activity-fill-retry-slim"));',
  'await app.waitFor("text:EXACT THOUGHT");',
  'if (capture) await app.screenshot("../../.scratch/nsh/chat-frames/activity-fill-ready-uikit.png");',
  'await app.press("id:body-activity-slim");', 'await app.press("id:body-activity-slim");',
  'expect(app.shows("text:READS 2")).toBe(true);',
];
it('production Activity caps child faces, locks active compaction, and retries slim failure only on explicit action across remounts', () => {
  run(activitySteps);
}, 75_000);
it('explicit outer disclosure never crosses a turn boundary', () => {
  run([
    'await app.press("id:two-turns");', 'await app.waitFor("id:body-activity-a2");',
    'await app.press("id:body-activity-a");',
    'expect(app.shows("id:body-process:a:read-a")).toBe(true);',
    'expect(app.shows("id:body-process:a2:read-a")).toBe(false);',
    'await app.press("id:body-activity-a2");', 'await app.press("id:body-activity-a");',
    'expect(app.shows("id:body-process:a:read-a")).toBe(false);',
    'expect(app.shows("id:body-process:a2:read-a")).toBe(true);',
  ]);
}, 75_000);
it.skipIf(process.env.NSH_PARITY_IOS !== '1')('UIKit renders arbitrary child artwork, compaction transitions and exact-fill recovery in production components', () => {
  run(activitySteps, true);
}, 105_000);
it.skipIf(process.env.NSH_PARITY_IOS !== '1')('UIKit exercises production turn/model and shared segmented disclosure without a model request', () => {
  run([
    'expect(app.texts().filter(text => text === "Catalog GPT").length).toBe(1);',
    'expect(app.shows("text:Catalog Claude")).toBe(false);',
    'await app.press("id:segmented");', 'await app.waitFor("id:body-activity-b");',
    'await app.press("id:body-activity-a");', 'await app.waitFor("id:body-process:b:read-b");',
    'expect(app.shows("id:body-process:a:read-a")).toBe(true);',
    'await app.press("id:body-activity-b");', 'await app.waitUntil(() => !app.shows("id:body-process:a:read-a"));',
    'expect(app.shows("text:FINAL ANSWER")).toBe(true);',
    'await app.press("id:compact");', 'await app.waitFor("id:body-activity-summary");',
    'expect(app.shows("text:COMPACT SUMMARY")).toBe(false);',
    'await app.press("id:body-activity-summary");', 'await app.waitFor("text:COMPACT SUMMARY");',
    'await app.press("id:pending-header");', 'await app.waitFor("text:Catalog GPT");',
    'await app.press("id:first-packet");', 'await app.waitFor("text:PACKET");',
    'expect(app.texts().filter(text => text === "Catalog GPT").length).toBe(1);',
  ], true);
}, 105_000);

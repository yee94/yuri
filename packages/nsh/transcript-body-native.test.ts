import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], trace = false) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'transcript-body-fixture.tsx', '--web-host', 'tests/host.js', ...(trace ? ['--trace'] : [])], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: ['await app.waitFor("id:body-activity-step");', ...steps].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout + result.stderr;
}
it('production body repeats outer/group/input-output disclosure without losing original text order (headless only)', () => {
  run([
    'expect(app.shows("text:FIRST TEXT")).toBe(false);',
    'expect(app.shows("text:FINAL TEXT")).toBe(true);',
    'await app.press("id:body-activity-step");',
    'await app.waitFor("text:FIRST TEXT");',
    'expect(app.texts().indexOf("FIRST TEXT") < app.texts().indexOf("SECOND TEXT")).toBe(true);',
    'expect(app.texts().indexOf("SECOND TEXT") < app.texts().indexOf("FINAL TEXT")).toBe(true);',
    'expect(app.shows("id:tool-expand-call")).toBe(false);',
    'await app.press("id:body-process:step:call");',
    'await app.waitFor("id:tool-expand-call");',
    'expect(app.texts()).toContain("11.4s");',
    'await app.press("id:tool-expand-call");',
    'await app.waitFor("text:OUTPUT");',
    'expect(app.shows("text:FIRST TEXT")).toBe(true);',
    'expect(app.shows("id:tool-expand-call")).toBe(true);',
    'expect(app.shows("id:body-process:step:call")).toBe(true);',
    'expect(app.shows("id:body-activity-step")).toBe(true);',
    'expect(app.texts().join(" ")).toContain("printf INPUT");',
    'expect(app.texts().indexOf("SECOND TEXT") < app.texts().indexOf("OUTPUT")).toBe(true);',
    'expect(app.texts().indexOf("OUTPUT") < app.texts().indexOf("FINAL TEXT")).toBe(true);',
    'await app.press("id:tool-expand-call");',
    'expect(app.shows("text:OUTPUT")).toBe(false);',
    'expect(app.shows("text:FIRST TEXT")).toBe(true);',
    'expect(app.shows("id:tool-expand-call")).toBe(true);',
    'await app.press("id:body-process:step:call");',
    'expect(app.shows("id:tool-expand-call")).toBe(false);',
    'await app.press("id:body-activity-step");',
    'expect(app.shows("text:FIRST TEXT")).toBe(false);',
    'await app.press("id:body-activity-step");',
    'await app.waitFor("text:SECOND TEXT");',
  ]);
}, 75_000);
it('production nested tools read current pending/error/completed payload after same-key replacement (headless only)', () => {
  run([
    'await app.press("id:body-activity-step");', 'await app.press("id:body-process:step:call");', 'await app.press("id:tool-expand-call");',
    'await app.press("id:replace");', 'await app.waitFor("text:OUTPUT UPDATED");',
    'expect(app.shows("text:FIRST TEXT")).toBe(false);',
    'expect(app.texts().join(" ")).toContain("printf INPUT UPDATED");',
    'await app.press("id:pending");', 'await app.waitFor("id:body-process:step:call-active");',
    'await app.press("id:error");', 'await app.waitFor("text:FAILURE");',
    'expect(app.shows("id:body-process:step:call-settled")).toBe(true);',
    'expect(app.shows("text:OUTPUT UPDATED")).toBe(false);',
  ]);
}, 75_000);
it('production List virtualizes bodies, preserves short turns, and replacement props reach remounted tail (headless only)', () => {
  run([
    'await app.press("id:grow");', 'await app.press("id:start");', 'await app.waitFor("id:turn-body-filler-0");',
    'expect(app.shows("id:body-activity-filler-0")).toBe(false);',
    'await app.press("id:tail");', 'await app.waitFor("id:body-activity-filler-39");',
    'await app.press("id:body-activity-filler-39");', 'await app.waitFor("text:SECOND TEXT");',
    'await app.press("id:replace");', 'await app.press("id:tail");', 'await app.waitFor("id:body-activity-step");',
    'await app.press("id:body-activity-step");', 'await app.waitFor("text:SECOND TEXT UPDATED");',
    'expect(app.shows("text:SECOND TEXT")).toBe(false);',
  ]);
}, 75_000);
it('long original user body clamps by ten-line layout, hides attachments, and expands/collapses without changing source (headless only)', () => {
  run([
    'await app.press("id:user-long");',
    'await app.waitFor("id:user-show-more-long-user:long-text");',
    'expect(app.shows("text:retained.txt")).toBe(false);',
    'const height = () => Number(app.texts().find(value => value.startsWith("BODY_HEIGHT:")).split(":")[1]);',
    'expect(height() < 320).toBe(true);',
    'await app.press("id:user-show-more-long-user:long-text");',
    'await app.waitFor("id:user-collapse-long-user:long-text");',
    'expect(app.shows("text:retained.txt")).toBe(true);',
    'expect(app.texts().join(" ")).toContain("Original line 16 with full source retained.");',
    'expect(height() > 400).toBe(true);',
    'await app.press("id:user-collapse-long-user:long-text");',
    'await app.waitFor("id:user-show-more-long-user:long-text");',
    'expect(app.shows("text:retained.txt")).toBe(false);',
    'await app.press("id:preference");',
    'await app.waitFor("text:retained.txt");',
    'expect(app.shows("id:user-show-more-long-user:long-text")).toBe(false);',
    'await app.press("id:preference");',
    'await app.waitFor("id:user-show-more-long-user:long-text");',
    'await app.press("id:user-replace");',
    'await app.waitFor("text:replacement.txt");',
    'expect(app.shows("id:user-show-more-long-user:replacement-text")).toBe(false);',
    'await app.press("id:user-short");',
    'expect(app.shows("text:Short original")).toBe(true);',
    'expect(app.shows("id:user-show-more-short-user:short-text")).toBe(false);',
  ]);
}, 75_000);
it('production Activity has an explicit arrow in both disclosure states (headless only)', () => {
  run([
    'expect(app.shows("id:body-activity-arrow-step")).toBe(true);',
    'await app.press("id:body-activity-step");',
    'expect(app.shows("id:body-activity-arrow-step")).toBe(true);',
  ]);
}, 75_000);
it('production ordered lists retain 9–16 numbering and use smaller markers (headless only)', () => {
  run([
    'await app.press("id:numbered");',
    'await app.waitFor("text:16.");',
    'expect(app.shows("text:9.")).toBe(true);',
    'expect(app.shows("text:10.")).toBe(true);',
    'expect(app.spanStyle("text:10.").fontSize < app.spanStyle("text:Integer 10").fontSize).toBe(true);',
  ]);
}, 75_000);
it('headless mount frames keep every 9–16 intrinsic marker inside the viewport with a 6pt gap before its text', () => {
  const trace = run(['await app.press("id:numbered");', 'await app.waitFor("text:16.");'], true);
  const parents = new Map<number, number>(), frames = new Map<number, { x: number; width: number }>(), texts = new Map<number, string>();
  for (const line of trace.split('\n')) {
    const insert = /Insert \{ parent: (\d+), child: (\d+)/.exec(line);
    if (insert) parents.set(Number(insert[2]), Number(insert[1]));
    const deleted = /Delete \{ id: (\d+)/.exec(line);
    if (deleted) { const id = Number(deleted[1]); parents.delete(id); frames.delete(id); texts.delete(id); }
    const text = /Text \{ id: (\d+), text: "([^"]*)"/.exec(line);
    if (text) texts.set(Number(text[1]), text[2]!);
    const frame = /Frame \{ id: (\d+), x: (-?[\d.]+), y: -?[\d.]+, w: ([\d.]+)/.exec(line);
    if (frame) frames.set(Number(frame[1]), { x: Number(frame[2]), width: Number(frame[3]) });
  }
  function find(value: string) { const pair = [...texts].find(([, text]) => text === value); expect(pair, value).toBeDefined(); return pair![0]; }
  function x(id: number) { let value = 0; const seen = new Set<number>(); while (!seen.has(id)) { seen.add(id); value += frames.get(id)?.x ?? 0; const parent = parents.get(id); if (parent === undefined) break; id = parent; } return value; }
  for (let index = 9; index <= 16; index++) {
    const marker = find(`${index}.`), body = find(`Integer ${index}`);
    expect(x(marker), `marker ${index} viewport x`).toBeGreaterThanOrEqual(0);
    expect(x(marker) + frames.get(marker)!.width).toBeLessThanOrEqual(x(body));
    expect(frames.get(marker)!.width).toBeGreaterThan(0);
    expect(x(body) - x(marker) - frames.get(marker)!.width).toBeCloseTo(6, 1);
  }
}, 75_000);

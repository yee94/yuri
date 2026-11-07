import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createReferenceKeyboard, type ReferenceKeyboardContext } from './composer-reference-keyboard';
import { mixedReferenceRows, type ReferenceCandidate } from './composer-references';

test('query reset, identity retention, wrapping, scope fence and selection CAS share one core', () => {
  const scope = { host: 'host', draft: 'draft', directory: '/workspace' };
  let context: ReferenceKeyboardContext | null = { scope, query: 'src', text: '@src tail', start: 0, end: 4, editing: true };
  const selected: ReferenceCandidate[] = [];
  const core = createReferenceKeyboard({ read: () => context, publish: () => {}, choose: candidate => { selected.push(candidate); }, dismiss: () => { context = null; } });
  const rows = mixedReferenceRows(['a', 'b', 'c'].map(value => ({ kind: 'file', value: `src/${value}`, label: value, scope })), 'src');
  core.rows({ scope, query: 'src' }, rows);
  core.key('down'); expect(core.state().id).toBe(rows[1].presentation.id);
  core.rows({ scope, query: 'src' }, [], true); expect(core.state().rows).toEqual([]);
  core.rows({ scope, query: 'src' }, rows); expect(core.state().id).toBe(rows[1].presentation.id);
  core.rows({ scope, query: 'src' }, [rows[2], rows[1], rows[0]]); expect(core.state().index).toBe(1);
  core.rows({ scope, query: 'src' }, [rows[1], rows[0]]); expect(core.state().index).toBe(0);
  core.rows({ scope, query: 'src' }, [rows[2], rows[0]]); expect(core.state().index).toBe(0);
  core.rows({ scope, query: 'src' }, [rows[1], rows[0]]);
  core.key('up'); expect(core.state().index).toBe(1);
  core.key('down'); expect(core.state().index).toBe(0);
  expect(core.key('mod+down')).toBe(false);
  context = { ...context!, text: '@src other tail' };
  expect(core.choose(rows[1].presentation.id)).toBe(false); expect(selected).toEqual([]);
  core.rows({ scope, query: 'src' }, rows);
  core.key('tab'); expect(selected).toHaveLength(1);
  context = { ...context!, query: 'next' }; core.sync(); expect(core.state().rows).toEqual([]);
  core.rows({ scope, query: 'src' }, rows); expect(core.state().rows).toEqual([]);
  context = { ...context!, query: 'src', scope: { ...scope, host: 'next' } }; core.rows({ scope, query: 'src' }, rows); expect(core.state().rows).toEqual([]);
  context = { ...context!, scope: { ...scope, host: '' } }; expect(core.sync()).toBeNull();
  context = { scope, query: 'src', text: '@src', start: 0, end: 4, editing: false }; core.rows({ scope, query: 'src' }, rows); expect(core.key('enter')).toBe(false);
  context.editing = true; expect(core.key('escape')).toBe(true); expect(core.state().rows).toEqual([]);
});

function headless(steps: string[]) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'composer-reference-keyboard-fixture.tsx', '--web-host', 'tests/composer-references-chat-host.js'], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: ['await app.waitFor("text:ready");', 'await app.paste("id:keyboard-composer", {text:""});', ...steps].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('real headless keyboard navigates, wraps, chooses by Enter/Tab, dismisses without sending, and preserves tail', () => headless([
  'await app.type("id:keyboard-composer", "@src");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'expect(app.texts()).toContain("active:1:file:src/file-00.ts");',
  'await app.keyboard.press("up");',
  'await app.keyboard.press("down");',
  'expect(app.texts()).toContain("active:1:file:src/file-00.ts");',
  'await app.keyboard.press("tab");',
  'expect(app.value("id:keyboard-composer")).toBe("@src/file-00.ts ");',
  'expect(app.texts()).toContain("refs:1");',
  'expect(app.texts()).toContain("fallback:none");',
  'await app.type("id:keyboard-composer", "@src");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.keyboard.press("up");',
  'await app.keyboard.press("up");',
  'expect(app.texts()).toContain("active:9:file:src/file-08.ts");',
  'expect(app.shows("id:reference-result-file-src/file-08.ts")).toBe(true);',
  'await app.keyboard.press("down");',
  'expect(app.texts()).toContain("active:0:file:src/");',
  'await app.keyboard.press("escape");',
  'expect(app.value("id:keyboard-composer")).toBe("@src/file-00.ts @src");',
  'expect(app.shows("id:reference-picker")).toBe(false);',
  'await app.press("id:middle");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.keyboard.press("up");',
  'await app.keyboard.press("down");',
  'await app.keyboard.press("enter");',
  'expect(app.value("id:keyboard-composer")).toBe("Read @src/file-00.ts and keep tail");',
  'expect(app.texts()).toContain("refs:1");',
]), 75_000);

test('soft submit and pointer choose share admission, query changes clamp and empty Enter never sends', () => headless([
  'await app.type("id:keyboard-composer", "@src");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.submit("id:keyboard-composer");',
  'expect(app.value("id:keyboard-composer")).toBe("@src/file-00.ts ");',
  'expect(app.texts()).toContain("refs:1");',
  'await app.type("id:keyboard-composer", "@reviewer");',
  'await app.waitFor("id:reference-result-agent-reviewer");',
  'expect(app.texts()).toContain("active:0:agent:reviewer");',
  'await app.press("id:reference-result-agent-reviewer");',
  'expect(app.value("id:keyboard-composer")).toBe("@src/file-00.ts @reviewer ");',
  'expect(app.texts()).toContain("refs:2");',
  'await app.type("id:keyboard-composer", "@unmatched");',
  'await app.wait(400);',
  'expect(app.texts()).toContain("rows:0");',
  'await app.keyboard.press("enter");',
  'expect(app.value("id:keyboard-composer")).toBe("@src/file-00.ts @reviewer @unmatched");',
  'expect(app.texts()).toContain("refs:2");',
  'expect(app.texts()).toContain("fallback:none");',
  'await app.keyboard.press("escape");',
  'await app.type("id:keyboard-composer", " closed typing");',
  'await app.wait(400);',
  'expect(app.shows("id:reference-picker")).toBe(false);',
  'expect(app.texts()).toContain("calls:15");',
]), 75_000);

test('host and page changes remove pending selection and release hardware bindings', () => headless([
  'await app.type("id:keyboard-composer", "@src");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.keyboard.press("down");',
  'await app.press("id:host");',
  'await app.keyboard.press("enter");',
  'expect(app.texts()).toContain("refs:0");',
  'expect(app.texts()).toContain("fallback:enter");',
  'await app.press("id:page");',
  'await app.wait(350);',
  'expect(app.texts()).toContain("active:0:none");',
  'await app.keyboard.press("tab");',
  'expect(app.texts()).toContain("fallback:tab");',
  'expect(app.shows("id:reference-picker")).toBe(false);',
]), 75_000);

test('real keymap releases bare keys for IME, selection, blur and inactive page; modifiers never navigate', () => headless([
  'await app.type("id:keyboard-composer", "@src");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.keyboard.press("mod+down");',
  'expect(app.texts()).toContain("fallback:mod+down");',
  'await app.keyboard.press("shift+tab");',
  'expect(app.texts()).toContain("fallback:shift+tab");',
  'expect(app.texts()).toContain("refs:0");',
  'await app.press("id:ime-start");',
  'await app.clear("id:keyboard-composer");',
  'await app.type("id:keyboard-composer", "@src");',
  'await app.wait(350);',
  'expect(app.texts()).toContain("calls:5");',
  'await app.keyboard.press("down");',
  'expect(app.texts()).toContain("fallback:down");',
  'expect(app.shows("id:reference-picker")).toBe(false);',
  'await app.press("id:ime-end");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.press("id:middle");',
  'await app.press("id:selection");',
  'await app.keyboard.press("enter");',
  'expect(app.texts()).toContain("fallback:enter");',
  'expect(app.texts()).toContain("refs:0");',
  'await app.type("id:other-input", "focus");',
  'await app.keyboard.press("tab");',
  'expect(app.texts()).toContain("fallback:tab");',
  'await app.press("id:page");',
  'await app.keyboard.press("escape");',
  'expect(app.texts()).toContain("fallback:escape");',
  'expect(app.shows("id:reference-picker")).toBe(false);',
]), 75_000);

test('background lifecycle clears rows and unbinds without changing the draft', () => headless([
  'await app.type("id:keyboard-composer", "@src");',
  'await app.waitFor("id:reference-result-directory-src/");',
  'await app.setLifecycle("background");',
  'await app.keyboard.press("enter");',
  'expect(app.texts()).toContain("fallback:enter");',
  'expect(app.texts()).toContain("rows:0");',
  'expect(app.value("id:keyboard-composer")).toBe("@src");',
  'expect(app.texts()).toContain("refs:0");',
  'expect(app.shows("id:reference-picker")).toBe(false);',
]), 75_000);

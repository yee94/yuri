import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHost } from './tests/transcript-host.js';
import { createNativeAppearanceSync, type AppliedNativeAppearance } from './appearance-core';
import { nativeAssistantTps } from './chat-preferences-core';
import { messagesFrom } from './model';
import { nativeBodyRows } from './transcript-body-model';
import { nativeTurnHeaderMessage, nativeTurnPresentation } from './transcript-tools-turn-model';

const directory = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, fixture: string, engineDirectory: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'nsh-transcript-'));
  fixture = path.join(temporary, 'host.js');
  engineDirectory = mkdtempSync(path.join(directory, 'tests', '.transcript-engine-'));
  const result = spawnSync('bun', ['build', 'tests/transcript-host.js', '--target=browser', '--outfile', fixture], { cwd: directory, encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  if (engineDirectory) rmSync(engineDirectory, { recursive: true, force: true });
});
function run(steps: string[]) {
  const engineTest = path.join(engineDirectory, 'transcript-engine.test.tsx');
  writeFileSync(engineTest, [
    'import { expect, open, test } from "nsh/test";',
    'test("production transcript callbacks on the headless non-iOS surface", async () => {',
    `const app = await open(${JSON.stringify(path.join(directory, 'App.tsx'))}, { platform: 'macos', storage: {}, network: {} });`,
    'try {',
    'await app.waitFor("text:Native conversation");', 'await app.press("text:Native conversation");', 'await app.waitFor("id:history-edit-history-user");',
    ...steps,
    '} finally { app.dispose(); }',
    '});',
  ].join('\n'));
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', engineTest, '--web-host', fixture], {
    cwd: directory, encoding: 'utf8', timeout: 60_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

function appearanceFixture(host = createHost()) {
  let current: AppliedNativeAppearance | null = null, error = '';
  const read = async (path: string) => {
    const result = host.call('runtime.request', { path, method: 'GET' });
    if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
    return result.body;
  };
  const sync = createNativeAppearanceSync({
    readSettings: () => read('/api/config/settings'), readThemes: () => read('/api/config/themes'),
    reset: async scope => host.call('appearance.reset', { hostID: scope?.hostID ?? null }).revision,
    apply: async (scope, revision, appearance) => host.call('appearance.apply', { hostID: scope.hostID, revision, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts }),
    changed: value => { current = value; }, failed: message => { error = message; },
  });
  sync.setScope({ hostID: 'fixture', url: 'https://host.example', generation: 1 });
  return { host, sync, snapshot: (): AppliedNativeAppearance | null => current, error: () => error };
}

test('the transcript Host rejects stale and missing write scopes before changing history', () => {
  const host = createHost();
  const scope = host.call('connection.list', {}).runtimeScope;
  const path = '/api/session/ses_1/revert/stage?directory=%2Fworkspace%2Fproject';
  const body = { messageID: 'history-user', files: false };
  expect(() => host.call('runtime.request', { path, method: 'POST', body })).toThrow('Missing synthetic chat scope');
  expect(() => host.call('runtime.request', { path, method: 'POST', body, expectedHost: { ...scope, lease: 'retired' } })).toThrow('Stale synthetic chat scope');
  expect(host.call('runtime.request', { path: '/api/session/ses_1/message?', method: 'GET' }).body.data).toHaveLength(3);
  expect(host.call('runtime.request', { path, method: 'POST', body, expectedHost: scope }).status).toBe(200);
  expect(() => host.call('runtime.request', { path: '/api/session/ses_1/revert?', method: 'DELETE' })).toThrow('Missing synthetic chat scope');
  expect(host.call('runtime.request', { path: '/api/session/ses_1/message?', method: 'GET' }).body.data).toEqual([]);
  expect(host.call('runtime.request', { path: '/api/git/remotes?directory=%2Fworkspace%2Fproject', method: 'GET' }).body).toEqual([]);
});

test('transcript fixture authorizes the exact historical TPS through the real root appearance protocol (pure)', async () => {
  const { host, sync, snapshot, error } = appearanceFixture();
  const history = messagesFrom(host.call('runtime.request', { path: '/api/session/ses_1/message?', method: 'GET' }).body, false).messages;
  const footer = nativeTurnPresentation(history).get('history-final-answer')!;
  expect(footer).toEqual({ header: false, footer: true, tps: '7.5 tok/s', duration: '4.3s' });
  expect(nativeAssistantTps(footer.tps, snapshot()?.showAssistantTps)).toBeUndefined();
  await sync.refresh();
  expect(nativeAssistantTps(footer.tps, snapshot()?.showAssistantTps), error()).toBe('7.5 tok/s');
  expect(error()).toBe('');
  expect(snapshot()).toMatchObject({ mode: 'system', themeIDs: { light: 'jetbrains-light', dark: 'jetbrains-dark' },
    fontSize: 100, timeFormatPreference: 'auto', chatRenderMode: 'sorted', activityRenderMode: 'collapsed',
    showReasoningTraces: true, collapsibleUserMessages: true, sessionGoalEnabled: true,
    showAssistantTps: true, collapsibleThinkingBlocks: true, followUpBehavior: 'queue',
    uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [],
  });
});

test.each([false, true])('transcript fixture keeps TPS=%s authority and historical identity/timing through failed refreshes (pure)', async enabled => {
  const settings = { showAssistantTps: enabled };
  let offline = false;
  const h = appearanceFixture(createHost({ settings, failSettings: () => offline }));
  const historyPath = '/api/session/ses_1/message?';
  const history = messagesFrom(h.host.call('runtime.request', { path: historyPath, method: 'GET' }).body, false).messages;
  const original = JSON.stringify(history);
  const row = nativeBodyRows(history).find(row => row.head.id === 'history-answer')!;
  const assertHistory = () => {
    const session = h.host.call('runtime.request', { path: '/api/session/ses_1?', method: 'GET' }).body;
    expect(session).toMatchObject({ model: { id: 'current-other', providerID: 'fixture', variant: 'low' }, agent: 'plan' });
    expect(nativeTurnHeaderMessage(row, { active: true, composer: { providerId: 'fixture', modelId: 'current-other' }, agent: 'plan' }))
      .toMatchObject({ modelID: 'gpt-6.1-sol', providerID: 'fixture', variant: 'high', agent: 'build' });
    expect(nativeTurnPresentation(history).get('history-final-answer')).toEqual({ header: false, footer: true, tps: '7.5 tok/s', duration: '4.3s' });
    expect(JSON.stringify(history)).toBe(original);
    expect(messagesFrom(h.host.call('runtime.request', { path: historyPath, method: 'GET' }).body, false).messages).toEqual(history);
  };
  await h.sync.refresh();
  expect(h.snapshot()?.showAssistantTps).toBe(enabled);
  expect(nativeAssistantTps('7.5 tok/s', h.snapshot()?.showAssistantTps)).toBe(enabled ? '7.5 tok/s' : undefined);
  assertHistory();
  const previous = h.snapshot();
  settings.showAssistantTps = !enabled; offline = true;
  await h.sync.refresh();
  expect(h.error()).toBe('HTTP 503');
  expect(h.snapshot()).toBe(previous);
  expect(nativeAssistantTps('7.5 tok/s', h.snapshot()?.showAssistantTps)).toBe(enabled ? '7.5 tok/s' : undefined);
  assertHistory();
  offline = false; await h.sync.refresh();
  expect(h.error()).toBe('');
  expect(h.snapshot()?.showAssistantTps).toBe(!enabled);
  expect(nativeAssistantTps('7.5 tok/s', h.snapshot()?.showAssistantTps)).toBe(enabled ? undefined : '7.5 tok/s');
  assertHistory();
});

test('transcript fixture never treats failed initial settings as defaults and applies the Web default only after success (pure)', async () => {
  let offline = true;
  const h = appearanceFixture(createHost({ settings: { showAssistantTps: undefined }, failSettings: () => offline }));
  await h.sync.refresh();
  expect(h.error()).toBe('HTTP 503'); expect(h.snapshot()).toBeNull();
  expect(nativeAssistantTps('7.5 tok/s', h.snapshot()?.showAssistantTps)).toBeUndefined();
  offline = false; await h.sync.refresh();
  expect(h.error()).toBe(''); expect(h.snapshot()?.showAssistantTps).toBe(true);
  expect(nativeAssistantTps('7.5 tok/s', h.snapshot()?.showAssistantTps)).toBe('7.5 tok/s');
});

test('transcript fixture rejects unknown appearance calls, writes and stale revisions (pure)', async () => {
  const host = createHost();
  expect(() => host.call('appearance.unknown', {})).toThrow('Unexpected native call');
  expect(() => host.call('runtime.request', { path: '/api/config/unknown', method: 'GET' })).toThrow('Unexpected request');
  const expectedHost = host.call('connection.list', {}).runtimeScope;
  for (const path of ['/api/config/settings', '/api/config/themes']) {
    for (const method of ['PUT', 'POST', 'DELETE']) expect(() => host.call('runtime.request', { path, method, body: {}, expectedHost })).toThrow('Unsafe transcript appearance request');
  }
  expect(() => host.call('appearance.reset', { hostID: 'other' })).toThrow('Unsafe transcript appearance reset');
  expect(() => host.call('appearance.reset', { hostID: 'fixture', unknown: true })).toThrow('Unsafe transcript appearance reset');
  const revision = host.call('appearance.reset', { hostID: 'fixture' }).revision;
  expect(host.call('appearance.reset', { hostID: null }).revision).toBe(revision + 1);
  const h = appearanceFixture(host); await h.sync.refresh(); expect(h.error()).toBe('');
  expect(() => host.call('appearance.apply', { hostID: 'fixture', revision, mode: h.snapshot()!.mode, cssVars: h.snapshot()!.cssVars, fonts: h.snapshot()!.fonts })).toThrow('Unsafe transcript appearance apply');
});

test('production transcript uses native inversion with a newest-first display copy and no competing forward follow (wiring)', () => {
  const source = readFileSync(path.join(directory, 'application.tsx'), 'utf8');
  const list = source.slice(source.indexOf('testID="transcript"'), source.indexOf('keyboardDismissMode="interactive"'));
  expect(/\binverted\b/.test(list), 'native transcript must use bottom-up layout').toBe(true);
  expect(source).toContain('const projectHistoryRows = createNativeHistoryRows();');
  expect(source).toContain('projectHistoryRows(chat.visibleMessages())');
  expect(source).not.toContain('previousBodyRows.slice().reverse()');
  expect(list.includes('maintainVisibleContentPosition'), 'native inversion is the sole follow owner').toBe(false);
  for (const event of ['onScrollDragStart', 'onScroll', 'onScrollEnd', 'onLoadMore', 'onLoadMoreAtStart']) expect(list).toContain(`${event}={listHistoryEvents().${event}}`);
  expect(source).toContain("return chat.load(false, ['messages']);");
  expect(source).toContain('generation === footerState().eventGeneration');
  expect(list.includes('onLoadMore='), 'old history loads at the native inverted-list end').toBe(true);
  expect(list).toContain('footer={() => <View');
  expect(list).toContain('void chat.loadOlder();');
  expect(list).toContain('chat.historyError()');
  expect(list).toContain('chat.hasGap()');
  expect(source.slice(source.indexOf('function Chat('), source.indexOf('testID="transcript"')).includes('<If when={chat.more()}>')).toBe(false);
});

test('production transcript keeps redo outside the removed history and preserves draft attachments for recovery (fixture headless only)', () => {
  run([
    'await app.type("id:composer", "Original unsent draft");',
    'await app.press("id:history-edit-history-user");',
    'await app.waitFor("id:history-revert-indicator");',
    'await app.waitUntil(() => app.value("id:composer") === "Editable historical input");',
    'expect(app.texts()).toContain("upload.txt");',
    'await app.waitUntil(() => !app.shows("id:history-edit-history-user"));',
    'await app.press("id:history-redo");',
    'await app.waitFor("id:history-edit-history-user");',
    'expect(app.value("id:composer")).toBe("Editable historical input");',
    'await app.press("id:history-draft-recover");',
    'await app.waitUntil(() => app.value("id:composer") === "Original unsent draft");',
    'await app.press("id:history-draft-recover");',
    'await app.waitUntil(() => app.value("id:composer") === "Editable historical input");',
    'expect(app.texts()).toContain("upload.txt");',
  ]);
}, 75_000);

test('production workspace Changes opens the native sheet and restores the same unsent composer (fixture only)', () => {
  run([
    'await app.type("id:composer", "Unsent workspace changes draft");',
    'await app.press("id:chat-header-root >> id:chat-header-options");',
    'await app.press("id:chat-menu-changes");',
    'await app.waitFor("id:native-changes-sheet");',
    'await app.waitFor("text:Working tree clean, no changes to display");',
    'await app.press("id:changes-close");',
    'await app.waitUntil(() => !app.shows("id:native-changes-sheet"));',
    'expect(app.value("id:composer")).toBe("Unsent workspace changes draft");',
    'expect(app.shows("id:history-edit-history-user")).toBe(true);',
  ]);
}, 75_000);

test('production native tools show output instead of JSON and open the authoritative child session (fixture headless only)', () => {
  run([
    'await app.press("id:body-activity-history-answer");',
    'await app.press("id:body-process:history-answer:shell-fixture");',
    'await app.press("id:tool-expand-shell-fixture");',
    'await app.waitFor("text:Neutral shell result");',
    'expect(app.texts().join("\\n")).not.toContain("\\\"state\\\":");',
    'await app.press("id:tool-session-child-session");',
    'await app.waitFor("text:Authoritative child content");',
    'expect(app.shows("text:Historical answer")).toBe(false);',
  ]);
}, 75_000);

test('production turn identity and footer use historical model/agent/variant/timing, not the current selection (fixture headless only)', () => {
  run([
    'await app.waitFor("id:turn-header-history-answer");',
    'await app.waitFor("text:GPT-6.1 Sol");',
    'expect(app.texts()).toContain("High");',
    'expect(app.texts()).toContain("Build");',
    'await app.waitFor("text:7.5 tok/s");',
    'expect(app.texts()).toContain("7.5 tok/s");',
    'expect(app.texts()).toContain("4.3s");',
    'expect(app.shows("id:appearance-feedback")).toBe(false);',
    'expect(app.texts()).not.toContain("Copy message");',
    'expect(app.texts()).not.toContain("Fork from here");',
  ]);
}, 75_000);

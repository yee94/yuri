import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { SHORTCUT_ACTIONS, getEffectiveShortcutCombo, getEffectiveShortcutCombos, UNASSIGNED_SHORTCUT } from '../ui/src/lib/shortcuts-core';
import {
  createDesktopShortcutPreferences, nativeShortcutBindings, nativeShortcutCaptureStrokes, nativeShortcutConflicts,
  nativeShortcutKeystroke, nativeShortcutRegistry, nativeShortcutReserved, shortcutFromNativeKeystroke,
  type ShortcutStorage,
} from './desktop-shortcuts-core';

describe('one Web-owned catalog and native physical keys', () => {
  test('supported session actions remain configurable while a modal disables execution; leader support follows real child implementations', () => {
    const supportedIDs = ['previous_session', 'next_session', ...Array.from({ length: 9 }, (_, index) => `switch_tab_${index + 1}`)];
    const actions = Object.fromEntries(supportedIDs.map(id => [id, { run() {}, enabled: false }]));
    const registry = nativeShortcutRegistry({ ...actions, new_chat: { run() {}, enabled: false }, abort_run: { run() {}, supported: false } });
    for (const id of [...supportedIDs, 'leader_key']) expect(registry.find(row => row.id === id)).toMatchObject({ supported: true, enabled: false });
    expect(registry.find(row => row.id === 'abort_run')).toMatchObject({ supported: false, enabled: false });
    expect(registry.find(row => row.id === 'focus_input')).toMatchObject({ supported: false, enabled: false });
    expect(nativeShortcutBindings({ actions, apple: true, settingsOpen: false })).toEqual([]);
    expect(nativeShortcutRegistry({ new_chat: { run() {}, supported: false } }).find(row => row.id === 'leader_key')).toMatchObject({ supported: false, enabled: false });
    expect(nativeShortcutRegistry({ new_chat: { run() {}, enabled: true } }).find(row => row.id === 'leader_key')).toMatchObject({ supported: true, enabled: true });
  });
  test('all actions are represented, absent callbacks are visibly disabled, no dummy binding', () => {
    const registry = nativeShortcutRegistry({ open_command_palette: { run() {} } });
    expect(registry.map(row => row.id)).toEqual(SHORTCUT_ACTIONS.map(row => row.id));
    expect(registry.filter(row => row.enabled).map(row => row.id)).toEqual(['open_command_palette']);
    expect(nativeShortcutBindings({ actions: {}, apple: true, settingsOpen: false })).toEqual([]);
    for (const row of SHORTCUT_ACTIONS) for (const combo of [row.defaultCombo, ...row.defaultAliases ?? []]) {
      if (combo === UNASSIGNED_SHORTCUT) expect(nativeShortcutKeystroke(combo, true)).toBeNull();
      else expect(nativeShortcutKeystroke(combo, true), combo).not.toBeNull();
    }
  });
  test('default mod is Cmd on Mac and Ctrl on Windows; aliases and unassigned use the same rules', () => {
    expect(nativeShortcutKeystroke('mod+comma', true)).toBe('cmd+,');
    expect(nativeShortcutKeystroke('mod+p', false)).toBe('ctrl+p');
    expect(nativeShortcutKeystroke('ctrl+backtick', true)).toBe('ctrl+`');
    expect(nativeShortcutKeystroke('mod+ctrl+p', false)).toBe('ctrl+p');
    expect(shortcutFromNativeKeystroke('cmd+ctrl+shift+up', true)).toBe('mod+ctrl+shift+arrowup');
    expect(shortcutFromNativeKeystroke('ctrl+shift+p', false)).toBe('mod+shift+p');
    expect(nativeShortcutKeystroke(UNASSIGNED_SHORTCUT, true)).toBeNull();
    expect(nativeShortcutConflicts('focus_input', 'mod+arrowup', {}, true)).toContain('previous_session');
    expect(nativeShortcutConflicts('focus_input', 'ctrl+p', {}, false)).toContain('open_command_palette');
    expect(nativeShortcutConflicts('focus_input', 'ctrl+p', {}, true)).not.toContain('open_command_palette');
    expect(nativeShortcutConflicts('focus_input', 'shift+tab', {}, true)).toContain('cycle_agent');
    expect(nativeShortcutConflicts('focus_input', 'mod+shift+=', {}, true)).toContain('zoom_in');
  });
  test('settings gate, menu ownership and context priorities happen before native consumption', () => {
    const actions = { open_command_palette: { run() {} }, open_settings: { run() {} }, new_chat: { run() {} }, next_session: { run() {} }, next_terminal_tab: { run() {}, priority: 20 } };
    const plan = nativeShortcutBindings({ actions, apple: true, settingsOpen: false, menuOwnedActions: ['open_command_palette'] });
    expect(plan.some(row => row.actionId === 'open_command_palette')).toBe(false);
    expect(plan.find(row => row.keystroke === 'cmd+shift+]')?.actionId).toBe('next_terminal_tab');
    expect(plan.find(row => row.keystroke === 'cmd+down')?.actionId).toBe('next_session');
    expect(nativeShortcutBindings({ actions, apple: true, settingsOpen: true }).map(row => row.actionId)).toEqual(['open_settings']);
    expect(nativeShortcutBindings({ actions: { new_chat: { run() {}, enabled: false } }, apple: true, settingsOpen: false })).toEqual([]);
    expect(nativeShortcutBindings({ actions: { focus_input: { run() {} } }, overrides: { focus_input: 'mod+p' }, apple: true, settingsOpen: false, menuOwnedActions: ['open_command_palette'] })).toEqual([]);
    const cycles = nativeShortcutBindings({ actions: { cycle_agent: { run() {} } }, apple: true, settingsOpen: false });
    expect(cycles.map(value => [value.keystroke, value.direction])).toEqual([['tab', 1], ['shift+tab', -1]]);
    const closing = { open_settings: { run() {} }, close_context_panel_tab: { run() {} }, new_chat: { run() {} } };
    expect(nativeShortcutBindings({ actions: closing, apple: true, settingsOpen: true }).map(value => value.actionId)).toEqual(['open_settings']);
    expect(nativeShortcutBindings({ actions: closing, apple: true, settingsOpen: true, blockingOverlay: true, settingsAllowedActions: ['open_settings', 'close_context_panel_tab'] }).map(value => value.actionId)).toEqual(['open_settings', 'close_context_panel_tab']);
  });
  test('capture table is bounded, unique, platform safe, and every captured stroke round trips', () => {
    for (const apple of [true, false]) {
      const strokes = nativeShortcutCaptureStrokes(apple);
      expect(strokes.length).toBeLessThan(1500);
      expect(new Set(strokes).size).toBe(strokes.length);
      expect(strokes.some(stroke => nativeShortcutReserved(stroke, apple))).toBe(false);
      // Super keys on Windows are not Web `mod`, so only bind portable Ctrl there.
      for (const stroke of strokes.filter(value => apple || !value.split('+').includes('cmd'))) {
        expect(nativeShortcutKeystroke(shortcutFromNativeKeystroke(stroke, apple), apple), stroke).toBe(stroke);
      }
    }
  });
});

function storage(initial: string | null = null) {
  let raw = initial;
  return { getItem: vi.fn(async () => raw), setItem: vi.fn(async (_key: string, next: string) => { raw = next; }), raw: () => raw };
}

describe('ACK-owned serial device preferences', () => {
  test('round-trip, aliases, conflict overwrite, defaults and unknown old keys', async () => {
    const backend = storage(JSON.stringify({ future_action: 'alt+z' })), preferences = createDesktopShortcutPreferences(backend);
    await preferences.load();
    expect(await preferences.set('focus_input', 'mod+arrowup', false, true)).toBe(false);
    expect(preferences.state().error).toBeNull();
    expect(await preferences.set('focus_input', 'mod+arrowup', true, true)).toBe(true);
    expect(getEffectiveShortcutCombos('previous_session', preferences.state().overrides)).toEqual([]);
    expect(preferences.state().overrides.future_action).toBe('alt+z');
    expect(await preferences.reset('focus_input', false, true)).toBe(true);
    expect(getEffectiveShortcutCombo('focus_input', preferences.state().overrides)).toBe('mod+i');
    await preferences.reset();
    const restored = createDesktopShortcutPreferences(backend); await restored.load();
    expect(restored.state()).toMatchObject({ ready: true, overrides: {} });
    expect(getEffectiveShortcutCombos('previous_session', restored.state().overrides)).toHaveLength(2);
  });
  test('concurrent writes serialize and merge against the latest ACK, not a stale draft', async () => {
    const backend = storage(), preferences = createDesktopShortcutPreferences(backend);
    await preferences.load();
    let release!: () => void;
    backend.setItem.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve; }));
    const first = preferences.set('focus_input', 'alt+f8'), second = preferences.set('open_command_palette', 'alt+f9');
    await vi.waitFor(() => expect(backend.setItem).toHaveBeenCalledTimes(1));
    expect(preferences.state().overrides).toEqual({});
    release(); await first; await second;
    expect(backend.setItem).toHaveBeenCalledTimes(2);
    expect(preferences.state().overrides).toEqual({ focus_input: 'alt+f8', open_command_palette: 'alt+f9' });
    expect(JSON.parse(backend.raw()!)).toEqual(preferences.state().overrides);
  });
  test('save failure preserves prior binding and exact retry, does not let queued edits discard it', async () => {
    const backend = storage(), preferences = createDesktopShortcutPreferences(backend); await preferences.load();
    backend.setItem.mockRejectedValueOnce(new Error('disk full'));
    const first = preferences.set('focus_input', 'alt+f8'), second = preferences.set('open_command_palette', 'alt+f9');
    expect(await first).toBe(false); expect(await second).toBe(false);
    expect(preferences.state()).toMatchObject({ overrides: {}, ready: true, error: 'save' });
    expect(await preferences.retry()).toBe(true);
    expect(preferences.state().overrides).toEqual({ focus_input: 'alt+f8' });
    expect(backend.setItem).toHaveBeenCalledTimes(2);
  });
  test('malformed/read failure is not authoritative empty and remains explicitly retryable', async () => {
    const backend = storage('{'), preferences = createDesktopShortcutPreferences(backend);
    expect(await preferences.load()).toBe(false);
    expect(preferences.state()).toMatchObject({ ready: false, error: 'load' });
    expect(await preferences.set('focus_input', 'alt+f8')).toBe(false);
    expect(backend.setItem).not.toHaveBeenCalled();
    backend.getItem.mockResolvedValueOnce('{"focus_input":"alt+f8"}');
    await preferences.retry();
    expect(preferences.state()).toMatchObject({ ready: true, error: null, overrides: { focus_input: 'alt+f8' } });
  });
  test('dispose fences a late load and a late write without notification', async () => {
    let release!: (value: string | null) => void;
    const backend: ShortcutStorage = { getItem: () => new Promise(resolve => { release = resolve; }), setItem: async () => {} };
    const preferences = createDesktopShortcutPreferences(backend), changed = vi.fn(); preferences.subscribe(changed);
    const work = preferences.load(); await Promise.resolve();
    const calls = changed.mock.calls.length; preferences.dispose(); release('{"focus_input":"alt+f8"}'); await work;
    expect(changed).toHaveBeenCalledTimes(calls); expect(preferences.state().ready).toBe(false);
  });
});

function headless(steps: string[]) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-shortcuts-fixture.tsx'], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: ['await app.waitFor("text:ready");', ...steps].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('NSH keymap: defaults, menu exclusion, settings/IME gates, leader/abort and disposal', () => headless([
  'await app.keyboard.press("mod+p");', 'expect(app.texts()).toContain("palette:1");',
  'await app.keyboard.press("mod+n");', 'expect(app.texts()).toContain("new:0");',
  'await app.press("id:menu-new");', 'expect(app.texts()).toContain("new:1");',
  'await app.press("id:settings");', 'await app.keyboard.press("mod+p");', 'expect(app.texts()).toContain("palette:1");',
  'await app.press("id:menu-new");', 'expect(app.texts()).toContain("new:1");',
  'await app.press("id:settings");', 'await app.press("id:ime");', 'await app.keyboard.press("mod+p");', 'expect(app.texts()).toContain("palette:1");',
  'await app.press("id:ime");', 'await app.keyboard.press("ctrl+x");', 'await app.keyboard.press("m");',
  'await app.waitFor("text:model:1");', 'await app.keyboard.press("ctrl+x");', 'await app.keyboard.press("a");', 'await app.waitFor("text:agent:1");',
  'await app.keyboard.press("ctrl+x");', 'await app.keyboard.press("c");', 'await app.waitFor("text:compact:1");',
  'await app.keyboard.press("escape");', 'expect(app.texts()).toContain("abort:0");',
  'await app.keyboard.press("escape");', 'expect(app.texts()).toContain("abort:1");',
  'await app.press("id:dispose");', 'await app.keyboard.press("mod+p");', 'expect(app.texts()).toContain("palette:1");',
  'expect(app.texts()).toContain("fallback:3");',
]), 75_000);

test('NSH repeated shortcuts do one action lookup each, not a table rebuild or persistent write', () => headless([
  'await app.press("id:metrics-reset");',
  'for (let i = 0; i < 100; i++) await app.keyboard.press("mod+p");',
  'await app.press("id:metrics");', 'expect(app.texts()).toContain("scans:100 writes:0");', 'expect(app.texts()).toContain("palette:100");',
]), 75_000);

test('NSH settings guarded close is opt-in and shares keyboard/menu admission; capture still owns its keys', () => headless([
  'await app.press("id:settings");', 'await app.keyboard.press("mod+w");', 'await app.press("id:menu-close");', 'expect(app.texts()).toContain("close:0");',
  'await app.press("id:allow-close");', 'await app.keyboard.press("mod+w");', 'expect(app.texts()).toContain("close:1");',
  'await app.press("id:menu-close");', 'expect(app.texts()).toContain("close:2");',
  'await app.press("id:capture");', 'await app.press("id:menu-close");', 'expect(app.texts()).toContain("close:2");',
  'await app.keyboard.press("mod+w");', 'expect(app.texts()).toContain("close:2");',
  'await app.keyboard.press("mod+w");', 'expect(app.texts()).toContain("close:3");',
]), 75_000);

test('NSH focused Input keeps editing and typing performs zero registry rebuilds/storage operations', () => headless([
  'await app.press("id:metrics-reset");',
  'await app.type("id:input", "ordinary typing");', 'await app.keyboard.press("mod+a");',
  'await app.keyboard.press("ctrl+c");', 'expect(app.texts()).toContain("clear:0");',
  'await app.press("id:metrics");', 'expect(app.texts()).toContain("scans:0 writes:0");',
  'expect(app.value("id:input")).toBe("ordinary typing");',
]), 75_000);

test('NSH leader chords are intentionally admitted while an Input is focused', () => headless([
  'await app.type("id:input", "Keep the focused draft");',
  'await app.keyboard.press("ctrl+x");', 'await app.keyboard.press("a");', 'await app.waitFor("text:agent:1");',
  'expect(app.value("id:input")).toBe("Keep the focused draft");',
]), 75_000);

test('NSH rebind retires old shortcut and foreground/scope boundaries disarm pending leader', () => headless([
  'await app.press("id:rebind");', 'await app.waitFor("text:rebound");',
  'await app.keyboard.press("mod+p");', 'expect(app.texts()).toContain("palette:0");',
  'await app.keyboard.press("alt+f8");', 'expect(app.texts()).toContain("palette:1");',
  'await app.keyboard.press("ctrl+x");', 'await app.press("id:scope");', 'await app.keyboard.press("m");', 'expect(app.texts()).toContain("model:0");',
  'await app.setLifecycle("background");', 'await app.keyboard.press("alt+f8");', 'expect(app.texts()).toContain("palette:1");',
  'await app.setLifecycle("active");', 'await app.keyboard.press("alt+f8");', 'expect(app.texts()).toContain("palette:2");',
]), 75_000);

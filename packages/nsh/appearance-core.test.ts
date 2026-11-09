import { describe, expect, it, vi } from 'vitest';
import { appearanceFromSettings, createNativeAppearanceSync, nativeThemeTokens, nativeToolThemeTokens, nativeTypographyStyle, type AppliedNativeAppearance, type NativeAppearance } from './appearance-core';
import { getThemeById, themes } from '../ui/src/lib/theme/themes';
import { withBaseTextFloor } from '../ui/src/lib/theme/baseTextColors';
import { agentAvatarThemeTokens } from '../ui/src/lib/agentAvatarPalette';
import { nativeAssistantTps, nativeReasoningPresentation } from './chat-preferences-core';

const settings = { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, fontSize: 120, uiFont: 'system', monoFont: 'system-mono' };
const fonts = { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [] };
const custom = vi.fn(async () => ({ themes: [] }));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('Host-authoritative native appearance mapping', () => {
  it('resolves the same Web tools title blend, explicit description and icon tokens without expanding the Swift schema', async () => {
    const theme = structuredClone(getThemeById('jetbrains-dark')!);
    theme.colors.tools = { ...theme.colors.tools, title: '#e0e0e0', icon: '#123456', description: '#abcdefcc' };
    theme.colors.surface.mutedForeground = '#808080';
    expect(nativeToolThemeTokens(theme)).toMatchObject({ title: '#b0b0b0ff', icon: '#123456', description: '#abcdefcc' });
    const value = await appearanceFromSettings(settings, custom);
    expect(value.toolTokens.dark).toEqual(nativeToolThemeTokens(getThemeById('jetbrains-dark')!));
    expect(Object.keys(value.cssVars.dark)).toHaveLength(21);
  });
  it('maps Host transcript display preferences and the same absent-setting defaults', async () => {
    expect(await appearanceFromSettings(settings, custom)).toMatchObject({ chatRenderMode: 'sorted', activityRenderMode: 'collapsed', showReasoningTraces: true });
    expect(await appearanceFromSettings({ ...settings, chatRenderMode: 'live', activityRenderMode: 'summary', showReasoningTraces: false }, custom)).toMatchObject({ chatRenderMode: 'live', activityRenderMode: 'summary', showReasoningTraces: false });
  });
  it.each(['sessionGoalEnabled', 'showAssistantTps', 'collapsibleThinkingBlocks'] as const)('maps %s once from Host, with the Web default only for an absent field', async key => {
    expect((await appearanceFromSettings({}, custom))[key]).toBe(true);
    for (const value of [false, true]) expect((await appearanceFromSettings({ ...settings, [key]: value }, custom))[key]).toBe(value);
    for (const value of ['false', 0, null, {}]) expect((await appearanceFromSettings({ ...settings, [key]: value }, custom))[key]).toBeNull();
  });
  it('defaults follow-up behavior only after a successful absent-setting snapshot', async () => {
    expect((await appearanceFromSettings({}, custom)).followUpBehavior).toBe('queue');
    for (const value of ['immediate', 'invalid', '', null, false, 0, {}]) {
      expect((await appearanceFromSettings({ followUpBehavior: value }, custom)).followUpBehavior).toBeNull();
    }
    for (const value of ['false', null, 0, {}]) {
      expect((await appearanceFromSettings({ queueModeEnabled: value }, custom)).followUpBehavior).toBeNull();
    }
  });
  it.each([false, true])('uses canonical follow-up values before legacy queueModeEnabled=%s', async queueModeEnabled => {
    for (const followUpBehavior of ['steer', 'queue']) {
      expect((await appearanceFromSettings({ followUpBehavior, queueModeEnabled }, custom)).followUpBehavior).toBe(followUpBehavior);
    }
    for (const followUpBehavior of [undefined, 'immediate', 'invalid', null]) {
      expect((await appearanceFromSettings({ followUpBehavior, queueModeEnabled }, custom)).followUpBehavior).toBe(queueModeEnabled ? 'queue' : 'steer');
    }
  });
  it('maps the shared built-in catalog and explicitly reports its two malformed Vitesse focus-ring sources', () => {
    const failed: string[] = [];
    for (const theme of themes) {
      try { expect(Object.keys(nativeThemeTokens(theme))).toHaveLength(21); }
      catch (error) { expect(String(error)).toContain('hexadecimal'); failed.push(theme.metadata.id); }
    }
    expect(failed.sort()).toEqual(['vitesse-dark-dark', 'vitesse-light-light']);
  });
  it('maps the real selected palette, shared brightness algorithm and chat colors without theme-specific constants', async () => {
    const appearance = await appearanceFromSettings(settings, custom);
    const source = withBaseTextFloor(getThemeById('jetbrains-dark')!);
    expect(appearance.mode).toBe('dark');
    expect(appearance.cssVars.light).toEqual(appearance.cssVars.dark);
    expect(appearance.cssVars.dark.background).toBe(source.colors.surface.background);
    expect(appearance.cssVars.dark.foreground).toBe(source.colors.surface.foreground);
    expect(appearance.cssVars.dark['chat-user']).toBe(source.colors.chat?.userMessageBackground);
    expect(appearance.cssVars.dark.primary).toBe(source.colors.surface.foreground);
    expect(appearance.cssVars.dark['accent-foreground']).toBe(source.colors.interactive.selectionForeground);
    expect(appearance.agentAvatarTokens.dark).toEqual(agentAvatarThemeTokens(source.colors));
    expect(custom).not.toHaveBeenCalled();
    const other = await appearanceFromSettings({ themeId: 'nord-light', themeVariant: 'light' }, custom);
    expect(other.cssVars.light).toEqual(nativeThemeTokens(getThemeById('nord-light')!));
    expect(other.cssVars.light.background).not.toBe(appearance.cssVars.dark.background);
  });
  it('supports two Host-selected system palettes and rejects unavailable ids, bad variants and failed catalogs', async () => {
    const value = await appearanceFromSettings({ useSystemTheme: true, lightThemeId: 'jetbrains-light', darkThemeId: 'nord-dark' }, custom);
    expect(value.mode).toBe('system');
    expect(value.cssVars.light).toEqual(nativeThemeTokens(getThemeById('jetbrains-light')!));
    expect(value.cssVars.dark).toEqual(nativeThemeTokens(getThemeById('nord-dark')!));
    expect(value.agentAvatarTokens.light).toEqual(agentAvatarThemeTokens(getThemeById('jetbrains-light')!.colors));
    expect(value.agentAvatarTokens.dark).toEqual(agentAvatarThemeTokens(getThemeById('nord-dark')!.colors));
    await expect(appearanceFromSettings(null, custom)).rejects.toThrow('Invalid Host');
    await expect(appearanceFromSettings({ ...settings, darkThemeId: 'nord-light' }, custom)).rejects.toThrow('unavailable');
    await expect(appearanceFromSettings({ ...settings, themeId: 'missing' }, custom)).rejects.toThrow('unavailable');
    await expect(appearanceFromSettings({ themeId: 'missing' }, custom)).rejects.toThrow('unavailable');
    await expect(appearanceFromSettings({ ...settings, themeId: 'missing' }, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
  it('loads a selected custom JSON theme and fails closed on CSS expressions or malformed catalog data', async () => {
    const theme = structuredClone(getThemeById('jetbrains-dark')!);
    theme.metadata.id = 'custom-dark';
    const load = vi.fn(async () => ({ themes: [theme] }));
    const result = await appearanceFromSettings({ ...settings, themeId: 'custom-dark' }, load);
    expect(result.cssVars.dark.background).toBe(theme.colors.surface.background);
    expect(load).toHaveBeenCalledOnce();
    theme.colors.surface.background = 'url(https://invalid.example)';
    await expect(appearanceFromSettings({ ...settings, themeId: 'custom-dark' }, load)).rejects.toThrow('hexadecimal');
    await expect(appearanceFromSettings({ ...settings, themeId: 'missing' }, async () => ({}))).rejects.toThrow('catalog');
  });
  it('uses shared mobile semantic sizes and Host UI scale, not UI scale for browser-local code size', async () => {
    const appearance = { ...await appearanceFromSettings(settings, custom), ...fonts };
    expect(nativeTypographyStyle(appearance, 'markdown')).toEqual({ fontSize: 18, lineHeight: 29.25, fontFamily: 'system-ui' });
    expect(nativeTypographyStyle(appearance, 'code')).toEqual({ fontSize: 13, fontFamily: 'monospace' });
    expect(nativeTypographyStyle(appearance, 'uiLabel').fontSize).toBe(15.6);
    const selectedFonts = await appearanceFromSettings({ ...settings, uiFont: 'inter', monoFont: 'fira-code' }, custom);
    expect(selectedFonts.fonts).toEqual({ ui: 'Inter', mono: 'Fira Code', assistantLight: 'JetBrains Mono', assistantDark: 'JetBrains Mono' });
    await expect(appearanceFromSettings({ ...settings, fontSize: Infinity }, custom)).rejects.toThrow('scale');
    await expect(appearanceFromSettings({ ...settings, uiFont: 'arbitrary code' }, custom)).rejects.toThrow('font');
  });
  it('reads only the Host time-format whitelist and leaves absent or invalid preferences explicitly unknown', async () => {
    for (const preference of ['auto', '12h', '24h']) {
      expect((await appearanceFromSettings({ ...settings, timeFormatPreference: preference }, custom)).timeFormatPreference).toBe(preference);
    }
    expect((await appearanceFromSettings(settings, custom)).timeFormatPreference).toBeNull();
    expect((await appearanceFromSettings({ ...settings, timeFormatPreference: 'browser stale' }, custom)).timeFormatPreference).toBeNull();
  });
  it('reads diff layout from a confirmed snapshot and preserves invalid values as unknown', async () => {
    expect((await appearanceFromSettings(settings, custom)).diffLayoutPreference).toBe('inline');
    for (const value of ['dynamic', 'inline', 'side-by-side']) {
      expect((await appearanceFromSettings({ ...settings, diffLayoutPreference: value }, custom)).diffLayoutPreference).toBe(value);
    }
    for (const value of [null, false, 'split', {}, 0]) {
      expect((await appearanceFromSettings({ ...settings, diffLayoutPreference: value }, custom)).diffLayoutPreference).toBeNull();
    }
  });
  it('reads the real message transport whitelist only from a confirmed canonical snapshot', async () => {
    expect((await appearanceFromSettings(settings, custom)).messageStreamTransport).toBe('auto');
    for (const value of ['auto', 'ws', 'sse']) expect((await appearanceFromSettings({ ...settings, messageStreamTransport: value }, custom)).messageStreamTransport).toBe(value);
    for (const value of [null, false, 'websocket', 'poll', 0, {}]) expect((await appearanceFromSettings({ ...settings, messageStreamTransport: value }, custom)).messageStreamTransport).toBeNull();
  });
  it('publishes validated calendar week preferences to the existing native date picker consumer', async () => {
    expect((await appearanceFromSettings(settings, custom)).weekStartPreference).toBe('auto');
    for (const value of ['auto', 'monday', 'sunday']) expect((await appearanceFromSettings({ ...settings, weekStartPreference: value }, custom)).weekStartPreference).toBe(value);
    for (const value of [null, 1, false, 'Monday']) await expect(appearanceFromSettings({ ...settings, weekStartPreference: value }, custom)).rejects.toThrow('invalid-calendar-preferences');
  });
  it('reads user-message collapse from the same snapshot, using Web default only after a successful settings read', async () => {
    expect((await appearanceFromSettings(settings, custom)).collapsibleUserMessages).toBe(true);
    expect((await appearanceFromSettings({ ...settings, collapsibleUserMessages: false }, custom)).collapsibleUserMessages).toBe(false);
    expect((await appearanceFromSettings({ ...settings, collapsibleUserMessages: true }, custom)).collapsibleUserMessages).toBe(true);
    expect((await appearanceFromSettings({ ...settings, collapsibleUserMessages: 'true' }, custom)).collapsibleUserMessages).toBeNull();
  });
});

describe('one root appearance synchronization lane', () => {
  function harness() {
    let current: AppliedNativeAppearance | null = null, error = '';
    const readSettings = vi.fn(async (): Promise<unknown> => settings);
    const reset = vi.fn(async () => 7);
    const apply = vi.fn(async (_scope: unknown, _revision: number, _appearance: NativeAppearance) => fonts);
    const sync = createNativeAppearanceSync({ readSettings, readThemes: custom, reset, apply,
      changed: value => { current = value; }, failed: message => { error = message; } });
    return { sync, readSettings, reset, apply, current: () => current, error: () => error };
  }
  const one = { hostID: 'one', url: 'https://one.example', generation: 1 };
  it('keeps confirmed diff layout on refresh failure and rejects an old Host layout after switching', async () => {
    const h = harness(); h.sync.setScope(one);
    h.readSettings.mockRejectedValueOnce(new Error('offline'));
    await h.sync.refresh(); expect(h.current()).toBeNull();
    h.readSettings.mockResolvedValueOnce({ ...settings, diffLayoutPreference: 'side-by-side' });
    await h.sync.refresh(); const prior = h.current();
    expect(prior?.diffLayoutPreference).toBe('side-by-side');
    h.readSettings.mockRejectedValueOnce(new Error('offline'));
    await h.sync.refresh(); expect(h.current()).toBe(prior);
    const old = deferred<unknown>(); h.readSettings.mockReturnValueOnce(old.promise);
    const pending = h.sync.refresh(); await flush();
    h.sync.setScope({ ...one, hostID: 'two', generation: 2 });
    expect(h.current()).toBeNull();
    h.readSettings.mockResolvedValueOnce(settings); await h.sync.refresh();
    expect(h.current()?.diffLayoutPreference).toBe('inline');
    old.resolve({ ...settings, diffLayoutPreference: 'side-by-side' }); await pending;
    expect(h.current()?.diffLayoutPreference).toBe('inline');
  });
  it('keeps follow-up unknown before success, preserves confirmed values on failure and clears them across Hosts', async () => {
    const h = harness(); h.sync.setScope(one);
    const followUpBehavior = () => h.current()?.followUpBehavior ?? null;
    expect(followUpBehavior()).toBeNull();
    h.readSettings.mockRejectedValueOnce(new Error('offline'));
    await h.sync.refresh(); expect(followUpBehavior()).toBeNull();
    h.readSettings.mockResolvedValueOnce({ followUpBehavior: 'steer' });
    await h.sync.refresh(); expect(followUpBehavior()).toBe('steer');
    const reads = h.readSettings.mock.calls.length;
    for (let index = 0; index < 200; index++) expect(followUpBehavior()).toBe('steer');
    expect(h.readSettings).toHaveBeenCalledTimes(reads);
    h.readSettings.mockRejectedValueOnce(new Error('offline'));
    await h.sync.refresh(); expect(followUpBehavior()).toBe('steer');
    const old = deferred<unknown>(); h.readSettings.mockReturnValueOnce(old.promise);
    const pending = h.sync.refresh(); await flush();
    h.sync.setScope({ ...one, hostID: 'two', generation: 2 });
    expect(followUpBehavior()).toBeNull();
    h.readSettings.mockResolvedValueOnce({});
    await h.sync.refresh(); expect(followUpBehavior()).toBe('queue');
    old.resolve({ followUpBehavior: 'steer' }); await pending;
    expect(followUpBehavior()).toBe('queue');
  });
  it('coalesces refreshes, skips identical native commits and preserves previous appearance on failure', async () => {
    const h = harness(); h.sync.setScope(one);
    await Promise.all(Array.from({ length: 50 }, () => h.sync.refresh()));
    expect(h.readSettings).toHaveBeenCalledOnce(); expect(h.apply).toHaveBeenCalledOnce();
    const previous = h.current();
    await h.sync.refresh(); expect(h.apply).toHaveBeenCalledOnce(); expect(h.current()).toBe(previous);
    h.readSettings.mockRejectedValueOnce(new Error('offline'));
    await h.sync.refresh(); expect(h.current()).toBe(previous); expect(h.error()).toBe('offline');
    await h.sync.refresh(); expect(h.error()).toBe(''); expect(h.current()).toBe(previous);
  });
  it('rebind replaces both same-Host readers, preserves canonical prior, retires the old barrier and keeps hold/resume reader ownership', async () => {
    const h = harness(); h.sync.setScope(one); await h.sync.refresh();
    const prior = h.current(), old = deferred<unknown>();
    h.readSettings.mockReturnValueOnce(old.promise); const pending = h.sync.refresh(); await flush();
    const barrier = h.sync.refreshAfterCurrent(() => true).then(() => 'accepted', () => 'retired');
    const nextSettings = vi.fn(async (): Promise<unknown> => ({ ...settings, fontSize: 125 })), nextThemes = vi.fn(async () => ({ themes: [] }));
    const scope = { ...one, generation: 2 };
    h.sync.pause(); h.sync.rebind(false, { scope, readSettings: nextSettings, readThemes: nextThemes });
    expect(h.current()).toBe(prior); await h.sync.refresh();
    expect(h.current()?.fontSize).toBe(125); expect(h.current()?.sourceHost).toEqual(scope);
    old.resolve({ ...settings, fontSize: 100 }); await pending;
    expect(await barrier).toBe('retired'); expect(h.current()?.fontSize).toBe(125);
    expect(h.readSettings).toHaveBeenCalledTimes(2);
    const themeReads = nextThemes.mock.calls.length;
    nextSettings.mockResolvedValueOnce({ ...settings, fontSize: 125, darkThemeId: 'synthetic-missing-theme' });
    await h.sync.refresh(); expect(nextThemes).toHaveBeenCalledTimes(themeReads + 1); expect(h.current()?.fontSize).toBe(125);
    const reads = nextSettings.mock.calls.length; await h.sync.hold(); await h.sync.refresh(); expect(nextSettings).toHaveBeenCalledTimes(reads);
    h.sync.resume(); await h.sync.refresh(); expect(nextSettings).toHaveBeenCalledTimes(reads + 1);
    expect(() => h.sync.rebind(false, { scope: { ...scope, hostID: 'other' }, readSettings: nextSettings, readThemes: nextThemes })).toThrow('reader Host changed');
  });
  it('confirmation joins an old delayed apply then coalesces 50 barriers into one fresh read without parallel native commits', async () => {
    const h = harness(), old = deferred<typeof fonts>(); h.sync.setScope(one);
    h.readSettings.mockResolvedValueOnce({ ...settings, fontSize: 100 }); h.apply.mockReturnValueOnce(old.promise);
    const previous = h.sync.refresh(); await flush(); expect(h.apply).toHaveBeenCalledOnce();
    h.readSettings.mockResolvedValueOnce({ ...settings, fontSize: 125 });
    const confirmations = Array.from({ length: 50 }, () => h.sync.refreshAfterCurrent(() => true));
    expect(h.sync.refresh()).toBe(previous); expect(h.readSettings).toHaveBeenCalledOnce();
    old.resolve(fonts); await Promise.all(confirmations);
    expect(h.readSettings).toHaveBeenCalledTimes(2); expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.current()?.fontSize).toBe(125); expect(h.reset).toHaveBeenCalledOnce();
  });
  it.each(['scope', 'pause', 'hold', 'owner'] as const)('confirmation cannot cross %s retirement while joining an old flight', async boundary => {
    const h = harness(), old = deferred<typeof fonts>(); h.sync.setScope(one); h.apply.mockReturnValueOnce(old.promise);
    const previous = h.sync.refresh(); await flush(); let owner = true;
    const confirmation = h.sync.refreshAfterCurrent(() => owner);
    if (boundary === 'scope') h.sync.setScope({ ...one, hostID: 'two', generation: 2 });
    else if (boundary === 'pause') h.sync.pause();
    else if (boundary === 'hold') await h.sync.hold();
    else owner = false;
    old.resolve(fonts); await expect(confirmation).rejects.toThrow('confirmation retired'); await previous;
    expect(h.readSettings).toHaveBeenCalledOnce();
    if (boundary === 'hold') { await h.sync.refresh(); expect(h.readSettings).toHaveBeenCalledOnce(); h.sync.resume(); }
  });
  it('shares three chat preferences through the same snapshot without reads/scans for 200 input-adjacent evaluations', async () => {
    const h = harness(); h.sync.setScope(one); await h.sync.refresh();
    const previous = h.current();
    for (let index = 0; index < 200; index++) {
      const snapshot = h.current();
      expect(snapshot?.sessionGoalEnabled).toBe(true);
      expect(nativeAssistantTps('24 tok/s', snapshot?.showAssistantTps)).toBe('24 tok/s');
      expect(nativeReasoningPresentation('> Thinking', snapshot?.collapsibleThinkingBlocks, false)).toEqual({ collapsible: true, content: 'Thinking' });
    }
    expect(h.current()).toBe(previous);
    expect(h.readSettings).toHaveBeenCalledOnce(); expect(h.apply).toHaveBeenCalledOnce();
    h.readSettings.mockResolvedValueOnce({ ...settings, sessionGoalEnabled: false, showAssistantTps: false, collapsibleThinkingBlocks: false });
    await h.sync.refresh();
    expect(h.current()).toMatchObject({ sessionGoalEnabled: false, showAssistantTps: false, collapsibleThinkingBlocks: false });
    const disabled = h.current();
    h.readSettings.mockRejectedValueOnce(new Error('offline'));
    await h.sync.refresh(); expect(h.current()).toBe(disabled);
    h.sync.setScope({ ...one, hostID: 'two', generation: 2 });
    expect(h.current()).toBeNull();
    expect(nativeAssistantTps('24 tok/s', h.current()?.showAssistantTps)).toBeUndefined();
    await h.sync.refresh();
    expect(h.current()).toMatchObject({ sessionGoalEnabled: true, showAssistantTps: true, collapsibleThinkingBlocks: true });
  });
  it('immediately clears Host/generation scope and fences an older settings result', async () => {
    const h = harness(); h.sync.setScope(one); await h.sync.refresh();
    const old = deferred<unknown>(); h.readSettings.mockReturnValueOnce(old.promise);
    const pending = h.sync.refresh(); await flush();
    h.sync.setScope({ ...one, hostID: 'two', generation: 2 });
    expect(h.current()).toBeNull();
    await h.sync.refresh();
    const second = h.current(); old.resolve({ themeId: 'nord-light', themeVariant: 'light' }); await pending;
    expect(h.current()).toBe(second); expect(h.apply).toHaveBeenCalledTimes(2);
    h.sync.setScope({ ...one, generation: 3 }); expect(h.current()).toBeNull();
  });
  it('fences a delayed native commit and stale rejection after disconnect', async () => {
    const h = harness(); h.sync.setScope(one);
    const delayed = deferred<typeof fonts>(); h.apply.mockReturnValueOnce(delayed.promise);
    const pending = h.sync.refresh(); await flush();
    h.sync.setScope(null); delayed.resolve(fonts); await pending;
    expect(h.current()).toBeNull(); expect(h.error()).toBe('');
    const reads = h.readSettings.mock.calls.length; await h.sync.refresh(); expect(h.readSettings).toHaveBeenCalledTimes(reads);
  });
  it('surfaces reset/native commit failure without treating it as successful default appearance', async () => {
    const h = harness(); h.reset.mockRejectedValueOnce(new Error('reset failed'));
    h.sync.setScope(one); await h.sync.refresh();
    expect(h.error()).toBe('reset failed'); expect(h.current()).toBeNull(); expect(h.readSettings).not.toHaveBeenCalled();
    h.apply.mockRejectedValueOnce(new Error('native rejected')); await h.sync.refresh();
    expect(h.error()).toBe('native rejected'); expect(h.current()).toBeNull();
    await h.sync.refresh(); expect(h.current()).not.toBeNull(); expect(h.error()).toBe('');
  });
});

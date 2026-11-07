import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeAssistantTps, nativeReasoningPresentation } from './chat-preferences-core';

const harness = vi.hoisted(() => ({
  lifecycle: 'active', connection: { id: 'one', url: 'https://one.example' } as { id: string; url: string } | null,
  epoch: 1, effects: [] as Array<() => void | (() => void)>, effectStops: [] as Array<() => void>,
  cleanups: [] as Array<() => void>, listeners: new Map<string, Set<(payload: unknown) => void>>(),
  request: vi.fn(), native: vi.fn(), setColorScheme: vi.fn(), scheme: 'dark',
}));
vi.mock('nsh', () => ({
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  lifecycle: () => harness.lifecycle, colorScheme: () => harness.scheme, setColorScheme: harness.setColorScheme,
  untracked: <T>(work: () => T) => work(),
  effect: (work: () => void | (() => void)) => { harness.effects.push(work); const stop = work(); if (stop) harness.effectStops.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work),
  host: { on: (name: string, work: (payload: unknown) => void) => {
    const listeners = harness.listeners.get(name) ?? new Set(); listeners.add(work); harness.listeners.set(name, listeners);
    return () => { listeners.delete(work); };
  } },
}));
vi.mock('./runtime', () => ({ request: harness.request, native: harness.native }));
vi.mock('./state', () => ({ app: { connection: () => harness.connection }, epoch: () => harness.epoch, captureHostRequest: () => harness.request }));
vi.mock('nsh/base', () => ({ Button: () => null }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const emit = (type: string, key = 'global') => {
  for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ key, data: JSON.stringify({ type }) });
};
function rerun() {
  harness.effectStops.forEach(stop => stop()); harness.effectStops = [];
  for (const effect of harness.effects) { const stop = effect(); if (stop) harness.effectStops.push(stop); }
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  harness.lifecycle = 'active'; harness.connection = { id: 'one', url: 'https://one.example' }; harness.epoch = 1;
  harness.effects = []; harness.effectStops = []; harness.cleanups = []; harness.listeners.clear();
  harness.request.mockReset().mockResolvedValue({ themeId: 'jetbrains-dark', themeVariant: 'dark', uiFont: 'system', monoFont: 'system-mono', fontSize: 125, timeFormatPreference: '24h' });
  harness.native.mockReset().mockImplementation(async (name) => name === 'appearance.reset' ? { revision: 1 } : { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [] });
  harness.setColorScheme.mockReset();
});
afterEach(async () => {
  harness.effectStops.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); await flush(); vi.useRealTimers();
});

describe('NativeAppearanceSync root integration', () => {
  it('mounts one lifetime, maps native text styles, and performs zero work for input/token events', async () => {
    const appearance = await import('./appearance');
    appearance.NativeAppearanceSync(); await flush();
    expect(harness.request).toHaveBeenCalledExactlyOnceWith('/api/config/settings');
    expect(appearance.nativeAppearance.current()?.mode).toBe('dark');
    expect(appearance.nativeAppearance.current()).toMatchObject({ sessionGoalEnabled: true, showAssistantTps: true, collapsibleThinkingBlocks: true });
    expect(appearance.nativeAgentPaletteTokens()['--status-success']).toBe('#57965D');
    expect(appearance.nativeAgentPaletteTokens()['--syntax-type']).toBe('#A6BB77');
    expect(harness.native.mock.calls.find(([name]) => name === 'appearance.apply')?.[1]).not.toHaveProperty('agentAvatarTokens');
    for (const key of ['sessionGoalEnabled', 'showAssistantTps', 'collapsibleThinkingBlocks']) expect(harness.native.mock.calls.find(([name]) => name === 'appearance.apply')?.[1]).not.toHaveProperty(key);
    expect(appearance.nativeTimeFormat()).toBe('24h');
    expect(appearance.nativeChatTextStyle('user')).toEqual(expect.objectContaining({ fontSize: 18.75, fontFamily: 'system-ui', color: expect.stringMatching(/^#/) }));
    expect(appearance.nativeChatSurfaceStyle('user').backgroundColor).toBe(appearance.nativeAppearance.current()?.cssVars.dark['chat-user']);
    expect(() => appearance.NativeAppearanceSync()).toThrow('already mounted');
    for (let i = 0; i < 200; i++) {
      emit('message.part.delta', 'chat'); emit('message.updated', 'chat'); appearance.nativeChatTextStyle('composer');
      const snapshot = appearance.nativeAppearance.current();
      expect(nativeAssistantTps('24 tok/s', snapshot?.showAssistantTps)).toBe('24 tok/s');
      expect(nativeReasoningPresentation('> Thinking', snapshot?.collapsibleThinkingBlocks, false).collapsible).toBe(true);
    }
    await flush(); expect(harness.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999); expect(harness.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.native.mock.calls.filter(([name]) => name === 'appearance.apply')).toHaveLength(1);
  });
  it('matches the corrected touch typography geometry: scaled body leading and fixed composer zoom floor', async () => {
    harness.request.mockResolvedValue({ themeId: 'jetbrains-dark', themeVariant: 'dark', fontSize: 105 });
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    expect(appearance.nativeChatTextStyle('user')).toEqual(expect.objectContaining({ fontSize: 15.75, lineHeight: 25.59375 }));
    expect(appearance.nativeChatTextStyle('composer')).toEqual(expect.objectContaining({ fontSize: 16, lineHeight: 24 }));
    expect(appearance.nativeChatTextStyle('assistant')).toEqual(expect.objectContaining({ fontFamily: 'JetBrains Mono', fontSize: 15.75, lineHeight: 25.59375 }));
    expect(appearance.nativeChatTextStyle('user').fontFamily).toBe('system-ui');
    expect(appearance.nativeTimeFormat()).toBeNull();
    expect(harness.request).toHaveBeenCalledExactlyOnceWith('/api/config/settings');
  });
  it('pauses all settings work when hidden, revalidates resume/Host generation and coalesces reconnect bursts', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const previous = appearance.nativeAppearance.current();
    harness.lifecycle = 'background'; rerun(); await flush();
    expect(appearance.nativeAppearance.current()).toBe(previous);
    const reads = harness.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90_000); expect(harness.request).toHaveBeenCalledTimes(reads);
    harness.lifecycle = 'active'; harness.connection = { id: 'two', url: 'https://two.example' }; harness.epoch++;
    rerun(); await flush();
    expect(harness.native).toHaveBeenCalledWith('appearance.reset', { hostID: 'two' });
    for (let i = 0; i < 50; i++) emit('reconnected');
    await flush(); expect(harness.request).toHaveBeenCalledTimes(reads + 2);
    harness.epoch++; rerun(); expect(appearance.nativeAppearance.current()).toBeNull(); await flush();
    expect(appearance.nativeAppearance.current()).not.toBeNull();
  });
  it('restores the same Host palette before resume GET, preserving it if the Host is offline', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const palette = appearance.nativeAppearance.current()?.cssVars;
    harness.lifecycle = 'background'; rerun(); await flush();
    harness.request.mockRejectedValueOnce(new Error('offline on resume'));
    harness.lifecycle = 'active'; rerun(); await flush();
    expect(appearance.nativeAppearance.current()?.cssVars).toBe(palette);
    expect(appearance.nativeAppearance.error()).toBe('offline on resume');
    expect(harness.native.mock.calls.filter(([name]) => name === 'appearance.apply')).toHaveLength(2);
  });
  it('exposes refresh failure and unsupported fonts separately while retaining the valid palette', async () => {
    harness.native.mockImplementation(async (name) => name === 'appearance.reset' ? { revision: 1 } : { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: ['Inter'] });
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const previous = appearance.nativeAppearance.current(); expect(previous?.unsupportedFonts).toEqual(['Inter']);
    harness.request.mockRejectedValueOnce(new Error('Host unavailable'));
    await appearance.refreshNativeAppearance();
    expect(appearance.nativeAppearance.current()).toBe(previous); expect(appearance.nativeAppearance.error()).toBe('Host unavailable');
    await appearance.refreshNativeAppearance(); expect(appearance.nativeAppearance.error()).toBe('');
  });
  it('saves color mode to canonical Host fields, preserves both selected themes and re-reads instead of storing local appearance', async () => {
    let settings = { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark', fontSize: 105 };
    harness.request.mockImplementation(async (_path, method, body) => {
      if (method === 'PUT') settings = { ...settings, ...body };
      return settings;
    });
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    harness.request.mockClear();
    await appearance.saveNativeAppearanceMode('light', () => true, harness.request);
    expect(harness.request.mock.calls).toEqual([
      ['/api/config/settings'],
      ['/api/config/settings', 'PUT', { useSystemTheme: false, themeVariant: 'light', themeId: 'jetbrains-light', lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark' }],
      ['/api/config/settings'],
    ]);
    expect(appearance.nativeAppearance.current()?.mode).toBe('light'); expect(appearance.nativeAppearance.saving()).toBe(false);
    harness.request.mockClear(); await appearance.saveNativeAppearanceMode('system', () => true, harness.request);
    expect(harness.request).toHaveBeenCalledWith('/api/config/settings', 'PUT', expect.objectContaining({ useSystemTheme: true, themeVariant: 'dark', themeId: 'jetbrains-dark' }));
    expect(appearance.nativeAppearance.current()?.mode).toBe('system');
  });
  it('failed canonical writes retain the prior mode and expose only a safe error to settings callers', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    harness.request.mockImplementation(async (_path, method) => {
      if (method === 'PUT') throw new Error('sensitive Host URL and settings sentinel');
      return { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false };
    });
    await expect(appearance.saveNativeAppearanceMode('light', () => true, harness.request)).rejects.toThrow('chat.chatInput.toast.reloadFailed');
    expect(appearance.nativeAppearance.current()?.mode).toBe('dark');
    expect(appearance.nativeAppearance.error()).not.toContain('sentinel');
    expect(appearance.nativeAppearance.saving()).toBe(false);
  });
  it('refuses an unbound save helper without borrowing the current root sender', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    harness.request.mockClear(); harness.native.mockClear();
    await expect(appearance.saveNativeAppearanceMode('light', () => true)).rejects.toThrow('chat.chatInput.toast.reloadFailed');
    expect(harness.request).not.toHaveBeenCalled(); expect(harness.native).not.toHaveBeenCalled();
  });
  it('selecting system writes the actual device appearance rather than the old forced dark variant', async () => {
    harness.native.mockImplementation(async name => name === 'appearance.reset' ? { revision: 1 } : {
      uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [], systemColorScheme: 'light',
    });
    let settings = { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark' };
    harness.request.mockImplementation(async (_path, method, body) => { if (method === 'PUT') settings = { ...settings, ...body }; return settings; });
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    await appearance.saveNativeAppearanceMode('system', () => true, harness.request);
    expect(harness.request).toHaveBeenCalledWith('/api/config/settings', 'PUT', expect.objectContaining({ useSystemTheme: true, themeVariant: 'light', themeId: 'jetbrains-light' }));
  });
  it('fences an old polling result and prevents duplicate writes while a color-mode mutation is pending', async () => {
    let settings = { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false };
    harness.request.mockImplementation(async (_path, method, body) => { if (method === 'PUT') settings = { ...settings, ...body }; return settings; });
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const old = deferred<unknown>(); harness.request.mockReturnValueOnce(old.promise);
    const polling = appearance.refreshNativeAppearance(); await flush();
    const write = deferred<unknown>();
    harness.request.mockImplementation(async (_path, method, body) => { if (method === 'PUT') { settings = { ...settings, ...body }; return write.promise; } return settings; });
    const mutation = appearance.saveNativeAppearanceMode('light', () => true, harness.request); await flush();
    await expect(appearance.saveNativeAppearanceMode('dark', () => true, harness.request)).rejects.toThrow();
    const before = harness.request.mock.calls.length; await appearance.refreshNativeAppearance(); expect(harness.request).toHaveBeenCalledTimes(before);
    old.resolve({ themeId: 'nord-light', themeVariant: 'light' }); await polling;
    expect(appearance.nativeAppearance.current()?.mode).toBe('dark');
    write.resolve(settings); await mutation;
    expect(appearance.nativeAppearance.current()?.themeIDs.light).toBe('carbonfox-light');
    expect(appearance.nativeAppearance.current()?.mode).toBe('light');
  });
  it('does not send a color-mode PUT after switching Host during its initial GET', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const read = deferred<unknown>(); harness.request.mockReturnValueOnce(read.promise);
    const pending = appearance.saveNativeAppearanceMode('light', () => true, harness.request); await flush();
    harness.connection = { id: 'other', url: 'https://other.example' }; harness.epoch++; rerun(); await flush();
    read.resolve({ themeId: 'jetbrains-dark', themeVariant: 'dark' }); await pending;
    expect(harness.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    expect(appearance.nativeAppearance.saving()).toBe(false);
  });
});

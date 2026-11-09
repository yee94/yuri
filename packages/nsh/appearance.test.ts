import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeAssistantTps, nativeReasoningPresentation } from './chat-preferences-core';

const harness = vi.hoisted(() => ({
  lifecycle: 'active', connection: { id: 'one', url: 'https://one.example' } as { id: string; url: string } | null,
  epoch: 1, effects: [] as Array<() => void | (() => void)>, effectStops: [] as Array<() => void>,
  cleanups: [] as Array<() => void>, listeners: new Map<string, Set<(payload: unknown) => void>>(),
  request: vi.fn(), native: vi.fn(), setColorScheme: vi.fn(), scheme: 'dark', desktop: false,
  storageGet: vi.fn(), storageSet: vi.fn(),
  readers: [] as Array<{ scope: { hostID: string; lease: string }; send: (path: string, method?: string, body?: unknown) => Promise<unknown> }>,
}));
vi.mock('nsh', () => {
  type Reaction = { run: () => void; dependencies: Set<Set<Reaction>> };
  let tracking: Reaction | undefined, flushing = false;
  const queue = new Set<Reaction>();
  const untracked = <T>(work: () => T) => { const previous = tracking; tracking = undefined; try { return work(); } finally { tracking = previous; } };
  function signal<T>(initial: T) {
    let value = initial;
    const observers = new Set<Reaction>();
    return Object.assign(() => { if (tracking) { observers.add(tracking); tracking.dependencies.add(observers); } return value; }, {
      set(next: T) {
        if (Object.is(value, next)) return;
        value = next; observers.forEach(observer => queue.add(observer));
        if (flushing) return;
        flushing = true; let turns = 0;
        try { while (queue.size) { if (++turns > 100) throw new Error('Appearance fixture reaction loop'); const reaction = queue.values().next().value!; queue.delete(reaction); reaction.run(); } }
        finally { flushing = false; }
      },
    });
  }
  function effect(work: () => void | (() => void)) {
    let stop: void | (() => void);
    const reaction: Reaction = { dependencies: new Set(), run() {
      stop?.(); stop = undefined;
      reaction.dependencies.forEach(observers => observers.delete(reaction)); reaction.dependencies.clear();
      const previous = tracking; tracking = reaction;
      try { stop = work(); } finally { tracking = previous; }
    } };
    harness.effects.push(reaction.run);
    harness.effectStops.push(() => { stop?.(); stop = undefined; });
    harness.cleanups.push(() => { stop?.(); stop = undefined; reaction.dependencies.forEach(observers => observers.delete(reaction)); queue.delete(reaction); });
    reaction.run();
  }
  return {
  signal, computed: <T>(read: () => T) => () => read(),
  lifecycle: () => harness.lifecycle, colorScheme: () => harness.scheme, setColorScheme: harness.setColorScheme,
  untracked, effect,
  cleanup: (work: () => void) => harness.cleanups.push(work),
  platform: { get desktop() { return harness.desktop; } },
  Storage: { getItem: harness.storageGet, setItem: harness.storageSet },
  host: { on: (name: string, work: (payload: unknown) => void) => {
    const listeners = harness.listeners.get(name) ?? new Set(); listeners.add(work); harness.listeners.set(name, listeners);
    return () => { listeners.delete(work); };
  } },
}; });
vi.mock('./runtime', () => ({ request: harness.request, native: harness.native, bindRequest: (scope: { hostID: string; lease: string } | null) => {
  if (!scope || scope.hostID !== harness.connection?.id || scope.lease !== `lease-${harness.epoch}`) throw new Error('Appearance fixture scope not admitted');
  const send = async (path: string, method?: string, body?: unknown): Promise<unknown> => {
    if (scope.hostID !== harness.connection?.id || scope.lease !== `lease-${harness.epoch}`) throw new Error('Retired appearance fixture lease');
    return method === undefined ? harness.request(path) : harness.request(path, method, body);
  };
  harness.readers.push({ scope, send });
  return send;
} }));
vi.mock('./state', () => ({ app: { connection: () => harness.connection, runtimeScope: () => harness.connection ? { hostID: harness.connection.id, lease: `lease-${harness.epoch}` } : null }, epoch: () => harness.epoch, captureHostRequest: () => harness.request }));
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
  harness.readers = [];
  harness.request.mockReset().mockResolvedValue({ themeId: 'jetbrains-dark', themeVariant: 'dark', uiFont: 'system', monoFont: 'system-mono', fontSize: 125, timeFormatPreference: '24h' });
  harness.native.mockReset().mockImplementation(async (name) => name === 'appearance.reset' ? { revision: 1 } : { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [] });
  harness.setColorScheme.mockReset();
  harness.desktop = false; harness.storageGet.mockReset().mockResolvedValue(null); harness.storageSet.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  harness.effectStops.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); await flush(); vi.useRealTimers();
});

describe('NativeAppearanceSync root integration', () => {
  it('loads desktop code scale once, applies acknowledged local saves to real text styles, and never PUTs it to Host', async () => {
    harness.desktop = true; harness.storageGet.mockResolvedValue('125');
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    expect(appearance.nativeChatTextStyle('code')).toMatchObject({ fontSize: 15, lineHeight: 24.375 });
    expect(appearance.nativeChatTextStyle('user').fontSize).toBe(17.5);
    expect(appearance.nativeChatTextStyle('composer')).toMatchObject({ fontSize: 14, lineHeight: 21 });
    await appearance.saveNativeCodeFontSize(150);
    expect(harness.storageSet).toHaveBeenCalledExactlyOnceWith('native-code-font-size', '150');
    expect(appearance.nativeChatTextStyle('code')).toMatchObject({ fontSize: 18, lineHeight: 29.25 });
    for (let i = 0; i < 200; i++) appearance.nativeChatTextStyle('code');
    expect(harness.storageGet).toHaveBeenCalledTimes(1);
    expect(harness.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    harness.desktop = false;
    expect(appearance.nativeChatTextStyle('code').fontSize).toBe(13);
  });
  it('adopts native font completion without settings reads, palette apply or stale Host/ticket adoption', async () => {
    const projection = { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], fontRevision: 1, fontTicket: 2, fontStatus: 'loading' };
    harness.native.mockImplementation(async name => name === 'appearance.reset' ? { revision: 1 } : projection);
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const prior = appearance.nativeAppearance.current()!, reads = harness.request.mock.calls.length, applies = harness.native.mock.calls.length;
    const event = { ...projection, hostID: 'one', uiFontFamily: 'Inter', fontStatus: 'ready', cssVars: { dark: { background: 'poison' } } };
    const send = (payload: unknown) => harness.listeners.get('appearance.fonts')?.forEach(listener => listener(payload));
    send({ ...event, fontTicket: 1 }); expect(appearance.nativeAppearance.current()).toBe(prior);
    send({ ...event, hostID: 'other' }); expect(appearance.nativeAppearance.current()).toBe(prior);
    send(event); const next = appearance.nativeAppearance.current()!;
    expect(next.uiFontFamily).toBe('Inter'); expect(next.cssVars).toBe(prior.cssVars);
    for (let i = 0; i < 200; i++) send(event);
    expect(appearance.nativeAppearance.current()).toBe(next);
    expect(harness.request).toHaveBeenCalledTimes(reads); expect(harness.native).toHaveBeenCalledTimes(applies);
    harness.lifecycle = 'background'; send({ ...event, uiFontFamily: 'Late Background' });
    expect(appearance.nativeAppearance.current()).toBe(next);
  });
  it('joins an early native retry completion after its new ticket response without re-reading or replaying palette', async () => {
    const projection = { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], fontRevision: 1, fontTicket: 2, fontStatus: 'failed' };
    harness.native.mockImplementation(async name => name === 'appearance.reset' ? { revision: 1 } : projection);
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const prior = appearance.nativeAppearance.current()!;
    harness.request.mockClear(); harness.native.mockClear();
    harness.native.mockImplementation(async name => {
      expect(name).toBe('appearance.fonts.retry');
      harness.listeners.get('appearance.fonts')?.forEach(listener => listener({ ...projection, hostID: 'one', fontTicket: 3, fontStatus: 'ready', uiFontFamily: 'Inter' }));
      return { ...projection, hostID: 'one', fontTicket: 3, fontStatus: 'loading' };
    });
    await appearance.retryNativeAppearanceFonts();
    expect(appearance.nativeAppearance.current()).toMatchObject({ fontTicket: 3, fontStatus: 'ready', uiFontFamily: 'Inter' });
    expect(appearance.nativeAppearance.current()?.cssVars).toBe(prior.cssVars);
    expect(harness.request).not.toHaveBeenCalled(); expect(harness.native).toHaveBeenCalledTimes(1);
  });
  it('tracks canonical density dependencies through computed without subscribing untracked feedback or issuing reads', async () => {
    const appearance = await import('./appearance');
    const { effect, untracked } = await import('nsh');
    appearance.NativeAppearanceSync(); await flush();
    const scales: number[] = [];
    effect(() => { scales.push(appearance.nativeDensity().scale); untracked(() => appearance.nativeAppearance.error()); });
    expect(scales).toEqual([1]);
    const prior = appearance.nativeAppearance.current()!;
    appearance.nativeAppearance.current.set({ ...prior, padding: 200 });
    expect(scales).toEqual([1, Math.sqrt(2)]);
    appearance.nativeAppearance.error.set('feedback-only');
    expect(scales).toEqual([1, Math.sqrt(2)]);
    appearance.nativeAppearance.current.set(prior);
    expect(scales).toEqual([1, Math.sqrt(2), 1]);
    expect(harness.request).toHaveBeenCalledExactlyOnceWith('/api/config/settings');
  });
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
    rerun(); expect(appearance.nativeAppearance.current()).toBeNull(); await flush();
    expect(harness.native).toHaveBeenCalledWith('appearance.reset', { hostID: 'two' });
    for (let i = 0; i < 50; i++) emit('reconnected');
    await flush(); expect(harness.request).toHaveBeenCalledTimes(reads + 2);
    const prior = appearance.nativeAppearance.current()!, next = deferred<unknown>();
    harness.request.mockReturnValueOnce(next.promise);
    harness.epoch++; rerun(); expect(appearance.nativeAppearance.current()).toBe(prior); await flush();
    expect(appearance.nativeAppearance.current()?.cssVars).toBe(prior.cssVars);
    expect(harness.readers.at(-1)?.scope).toEqual({ hostID: 'two', lease: 'lease-3' });
    next.resolve({ themeId: 'jetbrains-dark', themeVariant: 'dark', fontSize: 150 }); await flush();
    expect(appearance.nativeAppearance.current()).toMatchObject({ fontSize: 150, sourceHost: { hostID: 'two', generation: 3 } });
  });
  it('same-Host lease renewal retains canonical prior after read failure, rejects old authority and ignores a late old read before explicit recovery', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const prior = appearance.nativeAppearance.current()!, oldReader = harness.readers.at(-1)!, old = deferred<unknown>();
    harness.request.mockReturnValueOnce(old.promise);
    const pending = appearance.refreshNativeAppearance(); await flush();
    harness.request.mockRejectedValueOnce(new Error('renewed reader offline'));
    harness.epoch++; rerun();
    expect(appearance.nativeAppearance.current()).toBe(prior); await flush();
    expect(appearance.nativeAppearance.current()?.cssVars).toBe(prior.cssVars);
    expect(appearance.nativeAppearance.error()).toBe('renewed reader offline');
    expect(harness.readers.at(-1)?.scope).toEqual({ hostID: 'one', lease: 'lease-2' });
    const calls = harness.request.mock.calls.length;
    await expect(oldReader.send('/api/config/settings', 'PUT', { fontSize: 50 })).rejects.toThrow('Retired appearance fixture lease');
    expect(harness.request).toHaveBeenCalledTimes(calls);
    old.resolve({ themeId: 'nord-light', themeVariant: 'light', fontSize: 50 }); await pending; await flush();
    expect(appearance.nativeAppearance.current()?.cssVars).toBe(prior.cssVars);
    expect(appearance.nativeAppearance.current()?.fontSize).toBe(prior.fontSize);
    expect(appearance.nativeAppearance.error()).toBe('renewed reader offline');
    harness.request.mockResolvedValueOnce({ themeId: 'jetbrains-dark', themeVariant: 'dark', fontSize: 150 });
    await appearance.refreshNativeAppearance();
    expect(appearance.nativeAppearance.current()).toMatchObject({ fontSize: 150, sourceHost: { hostID: 'one', generation: 2 } });
    expect(appearance.nativeAppearance.error()).toBe('');
    expect(harness.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
  });
  it('switching Host clears the prior palette and a failed new reader cannot publish the old Host snapshot', async () => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const old = deferred<unknown>(); harness.request.mockReturnValueOnce(old.promise);
    const pending = appearance.refreshNativeAppearance(); await flush();
    harness.request.mockRejectedValueOnce(new Error('new Host offline'));
    harness.connection = { id: 'other', url: 'https://other.example' }; harness.epoch++; rerun();
    expect(appearance.nativeAppearance.current()).toBeNull(); await flush();
    expect(appearance.nativeAppearance.current()).toBeNull(); expect(appearance.nativeAppearance.error()).toBe('new Host offline');
    old.resolve({ themeId: 'nord-light', themeVariant: 'light' }); await pending;
    expect(appearance.nativeAppearance.current()).toBeNull(); expect(appearance.nativeAppearance.error()).toBe('new Host offline');
    await appearance.refreshNativeAppearance();
    expect(appearance.nativeAppearance.current()?.sourceHost.hostID).toBe('other');
    expect(appearance.nativeAppearance.error()).toBe('');
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
  it.each(['other Host', 'same-Host lease'] as const)('does not send a color-mode PUT after %s changes during its initial GET', async boundary => {
    const appearance = await import('./appearance'); appearance.NativeAppearanceSync(); await flush();
    const read = deferred<unknown>(); harness.request.mockReturnValueOnce(read.promise);
    const pending = appearance.saveNativeAppearanceMode('light', () => true, harness.request); await flush();
    if (boundary === 'other Host') harness.connection = { id: 'other', url: 'https://other.example' };
    harness.epoch++; rerun(); await flush();
    read.resolve({ themeId: 'jetbrains-dark', themeVariant: 'dark' }); await pending;
    expect(harness.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    expect(appearance.nativeAppearance.saving()).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { nativeLayoutDensity, nativePadding } from './native-density';
import { projectHomeDensityGeometry, projectHomeGeometry } from './projects-presentation';
import { appearanceFromSettings, createNativeAppearanceSync, nativeTypographyStyle, type AppliedNativeAppearance } from './appearance-core';

const fonts = { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] };
const scope = { hostID: 'host-a', generation: 1, url: 'https://host.invalid' };

describe('canonical padding geometry', () => {
  it.each([50, 100, 105, 200])('projects %s%% into real layout while preserving independent geometry', async padding => {
    const appearance = await appearanceFromSettings({ padding }, async () => ({ themes: [] }));
    const scale = Math.sqrt(padding / 100), layout = nativeLayoutDensity(appearance.padding), projects = projectHomeDensityGeometry(appearance.padding);
    expect(appearance.padding).toBe(padding);
    expect(layout.scale).toBe(scale);
    expect(projects.headerHeight).toBeCloseTo(74 * scale);
    expect(projects.icon).toBeCloseTo(38 * scale);
    expect(projects.pageGap).toBeCloseTo(20 * scale);
    expect(projects.pageInset).toBe(18);
    expect(projects.groupGap).toBe(10);
    expect(projects.groupsInset).toBeCloseTo(12 * scale);
    expect(projects.rowHeight).toBeCloseTo(Math.max(36, 40 * scale));
    expect(projects.worktreeHeight).toBeCloseTo(Math.max(36, 42 * scale));
    expect(projects.action).toBeGreaterThanOrEqual(36);
    expect(layout.settings.field.minHeight).toBeGreaterThanOrEqual(44);
    expect(layout.settings.chip.minHeight).toBeGreaterThanOrEqual(36);
    expect(layout.settings.radio.minHeight).toBeGreaterThanOrEqual(36);
    expect(layout.chat.transcript).toEqual({ paddingHorizontal: 12 * scale, paddingTop: 26, gap: 20 * scale });
    expect(layout.chat.composerSurface).toEqual({ paddingHorizontal: 12 * scale, paddingTop: 4 * scale, paddingBottom: 4 * scale });
    expect(layout.chat.input).toEqual({ maxHeight: 104 * scale });
    expect(layout.chat.welcome).toEqual({ paddingHorizontal: 24 * scale, paddingVertical: 16 * scale, gap: 16 * scale });
    expect(projects.radius).toBe(24); expect(projects.groupRadius).toBe(16);
    expect(projects.title).toBe(projectHomeGeometry.title);
    expect(projects.sessionTitle).toBe(projectHomeGeometry.sessionTitle);
    expect(nativeTypographyStyle({ ...appearance, ...fonts, codeFontSize: 140 }, 'code')).toEqual({ fontSize: 18.2, fontFamily: 'monospace' });
    expect(nativeTypographyStyle({ ...appearance, ...fonts }, 'markdown').fontSize).toBe(15);
  });

  it('uses the successful snapshot default and Host integer precision, but rejects malformed authority', async () => {
    expect((await appearanceFromSettings({}, async () => ({}))).padding).toBe(100);
    expect(nativePadding(105.4)).toBe(105);
    for (const value of [null, '105', NaN, Infinity, 49, 201, {}, []]) expect(() => nativePadding(value)).toThrow('padding');
  });

  it('keeps prior density after failure and rejects late Host geometry without another reader', async () => {
    let settings: unknown = { padding: 105 }, value: AppliedNativeAppearance | null = null;
    let pending: Promise<unknown> | undefined;
    const read = vi.fn(async () => pending ?? settings), apply = vi.fn(async () => fonts), failed = vi.fn();
    const sync = createNativeAppearanceSync({ readSettings: read, readThemes: async () => ({ themes: [] }), reset: async () => 1, apply, changed: next => { value = next; }, failed });
    sync.setScope(scope); await sync.refresh();
    const previous = value;
    settings = { padding: '200' }; await sync.refresh();
    expect(value).toBe(previous); expect(value!.padding).toBe(105); expect(apply).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls.at(-1)?.[0]).toContain('padding');
    let resolve!: (value: unknown) => void;
    pending = new Promise(done => { resolve = done; });
    const old = sync.refresh(); await Promise.resolve(); await Promise.resolve();
    sync.setScope({ ...scope, hostID: 'host-b', generation: 2 });
    pending = undefined; settings = { padding: 50 }; await sync.refresh();
    resolve({ padding: 200 }); await old;
    expect(value!.padding).toBe(50); expect(value!.sourceHost?.hostID).toBe('host-b');
    expect(read).toHaveBeenCalledTimes(4); expect(apply).toHaveBeenCalledTimes(2);
  });
});

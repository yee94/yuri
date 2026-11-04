import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { getDefaultTheme } from '@/lib/theme/themes';
import { YuriLogo } from '@/components/ui/YuriLogo';
import { GuiPluginHost } from './host';
import { GuiAppearanceProvider } from './GuiAppearanceProvider';
import { readRuntimeScopedItem, writeRuntimeScopedItem } from '@/lib/runtimeScopedStorage';
import { updateDesktopSettings } from '@/lib/persistence';
import { NativeGuiSession } from './native';
import type { NativeGuiBridge } from './native-types';
import { guiPreferencesKey } from './preferences';
import { getRuntimeKey } from '@/lib/runtime-switch';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn(async () => new Response(JSON.stringify({ themes: [] }))) }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn(async () => {}) }));
const disposals: (() => void)[] = [];
afterEach(async () => { await act(async () => { for (const dispose of disposals.splice(0)) dispose(); }); localStorage.clear(); vi.restoreAllMocks(); });

function fixture() {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    writeRuntimeScopedItem('themeMode', 'dark');
    writeRuntimeScopedItem('darkThemeId', getDefaultTheme(true).metadata.id);
    const host = new GuiPluginHost({ client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(), transport: 'appearance', storage: localStorage, locale: 'en', mode: 'dark', narrow: false });
    const node = document.createElement('div'); document.body.append(node);
    const root = createRoot(node);
    disposals.push(() => { root.unmount(); host.dispose(); node.remove(); });
    let context: ThemeContextValue | undefined;
    function Probe() { context = React.useContext(ThemeSystemContext); return <YuriLogo />; }
    const current = () => { if (!context) throw new Error('No theme context'); return context; };
    const render = (owner: GuiPluginHost | null = host) => root.render(<ThemeSystemProvider><GuiAppearanceProvider host={owner}><Probe /></GuiAppearanceProvider></ThemeSystemProvider>);
    return { host, node, render, current };
}
const svg = (radius: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="${radius}"/></svg>`;
function bundle(title = 'Ink') {
    return { options: {}, revision: '1', code: `const G=require('@opencode/plugin/gui'); module.exports=G.Plugin.define({setup(ctx){
        ctx.add(G.Registry.define('yuri.theme'),{id:'ink',title:${JSON.stringify(title)},variant:'dark',colors:{primary:{base:'#123456'}}});
        ctx.add(G.Registry.define('yuri.branding'),{id:'logo',title:'Logo',logo:{svg:${JSON.stringify(svg(9))},lightSvg:${JSON.stringify(svg(6))}}});
    }});` };
}

it('automatically applies enabled themes and logos without changing saved theme choices or exposing plugin theme options', async () => {
    const f = fixture();
    const oldPreferenceKey = `${guiPreferencesKey(getRuntimeKey())}:appearance`;
    localStorage.setItem(oldPreferenceKey, '{');
    await act(async () => {
        f.host.install('skin', bundle());
        f.render();
    });
    expect(f.current().currentTheme.metadata.name).toBe('Ink');
    expect(f.current().currentTheme.colors.primary.base).toBe('#123456');
    expect(f.current().availableThemes.some((theme) => theme.metadata.id.startsWith('gui:'))).toBe(false);
    expect(f.current().darkThemeId).toBe(getDefaultTheme(true).metadata.id);
    expect(readRuntimeScopedItem('selectedThemeId')).toBe(getDefaultTheme(true).metadata.id);
    expect(localStorage.getItem(oldPreferenceKey)).toBe('{');
    const darkLogo = f.node.querySelector('img[data-yuri-logo]')?.getAttribute('src');
    expect(darkLogo).toContain('data:image/svg+xml,');
    await act(async () => window.dispatchEvent(new CustomEvent('yuri:settings-synced', { detail: {
        useSystemTheme: false, themeVariant: 'dark', lightThemeId: f.current().lightThemeId, darkThemeId: f.current().darkThemeId,
    } })));
    expect(vi.mocked(updateDesktopSettings).mock.lastCall?.[0].themeId).toBe(getDefaultTheme(true).metadata.id);
    const notify = vi.fn(); f.host.appearanceCatalog.subscribe(notify);
    const currentTheme = f.current().currentTheme;
    await act(async () => { for (let index = 0; index < 50; index++) f.host.setSession({ id: `session-${index}`, directory: '/work' }); });
    expect(notify).not.toHaveBeenCalled();
    expect(f.current().currentTheme).toBe(currentTheme);
    await act(async () => f.current().setThemeMode('light'));
    expect(f.current().currentTheme.metadata.variant).toBe('light');
    expect(f.current().currentTheme.metadata.id.startsWith('gui:')).toBe(false);
    expect(f.node.querySelector('img[data-yuri-logo]')?.getAttribute('src')).not.toBe(darkLogo);
    await act(async () => f.current().setThemeMode('dark'));
    await act(async () => f.host.uninstall('skin'));
    expect(f.current().currentTheme.metadata.id).toBe(getDefaultTheme(true).metadata.id);
    expect(f.node.querySelector('svg[data-yuri-logo]')).not.toBeNull();
    await act(async () => f.host.install('skin', { ...bundle(), revision: '2' }));
    expect(f.current().currentTheme.metadata.name).toBe('Ink');
    expect(f.node.querySelector('img[data-yuri-logo]')).not.toBeNull();
    await act(async () => f.render(null));
    expect(f.current().currentTheme.metadata.id).toBe(getDefaultTheme(true).metadata.id);
    expect(f.node.querySelector('svg[data-yuri-logo]')).not.toBeNull();
});

it('uses inventory priority, restores the preceding plugin on withdrawal, and clears the old host on runtime change', async () => {
    const f = fixture();
    const other = new GuiPluginHost({ client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(), transport: 'other', storage: localStorage, locale: 'en', mode: 'dark', narrow: false });
    disposals.push(() => other.dispose());
    await act(async () => {
        f.host.appearanceCatalog.setOrder(['zeta', 'alpha']);
        f.host.install('alpha', bundle('Alpha'));
        f.host.install('zeta', bundle('Zeta'));
        f.render();
    });
    expect(f.current().currentTheme.metadata.name).toBe('Alpha');
    await act(async () => f.host.uninstall('alpha'));
    expect(f.current().currentTheme.metadata.name).toBe('Zeta');
    await act(async () => f.render(other));
    expect(f.current().currentTheme.metadata.id).toBe(getDefaultTheme(true).metadata.id);
    expect(f.node.querySelector('svg[data-yuri-logo]')).not.toBeNull();
});

it('automatically applies capable Dock icons and falls back when a failing provider is withdrawn', async () => {
    const f = fixture();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const lightPng = `${png}AAAA`;
    const request = vi.fn<NativeGuiBridge['request']>(async () => ({ ok: true, value: undefined }));
    const skin = bundle();
    const native = new NativeGuiSession({ request, subscribe: () => () => {} }, {
        lease: 'dock-lease', os: 'macos', capabilities: { dockIcon: true }, app: { version: '1', packaged: false }, bundle: skin,
    });
    await act(async () => {
        f.host.install('native', { ...skin, code: `const G=require('@opencode/plugin/gui'); module.exports=G.Plugin.define({setup(ctx){ctx.add(G.Registry.define('yuri.branding'),{id:'dock',title:'Dock',dockIcon:{png:${JSON.stringify(png)},lightPng:${JSON.stringify(lightPng)}}});}});` }, native);
        f.render();
    });
    expect(request).toHaveBeenCalledWith('dock-icon', expect.objectContaining({ image: png }));
    await act(async () => f.current().setThemeMode('light'));
    expect(request).toHaveBeenLastCalledWith('dock-icon', expect.objectContaining({ image: lightPng }));
    await act(async () => f.current().setThemeMode('dark'));
    expect(request).toHaveBeenLastCalledWith('dock-icon', expect.objectContaining({ image: png }));
    const count = request.mock.calls.length;
    await act(async () => { for (let index = 0; index < 50; index++) f.host.setSession({ id: `s-${index}`, directory: '/work' }); });
    expect(request).toHaveBeenCalledTimes(count);
    await act(async () => f.render(null));
    expect(request).toHaveBeenCalledWith('dock-icon', expect.objectContaining({ image: null }));
    request.mockResolvedValueOnce({ ok: false, error: { code: 'GUI_PLUGIN_INVALID_INPUT', message: 'Invalid Dock image' } });
    await act(async () => f.render());
    expect(f.host.getSnapshot().plugins.find((plugin) => plugin.id === 'native')).toMatchObject({ status: 'failed', errorCode: 'GUI_PLUGIN_INVALID_INPUT' });
    expect(f.host.appearanceCatalog.getSnapshot().branding).toEqual([]);
});

it('keeps window-only branding available without requesting a native Dock capability', async () => {
    const f = fixture();
    const setDockIcon = vi.spyOn(f.host, 'setDockIcon');
    await act(async () => {
        f.host.install('window', { options: {}, revision: '1', code: `const G=require('@opencode/plugin/gui'); module.exports=G.Plugin.define({setup(ctx){ctx.add(G.Registry.define('yuri.branding'),{id:'brand',title:'Brand',logo:{svg:${JSON.stringify(svg(8))}},dockIcon:{png:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'}});}});` });
        f.render();
    });
    expect(f.node.querySelector('img[data-yuri-logo]')).not.toBeNull();
    expect(setDockIcon).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from 'vitest';
import { GuiPluginAppearance, guiAppearanceKey, EMPTY_GUI_APPEARANCE } from './appearance';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="red"/></svg>';
describe('plugin appearance catalog', () => {
    it('merges theme defaults, namespaces ids, retains stable snapshots and withdraws cleanly', () => {
        const catalog = new GuiPluginAppearance();
        const notify = vi.fn(); catalog.subscribe(notify);
        const theme = { id: 'ink', title: 'Ink', variant: 'dark', colors: { primary: { base: '#123456' } } };
        catalog.replace('one', [theme], [{ id: 'logo', title: 'Logo', logo: { svg } }], false);
        const snapshot = catalog.getSnapshot();
        expect(snapshot.themes[0].metadata.id).toBe(`gui:${guiAppearanceKey('one', 'ink')}`);
        expect(snapshot.themes[0].colors.surface.background).toBe(getDefaultTheme(true).colors.surface.background);
        expect(snapshot.themes[0].colors.primary.base).toBe('#123456');
        expect(snapshot.branding[0].logo?.dark).toContain('data:image/svg+xml,');
        theme.colors.primary.base = '#654321';
        expect(snapshot.themes[0].colors.primary.base).toBe('#123456');
        theme.colors.primary.base = '#123456';
        catalog.replace('one', [theme], [{ id: 'logo', title: 'Logo', logo: { svg } }], false);
        expect(catalog.getSnapshot()).toBe(snapshot); expect(notify).toHaveBeenCalledTimes(1);
        catalog.replace('two', [theme], [], false);
        expect(catalog.getSnapshot().themes[0].metadata.id).not.toBe(snapshot.themes[0].metadata.id);
        catalog.remove('one'); expect(catalog.getSnapshot().branding).toEqual([]);
        catalog.dispose(); expect(catalog.getSnapshot()).toBe(EMPTY_GUI_APPEARANCE);
    });
    it('rejects invalid resources, duplicate ids and oversized inputs atomically', () => {
        const catalog = new GuiPluginAppearance();
        const theme = { id: 'ink', title: 'Ink', variant: 'dark' };
        catalog.replace('one', [theme], [], false);
        const snapshot = catalog.getSnapshot();
        for (const input of [
            { id: 'bad', title: 'Bad', logo: { svg: svg.replace('<circle', '<script') } },
            { id: 'bad', title: 'Bad', logo: { svg: svg.replace('fill="red"', 'onload="bad()"') } },
            { id: 'bad', title: 'Bad', dockIcon: { png: 'https://example.invalid/icon.png' } },
            { id: 'bad', title: 'Bad' },
        ]) expect(() => catalog.replace('one', [], [input], false)).toThrow();
        expect(() => catalog.replace('one', [theme, theme], [], false)).toThrow();
        expect(() => catalog.replace('one', [{ ...theme, colors: { surface: null } }], [], false)).toThrow();
        expect(() => catalog.replace('one', [{ ...theme, colors: { markdown: { heading1: {} } } }], [], false)).toThrow();
        expect(() => catalog.replace('one', [{ ...theme, config: { fonts: { sans: 42 } } }], [], false)).toThrow();
        expect(() => catalog.replace('one', Array.from({ length: 17 }, () => theme), [], false)).toThrow();
        expect(catalog.getSnapshot()).toBe(snapshot);
    });
    it('keeps plugin CSS after regenerated base tokens on theme switches', () => {
        const style = document.createElement('style'); style.dataset.yuriPluginStyle = 'fixture'; style.textContent = ':root{--surface-background:red}'; document.head.append(style);
        const generator = new CSSVariableGenerator();
        try {
            generator.apply(getDefaultTheme(true));
            generator.apply(getDefaultTheme(false));
            expect([...document.head.children].indexOf(document.getElementById('opencode-theme-variables')!)).toBeLessThan([...document.head.children].indexOf(style));
            expect(style.isConnected).toBe(true);
        } finally { style.remove(); document.getElementById('opencode-theme-variables')?.remove(); }
    });
    it('ranks by inventory and contribution order rather than identity or asynchronous arrival', () => {
        const catalog = new GuiPluginAppearance();
        catalog.setOrder(['zeta', 'alpha']);
        const theme = (id: string) => ({ id, title: id, variant: 'dark' });
        catalog.replace('alpha', [theme('first'), theme('last')], [{ id: 'logo', title: 'Alpha', logo: { svg } }], false);
        catalog.replace('zeta', [theme('one')], [{ id: 'logo', title: 'Zeta', logo: { svg } }], false);
        expect(catalog.getSnapshot().themes.map((entry) => entry.metadata.name)).toEqual(['last', 'first', 'one']);
        expect(catalog.getSnapshot().branding.map((entry) => entry.pluginId)).toEqual(['alpha', 'zeta']);
        const snapshot = catalog.getSnapshot();
        catalog.setOrder(['zeta', 'alpha']);
        expect(catalog.getSnapshot()).toBe(snapshot);
        catalog.setOrder(['alpha', 'zeta']);
        expect(catalog.getSnapshot().branding[0].pluginId).toBe('zeta');
        catalog.remove('zeta');
        expect(catalog.getSnapshot().branding[0].pluginId).toBe('alpha');
    });
});

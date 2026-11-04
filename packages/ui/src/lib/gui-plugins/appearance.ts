import type { Theme } from '@/types/theme';
import { getDefaultTheme } from '@/lib/theme/themes';
import { isValidTheme } from '@/contexts/theme-validation';
import { validateGuiSvg } from './file-icons';

export const GUI_THEME_REGISTRY = 'yuri.theme';
export const GUI_BRANDING_REGISTRY = 'yuri.branding';
export type GuiBranding = Readonly<{
    key: string; pluginId: string; title: string; native: boolean;
    logo?: { dark: string; light: string };
    dockIcon?: { dark: string; light: string };
}>;
type GuiAppearanceSnapshot = Readonly<{ themes: Theme[]; branding: readonly GuiBranding[] }>;
export const EMPTY_GUI_APPEARANCE: GuiAppearanceSnapshot = Object.freeze({ themes: [], branding: [] });
export const guiAppearanceKey = (pluginId: string, id: string) => JSON.stringify([pluginId, id]);

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an appearance object');
    return value as Record<string, unknown>;
}

function merge(base: unknown, patch: unknown): unknown {
    if (patch === undefined) return base;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const result = { ...object(base ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid appearance property');
        result[key] = merge(result[key], value);
    }
    return result;
}

function validateThemeValues(colors: Record<string, unknown>, config: unknown): void {
    const strings = (value: unknown) => {
        if (!Object.values(object(value)).every((item) => typeof item === 'string')) throw new Error('Theme tokens must be strings');
    };
    for (const [key, value] of Object.entries(colors)) {
        if (key === 'syntax') {
            for (const [field, tokens] of Object.entries(object(value))) {
                if (field === 'languages') Object.values(object(tokens)).forEach(strings);
                else strings(tokens);
            }
        } else if (key === 'tools' || key === 'toast') {
            for (const item of Object.values(object(value))) {
                if (typeof item !== 'string') strings(item);
            }
        } else if (key === 'buttons' || key === 'badges') Object.values(object(value)).forEach(strings);
        else if (key === 'charts') {
            if (!Object.values(object(value)).every((item) => typeof item === 'string' || Array.isArray(item) && item.every((color) => typeof color === 'string'))) throw new Error('Invalid chart colors');
        } else if (key === 'a11y') {
            if (!Object.values(object(value)).every((item) => typeof item === 'string' || typeof item === 'boolean')) throw new Error('Invalid accessibility tokens');
        } else strings(value);
    }
    if (config !== undefined) Object.values(object(config)).forEach(strings);
}

function png(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2 * 1024 * 1024 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error('Dock icons require an inline PNG data URL, at most 2 MiB');
    }
    return value;
}

/** A host-scoped catalog; unrelated sessions and host snapshots never republish it. */
export class GuiPluginAppearance {
    private plugins = new Map<string, { themes: Theme[]; branding: GuiBranding[]; signature: string; bytes: number }>();
    private order: readonly string[] = [];
    private snapshot = EMPTY_GUI_APPEARANCE;
    private listeners = new Set<() => void>();
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getSnapshot = () => this.snapshot;

    setOrder(ids: readonly string[]): void {
        if (ids.length === this.order.length && ids.every((id, index) => id === this.order[index])) return;
        this.order = [...ids];
        if (this.plugins.size) this.publish();
    }

    replace(pluginId: string, themeInputs: readonly unknown[], brandInputs: readonly unknown[], native: boolean): void {
        if (themeInputs.length > 16 || brandInputs.length > 8) throw new Error('Appearance contribution limit exceeded');
        if (!themeInputs.length && !brandInputs.length) { this.remove(pluginId); return; }
        const signature = JSON.stringify([themeInputs, brandInputs, native]);
        if (this.plugins.get(pluginId)?.signature === signature) return;
        const bytes = new TextEncoder().encode(signature).byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('Appearance resources exceed 8 MiB');
        const ids = new Set<string>();
        const identity = (input: unknown, kind: string) => {
            const value = object(input);
            if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 128 || ids.has(`${kind}:${value.id}`)) throw new Error('Invalid or duplicate appearance id/title');
            ids.add(`${kind}:${value.id}`);
            return { value, key: guiAppearanceKey(pluginId, value.id), title: value.title };
        };
        const themes = themeInputs.map((input) => {
            const { value, key, title } = identity(input, 'theme');
            if (value.variant !== 'light' && value.variant !== 'dark') throw new Error('Invalid theme variant');
            if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) throw new Error('Theme exceeds 64 KiB');
            const base = getDefaultTheme(value.variant === 'dark');
            const theme = { ...base, metadata: { ...base.metadata, id: `gui:${key}`, name: title, variant: value.variant }, colors: merge(base.colors, value.colors), config: merge(base.config, value.config) };
            if (!isValidTheme(theme)) throw new Error('Invalid plugin theme colors');
            validateThemeValues(theme.colors, theme.config);
            return structuredClone(theme);
        });
        const branding = brandInputs.map((input): GuiBranding => {
            const { value, key, title } = identity(input, 'brand');
            if (value.logo === undefined && value.dockIcon === undefined) throw new Error('Branding requires a logo or Dock icon');
            const logo = value.logo === undefined ? undefined : object(value.logo);
            const dock = value.dockIcon === undefined ? undefined : object(value.dockIcon);
            const darkLogo = logo ? validateGuiSvg(logo.svg) : undefined;
            const darkPng = dock ? png(dock.png) : undefined;
            return Object.freeze({ key, pluginId, title, native,
                logo: darkLogo ? { dark: darkLogo, light: logo?.lightSvg === undefined ? darkLogo : validateGuiSvg(logo.lightSvg) } : undefined,
                dockIcon: darkPng ? { dark: darkPng, light: dock?.lightPng === undefined ? darkPng : png(dock.lightPng) } : undefined,
            });
        });
        const others = [...this.plugins].filter(([id]) => id !== pluginId).map(([, entry]) => entry);
        if (themes.length + others.reduce((n, entry) => n + entry.themes.length, 0) > 128 || branding.length + others.reduce((n, entry) => n + entry.branding.length, 0) > 64 || bytes + others.reduce((n, entry) => n + entry.bytes, 0) > 16 * 1024 * 1024) throw new Error('Window appearance catalog limit exceeded');
        this.plugins.set(pluginId, { themes, branding, signature, bytes });
        this.publish();
    }

    remove(pluginId: string): void { if (this.plugins.delete(pluginId)) this.publish(); }
    dispose(): void { this.plugins.clear(); this.publish(); this.listeners.clear(); }
    private publish(): void {
        const rank = new Map(this.order.map((id, index) => [id, index]));
        const entries = [...this.plugins].sort(([a], [b]) => (rank.get(a) ?? -1) - (rank.get(b) ?? -1)).map(([, entry]) => entry);
        this.snapshot = entries.length ? { themes: entries.flatMap((entry) => entry.themes).reverse(), branding: entries.flatMap((entry) => entry.branding).reverse() } : EMPTY_GUI_APPEARANCE;
        for (const listener of this.listeners) listener();
    }
}

import type { IconName } from '@opencode/plugin/gui';
import type { JSX } from 'solid-js';

export const GUI_PAGE_REGISTRY = 'yuri.page';
export const GUI_PAGES_CONTRACT = 'yuri.pages';

/** A global placement for the same plugin-owned Solid content as file panels. */
export interface GuiPage {
    readonly id: string;
    readonly title: string;
    readonly icon?: IconName;
    render(): JSX.Element;
}

export interface GuiPagesAPI {
    open(id: string): boolean;
    current(): string | undefined;
}

export function guiPageKey(pluginId: string, pageId: string): string {
    return JSON.stringify([pluginId, pageId]);
}

export function validateGuiPage(value: unknown): GuiPage {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
        || !value.id.trim() || value.id.length > 128 || !('title' in value) || typeof value.title !== 'string'
        || !('render' in value) || typeof value.render !== 'function') {
        throw new Error('Invalid yuri.page contribution');
    }
    return value as GuiPage;
}

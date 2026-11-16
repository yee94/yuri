import type { ShortcutAction } from '@/lib/shortcuts';
import type { Command } from '@opencode/plugin/gui';

/** Optional Yuri extension; other hosts can ignore priority. */
export type YuriGuiCommand = Command & { readonly priority?: number };

export type GuiCommandShortcut = Readonly<ShortcutAction & {
  pluginId: string;
  commandId: string;
  scope?: string;
  editable?: true;
}>;

export function guiCommandShortcutId(pluginId: string, commandId: string): string {
  return `gui-plugin:${JSON.stringify([pluginId, commandId])}`;
}

import { desktopBrowserAddress } from './desktop-browser-core';
import type { DesktopPanelScope } from './desktop-panel-model';
import { resourcePath } from './resources-model';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';

/** Terminal URLs remain intents: browser native admission owns Host proxy/auth. */
export function createDesktopTerminalPreview(options: {
  scope(): DesktopPanelScope | null;
  active(): boolean;
  openPanel(scope: DesktopPanelScope, url: string): boolean;
  openExternal(url: string): Promise<{ opened: boolean }>;
}) {
  return async (host: RuntimeScope, directory: string, url: string, mode: 'preview' | 'external') => {
    const selected = options.scope();
    if (!selected || !options.active() || !sameRuntimeScope(host, selected.host)
      || resourcePath(directory) !== resourcePath(selected.directory)) throw new Error('terminal_preview_stale');
    if (mode !== 'preview' && mode !== 'external' || !/^https?:\/\//i.test(url)) throw new Error('terminal_preview_invalid');
    const intent = desktopBrowserAddress(url);
    if (intent.kind === 'html') throw new Error('terminal_preview_invalid');
    // Even an explicit external action cannot open the client's localhost.
    if (mode === 'preview' || intent.kind === 'loopback') {
      if (!options.openPanel(selected, intent.url)) throw new Error('terminal_preview_unavailable');
    } else if (!(await options.openExternal(intent.url)).opened) throw new Error('terminal_preview_external_failed');
  };
}

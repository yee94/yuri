import { isLikelyFileReferencePath, parseFileReference } from '../ui/src/components/chat/fileReferenceParser';
import { desktopBrowserAddress } from './desktop-browser-core';
import { desktopPanelFilePath, type DesktopPanelScope } from './desktop-panel-model';
import { resourcePath } from './resources-model';
import { runtimeScopeFrom, sameRuntimeScope } from './runtime-scope';

export type DesktopContentLinkOptions = {
  /** The content owner's exact target, including embedded readers' own directory. */
  scope: DesktopPanelScope;
  /** Null while hidden, covered, closing, disposed, or no longer the same owner. */
  current(): DesktopPanelScope | null;
  openFile(scope: DesktopPanelScope, path: string, targetLine?: number): boolean | Promise<boolean>;
  openPanel(scope: DesktopPanelScope, url: string): boolean | Promise<boolean>;
  /** Public NSH openUrl, under the app's declared scheme grant; never a Host request. */
  openExternal(url: string): Promise<{ opened: boolean }>;
};

const invalid = /[\u0000-\u001f\u007f-\u009f]/;
const credential = /(?:^|[?&#;])(?:oc_client_token|yuri_client_token|yuri_url_token|yuri_preview_token|authorization|access_token|refresh_token|api_key|apikey|token|password|secret)=/i;

function safeValue(value: string): void {
  if (!value || value !== value.trim() || value.length > 8192 || invalid.test(value)) throw new Error('content_link_invalid');
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error('content_link_invalid'); }
  if (invalid.test(decoded) || credential.test(decoded)) throw new Error('content_link_invalid');
}

/** Only the file URL envelope is adapted here: path/line syntax stays with Web's
 * parser. QuickJS has no URL global (which the Web parser uses for file: URLs). */
function fileReference(href: string) {
  if (href.includes('#') && !/#L\d+(?:C\d+)?$/i.test(href)) throw new Error('content_link_anchor_unavailable');
  let value = href;
  if (/^file:/i.test(value)) {
    const match = /^(?:file:\/\/(?:localhost)?|file:)(\/(?!\/)[^?#]*)(#[^?]*)?$/i.exec(value);
    if (!match) throw new Error('content_link_invalid_file');
    value = match[1].replace(/^\/([A-Za-z]:\/)/, '$1') + (match[2] ?? '');
  }
  const parsed = parseFileReference(value);
  if (!parsed) throw new Error('content_link_invalid_file');
  // Match getResolvedReference(referenceKind='href'): parse suffixes before
  // decoding, so an escaped # or ; belongs to the filename.
  try { parsed.path = decodeURIComponent(parsed.path); } catch { throw new Error('content_link_invalid_file'); }
  if (invalid.test(parsed.path) || !isLikelyFileReferencePath(parsed.path)) throw new Error('content_link_invalid_file');
  if (parsed.line !== undefined && (!Number.isSafeInteger(parsed.line) || parsed.line < 1)) throw new Error('content_link_invalid_line');
  return parsed;
}

/** Content navigation only. No fetch, model, directory catalog, or writer is
 * created here. Native browser/file admission must independently recheck scope. */
export function createDesktopContentLink(options: DesktopContentLinkOptions): (href: string) => Promise<void> {
  const host = runtimeScopeFrom(options.scope.host);
  if (!host || !options.scope.authorityKey.trim()) throw new Error('content_link_scope_required');
  const scope: DesktopPanelScope = Object.freeze({ ...options.scope, host, directory: resourcePath(options.scope.directory) });
  const check = () => {
    const current = options.current();
    if (!current || !sameRuntimeScope(current.host, scope.host) || current.authorityKey !== scope.authorityKey
      || current.sessionID !== scope.sessionID || resourcePath(current.directory) !== scope.directory) throw new Error('content_link_stale');
  };
  return async href => {
    check(); safeValue(href);
    // NSH 0.4 reports anchors, but exposes no document-anchor navigation ref.
    if (href.startsWith('#')) throw new Error('content_link_anchor_unavailable');
    if (/^https?:\/\//i.test(href)) {
      const intent = desktopBrowserAddress(href);
      if (intent.kind === 'html') throw new Error('content_link_invalid');
      check();
      const opened = await options.openPanel(scope, intent.url);
      check();
      if (opened !== true) throw new Error('content_link_panel_unavailable');
      return;
    }
    if (/^mailto:/i.test(href)) {
      // An opaque mailto address, not hierarchical authority/userinfo or headers
      // capable of injecting CR/LF into the system mail handler.
      if (/^mailto:\/\//i.test(href) || /\\/.test(href) || /%[\da-f]{2}/i.test(decodeURIComponent(href)) || !/^mailto:[^?#\s]+(?:\?[^#\s]*)?$/i.test(href)) throw new Error('content_link_invalid');
      check();
      const result = await options.openExternal(href);
      check();
      if (result?.opened !== true) throw new Error('content_link_external_failed');
      return;
    }
    if (href.startsWith('//') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(href) && !/^file:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) throw new Error('content_link_scheme_unavailable');
    const parsed = fileReference(href), path = desktopPanelFilePath(scope.directory, parsed.path);
    check();
    const opened = await options.openFile(scope, path, parsed.line);
    check();
    if (opened !== true) throw new Error('content_link_file_unavailable');
  };
}

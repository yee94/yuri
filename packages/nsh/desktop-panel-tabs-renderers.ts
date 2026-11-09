import type { JSX } from 'nsh';
import { desktopPanelFilePath, desktopPanelScopeKey, normalizeDesktopPanelIntent, type DesktopPanelFileSource, type DesktopPanelScope, type DesktopPanelTab } from './desktop-panel-model';
import type { ChangesSource } from './chat-changes-model';

/** Exact Web ContextPanelMode vocabulary. This is a CONTENT request contract,
 * not another tab store and not an extension that the legacy panel silently opens. */
export type DesktopPanelContentRequest =
  | { kind: 'diff'; source: ChangesSource }
  | { kind: 'file-diff'; source: ChangesSource & { path: string } }
  | { kind: 'file'; path: string; targetLine?: number; source?: DesktopPanelFileSource }
  | { kind: 'context' }
  | { kind: 'chat'; sessionID: string; directory: string; readOnly: true; titleFallback?: string; messageID?: string }
  | { kind: 'preview'; target: { kind: 'html'; path: string } | { kind: 'url'; url: string }; source?: DesktopPanelFileSource }
  | { kind: 'browser'; url: string }
  | { kind: 'btw'; sessionID: string };
export type DesktopPanelContentKind = DesktopPanelContentRequest['kind'];
export type DesktopPanelRendererContext = {
  tabID: string; scope: DesktopPanelScope;
  /** Retained hidden content receives false demand; do not destroy its owner or
   * use demand as a replacement for request/lease authority. */
  active: () => boolean; current: () => boolean;
};
export type DesktopPanelRendererSlots<Result = JSX.Element> = {
  [Kind in DesktopPanelContentKind]?: (request: Extract<DesktopPanelContentRequest, { kind: Kind }>, context: DesktopPanelRendererContext) => Result;
};

export function desktopPanelContentRequest(tab: DesktopPanelTab): DesktopPanelContentRequest {
  if (tab.kind === 'preview') return { kind: 'preview', target: { kind: 'html', path: tab.path }, ...(tab.source ? { source: tab.source } : {}) };
  if (tab.kind === 'chat') return {
    kind: 'chat', sessionID: tab.target.sessionID, directory: tab.target.directory, readOnly: true,
    ...(tab.target.title === undefined ? {} : { titleFallback: tab.target.title }),
    ...(tab.target.messageID === undefined ? {} : { messageID: tab.target.messageID }),
  };
  return tab;
}
function validate(scope: DesktopPanelScope, request: DesktopPanelContentRequest) {
  desktopPanelScopeKey(scope);
  if (request.kind === 'file-diff') {
    if (!request.source.path) throw new Error('desktop_panel_file_diff_path_required');
    if (request.source.kind === 'turn') normalizeDesktopPanelIntent(scope, { kind: 'file-diff', source: { ...request.source, path: request.source.path } });
    else {
      desktopPanelFilePath(scope.directory, request.source.path);
      normalizeDesktopPanelIntent(scope, { kind: 'diff', source: request.source });
    }
  } else if (request.kind === 'chat') {
    if (request.readOnly !== true) throw new Error('desktop_panel_chat_readonly_required');
    normalizeDesktopPanelIntent(scope, { kind: 'chat', target: { sessionID: request.sessionID, directory: request.directory,
      ...(request.titleFallback === undefined ? {} : { title: request.titleFallback }),
      ...(request.messageID === undefined ? {} : { messageID: request.messageID }),
    } });
  } else if (request.kind === 'btw') {
    if (!request.sessionID.trim() || request.sessionID !== scope.sessionID) throw new Error('desktop_panel_content_session_mismatch');
  } else if (request.kind === 'preview') {
    if (request.target.kind === 'html') normalizeDesktopPanelIntent(scope, { kind: 'preview', path: request.target.path, source: request.source });
    else normalizeDesktopPanelIntent(scope, { kind: 'browser', url: request.target.url });
  } else normalizeDesktopPanelIntent(scope, request);
}

/** Call BEFORE the shell commits a new kind to the one authoritative tab owner.
 * No callback means unavailable: no default View, fake tab, network or shadow state.
 * main must explicitly provide the actual source component for each admitted kind. */
export function admitDesktopPanelContent<Result>(slots: DesktopPanelRendererSlots<Result>, request: DesktopPanelContentRequest, context: DesktopPanelRendererContext, commit: (request: DesktopPanelContentRequest) => boolean): boolean {
  if (!context.current() || !context.active() || typeof slots[request.kind] !== 'function') return false;
  validate(context.scope, request);
  return commit(request);
}

/** The shell retains the source component under its real tab identity. Each slot
 * gets the exact source/session/readOnly input and demand; no main Chat fallback. */
export function renderDesktopPanelContent<Result>(slots: DesktopPanelRendererSlots<Result>, request: DesktopPanelContentRequest, context: DesktopPanelRendererContext): Result {
  validate(context.scope, request);
  const absent = (): never => { throw new Error('desktop_panel_renderer_unavailable'); };
  switch (request.kind) {
    case 'diff': return (slots.diff ?? absent)(request, context);
    case 'file-diff': return (slots['file-diff'] ?? absent)(request, context);
    case 'file': return (slots.file ?? absent)(request, context);
    case 'context': return (slots.context ?? absent)(request, context);
    case 'chat': return (slots.chat ?? absent)(request, context);
    case 'preview': return (slots.preview ?? absent)(request, context);
    case 'browser': return (slots.browser ?? absent)(request, context);
    case 'btw': return (slots.btw ?? absent)(request, context);
  }
}

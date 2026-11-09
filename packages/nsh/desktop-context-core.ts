import { createContextUsageRoute, type ContextUsageChat } from './context-usage-route-core';
import type { DesktopPanelScope } from './desktop-panel-model';

export type DesktopContextChat = ContextUsageChat;

/** No lookup by title, recent directory, or tab history: only the original Chat. */
export function desktopContextMatches(scope: DesktopPanelScope, chat: DesktopContextChat): boolean {
  const source = chat.messageScope;
  return !!scope.authorityKey && !!scope.host.lease && !!scope.sessionID && !!scope.directory
    && source.hostID === scope.host.hostID && source.sessionID === scope.sessionID
    && source.directory === scope.directory && Number.isSafeInteger(source.generation);
}

export function desktopContextIdentity(scope: DesktopPanelScope, chat: DesktopContextChat): string {
  return JSON.stringify([scope.host.hostID, scope.host.lease, scope.authorityKey, scope.sessionID, scope.directory, chat.messageScope.generation]);
}

/** A read projection, not another Chat, sender, stream, history loader or durable store. */
export function createDesktopContextOwner(options: {
  scope: DesktopPanelScope;
  chat: DesktopContextChat;
  /** Must check the captured lease AND connection/origin/authorization identity. Not modal state. */
  current: () => boolean;
  /** Captured Host GET owner; this module only requests session metadata and provider catalog. */
  read: (path: string) => Promise<unknown>;
  showAssistantTps: boolean;
  changed?: () => void;
}) {
  const scope = Object.freeze({ ...options.scope, host: Object.freeze({ ...options.scope.host }) });
  const chat = options.chat;
  if (!desktopContextMatches(scope, chat)) throw new Error('desktop_context_chat_scope_mismatch');
  const identity = desktopContextIdentity(scope, chat);
  let alive = true, active = false, interactive = false;
  const current = () => alive && options.current() && desktopContextMatches(scope, chat) && desktopContextIdentity(scope, chat) === identity;
  const canInteract = () => current() && active && interactive;
  const route = createContextUsageRoute({ chat, scope: chat.messageScope,
    target: { kind: 'session', id: scope.sessionID!, directory: scope.directory, title: '' },
    current, read: async path => {
      if (!current() || !active) throw new Error('desktop_context_read_retired');
      const value = await options.read(path);
      if (!current() || !active) throw new Error('desktop_context_read_retired');
      return value;
    }, showAssistantTps: options.showAssistantTps, changed: options.changed });
  return { scope, owner: route.owner, current, canInteract,
    setDemand(visible: boolean, enabled = visible) {
      active = visible && current(); interactive = active && enabled;
      route.setActive(active);
    },
    /** Preference changes are allowed to project only while displayed. */
    setShowAssistantTps(value: boolean) { if (active && current()) route.owner.setShowAssistantTps(value); },
    /** Explicit Retry delegates message failure to the ORIGINAL Chat's existing GET lane. */
    retry: () => canInteract() ? route.retry() : Promise.resolve(),
    /** Existing catalog/session owners may notify a real metadata boundary; never call per keystroke. */
    refresh: () => canInteract() ? route.refresh() : Promise.resolve(),
    dispose() { alive = false; active = false; interactive = false; route.dispose(); },
  };
}
export type DesktopContextOwner = ReturnType<typeof createDesktopContextOwner>;

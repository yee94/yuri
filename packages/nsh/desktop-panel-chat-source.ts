import { signal, type Signal } from 'nsh';
import type { openDraft } from './drafts';
import type { Message, Row, ChatTarget } from './model';
import type { NativeRevert } from './transcript-actions-core';
import type { ActivityMaterialization } from './transcript-materialization';
import type { RuntimeScope } from './runtime-scope';

/** Main/Host-owned subscription adapter. Events still arrive through runtime.event.
 * Inject only after the owning native Host confirms its independent namespace;
 * desktop support must not be inferred for iOS or from a JSX renderer. */
export type DesktopPanelChatStream = {
  start: (input: Readonly<{ path: string; key: string; expectedHost: RuntimeScope }>) => Promise<unknown>;
  stop: (input: Readonly<{ key: string; expectedHost: RuntimeScope }>) => Promise<unknown>;
};
export type DesktopChatSessionIdentity = Readonly<{ id: string; directory: string; parentID?: string }>;

/** Only read-model fields. No draft, queue, Goal controller or mutation transport. */
export type DesktopChatReadSource = {
  synchronizing: () => boolean;
  messages: () => Message[]; messagesResolved: () => boolean; historyGeneration: () => number;
  historyCursor: () => string | null;
  sessionIdentity: () => DesktopChatSessionIdentity | null;
  revert: () => NativeRevert | null; historyRepairPending: () => boolean;
  more: () => boolean; hasGap: () => boolean; loading: () => boolean; olderLoading: () => boolean;
  error: () => string; messageReadError: () => string; historyError: () => string;
  busy: () => boolean; retry: () => Row | null;
  streamingMessageIDs: () => ReadonlySet<string>;
  streamState: () => 'inactive' | 'connecting' | 'live' | 'disconnected';
  load: (older?: boolean, selected?: ('messages' | 'status')[]) => Promise<void>;
  loadOlder: () => Promise<void>; activityMaterialization: ActivityMaterialization;
};
const sources = signal<readonly { identity: string; source: DesktopChatReadSource }[]>([]);
export function desktopChatReadIdentity(hostID: string, authorityKey: string, lease: string | undefined, target: ChatTarget) {
  return JSON.stringify([hostID, authorityKey, lease ?? null, target.kind, target.directory, target.id]);
}
export function registerDesktopChatReadSource(identity: string, source: DesktopChatReadSource) {
  const entry = { identity, source }; sources.set([...sources(), entry]);
  return () => sources.set(sources().filter(value => value !== entry));
}
export function desktopChatReadSource(identity: string): DesktopChatReadSource | undefined {
  return sources().findLast(entry => entry.identity === identity && entry.source.synchronizing())?.source;
}
export function rejectDesktopChatWrite(): never { throw new Error('chat_read_only'); }
function frozenSignal<T>(initial: T): Signal<T> {
  return Object.assign(() => initial, { set: rejectDesktopChatWrite, update: rejectDesktopChatWrite });
}
/** Deliberately never calls openDraft: even a second reader would steal its CAS lane. */
export function desktopChatReadOnlyDraft(host: string, target: ChatTarget): ReturnType<typeof openDraft> {
  const scope = { host, directory: target.directory, draft: '' }, ready = Promise.resolve();
  return {
    key: '', authorityKey: undefined, scope, draft: frozenSignal(''), attachments: frozenSignal([]), pendingSend: frozenSignal(null), queueEdit: frozenSignal(null), context: frozenSignal(undefined),
    references: () => [], document: () => ({ text: '', references: [], scope }),
    setDocument: rejectDesktopChatWrite, setDraftText: rejectDesktopChatWrite, insertReference: rejectDesktopChatWrite,
    stageContext: async () => ({ status: 'blocked' }), status: frozenSignal('ready'), error: frozenSignal(''), ready,
    whenReady: () => ready, restore: () => ready, retry: () => ready, flush: () => ready, close: () => ready,
    revision: () => 0, draftRevision: () => 0, matches: () => false, matchesDocument: () => false,
  };
}

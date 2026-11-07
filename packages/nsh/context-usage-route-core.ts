import type { ChatTarget } from './model';
import type { createChat } from './state';
import { createContextUsageOwner, contextUsageScopeKey, type ContextUsageScope } from './context-usage-core';
import { createContextUsageSourceAdapter } from './context-usage-source';
import { readContextUsageMetadata } from './context-usage-authority';

type NativeChat = ReturnType<typeof createChat>;
export type ContextMessageCommit = Parameters<Parameters<NativeChat['observeMessageCommits']>[0]>[0];
export type ContextUsageChat = Pick<NativeChat, 'messageScope' | 'messages' | 'messagesResolved' | 'messageReadError' | 'load' | 'observeMessageCommits'>;

/** Read-only route owner. The existing Chat owns every message/network commit. */
export function createContextUsageRoute(options: {
  chat: ContextUsageChat;
  target: ChatTarget;
  scope: ContextUsageScope;
  current: () => boolean;
  read: (path: string) => Promise<unknown>;
  showAssistantTps: boolean;
  changed?: () => void;
}) {
  const scope = Object.freeze({ ...options.scope }), key = contextUsageScopeKey(scope), chat = options.chat;
  if (options.target.kind !== 'session' || options.target.id !== scope.sessionID || options.target.directory !== scope.directory || contextUsageScopeKey(chat.messageScope) !== key) throw new Error('Context overview route does not own the captured Chat');
  let alive = true, active = false, activation = 0, stop: (() => void) | undefined;
  let metadata: Awaited<ReturnType<typeof readContextUsageMetadata>> | undefined;
  let metadataError = '', flight: Promise<void> | undefined;
  const current = () => alive && options.current() && contextUsageScopeKey(chat.messageScope) === key;
  const visible = () => active && current();
  const owner = createContextUsageOwner(scope, { current, showAssistantTps: options.showAssistantTps, changed: options.changed });
  const adapter = createContextUsageSourceAdapter({ scope, current: visible, read: () => {
    if (!metadata) throw new Error('Context overview metadata is unresolved');
    return { messages: chat.messages(), messagesResolved: chat.messagesResolved(), session: metadata.session, providers: metadata.providers };
  } });
  const error = () => metadataError || chat.messageReadError();
  function restoreError() { const failure = error(); if (failure) owner.failed(failure); }
  function snapshot() {
    if (!visible()) return;
    if (!chat.messagesResolved()) { owner.loading(); restoreError(); return; }
    if (!metadata) return;
    try { const source = adapter.snapshot(); if (source) owner.reset(source.value); restoreError(); }
    catch (failure) { owner.failed(failure); }
  }
  function committed(commit: ContextMessageCommit) {
    if (!visible()) return;
    if (commit.kind === 'snapshot') {
      if (commit.error) owner.failed(commit.error);
      else snapshot();
      return;
    }
    if (!metadata || !chat.messagesResolved()) return;
    try {
      const source = adapter.commit(commit.messages);
      if (source?.kind === 'snapshot') owner.reset(source.value);
      else if (source) owner.patch(source);
      restoreError();
    } catch (failure) { owner.failed(failure); }
  }
  function refresh(retryMessages = false): Promise<void> {
    if (!visible()) return Promise.resolve();
    if (flight) return flight;
    const captured = activation;
    owner.loading();
    const work = (async () => {
      try {
        // Explicit retry reuses the existing Chat GET lane only after a message read failed.
        // Pending initial hydration is not duplicated, and the route never requests message URLs.
        if (retryMessages && chat.messageReadError()) await chat.load(false, ['messages']);
        if (!visible() || captured !== activation) return;
        const value = await readContextUsageMetadata({ scope, read: async path => {
          if (!visible() || captured !== activation) throw new Error('Context overview read retired');
          return options.read(path);
        } });
        if (!visible() || captured !== activation) return;
        metadata = value; metadataError = ''; snapshot();
      } catch (failure) {
        if (!visible() || captured !== activation) return;
        metadataError = failure instanceof Error ? failure.message : String(failure); owner.failed(metadataError);
      } finally { if (captured === activation) flight = undefined; }
    })();
    flight = work; return work;
  }
  function setActive(next: boolean) {
    next = next && current();
    if (next === active) return;
    active = next; activation++;
    stop?.(); stop = undefined; flight = undefined;
    if (!active) return;
    stop = chat.observeMessageCommits(committed);
    if (metadata) snapshot();
    else void refresh();
  }
  return { owner, setActive, refresh, retry: () => refresh(true), current,
    dispose() { active = false; alive = false; activation++; stop?.(); stop = undefined; flight = undefined; metadata = undefined; adapter.dispose(); owner.dispose(); },
  };
}

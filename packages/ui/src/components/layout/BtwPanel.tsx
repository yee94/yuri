import React from 'react';
import { useEvent } from '@reactuses/core';
import { ChatPromptComposer } from '@/components/chat/ChatPromptComposer';
import { ComposerQuoteChips } from '@/components/chat/ComposerQuoteChips';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { AssistantMessageActionButtons } from '@/components/chat/message/AssistantMessageActionButtons';
import { AssistantMessageFooter, MESSAGE_ACTION_ICON_BUTTON_CLASS, MESSAGE_ACTION_ICON_CLASS, MESSAGE_ACTION_ICON_WEIGHT } from '@/components/chat/message/AssistantMessageFooter';
import { formatAbsoluteMessageTimestamp, formatTurnDuration } from '@/components/chat/message/timeFormat';
import { bindMessageTimeFocus } from '@/components/chat/message/messageTimeFocus';
import { messageHoverHandlers } from '@/components/chat/lib/messageHover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { isPhoneBtwScopeOpen } from '@/mobile/useMobileNavigationStore';
import { ensureNativeComposerCover, releaseNativeComposerCover, BTW_SHEET_NATIVE_COMPOSER_COVER } from '@/lib/nativeComposerCover';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  EMPTY_SESSION_BTW_ENTRY,
  getSessionBtwKey,
  resolveSessionBtwSendSelection,
  useSessionBtwStore,
  type SessionBtwScope,
  type SessionBtwTurn,
} from '@/stores/useSessionBtwStore';

/** Same surface radius ChatInput applies to the primary composer pill. */
const BTW_COMPOSER_RADIUS = '1.5rem';
const BTW_COMPOSER_TEXT_CLASS = 'box-border w-full whitespace-pre-wrap break-words px-3 typography-markdown [font-family:inherit] [font-style:inherit] [font-weight:inherit] leading-[inherit] tracking-[inherit] md:typography-ui-label pt-4 pb-2';
const BTW_MOBILE_TEXT_CLASS = 'box-border w-full whitespace-pre-wrap break-words px-3 py-2.5 typography-markdown [font-family:inherit] [font-style:inherit] [font-weight:inherit] leading-[inherit] tracking-[inherit]';

export type BtwComposerFoot = 'panel' | 'page' | 'sheet';

const BtwTurnView = React.memo(function BtwTurnView({ turn, isLast, sessionId, directory, isMobile }: {
  turn: SessionBtwTurn;
  isLast: boolean;
  sessionId: string;
  directory: SessionBtwScope['directory'];
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const { hasTouchInput } = useDeviceInfo();
  const messageId = `btw:${sessionId}:${turn.id}`;
  const replyRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (isMobile && replyRef.current) return bindMessageTimeFocus(replyRef.current, messageId);
  }, [isMobile, messageId]);
  const error = turn.error === 'empty response' || turn.error === 'session.btw failed'
    ? t('chat.btw.failed')
    : turn.error;
  const cancelled = !turn.pending && !turn.error && !turn.answer;
  const copy = useEvent(async () => {
    const result = await copyTextToClipboard(turn.answer);
    if (!result.ok) toast.error(t('filesView.toast.copyFailed'));
    return result.ok;
  });
  return <div className="flex flex-col gap-2" data-btw-turn={turn.id}>
    <div className="ml-8 flex flex-col gap-1.5 self-end rounded-xl bg-[var(--surface-elevated)] px-3 py-2">
      {turn.quotes.map((quote, index) => <p key={index} data-btw-quote data-conversation-quote
        className="m-0 whitespace-pre-wrap break-words border-l-2 border-border pl-1.5 typography-meta text-muted-foreground">{quote}</p>)}
      <div className="whitespace-pre-wrap break-words typography-markdown text-foreground">{turn.question}</div>
    </div>
    {turn.pending ? <p role="status" className="flex items-center gap-1.5 typography-meta text-muted-foreground">
      <Icon name="loader-4" className="size-3.5 animate-spin" aria-hidden="true" />
      {t('chat.btw.pending')}
    </p> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap break-words typography-meta text-muted-foreground">
      <Icon name="error-warning" className="mr-1.5 inline size-3.5 align-[-2px] text-[var(--status-error)]/85" aria-hidden="true" />
      {error}
    </p> : null}
    {cancelled ? <p role="status" className="typography-meta text-muted-foreground">{t('chat.btw.cancelled')}</p> : null}
    <div ref={replyRef} data-message-id={messageId} data-message-text-export-root="true" data-speech-identity={messageId}
      {...messageHoverHandlers} className="min-w-0 text-foreground yuri-message-hover-scope">
    {turn.answer ? <div data-speech-content="true">
      <MarkdownRenderer content={turn.answer} messageId={messageId}
        isAnimated={false} isStreaming={false} variant="assistant" enableFileReferences={false} />
    </div> : null}
    {!turn.pending && (turn.answer || (isLast && (error || cancelled))) ? <AssistantMessageFooter
      messageId={messageId} isMobile={isMobile}
      duration={turn.answer && typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? formatTurnDuration(turn.durationMs) : null}
      timestamp={turn.answer && typeof turn.completedAt === 'number' && turn.completedAt > 0 ? formatAbsoluteMessageTimestamp(turn.completedAt) : null}
      actions={<>
        {turn.answer ? <AssistantMessageActionButtons messageId={messageId} hasCopyableText isTouchContext={hasTouchInput || isMobile}
          onCopyMessage={copy} ttsText={turn.answer} allowSourceSession={false} /> : null}
        {isLast ? <Tooltip>
          <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void useSessionBtwStore.getState().retry({ sessionId, directory })} aria-label={t('contextPanel.preview.actions.retry')}>
            <Icon name="refresh" weight={MESSAGE_ACTION_ICON_WEIGHT} className={MESSAGE_ACTION_ICON_CLASS} />
          </Button></TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('contextPanel.preview.actions.retry')}</TooltipContent>
        </Tooltip> : null}
      </>}
    /> : null}
    </div>
  </div>;
});

function BtwComposer({
  scope,
  pending,
  quotes,
  foot,
}: {
  scope: SessionBtwScope;
  pending: boolean;
  quotes: readonly string[];
  foot: BtwComposerFoot;
}) {
  const { t } = useI18n();
  const storedSelection = useSessionBtwStore((state) => state.sendSelection[getSessionBtwKey(scope)]);
  const selection = storedSelection ?? resolveSessionBtwSendSelection(scope);
  const providers = useConfigStore((state) => state.providers);
  const modelLabel = React.useMemo(() => {
    if (!selection?.providerID || !selection?.modelID) return null;
    const provider = providers.find((entry) => entry.id === selection.providerID);
    return getProviderModelDisplayName(provider, selection.modelID) || selection.modelID;
  }, [providers, selection]);
  const [draft, setDraft] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const send = useEvent(() => {
    const question = draft.trim();
    if (!question || pending) return;
    setDraft('');
    void useSessionBtwStore.getState().ask(scope, question);
  });
  const modelControl = selection && modelLabel ? (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1" aria-label={modelLabel}>
      <ModelLogo modelId={selection.modelID} providerId={selection.providerID} className="size-4 shrink-0" />
      <span className="min-w-0 truncate typography-meta font-medium text-foreground">{modelLabel}</span>
    </span>
  ) : null;
  const mobileFoot = foot !== 'panel';
  return <form
    data-btw-composer
    data-btw-composer-foot={foot}
    className={['shrink-0 px-3 pt-1', mobileFoot ? 'yuri-mobile-composer' : 'pb-3', foot === 'page' ? 'bottom-safe-area' : ''].filter(Boolean).join(' ')}
    onSubmit={(event) => { event.preventDefault(); send(); }}
  >
    <ChatPromptComposer
      value={draft}
      onChange={(value) => setDraft(value)}
      onSubmit={send}
      onStop={() => useSessionBtwStore.getState().cancel(scope)}
      pending={pending}
      disableInputWhilePending={false}
      isMobile={mobileFoot}
      placeholder={t('chat.btw.placeholder')}
      sendLabel={t('chat.chatInput.actions.sendMessageAria')}
      stopLabel={t('chat.statusRow.actions.stopGeneratingAria')}
      inputRef={textareaRef}
      textareaProps={{ autoFocus: true }}
      leftControls={modelControl}
      className={mobileFoot ? 'relative z-10 yuri-mobile-composer-surface' : 'relative z-10'}
      style={{ borderRadius: BTW_COMPOSER_RADIUS }}
      textLayoutClassName={mobileFoot ? BTW_MOBILE_TEXT_CLASS : BTW_COMPOSER_TEXT_CLASS}
      inputStyle={{ borderTopLeftRadius: BTW_COMPOSER_RADIUS, borderTopRightRadius: BTW_COMPOSER_RADIUS }}
      footerClassName="z-30 bg-transparent flex-shrink-0 px-2.5 py-1.5"
      footerStyle={{ borderBottomLeftRadius: BTW_COMPOSER_RADIUS, borderBottomRightRadius: BTW_COMPOSER_RADIUS }}
      inputHeader={<ComposerQuoteChips quotes={quotes} removeLabel={t('chat.btw.removeQuoteAria')} onRemove={(index) => useSessionBtwStore.getState().removeQuote(scope, index)} />}
    />
  </form>;
}

/**
 * Self-contained side conversation. Only the side turns render here; the main
 * session history is never loaded, and nothing is requested until a send.
 */
export function BtwPanel({ scope, foot = 'panel', active = true }: { scope: SessionBtwScope; foot?: BtwComposerFoot; active?: boolean }) {
  const { t } = useI18n();
  const key = getSessionBtwKey(scope);
  const turns = useSessionBtwStore((state) => (state.entries[key] ?? EMPTY_SESSION_BTW_ENTRY).turns);
  const quotes = useSessionBtwStore((state) => (state.entries[key] ?? EMPTY_SESSION_BTW_ENTRY).quotes);
  const pending = turns.some((turn) => turn.pending);
  const { scrollRef, notifyContentChange } = useChatAutoFollow({
    enabled: active,
    currentSessionId: scope.sessionId,
    viewportKey: `btw:${key}`,
    sessionMessageCount: turns.length,
    sessionIsWorking: pending,
    isMobile: foot !== 'panel',
  });
  const lastTurn = turns[turns.length - 1];
  React.useLayoutEffect(() => {
    notifyContentChange('structural');
  }, [turns.length, lastTurn?.answer, lastTurn?.pending, notifyContentChange]);
  return <section className="flex h-full min-h-0 min-w-0 flex-col text-foreground" aria-label={t('chat.btw.title')}>
    <div ref={scrollRef} data-btw-transcript className="overlay-scrollbar-container min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
      <div className="flex flex-col gap-5">
        {turns.length === 0
          ? <p className="typography-meta text-muted-foreground">{t('chat.btw.description')}</p>
          : turns.map((turn, index) => <BtwTurnView key={turn.id} turn={turn} isLast={index === turns.length - 1}
            sessionId={scope.sessionId} directory={scope.directory} isMobile={foot !== 'panel'} />)}
      </div>
    </div>
    <BtwComposer key={key} scope={scope} pending={pending} quotes={quotes} foot={foot} />
  </section>;
}

/**
 * The composer-side owner of the side conversation lifetime: closing the btw
 * tab or the panel clears it; switching tabs keeps it; leaving its session
 * cancels only an in-flight answer.
 */
export function BtwComposerSurface({ scope, active, mobile }: { scope: SessionBtwScope; active: boolean; mobile: boolean }) {
  const { t } = useI18n();
  const { sessionId, directory: scopeDirectory } = scope;
  const key = getSessionBtwKey(scope);
  const directory = normalizeDirectoryKey(scopeDirectory);
  const panel = useUIStore((state) => state.contextPanelByDirectory[directory]);
  const open = active && Boolean(panel?.isOpen && panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode === 'btw');
  const retained = Boolean(panel?.isOpen && panel.tabs.some((tab) => tab.mode === 'btw'));
  const previousPresentation = React.useRef({ key, retained });
  React.useEffect(() => {
    const capturedScope = { sessionId, directory: scopeDirectory };
    const previous = previousPresentation.current;
    previousPresentation.current = { key, retained };
    if (previous.key === key && previous.retained && !retained) useSessionBtwStore.getState().clear(capturedScope);
  }, [key, retained, sessionId, scopeDirectory]);
  const lease = React.useRef<{ key: string; active: boolean } | null>(null);
  React.useEffect(() => {
    const capturedScope = { sessionId, directory: scopeDirectory };
    const owner = { key, active };
    lease.current = owner;
    const phoneOwned = () => isPhoneBtwScopeOpen({ sessionId, directory: scopeDirectory ?? null });
    if (!active && !phoneOwned()) useSessionBtwStore.getState().cancel(capturedScope);
    return () => {
      const entry = useSessionBtwStore.getState().entries[key];
      // StrictMode's same-scope setup replaces the lease before this microtask.
      // An intervening ask replaces the entry, and retains ownership of that request.
      queueMicrotask(() => {
        const current = lease.current;
        if (current !== owner && current?.key === key && current.active) return;
        if (phoneOwned()) return;
        if (getSessionBtwKey(capturedScope) === key && useSessionBtwStore.getState().entries[key] === entry) {
          useSessionBtwStore.getState().cancel(capturedScope);
        }
      });
    };
  }, [key, active, sessionId, scopeDirectory]);
  const close = useEvent(() => {
    useSessionBtwStore.getState().clear(scope);
    useUIStore.getState().closeContextPanel(directory);
  });
  React.useEffect(() => {
    if (!mobile || !open) {
      releaseNativeComposerCover(BTW_SHEET_NATIVE_COMPOSER_COVER);
      return;
    }
    ensureNativeComposerCover(BTW_SHEET_NATIVE_COMPOSER_COVER);
    return () => releaseNativeComposerCover(BTW_SHEET_NATIVE_COMPOSER_COVER);
  }, [mobile, open]);
  if (!mobile) return null;
  return <MobileResizableSheet id="session-btw" open={open} onOpenChange={(next) => { if (!next) close(); }}
    title={t('chat.btw.title')} ariaLabel={t('chat.btw.title')} closeAriaLabel={t('gitView.common.close')} resizeAriaLabel={t('chat.btw.resize')}>
    <BtwPanel scope={scope} foot="sheet" />
  </MobileResizableSheet>;
}

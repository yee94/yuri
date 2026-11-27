import React from 'react';
import { useEvent } from '@reactuses/core';
import type { Message, Part } from '@/lib/opencode/v2-types';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

import MessageList, { type MessageListHandle } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { FormCard } from './FormCard';
import { StatusRowContainer } from './StatusRowContainer';
import { PromptNavigatorRail } from './components/PromptNavigatorRail';
import { getFullText } from './lib/messagePreview';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from '@/components/icon/Icon';
import type { AnimationHandlers, ContentChangeHandler } from '@/hooks/useChatAutoFollow';
import { CHAT_TAIL_SPACER_DESKTOP_HEIGHT, CHAT_TAIL_SPACER_MOBILE_HEIGHT } from './lib/scroll/chatTailSpacer';
import { CHAT_SCROLL_STYLE } from './lib/scroll/chatScrollStyle';
import { TranscriptSearchContext } from './TranscriptSearchContext';
import { resolveDesktopLoadOlderStatusVisibility, resolveMobileLoadOlderBusy } from './chatContainerHost';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { normalizeUserDisplayParts } from './message/normalizeUserDisplayParts';
import { findShellCommandForMessage, isUserShellMarkerMessage } from './lib/shellBridge';
import { shouldIgnoreChatNavigationTarget } from './lib/chatNavigationGuards';

export type SessionMessageRecord = { info: Message; parts: Part[] };

type ChatViewportProps = {
    timelineHistoryAnchorToken: number;
    currentSessionId: string;
    virtualizerKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    stickyUserHeader: boolean;
    directory?: string;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    pendingRevealWork: boolean;
    initialPinRevealComplete?: boolean;
    renderedMessages: SessionMessageRecord[];
    isLoadingOlder: boolean;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: import('./message/types').StreamPhase | null;
    retryOverlay: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    handleMessageContentChange: ContentChangeHandler;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    handleHistoryScroll: () => void;
    scrollToBottom: () => void;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
    sessionForms: import('@/sync/session-form-api').SessionFormInfo[];
    retryActionCopy: { title: string; message: string; label: string; link?: string } | null;
    isProgrammaticFollowActive: boolean;
    showLoadOlderButton: boolean;
    turnIds: string[];
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    showPromptNavigator: boolean;
    canLoadEarlierPrompts: boolean;
    isLoadingOlderPrompts: boolean;
    onLoadEarlierPrompts: () => void;
    transcriptStatusRow?: React.ReactNode;
};

export const ChatViewport = React.memo(({
    currentSessionId,
    virtualizerKey,
    isDesktopExpandedInput,
    isMobile,
    stickyUserHeader,
    directory,
    scrollRef,
    messageListRef,
    pendingRevealWork,
    initialPinRevealComplete = false,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleHistoryScroll,
    scrollToBottom,
    sessionQuestions,
    sessionPermissions,
    sessionForms,
    retryActionCopy,
    isProgrammaticFollowActive,
    showLoadOlderButton,
    turnIds,
    activeTurnId,
    onSelectTurn,
    showPromptNavigator,
    canLoadEarlierPrompts,
    isLoadingOlderPrompts,
    onLoadEarlierPrompts,
    transcriptStatusRow,
    timelineHistoryAnchorToken,
}: ChatViewportProps) => {
    const { t } = useI18n();
    const searchTarget = React.useContext(TranscriptSearchContext);
    const handleViewportHistoryScroll = useEvent(() => {
        // Find navigates within the loaded snapshot, never through scroll paging.
        if (!searchTarget) handleHistoryScroll();
    });
    // Loading status is mutation-owned only (isLoadingOlder); background
    // prefetch/SWR loading never drives it.
    const loadOlderBusy = resolveMobileLoadOlderBusy({ isLoadingOlder });
    const [mobileHistorySlot, setMobileHistorySlot] = React.useState({
        sessionId: currentSessionId, directory, reserved: showLoadOlderButton,
    });
    const sameHistorySlotScope = mobileHistorySlot.sessionId === currentSessionId && mobileHistorySlot.directory === directory;
    const reserveMobileHistorySlot = sameHistorySlotScope
        ? mobileHistorySlot.reserved || showLoadOlderButton
        : showLoadOlderButton;
    if (!sameHistorySlotScope || mobileHistorySlot.reserved !== reserveMobileHistorySlot) {
        setMobileHistorySlot({ sessionId: currentSessionId, directory, reserved: reserveMobileHistorySlot });
    }
    // Desktop loads by scroll only; the loading disc is an overlay so its
    // lifecycle cannot push the transcript.
    const showDesktopLoadOlderStatus = resolveDesktopLoadOlderStatusVisibility({
        isMobile,
        isLoadingOlder: loadOlderBusy,
    });
    const desktopHistoryStatus = showDesktopLoadOlderStatus ? (
        <div className="absolute inset-x-0 top-0 z-20 pointer-events-none" role="status" aria-live="polite">
            <div className="chat-column flex items-center justify-center gap-1.5 pt-3 pb-1">
                <span
                    className="yuri-mobile-glass-control flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)]"
                    aria-label={t('chat.history.loadingMore')}
                >
                    <Icon name="loader-4" className="size-4 animate-spin" aria-hidden="true" />
                </span>
            </div>
        </div>
    ) : null;
    // Keep the mobile status slot stable while scroll-triggered history loads.
    const mobileLoadOlderControl = isMobile && reserveMobileHistorySlot ? (
        <div className={cn('flex justify-center pt-3 pb-4', !loadOlderBusy && 'invisible')} aria-hidden={!loadOlderBusy}>
            <span
                role="status"
                className="flex items-center gap-1.5 text-[var(--surface-mutedForeground)] opacity-60"
                aria-busy={loadOlderBusy}
            >
                <Icon name="loader-4" className="size-3.5 animate-spin" aria-hidden="true" />
                <span className="typography-meta">{t('chat.history.loadingMore')}</span>
            </span>
        </div>
    ) : null;
    const promptPreviewsByTurnIdRef = React.useRef<Map<string, Part[]>>(new Map());
    // Cache normalized parts per source array so unchanged messages keep the
    // same reference and the memo below can bail out to the previous map.
    const normalizedPromptPartsCache = React.useRef(new WeakMap<Part[], Part[]>());
    // Shell-mode prompts show their extracted command; cache by message id so
    // the parts array reference is stable while the command is unchanged.
    const shellPreviewCache = React.useRef(new Map<string, { command: string; parts: Part[] }>());
    const promptPreviewsByTurnId = React.useMemo(() => {
        const next = new Map<string, Part[]>();
        for (let index = 0; index < renderedMessages.length; index += 1) {
            const message = renderedMessages[index];
            if (message.info.role !== 'user') {
                continue;
            }
            if (isUserShellMarkerMessage(message)) {
                const command = findShellCommandForMessage(renderedMessages, index) ?? '';
                const cached = shellPreviewCache.current.get(message.info.id);
                if (cached && cached.command === command) {
                    next.set(message.info.id, cached.parts);
                } else {
                    const parts = [{ type: 'text', text: command ? `$ ${command}` : '/shell' } as Part];
                    shellPreviewCache.current.set(message.info.id, { command, parts });
                    next.set(message.info.id, parts);
                }
                continue;
            }
            // Other fully synthetic user messages (loop continuations,
            // plan-mode injections) are not prompts the user typed — keep
            // them out of the navigator entirely.
            if (isFullySyntheticMessage(message.parts)) {
                continue;
            }
            let displayParts = normalizedPromptPartsCache.current.get(message.parts);
            if (!displayParts) {
                displayParts = normalizeUserDisplayParts(message.parts);
                normalizedPromptPartsCache.current.set(message.parts, displayParts);
            }
            if (displayParts.length === 0) {
                continue;
            }
            next.set(message.info.id, displayParts);
        }
        const prev = promptPreviewsByTurnIdRef.current;
        if (prev.size === next.size) {
            let unchanged = true;
            for (const [id, parts] of next) {
                if (prev.get(id) !== parts) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                return prev;
            }
        }
        promptPreviewsByTurnIdRef.current = next;
        return next;
    }, [renderedMessages]);
    // Only real (non-synthetic) prompts become rail entries; selection still
    // targets the same turn anchors as the timeline.
    const promptTurnIds = React.useMemo(
        () => turnIds.filter((id) => promptPreviewsByTurnId.has(id)),
        [promptPreviewsByTurnId, turnIds],
    );
    const promptMessageOwnersRef = React.useRef<ReadonlyMap<string, string>>(new Map());
    const promptConversationPreviews = React.useMemo(() => {
        const owners = new Map<string, string>();
        const replies = new Map<string, string>();
        let currentPrompt: string | undefined;
        for (const message of renderedMessages) {
            if (message.info.role === 'user') {
                if (promptPreviewsByTurnId.has(message.info.id)) currentPrompt = message.info.id;
                if (currentPrompt) owners.set(message.info.id, currentPrompt);
                continue;
            }
            const parentId = message.info.parentID;
            const owner = parentId ? owners.get(parentId) : currentPrompt;
            if (!owner) continue;
            owners.set(message.info.id, owner);
            const text = getFullText(message.parts).trim();
            if (text) replies.set(owner, text.slice(0, 600));
        }
        const previous = promptMessageOwnersRef.current;
        if (previous.size !== owners.size || [...owners].some(([id, owner]) => previous.get(id) !== owner)) {
            promptMessageOwnersRef.current = owners;
        }
        return { owners: promptMessageOwnersRef.current, replies };
    }, [promptPreviewsByTurnId, renderedMessages]);
    // If the viewport sits in a filtered-out (synthetic) turn, treat the
    // nearest preceding real prompt as active so the rail doesn't jump.
    const railActiveTurnId = React.useMemo(() => {
        if (!activeTurnId || promptPreviewsByTurnId.has(activeTurnId)) {
            return activeTurnId;
        }
        const activeIndex = turnIds.indexOf(activeTurnId);
        for (let index = activeIndex - 1; index >= 0; index -= 1) {
            const turnId = turnIds[index];
            if (promptPreviewsByTurnId.has(turnId)) {
                return turnId;
            }
        }
        return null;
    }, [activeTurnId, promptPreviewsByTurnId, turnIds]);
    const focusScrollContainer = useEvent((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    });

    return (
        <div
            className={cn(
                'relative min-h-0',
                isDesktopExpandedInput
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'flex-1'
            )}
            aria-hidden={isDesktopExpandedInput}
        >
            <div className="absolute inset-0">
                <ScrollShadow
                    className={cn(
                        'absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target',
                    )}
                    ref={scrollRef}
                    style={CHAT_SCROLL_STYLE}
                    observeMutations={false}
                    hideTopShadow={isMobile && stickyUserHeader}
                    // Mobile: the composer is a solid page foot — a bottom scroll
                    // mask reads as a soft full-width edge under the last messages.
                    hideBottomShadow={isMobile}
                    tabIndex={0}
                    onClick={focusScrollContainer}
                    onScroll={handleViewportHistoryScroll}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className={cn('yuri-chat-scroll-content relative z-0 min-h-full', isMobile && 'chat-scroll-foot-inset')}>
                        {mobileLoadOlderControl}
                        {desktopHistoryStatus}
                        <MessageList
                            timelineHistoryAnchorToken={timelineHistoryAnchorToken}
                            ref={messageListRef}
                            sessionKey={currentSessionId}
                            virtualizerKey={virtualizerKey}
                            disableStaging={pendingRevealWork}
                            initialPinRevealComplete={initialPinRevealComplete}
                            messages={renderedMessages}
                            sessionIsWorking={sessionIsWorking}
                            activeStreamingMessageId={streamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            retryOverlay={retryOverlay}
                            onMessageContentChange={handleMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            isLoadingOlder={isLoadingOlder}
                            scrollToBottom={scrollToBottom}
                            scrollRef={scrollRef}
                            directory={directory}
                            liveStatusSlot={
                                // No shell → no status. Mount inside MessageList's pin-reveal
                                // root so cold-open cannot orphan the label over a hidden transcript.
                                renderedMessages.length > 0
                                    ? (
                                        <div className="mb-1">
                                            {transcriptStatusRow ?? <StatusRowContainer />}
                                        </div>
                                    )
                                    : null
                            }
                        />
                        {(sessionQuestions.length > 0 || sessionPermissions.length > 0 || sessionForms.length > 0 || retryActionCopy) && (
                            <div>
                                {retryActionCopy ? (
                                    <div className="mb-2 rounded-xl border border-border/20 bg-muted/10 px-2.5 py-2">
                                        <div className="typography-ui-label text-foreground">{retryActionCopy.title}</div>
                                        <div className="typography-meta text-muted-foreground mt-1">{retryActionCopy.message}</div>
                                        {retryActionCopy.link ? (
                                            <a
                                                href={retryActionCopy.link}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="mt-2 inline-block typography-meta text-primary underline"
                                            >
                                                {retryActionCopy.label}
                                            </a>
                                        ) : null}
                                    </div>
                                ) : null}
                                {sessionQuestions.map((question) => (
                                    <QuestionCard key={question.id} question={question} />
                                ))}
                                {sessionPermissions.map((permission) => (
                                    <PermissionCard key={permission.id} permission={permission} />
                                ))}
                                {sessionForms.map((form) => (
                                    <FormCard key={form.id} form={form} directory={directory} />
                                ))}
                            </div>
                        )}

                        {/* The chrome reservation itself comes from
                            `.chat-scroll-foot-inset` padding on this content
                            wrapper, so the tail here is the breathing room only. */}
                        <div
                            className="flex-shrink-0"
                            style={{ height: isMobile ? CHAT_TAIL_SPACER_MOBILE_HEIGHT : CHAT_TAIL_SPACER_DESKTOP_HEIGHT }}
                            aria-hidden="true"
                        />
                    </div>
                </ScrollShadow>
                <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
                {showPromptNavigator && promptTurnIds.length >= 2 ? (
                    <PromptNavigatorRail
                        turnIds={promptTurnIds}
                        previewsByTurnId={promptPreviewsByTurnId}
                        scrollRef={scrollRef}
                        turnByMessageId={promptConversationPreviews.owners}
                        repliesByTurnId={promptConversationPreviews.replies}
                        activeTurnId={railActiveTurnId}
                        onSelectTurn={onSelectTurn}
                        canLoadEarlier={canLoadEarlierPrompts}
                        isLoadingOlder={isLoadingOlderPrompts}
                        onLoadEarlier={onLoadEarlierPrompts}
                    />
                ) : null}
            </div>
        </div>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.virtualizerKey === next.virtualizerKey
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.stickyUserHeader === next.stickyUserHeader
        && prev.directory === next.directory
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.pendingRevealWork === next.pendingRevealWork
        && prev.initialPinRevealComplete === next.initialPinRevealComplete
        && prev.renderedMessages === next.renderedMessages
        && prev.timelineHistoryAnchorToken === next.timelineHistoryAnchorToken
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.handleMessageContentChange === next.handleMessageContentChange
        && prev.getAnimationHandlers === next.getAnimationHandlers
        && prev.handleHistoryScroll === next.handleHistoryScroll
        && prev.scrollToBottom === next.scrollToBottom
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions
        && prev.sessionForms === next.sessionForms
        && prev.retryActionCopy === next.retryActionCopy
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive
        && prev.showLoadOlderButton === next.showLoadOlderButton
        && prev.turnIds === next.turnIds
        && prev.activeTurnId === next.activeTurnId
        && prev.onSelectTurn === next.onSelectTurn
        && prev.showPromptNavigator === next.showPromptNavigator
        && prev.canLoadEarlierPrompts === next.canLoadEarlierPrompts
        && prev.isLoadingOlderPrompts === next.isLoadingOlderPrompts
        && prev.onLoadEarlierPrompts === next.onLoadEarlierPrompts
        && prev.transcriptStatusRow === next.transcriptStatusRow;
});

ChatViewport.displayName = 'ChatViewport';

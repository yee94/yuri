import React from 'react';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { ComposerFoot } from './ComposerFoot';
import { ChatViewport } from './ChatViewport';
import { TranscriptSearch } from './TranscriptSearch';
import { TimelineDialog } from './TimelineDialog';
import { TranscriptScrollControls } from './components/TranscriptScrollControls';
import type { ChatSessionShell } from './useChatSessionShell';

type FrameShell = Pick<ChatSessionShell, 'composerSwapScopeRef' | 'isMobile'>;

/**
 * Root of a chat surface. It alone binds the mobile composer/header swap scope
 * (`yuri-chat-composer-swap-scope`), so every primary surface that renders a
 * transcript gets the scroll-collapse interaction from the same markup.
 */
export const ChatSessionFrame: React.FC<React.HTMLAttributes<HTMLDivElement> & {
    shell: FrameShell;
    /** Bind the swap scope. Shells with no scrolling transcript opt out. */
    swap?: boolean;
}> = ({ shell, swap = true, className, children, ...rest }) => (
    <div
        {...rest}
        ref={swap ? shell.composerSwapScopeRef : undefined}
        className={cn('relative flex h-full flex-col bg-background', shell.isMobile && swap && 'yuri-chat-composer-swap-scope', className)}
    >
        {children}
    </div>
);

/**
 * Composer foot with position-independent child keys: the composer must keep
 * its identity (focus, caret, IME) while the shell switches between loading,
 * empty and transcript layouts, whether or not scroll controls are mounted.
 */
export const ChatSessionFoot: React.FC<{
    isMobile: boolean;
    expanded: boolean;
    overlay?: boolean;
    className?: string;
    scrollControls?: React.ReactNode;
    children: React.ReactNode;
}> = ({ isMobile, expanded, overlay, className, scrollControls, children }) => (
    <ComposerFoot isMobile={isMobile} expanded={expanded} overlay={overlay} className={className}>
        {scrollControls ? <React.Fragment key="scroll-controls">{scrollControls}</React.Fragment> : null}
        <React.Fragment key="composer">{children}</React.Fragment>
    </ComposerFoot>
);

export const ChatSessionScrollControls: React.FC<{
    shell: Pick<ChatSessionShell, 'scrollRef' | 'timeline' | 'navigation'>;
    active: boolean;
    messageCount: number;
}> = ({ shell, active, messageCount }) => (
    <TranscriptScrollControls
        scrollRef={shell.scrollRef}
        active={active}
        showScrollToBottom={messageCount > 0 && shell.timeline.showScrollToBottom}
        onScrollToBottom={shell.navigation.resumeToLatest}
    />
);

type ChatTranscriptProps = {
    shell: ChatSessionShell;
    active: boolean;
    expandedInput: boolean;
    sessionId: string;
    viewKey: string;
    directory: string | undefined;
    /** Rows find-in-page searches; the viewport paints the shell's windowed rows. */
    searchMessages: React.ComponentProps<typeof TranscriptSearch>['messages'];
    working: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: React.ComponentProps<typeof ChatViewport>['activeStreamingPhase'];
    retryOverlay: React.ComponentProps<typeof ChatViewport>['retryOverlay'];
    retryActionCopy: React.ComponentProps<typeof ChatViewport>['retryActionCopy'];
    questions: QuestionRequest[];
    permissions: PermissionRequest[];
    forms: React.ComponentProps<typeof ChatViewport>['sessionForms'];
    initialPinRevealComplete?: boolean;
    transcriptStatusRow?: React.ReactNode;
};

/** Find-in-page + scroller for one session, wired to the shared shell. */
export const ChatTranscript: React.FC<ChatTranscriptProps> = ({
    shell,
    active,
    expandedInput,
    sessionId,
    viewKey,
    directory,
    searchMessages,
    working,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    retryActionCopy,
    questions,
    permissions,
    forms,
    initialPinRevealComplete,
    transcriptStatusRow,
}) => {
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const { timeline, follow } = shell;
    return (
        <TranscriptSearch
            key={`find:${viewKey}`}
            messages={searchMessages}
            enabled={active && !expandedInput}
            canOpen={shell.canOpenTranscriptSearch}
            onNavigate={follow.releaseAutoFollow}
        >
            <ChatViewport
                timelineHistoryAnchorToken={shell.timelineHistoryAnchorToken}
                key={sessionId}
                currentSessionId={sessionId}
                virtualizerKey={viewKey}
                isDesktopExpandedInput={expandedInput}
                isMobile={shell.isMobile}
                stickyUserHeader={stickyUserHeader}
                directory={directory}
                scrollRef={shell.scrollRef}
                messageListRef={shell.messageListRef}
                pendingRevealWork={timeline.pendingRevealWork}
                initialPinRevealComplete={initialPinRevealComplete}
                renderedMessages={timeline.renderedMessages}
                isLoadingOlder={shell.isLoadOlderBusy}
                sessionIsWorking={working}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={follow.notifyContentChange}
                getAnimationHandlers={follow.getAnimationHandlers}
                handleHistoryScroll={timeline.handleHistoryScroll}
                scrollToBottom={shell.resumeToLatestInstant}
                sessionQuestions={questions}
                sessionPermissions={permissions}
                sessionForms={forms}
                retryActionCopy={retryActionCopy}
                isProgrammaticFollowActive={follow.isFollowingProgrammatically}
                showLoadOlderButton={shell.showLoadOlderButton}
                turnIds={timeline.turnIds}
                activeTurnId={timeline.activeTurnId}
                onSelectTurn={shell.handlePromptNavigatorSelect}
                showPromptNavigator={shell.showPromptNavigator}
                canLoadEarlierPrompts={shell.canLoadEarlierPrompts}
                isLoadingOlderPrompts={shell.isLoadOlderBusy}
                onLoadEarlierPrompts={shell.handleLoadOlderClick}
                transcriptStatusRow={transcriptStatusRow}
            />
        </TranscriptSearch>
    );
};

export const ChatSessionTimelineDialog: React.FC<{
    shell: Pick<ChatSessionShell, 'timeline' | 'isLoadOlderBusy' | 'handleLoadOlderClick'>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessionId: string;
    directory: string | undefined;
    onRevertMessage: React.ComponentProps<typeof TimelineDialog>['onRevertMessage'];
}> = ({ shell, open, onOpenChange, sessionId, directory, onRevertMessage }) => (
    <TimelineDialog
        open={open}
        onOpenChange={onOpenChange}
        sessionID={sessionId}
        directory={directory}
        onRevertMessage={onRevertMessage}
        onScrollToMessage={shell.timeline.scrollToMessage}
        canLoadEarlier={shell.timeline.historySignals.canLoadEarlier}
        isLoadingEarlier={shell.isLoadOlderBusy}
        onLoadEarlier={shell.handleLoadOlderClick}
    />
);

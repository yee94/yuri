import React from 'react';
import {
    useEvent,
    useEventListener,
    useIsomorphicLayoutEffect,
    useResizeObserver,
    useUnmount,
} from '@reactuses/core';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import type { SessionHistoryMeta } from '@/stores/types/sessionTypes';

import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { resolveMobileLoadOlderVisibility } from './chatContainerHost';
import type { MessageListHandle } from './MessageList';
import { useMobileComposerSwap } from './useMobileComposerSwap';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useDesktopHistoryWarmup } from './hooks/useDesktopHistoryWarmup';
import type { ChatMessageEntry } from './lib/turns/types';
import {
    hasBlockingChatOverlay,
    shouldIgnoreChatNavigationForFocus,
    shouldIgnoreChatNavigationTarget,
} from './lib/chatNavigationGuards';

const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'yuri:chat-force-scroll-bottom';
/** useEventListener attaches to window when target is null — pass a no-op getter instead. */
const NO_EVENT_TARGET = () => undefined;

type ChatSessionShellArgs = {
    active: boolean;
    sessionId: string | null;
    /** Identity of the painted viewport; scroll snapshots are keyed by it. */
    viewKey?: string;
    directory: string | undefined;
    /** Rows the viewport paints (retained / merged rows included). */
    messages: ChatMessageEntry[];
    /** Authoritative message count the auto-follow policy reacts to. */
    messageCount: number;
    working: boolean;
    /** A cold transcript is shown as a skeleton: there is no scroller to pin. */
    hydrating: boolean;
    /** Fullscreen composer mode (desktop expand / mobile drag handle). */
    expandedInput: boolean;
    historyMeta: SessionHistoryMeta | null;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    questions: readonly QuestionRequest[];
    permissions: readonly PermissionRequest[];
    /** The host surface offers the prompt navigator rail at all. */
    promptNavigator: boolean;
    /** Surfaces with their own operation-error channel route a failed explicit load here. */
    onLoadEarlierError?: (error: unknown) => void;
    /** Bounded desktop history expansion; omitted by surfaces without a repository to page. */
    warmup?: {
        scope: string;
        enabled: boolean;
        cursor: string | null;
        loadedTurns: number;
        loadPrevious: (pageSize: number) => Promise<void>;
    };
};

/**
 * Transcript scrolling and chrome behaviour shared by every primary chat
 * surface (local session, remote project session). Auto-follow, the mobile
 * composer/header swap, history paging, turn navigation and the scroller
 * bookkeeping live here so a surface only supplies its data source.
 */
export const useChatSessionShell = (args: ChatSessionShellArgs) => {
    const {
        active,
        sessionId,
        viewKey,
        directory,
        messages,
        messageCount,
        working,
        hydrating,
        expandedInput,
        historyMeta,
        loadMoreMessages,
        questions,
        permissions,
        promptNavigator,
        onLoadEarlierError,
        warmup,
    } = args;
    const isMobile = useUIStore((state) => state.isMobile);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const isVSCode = isVSCodeRuntime();
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = useEvent((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    });
    // Bridge auto-follow upward intent → timeline handler without creating a
    // hook order cycle (auto-follow is created before the timeline controller).
    const historyUpwardIntentRef = React.useRef<() => void>(() => {});
    const handleHistoryUpwardIntentBridge = useEvent(() => {
        historyUpwardIntentRef.current();
    });

    // StaticHistoryList captures the reading position before explicit pagination.
    const [timelineHistoryAnchorToken, setTimelineHistoryAnchorToken] = React.useState(0);
    const armTimelineHistoryAnchor = useEvent(() => {
        setTimelineHistoryAnchorToken((token) => token + 1);
    });

    const follow = useChatAutoFollow({
        scrollControllerRef: messageListRef,
        enabled: active,
        currentSessionId: sessionId,
        viewportKey: viewKey,
        sessionMessageCount: messageCount,
        sessionIsWorking: working,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
        onUpwardUserIntent: handleHistoryUpwardIntentBridge,
    });
    const { scrollRef, goToBottom, releaseAutoFollow, restoreSnapshot, notifyContentChange } = follow;
    const composerSwapScopeRef = React.useRef<HTMLDivElement>(null);
    const expandMobileComposer = useMobileComposerSwap({
        enabled: isMobile,
        scrollRef,
        scopeRef: composerSwapScopeRef,
    });

    const timeline = useChatTimelineController({
        sessionId,
        directory,
        messages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow,
        beginHistoryViewportPreservation: follow.beginHistoryViewportPreservation,
        endHistoryViewportPreservation: follow.endHistoryViewportPreservation,
        isPinned: follow.isPinned,
        showScrollButton: follow.showScrollButton,
        // Same mounted flag as showLoadOlderButton — not isMobileSurfaceRuntime().
        isMobile,
        onWillLoadEarlier: armTimelineHistoryAnchor,
    });
    const resumeToLatestInstant = useEvent(() => {
        // goToBottom resumes follow policy and delegates to the active list.
        goToBottom('instant');
        expandMobileComposer();
    });
    const canOpenTranscriptSearch = useEvent((event: KeyboardEvent) => {
        if (useUIStore.getState().activeMainTab !== 'chat' || hasBlockingChatOverlay()) return false;
        const target = event.target;
        if (!(target instanceof HTMLElement) || composerSwapScopeRef.current?.contains(target)) return true;
        return !target.closest('input, textarea, [contenteditable="true"], .cm-editor, .monaco-editor, .terminal-viewport-container');
    });
    const scrollViewportOnSend = useEvent(() => {
        follow.scrollToBottomOnSend();
    });
    // Mobile scroll-load reserves a stable status slot at the history edge.
    // Busy state is mutation-owned (timeline loadEarlierMutation.isPending) —
    // never background historyLoading/prefetch, which can stick true on Relay.
    // The Capacitor mobile entrypoint sets isMobile before first render. Do not
    // use width/pointer surface inference here: native WebView viewport changes
    // can temporarily classify as desktop and hide this mobile-only status
    // until an unrelated scroll causes another render.
    // Visibility is authoritative-only: canLoadEarlier from the child-store
    // boundary, or a real user-initiated loadEarlier mutation in flight (that
    // mutation keeps the status slot painted so its spinner has an anchor). An
    // unresolved boundary (unknown availability) renders nothing — never a
    // speculative placeholder.
    const showLoadOlderButton = resolveMobileLoadOlderVisibility({
        isMobile,
        canLoadEarlier: timeline.historySignals.canLoadEarlier,
        isLoadingOlder: timeline.isLoadingOlder,
    });
    const isLoadOlderBusy = timeline.isLoadingOlder;
    const timelineLoadEarlier = timeline.loadEarlier;
    const handleLoadOlderClick = useEvent(() => {
        const loading = timelineLoadEarlier({ userInitiated: true });
        void (onLoadEarlierError ? loading.catch(onLoadEarlierError) : loading);
    });

    // Render-phase ref bridge: timeline is created after auto-follow, so handlers
    // publish into stable useEvent entry points without effect rebinding.
    activeTurnChangeRef.current = timeline.handleActiveTurnChange;
    historyUpwardIntentRef.current = timeline.handleHistoryUpwardIntent;

    React.useEffect(() => {
        if (permissions.length === 0 && questions.length === 0) {
            return;
        }
        notifyContentChange('permission');
    }, [notifyContentChange, permissions, questions]);

    const navigation = useChatTurnNavigation({
        sessionId,
        turnIds: timeline.turnIds,
        activeTurnId: timeline.activeTurnId,
        scrollToTurn: timeline.scrollToTurn,
        scrollToMessage: timeline.scrollToMessage,
        resumeToBottom: resumeToLatestInstant,
    });
    const handlePromptNavigatorSelect = useEvent((turnId: string) => {
        void navigation.scrollToTurnId(turnId, { behavior: 'smooth' });
    });
    const canLoadEarlierPrompts = timeline.historySignals.canLoadEarlier;
    const showPromptNavigator = promptNavigator
        && !isMobile
        && !isVSCode
        && !expandedInput
        && promptNavigatorEnabled
        && timeline.turnIds.length >= 2;

    React.useEffect(() => {
        if (!promptNavigator) return;
        if (!showPromptNavigator) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [promptNavigator, showPromptNavigator]);

    const handleForceScrollBottom = useEvent((event: Event) => {
        if (!active || !sessionId) return;
        const customEvent = event as CustomEvent<{ sessionId?: string }>;
        if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== sessionId) return;
        goToBottom('instant');
    });
    useEventListener(
        CHAT_FORCE_SCROLL_BOTTOM_EVENT,
        handleForceScrollBottom,
        active && sessionId && typeof window !== 'undefined' ? window : NO_EVENT_TARGET,
    );

    const handleChatTurnKeyDown = useEvent((event: KeyboardEvent) => {
        if (!active || !sessionId || expandedInput) return;
        if (event.defaultPrevented || event.isComposing) {
            return;
        }

        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
            return;
        }

        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }

        const { activeMainTab } = useUIStore.getState();
        if (activeMainTab !== 'chat' || hasBlockingChatOverlay()) {
            return;
        }

        const scrollContainer = scrollRef.current;
        if (shouldIgnoreChatNavigationForFocus(document.activeElement, scrollContainer)) {
            return;
        }

        if (shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        event.preventDefault();
        const offset = event.key === 'ArrowUp' ? -1 : 1;
        void navigation.scrollByTurnOffset(offset, { resumePastEnd: false });
    });
    useEventListener(
        'keydown',
        handleChatTurnKeyDown,
        active && sessionId && !expandedInput && typeof window !== 'undefined'
            ? window
            : NO_EVENT_TARGET,
    );

    // --chat-scroll-height tracks the scroller viewport for sticky headers.
    // useResizeObserver owns observe/disconnect; useEvent handlers stay latest.
    const chatScrollHeightRafRef = React.useRef(0);
    const updateChatScrollHeight = useEvent(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
    });
    const scheduleChatScrollHeightUpdate = useEvent(() => {
        if (chatScrollHeightRafRef.current) return;
        chatScrollHeightRafRef.current = requestAnimationFrame(() => {
            chatScrollHeightRafRef.current = 0;
            updateChatScrollHeight();
        });
    });
    useIsomorphicLayoutEffect(() => {
        if (!active) return;
        updateChatScrollHeight();
    }, [active, sessionId, expandedInput]);
    const canObserveChatScrollResize = typeof ResizeObserver !== 'undefined';
    useResizeObserver(
        active && canObserveChatScrollResize ? scrollRef : null,
        scheduleChatScrollHeightUpdate,
    );
    useEventListener(
        'resize',
        scheduleChatScrollHeightUpdate,
        active && !canObserveChatScrollResize && typeof window !== 'undefined' ? window : NO_EVENT_TARGET,
    );
    useUnmount(() => {
        if (chatScrollHeightRafRef.current) {
            cancelAnimationFrame(chatScrollHeightRafRef.current);
            chatScrollHeightRafRef.current = 0;
        }
    });

    const lastScrolledSessionRef = React.useRef<string | null>(null);
    // Tracks message count at the last pin so a cold open that pinned while the
    // transcript was still empty can re-pin once records land (deep link /
    // session switch). Later growth (stream, load-older) must not re-pin.
    const lastPinnedMessageCountRef = React.useRef(0);
    useDesktopHistoryWarmup({
        scope: warmup?.scope ?? '',
        enabled: Boolean(warmup?.enabled) && !timeline.isLoadingOlder,
        cursor: warmup?.cursor ?? null,
        loadedTurns: warmup?.loadedTurns ?? 0,
        messages,
        scrollRef,
        loadPrevious: warmup?.loadPrevious ?? (() => Promise.resolve()),
    });

    React.useEffect(() => {
        if (!active || !sessionId) return;
        // Skeleton has no ChatViewport/scrollRef. Pinning here only records
        // lastScrolled and fires restore against a null container — then the
        // real transcript commits later without a session-level re-pin
        // (trace: one programmatic ScrollLayer before ChatMessage paint → blank).
        if (hydrating) return;

        const currentMessageCount = messages.length;
        const sessionChanged = lastScrolledSessionRef.current !== sessionId;
        const firstContentLanded = !sessionChanged
            && lastPinnedMessageCountRef.current === 0
            && currentMessageCount > 0;
        if (!sessionChanged && !firstContentLanded) {
            if (lastScrolledSessionRef.current === sessionId) {
                lastPinnedMessageCountRef.current = currentMessageCount;
            }
            return;
        }

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionRef.current = sessionId;
        lastPinnedMessageCountRef.current = currentMessageCount;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            releaseAutoFollow();
            return;
        }

        const run = () => {
            void restoreSnapshot();
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [
        active,
        sessionId,
        hydrating,
        releaseAutoFollow,
        restoreSnapshot,
        messages.length,
    ]);

    return {
        isMobile,
        follow,
        scrollRef,
        messageListRef,
        composerSwapScopeRef,
        timeline,
        navigation,
        timelineHistoryAnchorToken,
        resumeToLatestInstant,
        canOpenTranscriptSearch,
        /** Pass to the composer: send follows the transcript to the latest row. */
        scrollViewportOnSend,
        showLoadOlderButton,
        isLoadOlderBusy,
        handleLoadOlderClick,
        showPromptNavigator,
        canLoadEarlierPrompts,
        handlePromptNavigatorSelect,
    };
};

export type ChatSessionShell = ReturnType<typeof useChatSessionShell>;

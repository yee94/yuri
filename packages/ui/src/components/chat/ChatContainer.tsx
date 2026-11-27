import React from 'react';
import {
    useEvent,
    useEventListener,
    useIsomorphicLayoutEffect,
    useMount,
    useUnmount,
} from '@reactuses/core';
import type { Message, Part } from '@/lib/opencode/v2-types';

import { ChatInput } from './ChatInput';
import { RemoteChatContainer } from './RemoteChatContainer';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import type { HostLocation } from '@/lib/remote-projects/location';
import type { ChatInputSurface } from './chatInputSurface';
import {
    resolveChatContainerHostFeatures,
    resolveChatHistoryLoadState,
    resolveChatHistoryPaginationLoading,
    hasChatTranscriptShell,
    resolveChatSessionTranscriptGate,
    mergePendingUserMessagePresentations,
    pendingUserMessagesImplyWorking,
    resolveRetainedTranscript,
    type ChatContainerHost,
    type ChatContainerHostFeatures,
    type PaintedTranscript,
} from './chatContainerHost';
import { hasUserDisplayableParts } from './message/normalizeUserDisplayParts';
import {
    createExplicitSessionSurface,
    SessionSurfaceContext,
} from './SessionSurfaceContext';
import { ReadOnlyPromptBanner } from './ReadOnlyPromptBanner';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { refreshSessionForms, useSessionFormStore } from '@/sync/session-form-store';
import { isQuestionFormMetadata } from '@/sync/v2-runtime';
import { isSessionRetryAction, resolveRetryActionCopy } from '@/sync/session-retry-action';
import { ChatViewport, type SessionMessageRecord } from './ChatViewport';
import { CHAT_SCROLL_STYLE } from './lib/scroll/chatScrollStyle';
import { useChatSessionShell } from './useChatSessionShell';
import {
    ChatSessionFoot,
    ChatSessionFrame,
    ChatSessionScrollControls,
    ChatSessionTimelineDialog,
    ChatTranscript,
} from './ChatSessionFrame';
import { createAssistantSessionDivider, mergeHostedCurrentSessionHistory, stitchHostedSessionHistory } from './hostedSessionHistory';
import type { ChatMessageEntry } from './lib/turns/types';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn, formatDirectoryName } from '@/lib/utils';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';

// New sync system imports
import { useSessionUIStore, type PendingUserMessagePresentation } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageLoadState,
    useSessionMessageRecords,
    useSessionMaterializationStatus,
    useSessionTranscriptHydration,
    useSessionTranscriptPagination,
    useSyncDirectory,
    useSessionStatus,
    useSessionStatusObservedAt,
    useSessionStatusSnapshotAt,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
    useParentSessionTarget,
    useSession,
    useCurrentSessionEntity,
    setActiveSession,
    releaseActiveSession,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import {
    ensureTranscriptInitial,
    fetchTranscriptPreviousPage,
    getTranscriptRepository,
    refreshTranscriptFromAuthority,
    retryTranscriptInitial,
    transcriptScope,
} from '@/sync/transcript-repository-runtime';
import {
    recordTranscriptDiagnostics,
    recordTranscriptDiff,
    snapshotTranscriptDiagnostics,
    tryCaptureTranscriptCanonicalSnapshot,
} from '@/sync/transcript-diagnostics-runtime';
import {
    INITIAL_TRANSCRIPT_STALL_STATE,
    TRANSCRIPT_STALL_COOLDOWN_MS,
    TRANSCRIPT_STALL_MAX_ATTEMPTS,
    TRANSCRIPT_STALL_POLL_MS,
    TRANSCRIPT_STALL_THRESHOLD_MS,
    advanceTranscriptStallState,
    buildTranscriptTailFingerprint,
    reportTranscriptStall,
} from './transcriptStallWatchdog';
import {
    resetTranscriptStallStateForInactive,
    shouldArmTranscriptStallWatchdog,
} from './transcriptStallWatchdogEffect';

import { useRecoverPendingQuestions } from '@/hooks/useRecoverPendingQuestions';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { MobileBackgroundWorkBar } from '@/mobile/chat/MobileBackgroundWorkBar';
import { BusyDots } from './message/parts/BusyDots';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useShallow } from 'zustand/react/shallow';
import { markSessionSwitchContentCommitted } from '@/lib/sessionSwitchPerf';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
    applySessionViewSelectionIntent,
    commitMaterializedSessionView,
    createSessionViewRenderIntent,
    materializeSessionViewRenderIntent,
    recordSessionViewEstimate,
    reconcileSessionViewCache,
    resolveActiveSessionViewKey,
    type SessionViewCacheLimits,
    type SessionViewRenderState,
    type SessionViewSelection,
} from './sessionViewCache';
import { getEmbeddedSessionChatOriginSessionId } from '@/components/layout/contextPanelEmbeddedChat';
import { resolveContextPanelSessionExecution } from '@/components/layout/contextPanelSessionExecution';
import {
    resolveChatPromptAvailability,
    resolveSessionIdentityPending,
    resolveSubagentReadOnlyBannerLatch,
    type SubagentReadOnlyBannerLatch,
} from './chatPromptAvailability';
import { shouldEnsureChatSessionRenderable } from './chatSessionMaterialization';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PENDING_USER_MESSAGES: readonly PendingUserMessagePresentation[] = [];
// Stable empty snapshot for the zustand form selector (see sessionForms below).
const EMPTY_SESSION_FORMS: import('@/sync/session-form-api').SessionFormInfo[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
/** useEventListener attaches to window when target is null — pass a no-op getter instead. */
const NO_EVENT_TARGET = () => undefined;
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
const MEBIBYTE = 1024 * 1024;
const DEFAULT_SESSION_VIEW_ESTIMATED_BYTES = MEBIBYTE;
const SESSION_VIEW_MESSAGE_BUCKET_SIZE = 20;
const SESSION_VIEW_MESSAGE_BUCKET_BYTES = MEBIBYTE;
const MAX_SINGLE_SESSION_VIEW_ESTIMATED_BYTES = 16 * MEBIBYTE;
const DESKTOP_SESSION_VIEW_CACHE_LIMITS: SessionViewCacheLimits = {
    maxEntries: 3,
    maxEstimatedBytes: 32 * MEBIBYTE,
};
const CONSTRAINED_SESSION_VIEW_CACHE_LIMITS: SessionViewCacheLimits = {
    maxEntries: 2,
    maxEstimatedBytes: 32 * MEBIBYTE,
};
const subscribeRuntimeKey = (notify: () => void): (() => void) => {
    return subscribeRuntimeEndpointChanged(() => notify());
};
type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

const HYDRATING_SKELETON_ITEMS: Array<{
    id: number;
    toolRows: HydratingToolSkeletonRow[];
    textWidths: [string, string, string];
}> = [
    {
        id: 1,
        toolRows: [
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-52' },
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-36' },
        ],
        textWidths: ['w-24', 'w-[92%]', 'w-[78%]'],
    },
];

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    return formatDirectoryName(project.path);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

type ChatContainerProps = {
    autoOpenDraft?: boolean;
    readOnly?: boolean;
    active?: boolean;
    host?: ChatContainerHost;
    /** Binds one phone navigation page to an explicit route and skips the primary retained-view cache. */
    explicitSession?: {
        location?: HostLocation;
        sessionId: string | null;
        directory: string | null;
        viewKey: string;
        active: boolean;
    };
};

type ChatContainerContentProps = Omit<ChatContainerProps, 'host'> & {
    sessionId: string | null;
    sessionDirectory: string | null;
    sessionViewKey?: string;
    onSessionViewEstimateChange?: (key: string, estimatedBytes: number) => void;
    composerSurface?: ChatInputSurface;
    hostedFeatures?: Required<ChatContainerHostFeatures>;
    assistantHistory?: ChatContainerHost['assistantHistory'];
    onRevertMessage?: (messageId: string) => Promise<void>;
    warning?: string | null;
    pendingUserMessages?: readonly PendingUserMessagePresentation[];
    onPendingUserMessagesMaterialized?: (messageIDs: readonly string[]) => void;
    committedDraftHandoffMessageId?: string | null;
};

const estimateSessionViewBytes = (messageCount: number): number => {
    const messageBuckets = Math.ceil(Math.max(0, messageCount) / SESSION_VIEW_MESSAGE_BUCKET_SIZE);
    return Math.min(
        MAX_SINGLE_SESSION_VIEW_ESTIMATED_BYTES,
        DEFAULT_SESSION_VIEW_ESTIMATED_BYTES + messageBuckets * SESSION_VIEW_MESSAGE_BUCKET_BYTES,
    );
};

const ChatContainerContent: React.FC<ChatContainerContentProps> = ({
    autoOpenDraft = true,
    readOnly = false,
    active = true,
    sessionId: currentSessionId,
    sessionDirectory: currentSessionDirectory,
    sessionViewKey,
    onSessionViewEstimateChange,
    composerSurface,
    hostedFeatures,
    assistantHistory,
    onRevertMessage,
    warning = null,
    pendingUserMessages: hostPendingUserMessages = EMPTY_PENDING_USER_MESSAGES,
    onPendingUserMessagesMaterialized,
    committedDraftHandoffMessageId = null,
}) => {
    const hostFeatures = hostedFeatures ?? resolveChatContainerHostFeatures(undefined);
    const { t } = useI18n();
    useIsomorphicLayoutEffect(() => {
        markSessionSwitchContentCommitted();
    }, []);
    // Session UI state
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const draftSubmitting = useSessionUIStore((s) => s.newSessionDraft.draftSubmitting ?? false);
    const draftEstablishing = useSessionUIStore((s) => s.newSessionDraft.draftEstablishing ?? false);
    const forkTransition = useSessionUIStore((s) => s.forkTransition);
    const projects = useProjectsStore((s) => s.projects);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);
    const providers = useConfigStore((state) => state.providers);

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    // Hosted surfaces (Assistant) never call setCurrentSession, so without this
    // orphaned SSE part events fall back to the primary chat directory and the
    // assistant store never receives user text parts. Layout-phase so routing is
    // ready before paint/event delivery (same contract as timeline DOM sync).
    useIsomorphicLayoutEffect(() => {
        if (!active || !currentSessionId || !effectiveSessionDirectory) return;
        setActiveSession(effectiveSessionDirectory, currentSessionId);
        return () => releaseActiveSession(effectiveSessionDirectory, currentSessionId);
    }, [active, currentSessionId, effectiveSessionDirectory]);
    const ensureSessionRenderable = useEvent(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, { directory: effectiveSessionDirectory }),
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

    // Streaming state — ordinary selectors (never useCallback; store compares selected values).
    const streamingMessageId = useStreamingStore(
        (s) => (active && currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
    );
    const activeStreamingPhase = useStreamingStore(
        (s) => {
            if (!streamingMessageId) return null;
            return s.messageStreamStates.get(streamingMessageId)?.phase ?? null;
        },
    );
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionViewEstimatedBytes = estimateSessionViewBytes(sessionMessageCount);
    React.useEffect(() => {
        if (!sessionViewKey || !onSessionViewEstimateChange) {
            return;
        }
        onSessionViewEstimateChange(sessionViewKey, sessionViewEstimatedBytes);
    }, [onSessionViewEstimateChange, sessionViewEstimatedBytes, sessionViewKey]);
    const hasRenderableSessionSnapshot = useSessionMaterializationStatus(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    ).renderable;
    const directorySessionEntity = useSession(currentSessionId, effectiveSessionDirectory);
    // Global/live fallback covers sessions whose directory list row is lagging
    // or lives under another selected workspace while messages already load.
    const liveSessionEntity = useCurrentSessionEntity(currentSessionId);
    const currentSessionEntity = directorySessionEntity ?? liveSessionEntity;
    // Primary chat blocks send only while identity is still unproven. A missing
    // directory list row must not permanently disable the composer once the
    // session is materializable (or known via live/global entity). Hosted
    // secondary surfaces never use this gate.
    const sessionIdentityPending = resolveSessionIdentityPending({
        sessionId: currentSessionId,
        hasSessionEntity: Boolean(currentSessionEntity),
        hasRenderableSessionSnapshot,
        composerSurfaceKind: composerSurface?.kind,
    });
    const sessionIdentityEnsureKey = currentSessionId
        ? JSON.stringify([effectiveSessionDirectory, currentSessionId])
        : null;
    const [sessionIdentityEnsureRetry, setSessionIdentityEnsureRetry] = React.useState<{
        key: string | null;
        attempt: number;
    }>({ key: sessionIdentityEnsureKey, attempt: 0 });
    // Messages from sync system. Inactive surfaces (phone predecessor) freeze
    // the painted snapshot and unsubscribe so streaming on another session does
    // not re-render this underlay — resume re-subscribes to live authority.
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {
        suspendPartUpdates: Boolean(streamingMessageId),
        suspendPartUpdatesForMessageId: streamingMessageId,
        enabled: active,
    });
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const draftPendingMessage = newSessionDraft.pendingUserMessage;
    // Rows the send path retained for this session until their authoritative
    // records land. This is what keeps a just-sent message on screen across the
    // draft → real session handover without any confirmation request.
    const retainedPendingUserMessages = useSessionUIStore(
        (state) => (currentSessionId ? state.retainedPendingUserMessages.get(currentSessionId) : undefined),
    ) ?? EMPTY_PENDING_USER_MESSAGES;
    const initialPinRevealComplete = Boolean(
        committedDraftHandoffMessageId
        || retainedPendingUserMessages.length > 0,
    );
    const clearRetainedPendingUserMessages = useSessionUIStore((state) => state.clearRetainedPendingUserMessages);
    const pendingUserMessages = React.useMemo(() => {
        if (retainedPendingUserMessages.length === 0) return hostPendingUserMessages;
        if (hostPendingUserMessages.length === 0) return retainedPendingUserMessages;
        const hosted = new Set(hostPendingUserMessages.map((message) => message.info.id));
        return [
            ...hostPendingUserMessages,
            ...retainedPendingUserMessages.filter((message) => !hosted.has(message.info.id)),
        ];
    }, [hostPendingUserMessages, retainedPendingUserMessages]);
    const sessionExecution = React.useMemo(
        () => resolveContextPanelSessionExecution(sessionMessages),
        [sessionMessages],
    );
    const sessionExecutionModelName = React.useMemo(() => {
        if (!sessionExecution.modelId) return t('common.unavailable');
        const provider = providers.find((entry) => entry.id === sessionExecution.providerId);
        // Always go through display helper so missing catalog entries humanize
        // (e.g. deepseek-v4-flash → "DeepSeek V4 Flash") instead of raw ids.
        return getProviderModelDisplayName(provider, sessionExecution.modelId) || sessionExecution.modelId;
    }, [providers, sessionExecution.modelId, sessionExecution.providerId, t]);
    // useMemo callback factories for useSyncExternalStore (stable identity; never useCallback).
    // Ticket 09: request lifecycle from repository (no session-prefetch).
    const sessionPrefetchInfo = useSessionMessageLoadState(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const transcriptHydration = useSessionTranscriptHydration(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const [retryingSessionHistoryId, setRetryingSessionHistoryId] = React.useState<string | null>(null);
    const isRetryingSessionHistory = Boolean(currentSessionId)
        && retryingSessionHistoryId === currentSessionId;
    const retrySessionHistory = useEvent(() => {
        if (!currentSessionId || isRetryingSessionHistory) return;
        const sessionId = currentSessionId;
        const directory = effectiveSessionDirectory;
        setRetryingSessionHistoryId(sessionId);
        const refreshDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() => {
            const repository = getTranscriptRepository();
            if (!repository) throw new Error('unbound');
            return repository.getTranscript(transcriptScope(directory, sessionId));
        });
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
            kind: 'refresh',
            sessionID: sessionId,
            directory,
            purpose: 'retry',
            source: 'network',
            request: sessionPrefetchInfo
                ? {
                    sessionID: sessionId,
                    status: sessionPrefetchInfo.status === 'ready' ? 'ready' : sessionPrefetchInfo.status,
                    error: sessionPrefetchInfo.error,
                }
                : undefined,
            hydration: transcriptHydration,
            error: sessionPrefetchInfo?.error,
        }));
        void (async () => {
            try {
                await retryTranscriptInitial(directory, sessionId);
                await sync.ensureSessionRenderable(sessionId, { directory });
                try {
                    const refreshDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() => {
                        const repository = getTranscriptRepository();
                        if (!repository) throw new Error('unbound');
                        return repository.getTranscript(transcriptScope(directory, sessionId));
                    });
                    if (refreshDiffBefore && refreshDiffAfter) {
                        recordTranscriptDiff({
                            trigger: 'user-refresh',
                            sessionID: sessionId,
                            directory,
                            purpose: 'retry',
                            before: refreshDiffBefore,
                            after: refreshDiffAfter,
                        });
                    }
                } catch {
                    // Diagnostics must never affect retry.
                }
            } catch (error) {
                recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
                    kind: 'request-error',
                    sessionID: sessionId,
                    directory,
                    purpose: 'retry',
                    source: 'network',
                    hydration: transcriptHydration,
                    error,
                }));
            } finally {
                setRetryingSessionHistoryId((current) => (current === sessionId ? null : current));
            }
        })();
    });
    // Ticket 02: pagination from TranscriptRepository.getPagination projection.
    // Boundary-only commits still re-render via repository subscribe.
    const transcriptPagination = useSessionTranscriptPagination(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const historyBoundary = transcriptPagination.boundary;
    const loadMoreMessages = useEvent(async (sessionId: string) => {
        // Ticket 09: Query fetchPreviousPage is the sole history flight.
        if (historyBoundary.kind === 'has-more') {
            await fetchTranscriptPreviousPage(
                effectiveSessionDirectory,
                sessionId,
                isMobile || isDedicatedMobileApp ? undefined : 50,
            );
            return;
        }
        if (historyBoundary.kind === 'unknown') {
            // Ensure authoritative tail; background SWR also converges.
            await ensureTranscriptInitial(effectiveSessionDirectory, sessionId);
            return;
        }
        // Only page assistant-owned archives after live pagination is authoritative-complete.
        if (assistantHistory && !assistantHistory.complete) {
            await assistantHistory.fetchPrevious();
        }
    });

    // Session status from sync system
    const resolvedSessionStatus = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionStatusObservedAt = useSessionStatusObservedAt(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionStatusSnapshotAt = useSessionStatusSnapshotAt(effectiveSessionDirectory);
    const sessionStatusForCurrent = resolvedSessionStatus ?? IDLE_SESSION_STATUS;

    // Scoped blocking requests — only subscribe to permissions/questions for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
    const sessionPermissions = useScopedBlockingPermissions(currentSessionId, effectiveSessionDirectory);
    const sessionQuestions = useScopedBlockingQuestions(currentSessionId, effectiveSessionDirectory);
    // useSyncExternalStore requires a stable snapshot. When the store has no
    // forms entry for this session yet, `?? []` would mint a fresh empty array
    // per read, trip React's "getSnapshot should be cached" loop, and crash
    // the chat container with "Maximum update depth exceeded".
    const storedSessionForms = useSessionFormStore(
        (state) => (currentSessionId ? state.forms[currentSessionId] ?? EMPTY_SESSION_FORMS : EMPTY_SESSION_FORMS),
    );
    // Question-tool forms already render as QuestionCard. Drop them here so a
    // hydrated list cannot paint a second "Questions" card before refresh.
    const sessionForms = React.useMemo(
        () => storedSessionForms.filter((form) => !isQuestionFormMetadata(form.metadata)),
        [storedSessionForms],
    );
    React.useEffect(() => {
        if (!currentSessionId) return;
        void refreshSessionForms({
            sessionID: currentSessionId,
            directory: effectiveSessionDirectory,
        }).catch((error) => {
            console.error('[ChatContainer] Failed to list session forms:', error);
        });
    }, [currentSessionId, effectiveSessionDirectory]);
    useRecoverPendingQuestions(
        currentSessionId,
        effectiveSessionDirectory,
        sessionMessages,
        sessionQuestions.length,
    );

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }

        // Host + retained pending rows imply work only until status has clearly
        // finished this send (fresh idle at/after newest pending created). A
        // retained presentation may still paint after working clears.
        if (pendingUserMessagesImplyWorking(pendingUserMessages, {
            resolvedSessionStatus,
            sessionStatusObservedAt,
        })) {
            return true;
        }

        const lastMessage = sessionMessages[sessionMessages.length - 1]?.info as Message | undefined;
        const lastMessageStartedAt = (lastMessage as { time?: { created?: number } } | undefined)?.time?.created;
        if (
            resolvedSessionStatus
            && typeof sessionStatusObservedAt === 'number'
            && typeof lastMessageStartedAt === 'number'
            && lastMessageStartedAt <= sessionStatusObservedAt
        ) {
            return false;
        }

        if (
            typeof sessionStatusSnapshotAt === 'number'
            && typeof lastMessageStartedAt === 'number'
            && lastMessageStartedAt <= sessionStatusSnapshotAt
        ) {
            return false;
        }
        return Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
        );
    }, [currentSessionId, pendingUserMessages, resolvedSessionStatus, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type, sessionStatusObservedAt, sessionStatusSnapshotAt]);
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || sessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (sessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((sessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (sessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
        };
    }, [currentSessionId, sessionStatusForCurrent]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== activeRetryStatus.sessionId) {
            retryFallbackSessionRef.current = activeRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [activeRetryStatus]);

    const retryOverlay = React.useMemo(() => {
        if (!activeRetryStatus) {
            return null;
        }
        if (isSessionRetryAction(sessionStatusForCurrent)) {
            return null;
        }

        return {
            ...activeRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [activeRetryStatus, retryFallbackTimestamp, sessionStatusForCurrent]);
    const retryActionCopy = React.useMemo(
        () => resolveRetryActionCopy(sessionStatusForCurrent, (key) => t(key as I18nKey)),
        [sessionStatusForCurrent, t],
    );

    // History metadata — boundary facts from the directory child store; request
    // lifecycle (loading) stays on sync/assistant page flights but never feeds
    // canLoadEarlier/complete/limit. Prefetch status is cold-transcript only.
    // Read syncLoading during render (not only inside useMemo) so a loadingRef
    // flip that rebuilds `sync` always invalidates this memo — a cached
    // `loading: true` after the flight cleared blocked load-older for the full
    // wait window with nothing in the network panel.
    const syncHistoryLoading = Boolean(
        currentSessionId
        && sync.isLoading(currentSessionId, { directory: effectiveSessionDirectory }),
    );
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        const loadState = resolveChatHistoryLoadState({
            boundary: historyBoundary,
            assistantComplete: assistantHistory?.complete ?? true,
        });
        return {
            // Product limit is cumulative authored-user turns (the boundary's
            // loadedTurns), not message count.
            limit: historyBoundary.loadedTurns,
            complete: loadState.complete,
            canLoadEarlier: loadState.canLoadEarlier,
            // Concurrent-page wait gate for the timeline only (sync.isLoading /
            // assistant archive). Never OR sessionPrefetch status — it can stick
            // at loading on Relay and blocked user loadMore for the historyLoading
            // wait window with toast and zero fetch. Button spinner stays
            // mutation-owned separately.
            loading: resolveChatHistoryPaginationLoading({
                syncLoading: syncHistoryLoading,
                assistantLoading: Boolean(assistantHistory?.loading),
            }),
        };
    }, [
        assistantHistory?.complete,
        assistantHistory?.loading,
        currentSessionId,
        historyBoundary,
        syncHistoryLoading,
    ]);

    const isMobile = useUIStore((state) => state.isMobile);
    const isDedicatedMobileApp = useMobileAppActions() !== null;
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const initError = useGlobalSyncStore((s) => s.error);
    // Despite the historical name, this now covers mobile too: the mobile
    // composer enters the same fullscreen-input mode via its drag handle.
    const isDesktopExpandedInput = isExpandedInput;
    const useCompactDraftLayout = isDedicatedMobileApp || isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
    const draftProjectLabel = React.useMemo(() => {
        const selectedProject = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        const activeProject = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        const project = selectedProject ?? activeProject ?? projects[0] ?? null;
        return project ? getProjectDisplayLabel(project) : null;
    }, [activeProjectId, newSessionDraft?.selectedProjectId, projects]);

    const parentSessionTarget = useParentSessionTarget(currentSessionId, effectiveSessionDirectory);
    // Subagent rows leave the live directory list on session.updated; keep the
    // confirmed footer parent + agent/model through that gap (mobile nested
    // pages share this ChatContainer path).
    const subagentBannerViewKey = sessionViewKey ?? currentSessionId ?? '';
    const [subagentBannerLatch, setSubagentBannerLatch] = React.useState<SubagentReadOnlyBannerLatch<NonNullable<typeof parentSessionTarget>> | null>(null);
    const nextSubagentBannerLatch = resolveSubagentReadOnlyBannerLatch(
        subagentBannerLatch,
        subagentBannerViewKey,
        parentSessionTarget,
        sessionExecution,
    );
    useIsomorphicLayoutEffect(() => {
        setSubagentBannerLatch((previous) => resolveSubagentReadOnlyBannerLatch(
            previous,
            subagentBannerViewKey,
            parentSessionTarget,
            sessionExecution,
        ));
    }, [parentSessionTarget, sessionExecution, subagentBannerViewKey]);
    const resolvedParentSessionTarget = parentSessionTarget ?? nextSubagentBannerLatch?.parentTarget ?? null;
    const bannerExecution = nextSubagentBannerLatch?.execution ?? sessionExecution;

    // In the embedded session-chat iframe, hide "Return to parent" when
    // viewing the panel's anchor session (the one recorded in the URL). Going
    // up from the anchor would show the primary session that's already in the
    // main chat. Drilling into a deeper subtask (currentSessionId ≠ anchor)
    // re-enables the button to navigate back to the embedded session.
    const embeddedPanelAnchorSessionId = getEmbeddedSessionChatOriginSessionId();
    const hideReturnToParent =
        embeddedPanelAnchorSessionId !== null && currentSessionId === embeddedPanelAnchorSessionId;

    const handleReturnToParentSession = useEvent(() => {
        if (!resolvedParentSessionTarget) return;
        setCurrentSession(resolvedParentSessionTarget.id, resolvedParentSessionTarget.directory);
    });

    const parentSessionTitle = resolvedParentSessionTarget?.session?.title;
    const returnToParentButton = hostFeatures.returnToParent && resolvedParentSessionTarget && !hideReturnToParent ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label={t('chat.container.returnToParent.aria')}
            title={parentSessionTitle?.trim()
                ? t('chat.container.returnToParent.titleNamed', { title: parentSessionTitle })
                : t('chat.container.returnToParent.title')}
        >
            <Icon name="arrow-left" className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
        </Button>
    ) : null;
    const promptAvailability = resolveChatPromptAvailability({
        readOnly,
        sessionIdentityPending,
        isSubagentSession: Boolean(currentSessionEntity?.parentID) || Boolean(nextSubagentBannerLatch),
        allowPromptingSubagentSessions,
    });
    const bannerModelName = bannerExecution.modelId === sessionExecution.modelId
        ? sessionExecutionModelName
        : bannerExecution.modelId
            ? getProviderModelDisplayName(
                providers.find((entry) => entry.id === bannerExecution.providerId),
                bannerExecution.modelId,
            ) || bannerExecution.modelId
            : t('common.unavailable');
    const readOnlyPromptBanner = resolvedParentSessionTarget ? (
        <ReadOnlyPromptBanner
            agentName={bannerExecution.agentName}
            providerId={bannerExecution.providerId}
            modelId={bannerExecution.modelId}
            modelName={bannerModelName}
        />
    ) : <ReadOnlyPromptBanner />;
    const applyEmbeddedChatSettingsSync = useEvent((payload: { allowPromptingSubagentSessions: boolean }) => {
        useUIStore.getState().setAllowPromptingSubagentSessions(payload.allowPromptingSubagentSessions);
    });
    const handleEmbeddedChatSettingsMessage = useEvent((event: MessageEvent) => {
        if (typeof window === 'undefined' || event.source !== window.parent || event.origin !== window.location.origin) {
            return;
        }
        const data = event.data as { type?: unknown; payload?: { allowPromptingSubagentSessions?: unknown } };
        if (data?.type !== 'yuri:chat-settings-sync'
            || typeof data.payload?.allowPromptingSubagentSessions !== 'boolean') {
            return;
        }
        applyEmbeddedChatSettingsSync({
            allowPromptingSubagentSessions: data.payload.allowPromptingSubagentSessions,
        });
    });
    // Embedded iframe only: parent posts settings, and the window bridge is for
    // same-origin callers that cannot rely on postMessage ordering.
    const isEmbeddedChatFrame = typeof window !== 'undefined' && window.parent !== window;
    useEventListener(
        'message',
        handleEmbeddedChatSettingsMessage,
        isEmbeddedChatFrame ? window : NO_EVENT_TARGET,
    );
    useMount(() => {
        if (!isEmbeddedChatFrame) return;
        const scopedWindow = window as typeof window & {
            __yuriApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        scopedWindow.__yuriApplyChatSettingsSync = applyEmbeddedChatSettingsSync;
        window.parent.postMessage({ type: 'yuri:chat-settings-request' }, window.location.origin);
    });
    useUnmount(() => {
        if (typeof window === 'undefined') return;
        const scopedWindow = window as typeof window & {
            __yuriApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        if (scopedWindow.__yuriApplyChatSettingsSync === applyEmbeddedChatSettingsSync) {
            delete scopedWindow.__yuriApplyChatSettingsSync;
        }
    });

    React.useEffect(() => {
        if (hostFeatures.newSessionDraft && autoOpenDraft && !currentSessionId && !draftOpen) {
            openNewSessionDraft();
        }
    }, [autoOpenDraft, currentSessionId, draftOpen, hostFeatures.newSessionDraft, openNewSessionDraft]);

    const historyPrefixCacheRef = React.useRef<ChatMessageEntry[]>([]);
    const historyPrefix = React.useMemo(() => {
        const next = stitchHostedSessionHistory(
            assistantHistory?.entries ?? [],
            currentSessionId,
            historyPrefixCacheRef.current,
        );
        historyPrefixCacheRef.current = next;
        return next;
    }, [assistantHistory?.entries, currentSessionId]);
    const currentAssistantHistoryCacheRef = React.useRef<ChatMessageEntry[]>([]);
    const currentSessionMessages = React.useMemo(() => {
        if (!assistantHistory) return sessionMessages;
        const next = mergeHostedCurrentSessionHistory(
            assistantHistory.entries,
            currentSessionId,
            sessionMessages,
            currentAssistantHistoryCacheRef.current,
        );
        currentAssistantHistoryCacheRef.current = next;
        return next;
    }, [assistantHistory, currentSessionId, sessionMessages]);
    const viewportMessages = React.useMemo(() => {
        const authoritativeMessages = historyPrefix.length === 0
            ? currentSessionMessages
            : !currentSessionId
                ? historyPrefix
                : [
                    ...historyPrefix,
                    createAssistantSessionDivider(currentSessionId),
                    ...currentSessionMessages,
                ];
        return mergePendingUserMessagePresentations(authoritativeMessages, pendingUserMessages);
    }, [currentSessionId, currentSessionMessages, historyPrefix, pendingUserMessages]);
    // Transcript rows come from the Query cache, which an idle session can lose
    // to eviction or a transport swap. Replaying the last painted rows through
    // that empty read keeps the viewport from being torn down and rebuilt.
    const paintedTranscriptRef = React.useRef<PaintedTranscript<SessionMessageRecord> | null>(null);
    const retainedTranscript = React.useMemo(
        () => resolveRetainedTranscript({
            sessionId: currentSessionId,
            messages: viewportMessages,
            retained: paintedTranscriptRef.current,
        }),
        [currentSessionId, viewportMessages],
    );
    paintedTranscriptRef.current = retainedTranscript.retained;
    const renderedViewportMessages = retainedTranscript.messages as SessionMessageRecord[];
    const paintedTranscriptSessionRef = React.useRef<string | null>(null);
    const hasPaintedTranscript = paintedTranscriptSessionRef.current === currentSessionId;
    // The status line and the body are independent subscriptions, so the body
    // can freeze while the session keeps reporting work. Repair that state
    // instead of leaving the user with a transcript that silently drops their
    // own message. See transcriptStallWatchdog for the firing conditions.
    const transcriptStallRef = React.useRef(INITIAL_TRANSCRIPT_STALL_STATE);
    const transcriptStallSessionKey = currentSessionId
        ? `${effectiveSessionDirectory}\n${currentSessionId}`
        : null;
    const readTranscriptTailFingerprint = useEvent(
        () => buildTranscriptTailFingerprint(renderedViewportMessages),
    );
    React.useEffect(() => {
        if (!shouldArmTranscriptStallWatchdog({
            active,
            sessionId: currentSessionId,
            sessionKey: transcriptStallSessionKey,
            sessionIsWorking,
        })) {
            // Drop stall history when inactive/idle so a later activate does not
            // inherit a near-threshold clock and fire an immediate false refresh.
            transcriptStallRef.current = resetTranscriptStallStateForInactive(transcriptStallRef.current);
            return;
        }
        const sessionId = currentSessionId!;
        const directory = effectiveSessionDirectory;
        const interval = setInterval(() => {
            const fingerprint = readTranscriptTailFingerprint();
            const result = advanceTranscriptStallState(transcriptStallRef.current, {
                sessionKey: transcriptStallSessionKey!,
                working: true,
                streaming: Boolean(streamingMessageId),
                fingerprint,
                now: Date.now(),
                thresholdMs: TRANSCRIPT_STALL_THRESHOLD_MS,
                cooldownMs: TRANSCRIPT_STALL_COOLDOWN_MS,
                maxAttempts: TRANSCRIPT_STALL_MAX_ATTEMPTS,
            });
            transcriptStallRef.current = result.state;
            if (!result.shouldRefresh) return;
            reportTranscriptStall({
                sessionId,
                directory,
                stalledForMs: result.stalledForMs,
                attempt: result.state.attempts,
                fingerprint,
            });
            void refreshTranscriptFromAuthority(directory, sessionId).catch(() => {
                // Authority refresh keeps the prior transcript on failure; the
                // cooldown governs the next attempt.
            });
        }, TRANSCRIPT_STALL_POLL_MS);
        return () => clearInterval(interval);
    }, [
        active,
        currentSessionId,
        effectiveSessionDirectory,
        readTranscriptTailFingerprint,
        sessionIsWorking,
        streamingMessageId,
        transcriptStallSessionKey,
    ]);
    const materializedPendingMessageIDs = React.useMemo(() => {
        if (pendingUserMessages.length === 0) return [];
        // A row counts as materialized only once it can paint a user bubble —
        // part-less or synthetic-only shells still render as null.
        const authoritativeIDs = new Set(
            [...historyPrefix, ...currentSessionMessages]
                .filter((message) => hasUserDisplayableParts(message.parts))
                .map((message) => message.info.id),
        );
        return pendingUserMessages.map((message) => message.info.id).filter((id) => authoritativeIDs.has(id));
    }, [currentSessionMessages, historyPrefix, pendingUserMessages]);
    React.useEffect(() => {
        if (materializedPendingMessageIDs.length === 0) return;
        onPendingUserMessagesMaterialized?.(materializedPendingMessageIDs);
        if (currentSessionId) {
            clearRetainedPendingUserMessages(currentSessionId, materializedPendingMessageIDs);
        }
    }, [clearRetainedPendingUserMessages, currentSessionId, materializedPendingMessageIDs, onPendingUserMessagesMaterialized]);

    // Cold transcript gate: prefer a stable skeleton over flashing the
    // "Unable to load this conversation" wall while imperative + reactive
    // pulls race on session switch (stale error or concurrent fail).
    const hasTranscriptShell = hasChatTranscriptShell({
            transcriptMessageCount: sessionMessages.length,
            pendingUserCount: pendingUserMessages.length,
            historyPrefixCount: historyPrefix.length,
        });
    const sessionTranscriptGate = resolveChatSessionTranscriptGate({
        hasTranscriptShell,
        transcriptRecords: sessionMessages,
        p0Satisfied: transcriptHydration.p0Satisfied,
        hasBusyShell: sessionIsWorking && hasTranscriptShell,
        hasImmediateShell: pendingUserMessages.length > 0 || historyPrefix.length > 0,
        hasRenderableSessionSnapshot,
        prefetchStatus: sessionPrefetchInfo?.status,
        syncLoading: Boolean(currentSessionId && sync.isLoading(currentSessionId, { directory: effectiveSessionDirectory })),
        userRetrying: isRetryingSessionHistory,
        hasPaintedTranscript,
    });
    if (sessionTranscriptGate === 'pass' && renderedViewportMessages.length > 0) {
        paintedTranscriptSessionRef.current = currentSessionId;
    }
    const isSessionHydrating = Boolean(currentSessionId) && sessionTranscriptGate === 'hydrating';
    const shell = useChatSessionShell({
        active,
        sessionId: currentSessionId,
        viewKey: sessionViewKey,
        directory: effectiveSessionDirectory,
        messages: renderedViewportMessages,
        messageCount: sessionMessageCount,
        working: sessionIsWorking,
        hydrating: isSessionHydrating,
        expandedInput: isDesktopExpandedInput,
        historyMeta,
        loadMoreMessages,
        questions: sessionQuestions,
        permissions: sessionPermissions,
        promptNavigator: hostFeatures.promptNavigator,
        warmup: {
            scope: JSON.stringify([getRuntimeKey(), effectiveSessionDirectory, currentSessionId]),
            enabled: active && !isMobile && !isDedicatedMobileApp && Boolean(currentSessionId)
                && sessionTranscriptGate === 'pass' && transcriptHydration.p0Satisfied
                && !sessionIsWorking && !historyMeta?.loading,
            cursor: historyBoundary.kind === 'has-more' ? historyBoundary.cursor : null,
            loadedTurns: historyBoundary.loadedTurns,
            loadPrevious: (pageSize: number) => fetchTranscriptPreviousPage(effectiveSessionDirectory, currentSessionId!, pageSize),
        },
    });
    // Transcript navigation stays outside the composer, including the compact pill.
    const promptSurface = promptAvailability.showReadOnlyBanner
        ? readOnlyPromptBanner
        : readOnly
            ? null
            : (
                <>
                    {isMobile ? <MobileBackgroundWorkBar sessionId={currentSessionId ?? null} directory={effectiveSessionDirectory ?? null} /> : null}
                    <ChatInput
                        key="composer-input"
                        foregroundActive={active}
                        surface={composerSurface}
                        scrollToBottom={shell.scrollViewportOnSend}
                        submissionBlocked={promptAvailability.blockSubmission}
                    />
                </>
            );

    // Assistant-owned history is authoritative for prior bindings. Do not replace
    // a restorable transcript with the live-session load-failure wall.
    const hasSessionHistoryLoadError =
        Boolean(currentSessionId) && sessionTranscriptGate === 'load-error';

    React.useEffect(() => {
        if (!hasSessionHistoryLoadError || !currentSessionId) return;
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
            kind: 'request-error',
            sessionID: currentSessionId,
            directory: effectiveSessionDirectory,
            purpose: 'load-failed',
            source: 'network',
            request: sessionPrefetchInfo
                ? {
                    sessionID: currentSessionId,
                    status: sessionPrefetchInfo.status === 'ready' ? 'ready' : sessionPrefetchInfo.status,
                    error: sessionPrefetchInfo.error,
                }
                : undefined,
            hydration: transcriptHydration,
            error: sessionPrefetchInfo?.error,
        }));
    }, [
        currentSessionId,
        effectiveSessionDirectory,
        hasSessionHistoryLoadError,
        sessionPrefetchInfo,
        transcriptHydration,
    ]);

    React.useEffect(() => {
        setSessionIdentityEnsureRetry((current) => (
            current.key === sessionIdentityEnsureKey
                ? current
                : { key: sessionIdentityEnsureKey, attempt: 0 }
        ));
    }, [sessionIdentityEnsureKey]);

    React.useEffect(() => {
        if (!active || !currentSessionId || sessionIdentityEnsureRetry.key !== sessionIdentityEnsureKey || !shouldEnsureChatSessionRenderable({
            sessionId: currentSessionId,
            hasRenderableSessionSnapshot,
            hasCurrentSessionEntity: Boolean(currentSessionEntity),
        })) return;
        void ensureSessionRenderable(currentSessionId);
        if (currentSessionEntity || sessionIdentityEnsureRetry.attempt >= 2) return;

        const nextAttempt = sessionIdentityEnsureRetry.attempt + 1;
        const timer = window.setTimeout(() => {
            setSessionIdentityEnsureRetry((current) => (
                current.key === sessionIdentityEnsureKey
                    && current.attempt === sessionIdentityEnsureRetry.attempt
                    ? { key: sessionIdentityEnsureKey, attempt: nextAttempt }
                    : current
            ));
        }, nextAttempt * 1000);

        return () => window.clearTimeout(timer);
    }, [
        active,
        currentSessionEntity,
        currentSessionId,
        effectiveSessionDirectory,
        ensureSessionRenderable,
        hasRenderableSessionSnapshot,
        sessionIdentityEnsureKey,
        sessionIdentityEnsureRetry,
    ]);

	// Fork loading is session-scoped: other chats stay interactive while this runs.
	// Before the forked id exists, pin to the source; afterwards follow the target
	// only so navigating back to the source conversation stays fully operable.
	const forkTransitionForSession =
		forkTransition &&
		currentSessionId &&
		(forkTransition.targetSessionId
			? currentSessionId === forkTransition.targetSessionId
			: currentSessionId === forkTransition.sourceSessionId)
			? forkTransition
			: null;

	if (forkTransitionForSession) {
		const stageKey =
			forkTransitionForSession.stage === 'preparing'
				? 'chat.forkTransition.preparing'
				: forkTransitionForSession.stage === 'copying'
					? 'chat.forkTransition.copying'
					: forkTransitionForSession.stage === 'opening'
						? 'chat.forkTransition.opening'
						: 'chat.forkTransition.loading';
		const stageOrder = ['preparing', 'copying', 'opening', 'loading'] as const;
		const stageIndex = Math.max(1, stageOrder.indexOf(forkTransitionForSession.stage) + 1);
		const progressLabel = t('chat.forkTransition.progress', {
			current: stageIndex,
			total: stageOrder.length,
		});
		return (
			<div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
				<div
					className="flex flex-col items-center gap-2"
					role="status"
					aria-live="polite"
					aria-label={`${t(stageKey)}. ${progressLabel}`}
				>
					<span className="typography-ui-header text-muted-foreground">
						<span className="animate-text-shimmer">{t(stageKey)}</span>
						<BusyDots />
					</span>
					<span className="text-xs text-muted-foreground/70 tabular-nums">{progressLabel}</span>
				</div>
			</div>
		);
	}

	if (!currentSessionId && !draftOpen) {
		// With auto-open, the draft welcome opens on the next tick (effect below),
		// so the empty state is only ever transient here — render a neutral
		// background instead of flashing the logo / "start a new chat" on refresh.
		// Keep the empty state when there's nothing to auto-open or an init error to show.
		if (autoOpenDraft && !initError) {
			return <div className="flex h-full flex-col bg-background" />;
		}
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

	if (!currentSessionId && draftOpen) {
		// Keep the keyed composer mounted while the pending transcript replaces
		// the welcome. ChatInput sets draftEstablishing before response-style
		// prep; claim then promotes to draftSubmitting.
		if ((draftSubmitting || draftEstablishing) && draftPendingMessage) {
			const draftViewportKey = `draft:${newSessionDraft.draftID ?? 'pending'}`;
			return (
				<ChatSessionFrame shell={shell}>
					<ChatViewport
						timelineHistoryAnchorToken={shell.timelineHistoryAnchorToken}
						key={draftViewportKey}
						currentSessionId={draftViewportKey}
						virtualizerKey={draftViewportKey}
						isDesktopExpandedInput={false}
						isMobile={isMobile}
						stickyUserHeader={stickyUserHeader}
						directory={effectiveSessionDirectory}
						scrollRef={shell.scrollRef}
						messageListRef={shell.messageListRef}
						pendingRevealWork={false}
						initialPinRevealComplete
						renderedMessages={[draftPendingMessage]}
						isLoadingOlder={false}
						sessionIsWorking
						streamingMessageId={null}
						activeStreamingPhase={null}
						retryOverlay={null}
						handleMessageContentChange={shell.follow.notifyContentChange}
						getAnimationHandlers={shell.follow.getAnimationHandlers}
						handleHistoryScroll={shell.timeline.handleHistoryScroll}
						scrollToBottom={shell.resumeToLatestInstant}
						sessionQuestions={[]}
						sessionPermissions={[]}
						sessionForms={[]}
						retryActionCopy={null}
						isProgrammaticFollowActive={shell.follow.isFollowingProgrammatically}
						showLoadOlderButton={false}
						turnIds={[]}
						activeTurnId={null}
						onSelectTurn={shell.handlePromptNavigatorSelect}
						showPromptNavigator={false}
						canLoadEarlierPrompts={false}
						isLoadingOlderPrompts={false}
						onLoadEarlierPrompts={shell.handleLoadOlderClick}
						transcriptStatusRow={(
							<div className="chat-column" role="status" aria-live="polite">
								<div className="flex h-[1.2rem] items-center py-0.5 typography-meta text-muted-foreground">
									<span className="animate-text-shimmer">{t('chat.emptyState.establishingConversation')}</span>
									<BusyDots />
								</div>
							</div>
						)}
					/>
					<ChatSessionFoot key="composer-foot" isMobile={isMobile} expanded={isDesktopExpandedInput}>
						{promptSurface}
					</ChatSessionFoot>
				</ChatSessionFrame>
			);
		}

		if (draftSubmitting || draftEstablishing) {
			return (
				<ChatSessionFrame shell={shell} swap={false}>
					<div
						className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
						role="status"
						aria-live="polite"
						aria-label={t('chat.emptyState.establishingConversation')}
					>
						<span className="typography-ui-header text-muted-foreground">
							<span className="animate-text-shimmer">{t('chat.emptyState.establishingConversation')}</span>
							<BusyDots />
						</span>
					</div>
					<ChatSessionFoot key="composer-foot" isMobile={isMobile} expanded={isDesktopExpandedInput} overlay={false}>
						{promptSurface}
					</ChatSessionFoot>
				</ChatSessionFrame>
			);
		}

		return (
			<ChatSessionFrame shell={shell} swap={false}>
				{useCompactDraftLayout && !isDesktopExpandedInput ? (
					<div className="yuri-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
						<h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
							{renderDraftTitle(
								draftProjectLabel
									? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
									: t('chat.emptyState.draftTitle'),
								draftProjectLabel,
							)}
						</h1>
						<DraftPresetChips
							onSubmit={(text) => useInputStore.getState().requestPresetSubmit(text)}
							className="yuri-draft-starters mt-8 max-w-md"
						/>
					</div>
				) : null}
				<ChatSessionFoot
					key="composer-foot"
					isMobile={isMobile}
					expanded={isDesktopExpandedInput}
					overlay={false}
					className={cn('flex min-h-0', !isDesktopExpandedInput && (
						useCompactDraftLayout ? 'px-0' : 'flex-1 items-center justify-center px-0 pb-[6vh]'
					))}
				>
                        {promptSurface}
				</ChatSessionFoot>
			</ChatSessionFrame>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (hasSessionHistoryLoadError) {
		return (
			<ChatSessionFrame shell={shell} swap={false}>
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0',
						isDesktopExpandedInput
							? 'absolute inset-0 opacity-0 pointer-events-none'
							: 'flex-1',
					)}
					aria-hidden={isDesktopExpandedInput}
				>
					{!isDesktopExpandedInput ? (
						<div className="absolute inset-0 flex items-center justify-center px-6">
							<div
								className="flex max-w-sm flex-col items-center text-center"
								role="alert"
								aria-live="polite"
							>
								<div className="mb-4 flex size-10 items-center justify-center rounded-full bg-[var(--status-error-background)] text-[var(--status-error-foreground)]">
									<Icon name="error-warning" className="size-5" aria-hidden="true" />
								</div>
								<h2 className="typography-ui-header text-foreground">
									{t('chat.history.loadFailedTitle')}
								</h2>
								<p className="mt-2 text-sm text-muted-foreground">
									{t('chat.history.loadFailedDescription')}
								</p>
								<Button
									type="button"
									className="mt-5"
									onClick={retrySessionHistory}
								>
									<Icon name="refresh" className="size-4" aria-hidden="true" />
									{t('chat.history.retry')}
								</Button>
							</div>
						</div>
					) : null}
				</div>
				<ChatSessionFoot key="composer-foot" isMobile={isMobile} expanded={isDesktopExpandedInput} overlay={false}>
					{promptSurface}
				</ChatSessionFoot>
			</ChatSessionFrame>
		);
	}

	if (isSessionHydrating) {
		return (
			<ChatSessionFrame shell={shell}>
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    <div ref={shell.scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6 chat-scroll" style={CHAT_SCROLL_STYLE}>
                        <div className="space-y-4 chat-scroll-foot-inset">
                            {HYDRATING_SKELETON_ITEMS.map((item) => (
                                <div key={item.id} className="group w-full">
                                    <div className="chat-message-column">
                                        <div className="space-y-2.5 px-4 py-3">
                                            <div className="space-y-1.5">
                                                {item.toolRows.map((row) => {
                                                    return (
                                                        <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                                            <Skeleton className="h-3.5 w-3.5 rounded-full flex-shrink-0" />
                                                            <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                                            <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="space-y-1.5 pt-1">
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[0])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[1])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[2])} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <ChatSessionFoot key="composer-foot" isMobile={isMobile} expanded={isDesktopExpandedInput}>
                    {promptSurface}
				</ChatSessionFoot>
            </ChatSessionFrame>
        );
    }

	if (renderedViewportMessages.length === 0 && !sessionIsWorking) {
		return (
			// No transform here either — same fixed-positioning constraint as the
			// draft branch above.
			<ChatSessionFrame shell={shell} swap={false}>
				{returnToParentButton}
				<div
					className={cn(
                        'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    {!isDesktopExpandedInput ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <ChatEmptyState />
                        </div>
                    ) : null}
                </div>
                <ChatSessionFoot key="composer-foot" isMobile={isMobile} expanded={isDesktopExpandedInput} overlay={false}>
                    {promptSurface}
				</ChatSessionFoot>
            </ChatSessionFrame>
        );
    }

	return (
		<ChatSessionFrame shell={shell}>
			{warning ? (
				<div className="shrink-0 border-b border-border bg-[var(--status-warning-background)] px-4 py-2.5 typography-meta text-[var(--status-warning-foreground)]">
					{warning}
				</div>
			) : null}
			{returnToParentButton}
			<ChatTranscript
				shell={shell}
				active={active}
				expandedInput={isDesktopExpandedInput}
				sessionId={currentSessionId}
				viewKey={sessionViewKey ?? currentSessionId}
				directory={effectiveSessionDirectory}
				searchMessages={renderedViewportMessages}
				working={sessionIsWorking}
				streamingMessageId={streamingMessageId}
				activeStreamingPhase={activeStreamingPhase}
				retryOverlay={retryOverlay}
				retryActionCopy={retryActionCopy}
				questions={sessionQuestions}
				permissions={sessionPermissions}
				forms={sessionForms}
				initialPinRevealComplete={initialPinRevealComplete}
			/>

			<ChatSessionFoot
				key="composer-foot"
				isMobile={isMobile}
				expanded={isDesktopExpandedInput}
				scrollControls={(
					<ChatSessionScrollControls
						shell={shell}
						active={active && !isDesktopExpandedInput}
						messageCount={renderedViewportMessages.length}
					/>
				)}
			>
				{promptSurface}
			</ChatSessionFoot>

			<ChatSessionTimelineDialog
				shell={shell}
				open={isTimelineDialogOpen}
				onOpenChange={setTimelineDialogOpen}
				sessionId={currentSessionId}
				directory={effectiveSessionDirectory}
				onRevertMessage={onRevertMessage}
			/>
		</ChatSessionFrame>
	);
};

const MemoizedChatContainerContent = React.memo(ChatContainerContent);
MemoizedChatContainerContent.displayName = 'MemoizedChatContainerContent';

const SessionViewLoadingPlaceholder: React.FC = () => (
    <div
        className="flex h-full flex-col bg-background"
        data-session-view-loading="true"
        aria-hidden="true"
    >
        <div className="mt-auto w-full pb-5 motion-safe:animate-pulse">
            <div className="chat-message-column space-y-2 px-4">
                <div className="space-y-2">
                    <Skeleton className="h-4 w-4/5 animate-none rounded-md" />
                    <Skeleton className="h-4 w-2/3 animate-none rounded-md" />
                    <Skeleton className="h-4 w-1/2 animate-none rounded-md" />
                </div>
                <div className="space-y-2">
                    <Skeleton className="h-4 w-5/6 animate-none rounded-md" />
                    <Skeleton className="h-4 w-3/5 animate-none rounded-md" />
                </div>
            </div>
        </div>
    </div>
);

const RuntimeScopedChatContainer: React.FC<ChatContainerProps & { runtimeKey: string }> = ({ runtimeKey, ...props }) => {
    const chatSurfaceMode = useChatSurfaceMode();
    const syncDirectory = useSyncDirectory();
    const selectedSession = useSessionUIStore(
        useShallow((state) => ({
            sessionId: state.currentSessionId,
            directory: state.currentSessionDirectory,
            draftID: state.newSessionDraft.open ? state.newSessionDraft.draftID : null,
            draftPendingMessageId: state.newSessionDraft.open
                ? state.newSessionDraft.pendingUserMessage?.info.id ?? null
                : null,
        })),
    );
    const committedDraftPendingRef = React.useRef<{
        identity: string;
        messageId: string;
    } | null>(null);
    const draftPendingIdentity = selectedSession.draftID && selectedSession.draftPendingMessageId
        ? `${selectedSession.draftID}:${selectedSession.draftPendingMessageId}`
        : null;
    if (
        draftPendingIdentity
        && committedDraftPendingRef.current?.identity !== draftPendingIdentity
    ) {
        committedDraftPendingRef.current = null;
    }
    useIsomorphicLayoutEffect(() => {
        if (!draftPendingIdentity || !selectedSession.draftPendingMessageId) {
            return;
        }
        // This layout commit contains the local pending shell. A same-frame
        // session claim can present that exact retained row without a timed
        // paint heuristic or a Markdown visibility gap.
        committedDraftPendingRef.current = {
            identity: draftPendingIdentity,
            messageId: selectedSession.draftPendingMessageId,
        };
    }, [draftPendingIdentity, selectedSession.draftPendingMessageId]);
    const selectedRetainedPendingMessages = useSessionUIStore((state) => (
        selectedSession.sessionId
            ? state.retainedPendingUserMessages.get(selectedSession.sessionId) ?? EMPTY_PENDING_USER_MESSAGES
            : EMPTY_PENDING_USER_MESSAGES
    ));
    const committedDraftPending = committedDraftPendingRef.current;
    const committedDraftHandoffMessageId = committedDraftPending
        && selectedRetainedPendingMessages.some(
            (message) => message.info.id === committedDraftPending.messageId,
        )
        ? committedDraftPending.messageId
        : null;
    const selectedSessionView = React.useMemo<SessionViewSelection | null>(() => {
        if (!selectedSession.sessionId) {
            return null;
        }
        return {
            runtimeKey,
            sessionId: selectedSession.sessionId,
            directory: selectedSession.directory ?? syncDirectory,
        };
    }, [runtimeKey, selectedSession.directory, selectedSession.sessionId, syncDirectory]);
    const selectionIntent = React.useMemo(
        () => createSessionViewRenderIntent(selectedSessionView),
        [selectedSessionView],
    );
    const selectionKey = selectionIntent.key;
    const cacheLimits = isMobileSurfaceRuntime() || isVSCodeRuntime() || chatSurfaceMode === 'mini-chat'
        ? CONSTRAINED_SESSION_VIEW_CACHE_LIMITS
        : DESKTOP_SESSION_VIEW_CACHE_LIMITS;
    const [sessionViewRenderState, setSessionViewRenderState] = React.useState<SessionViewRenderState>(() => ({
        activeIntent: selectionIntent,
        cacheNeedsTrim: false,
        cachedSessionViews: selectedSessionView
            ? reconcileSessionViewCache(
                [],
                selectedSessionView,
                cacheLimits,
                DEFAULT_SESSION_VIEW_ESTIMATED_BYTES,
            )
            : [],
        pendingSessionView: null,
    }));
    const committedSelectionIntentRef = React.useRef(selectionIntent);
    const committedSelectionKeyRef = React.useRef(selectionKey);
    const { cacheNeedsTrim, cachedSessionViews, pendingSessionView } = sessionViewRenderState;
    const pendingRenderEntry = pendingSessionView?.intent === selectionIntent
        ? pendingSessionView.entry
        : null;
    const immediateHandoffRenderEntry = React.useMemo(() => {
        if (!selectedSessionView || !committedDraftHandoffMessageId) {
            return null;
        }
        return reconcileSessionViewCache(
            [],
            selectedSessionView,
            cacheLimits,
            DEFAULT_SESSION_VIEW_ESTIMATED_BYTES,
        )[0] ?? null;
    }, [cacheLimits, committedDraftHandoffMessageId, selectedSessionView]);
    const renderedSessionViews = React.useMemo(
        () => {
            const next = [...cachedSessionViews];
            if (
                pendingRenderEntry
                && !next.some((entry) => entry.key === pendingRenderEntry.key)
            ) {
                next.push(pendingRenderEntry);
            }
            if (
                immediateHandoffRenderEntry
                && !next.some((entry) => entry.key === immediateHandoffRenderEntry.key)
            ) {
                next.push(immediateHandoffRenderEntry);
            }
            return next.sort((left, right) => left.key.localeCompare(right.key));
        },
        [cachedSessionViews, immediateHandoffRenderEntry, pendingRenderEntry],
    );
    const activeSessionViewKey = resolveActiveSessionViewKey(renderedSessionViews, selectionKey);
    const isMaterializingSessionView = Boolean(selectionKey && !activeSessionViewKey);

    useIsomorphicLayoutEffect(() => {
        committedSelectionIntentRef.current = selectionIntent;
        committedSelectionKeyRef.current = selectionKey;
        setSessionViewRenderState((current) => {
            const selected = applySessionViewSelectionIntent(
                current,
                selectionIntent,
                cacheLimits,
            );
            return committedDraftHandoffMessageId
                ? materializeSessionViewRenderIntent(
                    selected,
                    selectionIntent,
                    selectionIntent,
                    DEFAULT_SESSION_VIEW_ESTIMATED_BYTES,
                )
                : selected;
        });
    }, [cacheLimits, cacheNeedsTrim, committedDraftHandoffMessageId, selectionIntent, selectionKey]);

    const pendingSessionViewIntent = pendingSessionView?.intent ?? null;
    useIsomorphicLayoutEffect(() => {
        if (!pendingSessionViewIntent) {
            return;
        }
        setSessionViewRenderState((current) => commitMaterializedSessionView(
            current,
            pendingSessionViewIntent,
            cacheLimits,
        ));
    }, [cacheLimits, pendingSessionViewIntent]);

    React.useEffect(() => {
        if (!selectionIntent.selection || activeSessionViewKey) {
            return;
        }
        const scheduledIntent = selectionIntent;
        const scheduledSelectionKey = selectionKey;
        return scheduleAfterPaintTask(() => {
            if (
                committedSelectionIntentRef.current !== scheduledIntent
                || committedSelectionKeyRef.current !== scheduledSelectionKey
            ) {
                return;
            }
            setSessionViewRenderState((current) => {
                if (committedSelectionKeyRef.current !== scheduledSelectionKey) {
                    return current;
                }
                return materializeSessionViewRenderIntent(
                    current,
                    scheduledIntent,
                    committedSelectionIntentRef.current,
                    DEFAULT_SESSION_VIEW_ESTIMATED_BYTES,
                );
            });
        }, { priority: 'user-blocking' });
    }, [activeSessionViewKey, cacheLimits, selectionIntent, selectionKey]);

    const handleSessionViewEstimateChange = useEvent((key: string, estimatedBytes: number) => {
        const scheduledIntent = committedSelectionIntentRef.current;
        const scheduledSelectionKey = committedSelectionKeyRef.current;
        setSessionViewRenderState((current) => {
            if (
                committedSelectionIntentRef.current !== scheduledIntent
                || committedSelectionKeyRef.current !== scheduledSelectionKey
                || current.activeIntent !== scheduledIntent
                || key !== scheduledSelectionKey
            ) {
                return current;
            }
            const cachedViews = recordSessionViewEstimate(
                current.cachedSessionViews,
                key,
                estimatedBytes,
            );
            return cachedViews === current.cachedSessionViews
                ? current
                : { ...current, cacheNeedsTrim: true, cachedSessionViews: cachedViews };
        });
    });

    return (
        <div className="h-full bg-background" aria-busy={isMaterializingSessionView || undefined}>
            {isMaterializingSessionView ? <SessionViewLoadingPlaceholder key={selectionKey} /> : null}
            {renderedSessionViews.map((view) => (
                <React.Activity
                    key={view.key}
                    name={`chat-session-${view.sessionId}`}
                    mode={activeSessionViewKey === view.key ? 'visible' : 'hidden'}
                >
                    <MemoizedChatContainerContent
                        {...props}
                        sessionId={view.sessionId}
                        sessionDirectory={view.directory}
                        sessionViewKey={view.key}
                        onSessionViewEstimateChange={handleSessionViewEstimateChange}
                        committedDraftHandoffMessageId={activeSessionViewKey === view.key
                            ? committedDraftHandoffMessageId
                            : null}
                    />
                </React.Activity>
            ))}
            {!selectionKey ? (
                <MemoizedChatContainerContent
                    {...props}
                    sessionId={null}
                    sessionDirectory={selectedSession.directory}
                />
            ) : null}
        </div>
    );
};

const HostedChatContainer: React.FC<ChatContainerProps & { host: ChatContainerHost; runtimeKey: string }> = ({
    host,
    runtimeKey,
    readOnly = false,
}) => {
    const hostedFeatures = React.useMemo(() => resolveChatContainerHostFeatures(host), [host]);
    const sessionSurface = React.useMemo(() => ({
        ...host.sessionSurface,
        sessionId: host.sessionId,
        directory: host.directory,
        ...(host.onRevertMessage ? { onRevertMessage: host.onRevertMessage } : {}),
    }), [host]);
    const sessionViewKey = `host:${runtimeKey}:${sessionSurface.surfaceId}:${host.sessionId}`;
    return (
        <SessionSurfaceContext.Provider value={sessionSurface}>
            <div className="h-full bg-background">
                <MemoizedChatContainerContent
                    autoOpenDraft={false}
                    readOnly={readOnly}
                    sessionId={host.sessionId}
                    sessionDirectory={host.directory}
                    sessionViewKey={sessionViewKey}
                    composerSurface={host.composerSurface}
                    hostedFeatures={hostedFeatures}
                    assistantHistory={host.assistantHistory}
                    pendingUserMessages={host.pendingUserMessages}
                    onPendingUserMessagesMaterialized={host.onPendingUserMessagesMaterialized}
                    onRevertMessage={host.onRevertMessage}
                    warning={host.warning}
                />
            </div>
        </SessionSurfaceContext.Provider>
    );
};

const ExplicitChatContainer: React.FC<Omit<ChatContainerProps, 'host'> & {
    explicitSession: NonNullable<ChatContainerProps['explicitSession']>;
    runtimeKey: string;
}> = ({ explicitSession, runtimeKey, ...props }) => {
    const syncDirectory = useSyncDirectory();
    const directory = explicitSession.directory ?? syncDirectory;
    const sessionSurface = React.useMemo(() => createExplicitSessionSurface({
        ...explicitSession,
        directory,
    }), [directory, explicitSession]);
    return (
        <SessionSurfaceContext.Provider value={sessionSurface}>
            <div className="h-full bg-background">
                <MemoizedChatContainerContent
                    {...props}
                    active={explicitSession.active}
                    sessionId={explicitSession.sessionId}
                    sessionDirectory={directory}
                    sessionViewKey={`explicit:${runtimeKey}:${explicitSession.viewKey}`}
                />
            </div>
        </SessionSurfaceContext.Provider>
    );
};

export const ChatContainer: React.FC<ChatContainerProps> = (props) => {
    const remoteSession = useSessionNavigationStore((store) => store.remoteSession);
    const runtimeKey = React.useSyncExternalStore(
        subscribeRuntimeKey,
        getRuntimeKey,
        getRuntimeKey,
    );

    if (props.host) {
        return <HostedChatContainer key={`${runtimeKey}:${props.host.sessionSurface.surfaceId}`} {...props} host={props.host} runtimeKey={runtimeKey} />;
    }

    const remoteLocation = props.explicitSession?.location ?? (!props.explicitSession?.sessionId ? remoteSession?.location : undefined);
    if (remoteLocation?.hostId) {
        const sessionId = props.explicitSession?.location ? props.explicitSession.sessionId : remoteSession?.sessionId ?? null;
        return <RemoteChatContainer key={`${runtimeKey}:${remoteLocation.hubId}:${remoteLocation.hostId}:${remoteLocation.directory}`}
            location={remoteLocation} sessionId={sessionId} active={props.explicitSession?.active ?? props.active} readOnly={props.readOnly} composerPresentation="primary" />;
    }

    if (props.explicitSession) {
        return (
            <ExplicitChatContainer
                key={`${runtimeKey}:${props.explicitSession.viewKey}`}
                autoOpenDraft={props.autoOpenDraft}
                readOnly={props.readOnly}
                active={props.active}
                explicitSession={props.explicitSession}
                runtimeKey={runtimeKey}
            />
        );
    }

    return <RuntimeScopedChatContainer key={runtimeKey} {...props} runtimeKey={runtimeKey} />;
};

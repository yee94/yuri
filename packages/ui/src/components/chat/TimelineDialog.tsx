import React from 'react';
import { useEvent } from '@reactuses/core';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { formatTimelineDateGroup, formatTimelineMessageTime } from '@/lib/intlFormatters';
import { getFullText, getMessagePreview } from './lib/messagePreview';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useSessionSurface } from './SessionSurfaceContext';
import { getTimelineActionAvailability } from './timelineActions';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import './timeline-dialog.css';

interface TimelineDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessionID?: string;
    directory?: string;
    onScrollToMessage?: (messageId: string) => void | Promise<boolean>;
    onScrollByTurnOffset?: (offset: number) => void;
    onResumeToLatest?: () => void;
    canLoadEarlier?: boolean;
    isLoadingEarlier?: boolean;
    onLoadEarlier?: () => void;
    onRevertMessage?: (messageId: string) => Promise<void>;
}

type PendingTimelineAction = { type: 'revert' | 'fork'; messageId: string } | null;

/**
 * Stable shell: always mounted by ChatContainer. Holds cross-open UI state only.
 * Expensive message subscription + list build live in TimelineDialogBody, which
 * mounts solely under desktop Dialog or mobile sheet portal presence / exit lifecycle.
 *
 * Pending fork/revert gate lives on the shell (survives body remount during exit
 * / reopen) and stays locked until the in-flight promise settles. A generation
 * token ensures a late settle cannot clear a newer scoped action's UI.
 */
export const TimelineDialog: React.FC<TimelineDialogProps> = ({
    open,
    onOpenChange,
    sessionID,
    directory,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
    canLoadEarlier = false,
    isLoadingEarlier = false,
    onLoadEarlier,
    onRevertMessage,
}) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const [pendingAction, setPendingAction] = React.useState<PendingTimelineAction>(null);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const pendingActionGateRef = React.useRef(false);
    const pendingActionGenerationRef = React.useRef(0);

    const runPendingMessageAction = useEvent(async (
        type: 'revert' | 'fork',
        messageId: string,
        execute: () => Promise<void>,
    ) => {
        if (pendingActionGateRef.current) return;
        pendingActionGateRef.current = true;
        const generation = pendingActionGenerationRef.current + 1;
        pendingActionGenerationRef.current = generation;
        setPendingAction({ type, messageId });
        try {
            await execute();
            onOpenChange(false);
        } finally {
            if (pendingActionGenerationRef.current === generation) {
                pendingActionGateRef.current = false;
                setPendingAction(null);
            }
        }
    });

    if (!sessionID) return null;

    const body = (
        <TimelineDialogBody
            open={open}
            onOpenChange={onOpenChange}
            sessionID={sessionID}
            directory={directory}
            onScrollToMessage={onScrollToMessage}
            onScrollByTurnOffset={onScrollByTurnOffset}
            onResumeToLatest={onResumeToLatest}
            canLoadEarlier={canLoadEarlier}
            isLoadingEarlier={isLoadingEarlier}
            onLoadEarlier={onLoadEarlier}
            onRevertMessage={onRevertMessage}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
            pendingAction={pendingAction}
            runPendingMessageAction={runPendingMessageAction}
        />
    );

    if (isMobile) {
        return (
            <MobileResizableSheet
                id={`conversation-timeline:${sessionID}`}
                open={open}
                onOpenChange={onOpenChange}
                title={<span className="yuri-timeline-mobile-title">{t('chat.timeline.title')}</span>}
                ariaLabel={t('chat.timeline.title')}
                closeAriaLabel={t('mobile.surface.closeAria')}
                resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
                className="yuri-timeline-mobile"
                bodyClassName="yuri-timeline-body"
            >
                {body}
            </MobileResizableSheet>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                presentation="picker"
                className="yuri-timeline-dialog"
            >
                {body}
            </DialogContent>
        </Dialog>
    );
};

type TimelineDialogBodyProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessionID: string;
    directory?: string;
    onScrollToMessage?: (messageId: string) => void | Promise<boolean>;
    onScrollByTurnOffset?: (offset: number) => void;
    onResumeToLatest?: () => void;
    canLoadEarlier: boolean;
    isLoadingEarlier: boolean;
    onLoadEarlier?: () => void;
    onRevertMessage?: (messageId: string) => Promise<void>;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    selectedIndex: number;
    onSelectedIndexChange: (value: number | ((current: number) => number)) => void;
    pendingAction: PendingTimelineAction;
    runPendingMessageAction: (
        type: 'revert' | 'fork',
        messageId: string,
        execute: () => Promise<void>,
    ) => Promise<void>;
};

const TimelineDialogBody: React.FC<TimelineDialogBodyProps> = ({
    open,
    onOpenChange,
    sessionID,
    directory,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
    canLoadEarlier,
    isLoadingEarlier,
    onLoadEarlier,
    onRevertMessage,
    searchQuery,
    onSearchQueryChange,
    selectedIndex,
    onSelectedIndexChange,
    pendingAction,
    runPendingMessageAction,
}) => {
    const { t } = useI18n();
    const sessionSurface = useSessionSurface();
    const currentSessionId = sessionID;
    const messages = useSessionMessageRecords(currentSessionId ?? '', directory);
    const revertToMessage = useSessionUIStore((state) => state.revertToMessage);
    const forkFromMessage = useSessionUIStore((state) => state.forkFromMessage);
    const actionAvailability = getTimelineActionAvailability(sessionSurface.capabilities);
    const { isMobile, isTablet } = useDeviceInfo();
    const alwaysShowActions = isMobile || isTablet;

    const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const pendingLoadAnchorRef = React.useRef<{ messageId: string; top: number } | null>(null);
    const preservingLoadPositionRef = React.useRef(false);
    // Body remounts with the dialog portal. Always start "was closed" so the
    // first open (or reopen after full exit) still scrolls to the latest row.
    const wasOpenRef = React.useRef(false);

    // Pure render helpers — no React.useCallback (shared UI convention).
    const formatDateGroup = (timestamp: number): string => formatTimelineDateGroup(timestamp);

    const formatMessageTime = (timestamp: number): string => formatTimelineMessageTime(timestamp);

    // Timeline actions are only valid for user messages.
    const userMessages = React.useMemo(() => {
        return messages
            .filter((message) => message.info.role === 'user')
            .map((message) => ({ message }));
    }, [messages]);

    // Filter by search query using all text parts in each user message.
    const filteredMessages = React.useMemo(() => {
        const trimmedQuery = searchQuery.trim();
        if (!trimmedQuery) return userMessages;

        const query = trimmedQuery.toLowerCase();
        return userMessages.filter(({ message }) => {
            const fullText = getFullText(message.parts).toLowerCase();
            return fullText.includes(query);
        });
    }, [userMessages, searchQuery]);

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        onSelectedIndexChange(searchQuery.trim() ? 0 : Math.max(0, filteredMessages.length - 1));
    }, [filteredMessages, searchQuery, onSelectedIndexChange]);

    React.useEffect(() => {
        itemRefs.current = itemRefs.current.slice(0, filteredMessages.length);
    }, [filteredMessages.length]);

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        itemRefs.current[selectedIndex]?.scrollIntoView({
            block: 'nearest',
        });
    }, [selectedIndex]);

    React.useEffect(() => {
        if (!preservingLoadPositionRef.current || pendingLoadAnchorRef.current || isLoadingEarlier) {
            return;
        }

        preservingLoadPositionRef.current = false;
    }, [filteredMessages.length, isLoadingEarlier]);

    React.useLayoutEffect(() => {
        const wasOpen = wasOpenRef.current;
        wasOpenRef.current = open;

        if (!open || wasOpen || preservingLoadPositionRef.current || searchQuery.trim()) {
            return;
        }

        const container = listRef.current;
        if (!container) {
            return;
        }

        container.scrollTop = container.scrollHeight;
    }, [open, searchQuery]);

    React.useLayoutEffect(() => {
        const anchor = pendingLoadAnchorRef.current;
        const container = listRef.current;
        if (!anchor || !container || isLoadingEarlier) {
            return;
        }

        pendingLoadAnchorRef.current = null;
        const anchoredRow = itemRefs.current.find((row) => row?.dataset.timelineMessageId === anchor.messageId);
        if (!anchoredRow) {
            return;
        }

        const nextTop = anchoredRow.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += nextTop - anchor.top;
    }, [filteredMessages.length, isLoadingEarlier]);

    const handleLoadEarlier = useEvent(() => {
        const container = listRef.current;
        if (container) {
            const containerTop = container.getBoundingClientRect().top;
            const firstVisibleRow = itemRefs.current.find((row) => {
                if (!row) return false;
                return row.getBoundingClientRect().bottom >= containerTop;
            });

            if (firstVisibleRow?.dataset.timelineMessageId) {
                pendingLoadAnchorRef.current = {
                    messageId: firstVisibleRow.dataset.timelineMessageId,
                    top: firstVisibleRow.getBoundingClientRect().top - containerTop,
                };
            }
        }

        preservingLoadPositionRef.current = true;
        onLoadEarlier?.();
    });

    const navigateToMessage = useEvent(async (messageId: string) => {
        const didNavigate = await onScrollToMessage?.(messageId);
        if (didNavigate === false) {
            return;
        }
        onOpenChange(false);
    });

    const handleSearchKeyDown = useEvent((event: React.KeyboardEvent<HTMLInputElement>) => {
        const total = filteredMessages.length;
        if (total === 0) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            onSelectedIndexChange((current) => (current + 1) % total);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            onSelectedIndexChange((current) => (current - 1 + total) % total);
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            const safeIndex = ((selectedIndex % total) + total) % total;
            const selected = filteredMessages[safeIndex];
            if (selected) {
                void navigateToMessage(selected.message.info.id);
            }
        }
    });

    const handleMessageAction = useEvent(async (type: 'revert' | 'fork', messageId: string) => {
        if (!currentSessionId) return;
        await runPendingMessageAction(type, messageId, async () => {
            if (type === 'revert') {
                if (onRevertMessage) await onRevertMessage(messageId);
                else await revertToMessage(currentSessionId, messageId, { directory });
            } else {
                await forkFromMessage(currentSessionId, messageId, { directory });
            }
        });
    });

    return (
        <>
            {!isMobile ? <DialogHeader className="yuri-timeline-header">
                <DialogTitle className="yuri-timeline-title">
                    {t('chat.timeline.title')}
                </DialogTitle>
            </DialogHeader> : null}

            <div className={cn('yuri-timeline-search', isMobile && 'yuri-mobile-glass-control')}>
                <Icon name="search" className="size-4 shrink-0 text-muted-foreground" />
                <Input
                    autoFocus={!isMobile}
                    aria-label={t('chat.timeline.searchPlaceholder')}
                    inputMode="search"
                    placeholder={t('chat.timeline.searchPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => onSearchQueryChange(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                />
            </div>

            {canLoadEarlier && onLoadEarlier && (
                <div className="yuri-timeline-history">
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={handleLoadEarlier}
                        disabled={isLoadingEarlier}
                        className="text-muted-foreground hover:text-foreground"
                    >
                        {isLoadingEarlier && (
                            <Icon name="loader-4" className="size-4 animate-spin" />
                        )}
                        {t('chat.history.loadOlder')}
                    </Button>
                </div>
            )}

            <ScrollableOverlay ref={listRef} outerClassName="yuri-timeline-scroll" className="yuri-timeline-list" aria-label={t('chat.timeline.title')}>
                {filteredMessages.length === 0 ? (
                    <div className="yuri-timeline-empty text-center text-muted-foreground">
                        {searchQuery ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}
                    </div>
                ) : (
                    filteredMessages.map(({ message }, index) => {
                        const preview = getMessagePreview(message.parts);
                        const timestamp = message.info.time.created;
                        const dateGroup = formatDateGroup(timestamp);
                        const previous = filteredMessages[index - 1];
                        const previousDateGroup = previous
                            ? formatDateGroup(previous.message.info.time.created)
                            : null;
                        const showDateGroup = dateGroup !== previousDateGroup;
                        const messageTime = formatMessageTime(timestamp);
                        const isSelected = index === selectedIndex;

                        const snippet = searchQuery.trim()
                            ? getSearchSnippet(getFullText(message.parts), searchQuery)
                            : null;

                        return (
                            <React.Fragment key={message.info.id}>
                                {showDateGroup && (
                                    <div className="yuri-timeline-date text-muted-foreground">
                                        {dateGroup}
                                    </div>
                                )}
                                <div
                                    ref={(element) => {
                                        itemRefs.current[index] = element;
                                    }}
                                    data-timeline-message-id={message.info.id}
                                    data-selected={isSelected}
                                    data-show-actions={alwaysShowActions}
                                    className={cn(
                                        'yuri-timeline-row hover:bg-interactive-hover/30',
                                        isSelected && 'bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]'
                                    )}
                                    onMouseEnter={() => onSelectedIndexChange(index)}
                                >
                                    <button
                                        type="button"
                                        className="yuri-timeline-message"
                                        aria-current={isSelected || undefined}
                                        title={preview}
                                        onFocus={() => onSelectedIndexChange(index)}
                                        onClick={() => void navigateToMessage(message.info.id)}
                                    >
                                        <time className="yuri-timeline-time text-muted-foreground" dateTime={new Date(timestamp).toJSON() ?? undefined}>
                                            {messageTime}
                                        </time>
                                        <span className="yuri-timeline-preview text-foreground">
                                            {snippet ?? (preview || t('chat.timeline.noTextContent'))}
                                        </span>
                                    </button>

                                    <div className="yuri-timeline-row-actions">
                                            {actionAvailability.revert ? <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="text-muted-foreground hover:text-foreground"
                                                        aria-label={t('chat.timeline.actions.revertFromHere')}
                                                        aria-busy={pendingAction?.type === 'revert' && pendingAction.messageId === message.info.id}
                                                        disabled={pendingAction !== null}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void handleMessageAction('revert', message.info.id);
                                                        }}
                                                    >
                                                        <Icon
                                                            name={pendingAction?.type === 'revert' && pendingAction.messageId === message.info.id ? 'loader-4' : 'arrow-go-back'}
                                                            className={cn('h-4 w-4', pendingAction?.type === 'revert' && pendingAction.messageId === message.info.id && 'animate-spin')}
                                                        />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={6}>{t('chat.timeline.actions.revertFromHere')}</TooltipContent>
                                            </Tooltip> : null}

                                            {actionAvailability.fork ? <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="text-muted-foreground hover:text-foreground"
                                                        aria-label={t('chat.timeline.actions.forkFromHere')}
                                                        aria-busy={pendingAction?.type === 'fork' && pendingAction.messageId === message.info.id}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void handleMessageAction('fork', message.info.id);
                                                        }}
                                                        disabled={pendingAction !== null}
                                                    >
                                                        {pendingAction?.type === 'fork' && pendingAction.messageId === message.info.id ? (
                                                            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <Icon name="git-branch" className="h-4 w-4" />
                                                        )}
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={6}>{t('chat.timeline.actions.forkFromHere')}</TooltipContent>
                                            </Tooltip> : null}
                                    </div>
                                </div>
                            </React.Fragment>
                        );
                    })
                )}
            </ScrollableOverlay>

            {onScrollByTurnOffset || onResumeToLatest ? <div className="yuri-timeline-toolbar">
                    {onScrollByTurnOffset ? <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={pendingAction !== null}
                        onClick={() => {
                            void onScrollByTurnOffset?.(-1);
                            onOpenChange(false);
                        }}
                    >
                        {t('chat.timeline.actions.previousTurn')}
                    </Button> : null}
                    {onResumeToLatest ? <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={pendingAction !== null}
                        onClick={() => {
                            onResumeToLatest?.();
                            onOpenChange(false);
                        }}
                    >
                        {t('chat.timeline.actions.latest')}
                    </Button> : null}
            </div> : null}
        </>
    );
};

function getSearchSnippet(text: string, query: string, contextChars: number = 30): string | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    if (matchIndex === -1) return null;

    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + query.length + contextChars);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`;
}

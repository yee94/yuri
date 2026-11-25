import React from 'react';
import { useEvent } from '@reactuses/core';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useSessionTurnDiffQuery } from '@/queries/sessionTurnChangesQueries';
import type { ContentChangeHandler } from '@/hooks/useChatAutoFollow';
import type { TurnChangedFile } from '../lib/turns/types';
import { openTurnChangedFilePreview } from '../openTurnChangedFile';
import { getSessionSurfaceActionAvailability, useSessionSurface } from '../SessionSurfaceContext';

/** Inline transcript card shows 3 files by default, with an in-card expand toggle for the rest. */
const TURN_CHANGES_CARD_VISIBLE_LIMIT = 3;

interface TurnChangesCardFileRow {
    file: string;
    additions?: number;
    deletions?: number;
}

const splitTurnChangedFilePath = (file: string): { dirPrefix: string; fileName: string } => {
    const normalized = file.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash < 0) {
        return { dirPrefix: '', fileName: normalized };
    }
    return {
        dirPrefix: normalized.slice(0, lastSlash + 1),
        fileName: normalized.slice(lastSlash + 1) || normalized,
    };
};

const TurnChangesCardFileButton = React.memo(({
    file,
    canOpen,
    isMobile,
    onOpen,
}: {
    file: TurnChangesCardFileRow;
    canOpen: boolean;
    isMobile: boolean;
    onOpen: (file: string) => void;
}) => {
    const { t } = useI18n();
    const { dirPrefix, fileName } = React.useMemo(() => splitTurnChangedFilePath(file.file), [file.file]);
    const hasCounts = typeof file.additions === 'number' && typeof file.deletions === 'number';
    const handleClick = useEvent(() => {
        onOpen(file.file);
    });

    return (
        <button
            type="button"
            disabled={!canOpen}
            data-turn-change-file="true"
            onClick={handleClick}
            aria-label={t('chat.changedFiles.actions.openFileTitle', { path: file.file })}
            title={file.file}
            className={cn(
                'flex w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius-md)] text-left transition-colors',
                'hover:bg-interactive-hover focus-visible:bg-interactive-hover active:bg-interactive-active',
                'focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
                isMobile ? 'px-2.5 py-1.5 text-xs' : 'px-2.5 py-1.5 text-[13px]',
            )}
        >
            <span className="min-w-0 flex-1 truncate leading-snug">
                {dirPrefix ? <span className="text-[var(--surface-muted-foreground)]">{dirPrefix}</span> : null}
                <span className="text-foreground">{fileName}</span>
            </span>
            {hasCounts ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium leading-none tabular-nums">
                    <span style={{ color: 'var(--status-success)' }}>+{file.additions}</span>
                    <span style={{ color: 'var(--status-error)' }}>-{file.deletions}</span>
                </span>
            ) : null}
        </button>
    );
});

TurnChangesCardFileButton.displayName = 'TurnChangesCardFileButton';

interface TurnChangesCardProps {
    sessionId?: string;
    fileCount: number;
    totalAdditions?: number;
    totalDeletions?: number;
    changedFiles?: TurnChangedFile[];
    turnId: string;
    turnDiffFromMessageId?: string;
    turnDiffFiles?: string[];
    turnDiffSignature?: string;
    isLatestTurn: boolean;
    isMobile: boolean;
    onContentChange?: ContentChangeHandler;
}

export const TurnChangesCard = React.memo(({
    sessionId,
    fileCount,
    totalAdditions,
    totalDeletions,
    changedFiles,
    turnId,
    turnDiffFromMessageId,
    turnDiffFiles,
    turnDiffSignature,
    isLatestTurn,
    isMobile,
    onContentChange,
}: TurnChangesCardProps) => {
    const { t } = useI18n();
    const effectiveDirectory = useEffectiveDirectory();
    const hostRuntime = useHostRuntime();
    const hostScope = hostRuntime?.entry.location.hostId ? hostRuntime.entry : undefined;
    const sessionSurface = useSessionSurface();
    const sessionSurfaceActions = getSessionSurfaceActionAvailability(sessionSurface);
    const diffDirectory = sessionSurface.directory || effectiveDirectory;
    const diffSessionId = sessionSurface.sessionId || sessionId || null;
    const mobileActions = useMobileAppActions();
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const revertToMessage = useSessionUIStore((state) => state.revertToMessage);

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isReverting, setIsReverting] = React.useState(false);
    const revertInFlightRef = React.useRef(false);

    const hasLegacyFiles = Boolean(changedFiles && changedFiles.length > 0);
    const isV2TurnDiff = Boolean(turnDiffFromMessageId && turnDiffFiles && turnDiffFiles.length > 0);
    const targetTurnMessageId = turnDiffFromMessageId || turnId;

    const turnDiffQuery = useSessionTurnDiffQuery(
        isV2TurnDiff && diffSessionId && diffDirectory && turnDiffFromMessageId
            ? {
                sessionID: diffSessionId,
                directory: diffDirectory,
                from: turnDiffFromMessageId,
                snapshotSignature: turnDiffSignature,
                scope: hostScope,
            }
            : null,
        { enabled: isV2TurnDiff && Boolean(diffSessionId && diffDirectory && turnDiffFromMessageId) },
    );

    const resolvedFiles = React.useMemo<TurnChangesCardFileRow[]>(() => {
        if (isV2TurnDiff) {
            if (turnDiffQuery.isSuccess) {
                return turnDiffQuery.data
                    .filter((entry) => typeof entry?.file === 'string' && entry.file.length > 0)
                    .map((entry) => ({
                        file: entry.file,
                        additions: typeof entry.additions === 'number' && Number.isFinite(entry.additions) ? entry.additions : 0,
                        deletions: typeof entry.deletions === 'number' && Number.isFinite(entry.deletions) ? entry.deletions : 0,
                    }));
            }
            return (turnDiffFiles ?? []).map((file) => ({ file }));
        }
        if (hasLegacyFiles && changedFiles) {
            return changedFiles.map((file) => ({
                file: file.file,
                additions: file.additions,
                deletions: file.deletions,
            }));
        }
        return [];
    }, [changedFiles, hasLegacyFiles, isV2TurnDiff, turnDiffFiles, turnDiffQuery.data, turnDiffQuery.isSuccess]);

    const totals = React.useMemo<{ additions: number; deletions: number } | null>(() => {
        if (isV2TurnDiff) {
            if (!turnDiffQuery.isSuccess) return null;
            let additions = 0;
            let deletions = 0;
            for (const file of resolvedFiles) {
                additions += file.additions ?? 0;
                deletions += file.deletions ?? 0;
            }
            return { additions, deletions };
        }
        if (typeof totalAdditions === 'number' && typeof totalDeletions === 'number') {
            return { additions: totalAdditions, deletions: totalDeletions };
        }
        if (resolvedFiles.length > 0 && resolvedFiles.every((file) => typeof file.additions === 'number' && typeof file.deletions === 'number')) {
            let additions = 0;
            let deletions = 0;
            for (const file of resolvedFiles) {
                additions += file.additions ?? 0;
                deletions += file.deletions ?? 0;
            }
            return { additions, deletions };
        }
        return null;
    }, [isV2TurnDiff, resolvedFiles, totalAdditions, totalDeletions, turnDiffQuery.isSuccess]);

    const openTurnFile = useEvent((file: string) => {
        if (mobileActions) {
            mobileActions.openTurnDiff(targetTurnMessageId, diffSessionId, file);
            return;
        }

        if (!isMobile && diffDirectory) {
            openTurnChangedFilePreview({
                scope: hostScope,
                directory: diffDirectory,
                filePath: file,
                turnMessageId: targetTurnMessageId,
                sessionId: diffSessionId,
            });
            return;
        }

        if (isMobile && isLatestTurn && diffDirectory) {
            openTurnChangedFilePreview({
                scope: hostScope,
                directory: diffDirectory,
                filePath: file,
                turnMessageId: targetTurnMessageId,
                sessionId: diffSessionId,
                mobile: true,
            });
        }
    });

    const openCompleteTurnDiff = useEvent(() => {
        if (mobileActions) {
            mobileActions.openTurnDiff(targetTurnMessageId, diffSessionId);
            return;
        }

        if (!isMobile && diffDirectory) {
            openContextPanelTab(hostScope?.key ?? diffDirectory, {
                mode: 'diff',
                dedupeKey: `turn-diff:${diffSessionId || 'session'}:${targetTurnMessageId}`,
                targetPath: null,
                diffScope: 'turn',
                diffTurnMessageId: targetTurnMessageId,
                diffSessionId,
            });
            return;
        }

        const firstFile = resolvedFiles[0]?.file;
        if (firstFile && isMobile && isLatestTurn && diffDirectory) {
            openTurnChangedFilePreview({
                scope: hostScope,
                directory: diffDirectory,
                filePath: firstFile,
                turnMessageId: targetTurnMessageId,
                sessionId: diffSessionId,
                mobile: true,
            });
        }
    });

    const handleRevert = useEvent(async () => {
        if (!diffSessionId || !targetTurnMessageId || revertInFlightRef.current) return;
        revertInFlightRef.current = true;
        setIsReverting(true);
        try {
            if (sessionSurface.onRevertMessage) {
                await sessionSurface.onRevertMessage(targetTurnMessageId);
            } else {
                await revertToMessage(diffSessionId, targetTurnMessageId, {
                    directory: sessionSurface.directory ?? undefined,
                });
            }
        } catch (error) {
            if (sessionSurface.onRevertMessage) {
                toast.error(t('chat.revert.toast.failed'), {
                    id: 'session-revert-error',
                    description: error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error),
                });
            }
        } finally {
            revertInFlightRef.current = false;
            setIsReverting(false);
        }
    });

    const handleRetry = useEvent(() => {
        void turnDiffQuery.refetch();
    });

    const handleToggleExpanded = useEvent(() => {
        setIsExpanded((previous) => !previous);
        onContentChange?.('structural');
    });

    // When a steered/multi-step v2 turn resolves to zero net diff (e.g. changes were reverted),
    // hide the card instead of rendering an empty box.
    if (isV2TurnDiff && turnDiffQuery.isSuccess && resolvedFiles.length === 0) {
        return null;
    }

    const displayFileCount = resolvedFiles.length > 0 ? resolvedFiles.length : fileCount;
    if (displayFileCount <= 0) {
        return null;
    }

    const visibleFiles = isExpanded
        ? resolvedFiles
        : resolvedFiles.slice(0, TURN_CHANGES_CARD_VISIBLE_LIMIT);
    const hiddenCount = Math.max(0, resolvedFiles.length - TURN_CHANGES_CARD_VISIBLE_LIMIT);
    const canOpen = Boolean(mobileActions || (!isMobile && diffDirectory) || (isMobile && isLatestTurn));
    const canRevert = sessionSurfaceActions.revert && Boolean(diffSessionId) && Boolean(targetTurnMessageId);

    const editedTitle = displayFileCount === 1
        ? t('chat.changedFiles.editedFilesSingle', { count: displayFileCount })
        : t('chat.changedFiles.editedFilesPlural', { count: displayFileCount });

    const showMoreLabel = hiddenCount === 1
        ? t('chat.changedFiles.actions.showMoreSingle', { count: hiddenCount })
        : t('chat.changedFiles.actions.showMorePlural', { count: hiddenCount });

    return (
        <section
            className={cn(
                'flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-xl)] bg-[color-mix(in_srgb,var(--surface-foreground)_5.5%,var(--surface-background))] text-foreground',
                isMobile ? 'mt-2.5' : 'mt-3',
            )}
            data-turn-changes-preview="true"
            data-message-action-group="true"
            aria-labelledby={`turn-changes-${turnId}`}
        >
            <div
                className={cn(
                    'flex min-w-0 items-center justify-between gap-2.5',
                    isMobile ? 'px-3 py-2' : 'px-3.5 py-2.5',
                )}
            >
                <div className="flex min-w-0 items-center gap-2.5">
                    <div
                        aria-hidden="true"
                        className={cn(
                            'flex shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-interactive-hover text-foreground/85',
                            isMobile ? 'size-7' : 'size-8',
                        )}
                    >
                        <Icon name="file-edit" className={isMobile ? 'size-3.5' : 'size-4'} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <span
                            id={`turn-changes-${turnId}`}
                            className={cn(
                                'truncate font-medium leading-snug text-foreground',
                                isMobile ? 'text-xs' : 'text-[13px]',
                            )}
                        >
                            {editedTitle}
                        </span>
                        <div className="flex min-h-[14px] items-center gap-1.5 text-xs font-medium leading-none tabular-nums">
                            {totals ? (
                                <>
                                    <span style={{ color: 'var(--status-success)' }}>+{totals.additions}</span>
                                    <span style={{ color: 'var(--status-error)' }}>-{totals.deletions}</span>
                                </>
                            ) : isV2TurnDiff && turnDiffQuery.isError ? (
                                <button
                                    type="button"
                                    data-turn-changes-retry="true"
                                    onClick={handleRetry}
                                    className="text-[var(--surface-muted-foreground)] underline-offset-2 hover:text-foreground hover:underline"
                                >
                                    {t('chat.changedFiles.actions.retryDiff')}
                                </button>
                            ) : (
                                <span aria-hidden="true" className="text-[var(--surface-muted-foreground)] opacity-50">···</span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                    {canRevert ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={isReverting}
                            aria-busy={isReverting}
                            data-turn-changes-revert="true"
                            onClick={() => {
                                void handleRevert();
                            }}
                            className="h-7 gap-1 px-2.5 text-xs text-[var(--surface-muted-foreground)] hover:text-foreground"
                        >
                            <span>{t('chat.changedFiles.actions.revert')}</span>
                            <Icon
                                name={isReverting ? 'loader-4' : 'undo-2'}
                                className={cn('size-3.5', isReverting && 'animate-spin')}
                            />
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        disabled={!canOpen}
                        data-turn-changes-view="true"
                        onClick={openCompleteTurnDiff}
                        className="h-7 px-3 text-xs"
                    >
                        {t('chat.changedFiles.actions.viewChanges')}
                    </Button>
                </div>
            </div>

            {visibleFiles.length > 0 ? (
                <div
                    className={cn(
                        'mx-1.5 flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--surface-foreground)_2%,var(--surface-background))] p-1',
                        hiddenCount === 0 && 'mb-1.5',
                    )}
                >
                    {visibleFiles.map((file) => (
                        <TurnChangesCardFileButton
                            key={file.file}
                            file={file}
                            canOpen={canOpen}
                            isMobile={isMobile}
                            onOpen={openTurnFile}
                        />
                    ))}
                </div>
            ) : null}

            {hiddenCount > 0 ? (
                <div className="px-1.5 py-1">
                    <button
                        type="button"
                        data-turn-changes-toggle="true"
                        aria-expanded={isExpanded}
                        onClick={handleToggleExpanded}
                        className="flex w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-xs font-medium text-[var(--surface-muted-foreground)] transition-colors hover:bg-interactive-hover hover:text-foreground active:bg-interactive-active focus-visible:bg-interactive-hover focus-visible:outline-none"
                    >
                        <span>{isExpanded ? t('chat.changedFiles.actions.showLess') : showMoreLabel}</span>
                        <Icon name={isExpanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
                    </button>
                </div>
            ) : null}
        </section>
    );
});

TurnChangesCard.displayName = 'TurnChangesCard';

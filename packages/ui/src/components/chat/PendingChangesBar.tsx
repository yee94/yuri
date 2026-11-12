import React from 'react';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { useGitStore, useIsGitRepo } from '@/lib/api/useProjectGitStore';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import {
    type ChangedFileEntry,
    type GitChangedFile,
    extractGitChangedFiles,
    isGitFile,
    summarizeGitChangedFiles,
} from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';
import {
    statusBarComposerPopoverStyle,
    statusBarTriggerClassName,
    statusBarTriggerIconClassName,
    statusBarTriggerLabelClassName,
    statusBarTriggerMetaClassName,
} from './statusBarPopover';
import { useI18n } from '@/lib/i18n';

interface PendingChangesBarProps {
    isExpanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
}

export const PendingChangesBar: React.FC<PendingChangesBarProps> = React.memo(({ isExpanded, onExpandedChange }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const currentDirectory = useEffectiveDirectory() ?? null;
    const runtime = React.useContext(RuntimeAPIContext);
    const hostRuntime = useHostRuntime();
    const hostScope = hostRuntime?.entry.location.hostId ? hostRuntime.entry : undefined;
    const projectGit = React.useMemo(() => hostScope ? createProjectGitAPI(hostScope) : runtime?.git, [hostScope, runtime?.git]);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const fetchStatus = useGitStore((s) => s.fetchStatus);
    const mobileActions = useMobileAppActions();

    const hasChanges = Boolean(currentDirectory && isGitRepo === true && gitStatus && !gitStatus.isClean);

    // 折叠态只做单趟计数；逐文件列表（含绝对路径）仅在展开时构造。
    const summary = React.useMemo(() => {
        if (!hasChanges || !gitStatus) return { count: 0, insertions: 0, deletions: 0 };
        return summarizeGitChangedFiles(gitStatus.files, gitStatus.diffStats);
    }, [hasChanges, gitStatus]);

    const gitChangedFiles = React.useMemo<GitChangedFile[]>(() => {
        if (!isExpanded || !hasChanges || !gitStatus || !currentDirectory) return [];
        return extractGitChangedFiles(gitStatus.files, gitStatus.diffStats, currentDirectory);
    }, [isExpanded, hasChanges, gitStatus, currentDirectory]);

    const totalAdded = summary.insertions;
    const totalRemoved = summary.deletions;

    if (!currentDirectory || isGitRepo !== true) return null;
    if (summary.count === 0) return null;

    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;
        if (!isGitFile(file)) return;

        onExpandedChange(false);

        const absolutePath = file.path;

        // Dedicated mobile root: open the per-file diff inside the mobile Changes surface.
        if (mobileActions) {
            mobileActions.openChanges({
                diffPath: file.relativePath,
                staged: file.hasStagedChanges && !file.hasWorkingChanges,
            });
            return;
        }

        const editor = runtime?.editor;
        if (!hostScope && editor) {
            void editor.openFile(absolutePath);
            return;
        }

        const store = useUIStore.getState();
        const openStagedDiff = file.hasStagedChanges && !file.hasWorkingChanges;
        if (!store.isMobile) {
            store.openContextDiff(hostScope?.key ?? currentDirectory, file.relativePath, openStagedDiff);
            return;
        }
        store.navigateToDiff(file.relativePath, openStagedDiff);
        store.setRightSidebarOpen(false);
    };

    const fileCount = summary.count;
    const labelHead = fileCount === 1
        ? t('chat.pendingChanges.fileCountSingle', { count: fileCount })
        : t('chat.pendingChanges.fileCountPlural', { count: fileCount });

    // Same background refresh as opening the changes/diff view: external commits
    // often land without a local mutation hint, so expand must re-fetch. Keep the
    // current summary on screen; do not flip the status loading flag.
    const handleToggleExpanded = () => {
        const nextExpanded = !isExpanded;
        onExpandedChange(nextExpanded);
        if (!nextExpanded || !currentDirectory || !projectGit) return;
        void fetchStatus(currentDirectory, projectGit, { silent: true });
    };

    return (
        <div className={isMobile ? "contents" : "relative"}>
            <button
                type="button"
                className={cn(statusBarTriggerClassName, 'yuri-pending-changes-trigger max-w-full text-left')}
                onClick={handleToggleExpanded}
                aria-expanded={isExpanded}
            >
                <Icon name="file-edit" className={statusBarTriggerIconClassName} />
                <span className={cn(statusBarTriggerLabelClassName, 'shrink-0')}>{labelHead}</span>
                <span className={cn('status-row__changed-label', statusBarTriggerLabelClassName)}>
                    {t('chat.pendingChanges.changedInWorkspace')}
                </span>
                <span className={cn(statusBarTriggerMetaClassName, 'items-baseline gap-0.5')}>
                    {totalAdded > 0 ? <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span> : null}
                    {totalRemoved > 0 ? <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span> : null}
                </span>
                {isExpanded ? (
                    <Icon name="arrow-up-s" className={statusBarTriggerIconClassName} />
                ) : (
                    <Icon name="arrow-down-s" className={statusBarTriggerIconClassName} />
                )}
            </button>
            {isExpanded && (
                <div
                    style={isMobile ? statusBarComposerPopoverStyle : changedFilesPopoverStyle}
                    className={cn(
                        changedFilesPopoverClassName,
                        "absolute left-0 bottom-full mb-1 z-50",
                        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                        "duration-150"
                    )}
                >
                    <ChangedFilesList
                        files={gitChangedFiles}
                        currentDirectory={currentDirectory}
                        onOpenFile={handleOpenFile}
                    />
                </div>
            )}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';

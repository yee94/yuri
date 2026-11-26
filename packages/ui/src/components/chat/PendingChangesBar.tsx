import React from 'react';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { useGitStore, useWorkspaceGitSummary } from '@/lib/api/useProjectGitStore';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useEffectiveDirectory, useEffectiveWorkspaceDirectories } from '@/hooks/useEffectiveDirectory';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { buildWorkspaceRepoLabels, prefixWorkspaceFilePath } from './lib/turns/workspaceTurnChanges';
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
    const workspaceDirectories = useEffectiveWorkspaceDirectories();
    const runtime = React.useContext(RuntimeAPIContext);
    const hostRuntime = useHostRuntime();
    const hostScope = hostRuntime?.entry.location.hostId ? hostRuntime.entry : undefined;
    const projectGit = React.useMemo(() => hostScope ? createProjectGitAPI(hostScope) : runtime?.git, [hostScope, runtime?.git]);
    const isMultiPath = workspaceDirectories.length > 1;
    const singleDirStatus = useGitStore((s) =>
        !isMultiPath && currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const singleDirIsRepo = useGitStore((s) =>
        !isMultiPath && currentDirectory ? s.directories.get(currentDirectory)?.isGitRepo ?? null : null,
    );
    const workspaceSummary = useWorkspaceGitSummary(isMultiPath ? workspaceDirectories : []);
    const fetchStatus = useGitStore((s) => s.fetchStatus);
    const ensureStatus = useGitStore((s) => s.ensureStatus);
    const mobileActions = useMobileAppActions();

    React.useEffect(() => {
        if (!isMultiPath || !projectGit) return;
        for (const dir of workspaceDirectories) {
            void ensureStatus(dir, projectGit);
        }
    }, [ensureStatus, isMultiPath, projectGit, workspaceDirectories]);

    const hasChanges = isMultiPath
        ? workspaceSummary.isAnyGitRepo && workspaceSummary.hasChanges
        : Boolean(currentDirectory && singleDirIsRepo === true && singleDirStatus && !singleDirStatus.isClean);

    // 折叠态只做单趟计数；逐文件列表（含绝对路径）仅在展开时构造。
    const summary = React.useMemo(() => {
        if (!hasChanges) return { count: 0, insertions: 0, deletions: 0 };
        if (isMultiPath) {
            let count = 0;
            let insertions = 0;
            let deletions = 0;
            for (const entry of workspaceSummary.gitEntries) {
                if (!entry.status || entry.status.isClean) continue;
                const item = summarizeGitChangedFiles(entry.status.files, entry.status.diffStats);
                count += item.count;
                insertions += item.insertions;
                deletions += item.deletions;
            }
            return { count, insertions, deletions };
        }
        if (!singleDirStatus) return { count: 0, insertions: 0, deletions: 0 };
        return summarizeGitChangedFiles(singleDirStatus.files, singleDirStatus.diffStats);
    }, [hasChanges, isMultiPath, singleDirStatus, workspaceSummary.gitEntries]);

    const { gitChangedFiles, fileTargetMap } = React.useMemo(() => {
        const targetMap = new Map<string, { directory: string; relativePath: string; prefixedPath: string }>();
        if (!isExpanded || !hasChanges) return { gitChangedFiles: [] as GitChangedFile[], fileTargetMap: targetMap };
        if (isMultiPath) {
            const repoLabels = buildWorkspaceRepoLabels(workspaceDirectories);
            const merged: GitChangedFile[] = [];
            for (const entry of workspaceSummary.gitEntries) {
                if (!entry.status || entry.status.isClean) continue;
                const files = extractGitChangedFiles(entry.status.files, entry.status.diffStats, entry.directory);
                for (const file of files) {
                    const prefixedPath = prefixWorkspaceFilePath(file.relativePath, entry.directory, repoLabels);
                    const prefixed = {
                        ...file,
                        relativePath: prefixedPath,
                    };
                    targetMap.set(prefixed.path, {
                        directory: entry.directory,
                        relativePath: file.relativePath,
                        prefixedPath,
                    });
                    merged.push(prefixed);
                }
            }
            return { gitChangedFiles: merged, fileTargetMap: targetMap };
        }
        if (!singleDirStatus || !currentDirectory) return { gitChangedFiles: [] as GitChangedFile[], fileTargetMap: targetMap };
        return {
            gitChangedFiles: extractGitChangedFiles(singleDirStatus.files, singleDirStatus.diffStats, currentDirectory),
            fileTargetMap: targetMap,
        };
    }, [isExpanded, hasChanges, isMultiPath, singleDirStatus, currentDirectory, workspaceDirectories, workspaceSummary.gitEntries]);

    const totalAdded = summary.insertions;
    const totalRemoved = summary.deletions;

    if (!isMultiPath && (!currentDirectory || singleDirIsRepo !== true)) return null;
    if (isMultiPath && !workspaceSummary.isAnyGitRepo) return null;
    if (summary.count === 0) return null;

    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;
        if (!isGitFile(file)) return;

        onExpandedChange(false);

        const absolutePath = file.path;
        const target = fileTargetMap.get(absolutePath);
        const targetDirectory = target?.directory ?? currentDirectory;
        const targetRelativePath = target?.relativePath ?? file.relativePath;
        const targetDiffPath = isMultiPath ? (target?.prefixedPath ?? file.relativePath) : targetRelativePath;

        // Dedicated mobile root: open the per-file diff inside the mobile Changes surface.
        if (mobileActions) {
            mobileActions.openChanges({
                diffPath: targetRelativePath,
                staged: file.hasStagedChanges && !file.hasWorkingChanges,
                ...(isMultiPath ? { directory: targetDirectory } : {}),
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
            store.openContextDiff(hostScope?.key ?? currentDirectory, targetDiffPath, openStagedDiff);
            return;
        }
        store.navigateToDiff(targetDiffPath, openStagedDiff);
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
        if (!nextExpanded || !projectGit) return;
        if (isMultiPath) {
            for (const dir of workspaceDirectories) {
                void fetchStatus(dir, projectGit, { silent: true });
            }
            return;
        }
        if (!currentDirectory) return;
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
                        currentDirectory={currentDirectory ?? workspaceDirectories[0] ?? ''}
                        onOpenFile={handleOpenFile}
                    />
                </div>
            )}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';

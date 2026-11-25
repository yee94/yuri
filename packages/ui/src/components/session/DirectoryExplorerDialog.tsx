import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { canManageDesktopHosts, isDesktopLocalOriginActive } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { DirectoryExplorerSurface, DirectoryMachineActions, DirectoryMachineList } from './DirectoryExplorerViews';
import { Icon } from "@/components/icon/Icon";
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import { partitionByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { resolveDirectoryExplorerMobileLayout } from './directoryExplorerLayout';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Kbd } from '@/components/ui/kbd';
import { getHostRuntimeRegistry, supportsRemoteProjects, useRemoteHostCatalog } from '@/queries/remoteProjectQueries';
import { RemoteDirectoryExplorerDialog } from './RemoteDirectoryExplorerDialog';
import { useDirectoryMachineModel } from './useDirectoryMachineModel';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { HostLocation } from '@/lib/remote-projects/location';
import type { ProjectEntry } from '@/lib/api/types';
import { getWorkspacePaths, normalizeWorkspacePath } from '@/lib/workspacePaths';
import './directory-explorer-dialog.css';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: { x: number; y: number };
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
  onRemoteProjectAdded?: (project: RemoteProject, location: HostLocation) => void | Promise<void>;
  editProject?: Pick<ProjectEntry, 'id' | 'path' | 'paths'>;
}

type BrowseEntry = {
  name: string;
  path: string;
};

type BrowseRow =
  | { type: 'up'; value: 'browse:up'; name: string; path: string | null; disabled?: false }
  | { type: 'directory'; value: string; name: string; path: string; alreadyAdded: boolean };

const isRootPath = (value: string): boolean => value === '/';

const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');

const trimTrailingSeparators = (value: string): string => {
  if (!value || isRootPath(value)) return value;
  let result = value;
  while (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
};

const hasTrailingPathSeparator = (value: string): boolean => value.endsWith('/');

const ensureBrowseDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || hasTrailingPathSeparator(trimmed)) return trimmed;
  return `${trimmed}/`;
};

const getLastPathSeparatorIndex = (value: string): number => value.lastIndexOf('/');

const getBrowseDirectoryPath = (value: string): string => {
  if (hasTrailingPathSeparator(value)) return value;
  const lastSeparator = getLastPathSeparatorIndex(value);
  if (lastSeparator < 0) return value;
  return value.slice(0, lastSeparator + 1);
};

const getBrowseLeafPathSegment = (value: string): string => {
  const lastSeparator = getLastPathSeparatorIndex(value);
  return value.slice(lastSeparator + 1);
};

const getBrowseParentPath = (value: string): string | null => {
  const trimmed = trimTrailingSeparators(value.trim());
  if (!trimmed || trimmed === '~' || trimmed === '~/' || trimmed === '/') return null;
  const lastSeparator = getLastPathSeparatorIndex(trimmed);
  if (lastSeparator < 0) return null;
  if (trimmed.startsWith('~/') && lastSeparator <= 1) return '~/';
  if (lastSeparator === 0) return '/';
  return `${trimmed.slice(0, lastSeparator)}/`;
};

const canNavigateUp = (value: string): boolean => hasTrailingPathSeparator(value) && getBrowseParentPath(value) !== null;

const appendBrowsePathSegment = (currentPath: string, segment: string): string => (
  `${getBrowseDirectoryPath(currentPath)}${segment}/`
);

const normalizeDirectoryPath = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const normalized = trimTrailingSeparators(normalizeSeparators(path.trim()));
  if (!normalized) return null;
  return normalized.toLowerCase();
};

const displayPathToAbsolutePath = (value: string, homeDirectory: string): string => {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/')) return `${homeDirectory}${trimmed.slice(1)}`;
  return trimmed;
};

const isPrimaryModifierPressed = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const focusPathInput = (input: HTMLInputElement | null): void => {
  if (!input) return;
  input.focus({ preventScroll: true });
  const valueLength = input.value.length;
  input.setSelectionRange(valueLength, valueLength);
  input.scrollLeft = input.scrollWidth;
};

const resolveFreshFilesystemHome = async (): Promise<string | null> => {
  try {
    const response = await runtimeFetch('/api/fs/home', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const data = await response.json() as { home?: unknown };
      if (typeof data.home === 'string' && data.home.trim().length > 0) {
        return normalizeSeparators(data.home.trim());
      }
    }
  } catch {
    // Fall back to the client helper below.
  }

  return opencodeClient.getFilesystemHome().catch(() => null);
};

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = (props) => props.editProject
  ? <LocalDirectoryExplorerDialog key={props.editProject.id} {...props} machinePicker={null} />
  : <AddDirectoryExplorerDialog {...props} />;

const AddDirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = (props) => {
  const { t } = useI18n();
  const device = useDeviceInfo();
  const isMobile = resolveDirectoryExplorerMobileLayout(props.forceMobile, device.isMobile);
  const catalog = useRemoteHostCatalog(props.open, true);
  const registry = React.useMemo(() => catalog.data?.supported ? getHostRuntimeRegistry(catalog.data) : null, [catalog.data]);
  const machine = useDirectoryMachineModel(props.open, registry, props.onOpenChange);
  const { hostId, step } = machine;
  const openSshSettings = useEvent(() => {
    machine.changeOpen(false);
    const ui = useUIStore.getState();
    ui.setSettingsRemoteInstancesSelectedId('new');
    ui.setSettingsPage('remote-instances');
    ui.setSettingsDialogOpen(true);
  });
  const selectableHosts = catalog.data?.hosts.filter((host) => host.available !== false) ?? [];
  const selectedHost = selectableHosts.find((host) => host.id === hostId);
  const hasMachines = supportsRemoteProjects() && catalog.data?.supported && selectableHosts.length > 0;
  const showMachines = hasMachines && step === 'machine';
  if (supportsRemoteProjects() && catalog.isPending && !catalog.data) {
    return <DirectoryExplorerSurface open={props.open} onOpenChange={machine.changeOpen} origin={props.origin} mobile={isMobile} footer={null}>
      <p role="status" className="yuri-directory-empty text-muted-foreground">{t('common.loading')}</p>
    </DirectoryExplorerSurface>;
  }
  const steps = <div className="yuri-directory-step flex shrink-0 items-center gap-2 whitespace-nowrap py-2 text-muted-foreground">
    <span className={showMachines ? 'text-foreground' : undefined}>{t('remoteProjects.machine')}</span>
    <Icon name="arrow-right-s" className="size-3 shrink-0" />
    <span className={!showMachines ? 'text-foreground' : undefined}>{t('directoryExplorerDialog.browse.directories')}</span>
  </div>;
  if (showMachines) {
    const canContinue = !machine.pending && (!hostId || Boolean(registry && selectedHost
      && selectedHost.state !== 'unauthorized' && selectedHost.state !== 'incompatible'));
    const footer = <DirectoryMachineActions pending={machine.pending} failed={Boolean(machine.error)} canContinue={canContinue}
      onNext={machine.next} onAddSsh={openSshSettings} />;
    return <DirectoryExplorerSurface open={props.open} onOpenChange={machine.changeOpen} origin={props.origin} mobile={isMobile} footer={footer} error={catalog.error?.message}>
      <DirectoryMachineList hosts={selectableHosts} selectedId={hostId} onSelect={machine.selectHost} pending={catalog.isPending}
        error={machine.error} steps={steps} canContinue={canContinue} onNext={machine.next} />
    </DirectoryExplorerSurface>;
  }
  const machinePicker = hasMachines ? <div className="flex min-w-0 items-center gap-2 py-1">
    <Button variant="ghost" size="xs" className="-ml-1.5 shrink-0 gap-1 text-muted-foreground" onClick={machine.back} aria-label={t('header.actions.backAria')}>
      <Icon name="arrow-left-s" className="size-4" />
      {t('remoteProjects.machine')}
    </Button>
    <Icon name="arrow-right-s" className="size-3 shrink-0 text-muted-foreground" />
    <span className="yuri-directory-name min-w-0 truncate text-muted-foreground">{hostId ? selectedHost?.name ?? hostId : t('remoteProjects.local')}</span>
  </div> : null;
  if (hostId && registry) return <RemoteDirectoryExplorerDialog key={`${registry.hubId}:${hostId}`} {...props} registry={registry} hostId={hostId} machinePicker={machinePicker} onRegistered={async (project) => {
    registry.assertCurrent();
    await props.onRemoteProjectAdded?.(project, { hubId: registry.hubId, hostId, directory: project.path });
    registry.assertCurrent();
    await catalog.refetch();
  }} />;
  return <LocalDirectoryExplorerDialog {...props} machinePicker={machinePicker} discoveryError={catalog.error?.message}
    onAddSsh={canManageDesktopHosts() ? openSshSettings : undefined} />;
};

const LocalDirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps & { machinePicker: React.ReactNode; discoveryError?: string; onAddSsh?: () => void }> = ({
  open,
  onOpenChange,
  forceMobile,
  origin,
  machinePicker,
  discoveryError,
  onAddSsh,
  editProject,
}) => {
  const { t } = useI18n();
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const projects = useProjectsStore((s) => s.projects);
  const addProject = useProjectsStore((s) => s.addProject);
  const createWorkspace = useProjectsStore((s) => s.createWorkspace);
  const updateWorkspacePaths = useProjectsStore((s) => s.updateWorkspacePaths);
  const gitIdentityProfiles = useGitIdentitiesStore((s) => s.profiles);
  const globalGitIdentity = useGitIdentitiesStore((s) => s.globalIdentity);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadGitIdentityProfiles = useGitIdentitiesStore((s) => s.loadProfiles);
  const loadGlobalGitIdentity = useGitIdentitiesStore((s) => s.loadGlobalIdentity);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);
  const { isDesktop, requestAccess, startAccessing } = useFileSystemAccess();
  const isEditingWorkspace = Boolean(editProject);
  const deviceInfo = useDeviceInfo();
  const isMobile = resolveDirectoryExplorerMobileLayout(forceMobile, deviceInfo.isMobile);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const workspaceNameInputRef = React.useRef<HTMLInputElement>(null);
  const workspaceNameId = React.useId();
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const [dialogHomeDirectory, setDialogHomeDirectory] = React.useState('');
  const [query, setQuery] = React.useState('~/');
  const [entries, setEntries] = React.useState<BrowseEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isBrowseDirectoryMissing, setIsBrowseDirectoryMissing] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isOpeningFinder, setIsOpeningFinder] = React.useState(false);
  const [isCloneMode, setIsCloneMode] = React.useState(false);
  const [addingMultipleProjects, setAddingMultipleProjects] = React.useState(false);
  const isWorkspaceMode = isEditingWorkspace || addingMultipleProjects;
  const [workspaceName, setWorkspaceName] = React.useState('');
  const [workspaceNameError, setWorkspaceNameError] = React.useState(false);
  const [stagedWorkspacePaths, setStagedWorkspacePaths] = React.useState<string[]>([]);
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');
  const [selectedGitIdentityId, setSelectedGitIdentityId] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);
  const isSavingWorkspace = React.useRef(false);

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  const addedProjectPaths = React.useMemo(() => new Set(
    projects
      .filter((project) => !project.hostId)
      .map((project) => normalizeDirectoryPath(project.path))
      .filter((path): path is string => Boolean(path))
  ), [projects]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('~/');
    setEntries([]);
    setHighlightedIndex(0);
    setIsConfirming(false);
    setIsOpeningFinder(false);
    setIsCloneMode(false);
    setAddingMultipleProjects(false);
    setWorkspaceName('');
    setWorkspaceNameError(false);
    setStagedWorkspacePaths(editProject ? getWorkspacePaths(editProject) : []);
    setCloneRemoteUrl('');
    setSelectedGitIdentityId(null);
    setShowHidden(false);
    let cancelled = false;
    const focusDirectory = () => {
      if (!cancelled && workspaceNameInputRef.current !== document.activeElement) {
        focusPathInput(inputRef.current);
      }
    };

    requestAnimationFrame(focusDirectory);
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
      requestAnimationFrame(focusDirectory);
    };
    void resolveHome();
    return () => {
      cancelled = true;
    };
  // Seed staged changes only when opening the picker, not on settings refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (open && isWorkspaceMode && !isMobile) {
      workspaceNameInputRef.current?.focus({ preventScroll: true });
    }
  }, [open, isWorkspaceMode, isMobile]);

  React.useEffect(() => {
    if (!open || isEditingWorkspace) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
    void loadDefaultGitIdentityId();
  }, [isEditingWorkspace, loadDefaultGitIdentityId, loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

  const availableGitIdentities = React.useMemo(() => {
    const unique = new Map<string, NonNullable<typeof globalGitIdentity>>();
    if (globalGitIdentity) {
      unique.set(globalGitIdentity.id, globalGitIdentity);
    }
    for (const profile of gitIdentityProfiles) {
      unique.set(profile.id, profile);
    }
    return Array.from(unique.values());
  }, [gitIdentityProfiles, globalGitIdentity]);

  React.useEffect(() => {
    if (!open || !isCloneMode || selectedGitIdentityId !== null) return;
    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (defaultId && availableGitIdentities.some((identity) => identity.id === defaultId)) {
      setSelectedGitIdentityId(defaultId);
      return;
    }
    const firstSshIdentity = availableGitIdentities.find((identity) => identity.authType === 'ssh' || identity.sshKey);
    if (firstSshIdentity) {
      setSelectedGitIdentityId(firstSshIdentity.id);
    }
  }, [availableGitIdentities, defaultGitIdentityId, isCloneMode, open, selectedGitIdentityId]);

  const selectedGitIdentity = React.useMemo(
    () => availableGitIdentities.find((identity) => identity.id === selectedGitIdentityId) ?? null,
    [availableGitIdentities, selectedGitIdentityId]
  );

  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(query), [query]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(query) ? '' : getBrowseLeafPathSegment(query)),
    [query]
  );
  const browseDirectoryAbsolutePath = React.useMemo(
    () => explorerRootDirectory ? displayPathToAbsolutePath(browseDirectoryDisplayPath, explorerRootDirectory) : '',
    [browseDirectoryDisplayPath, explorerRootDirectory]
  );

  React.useEffect(() => {
    if (!open || !browseDirectoryAbsolutePath) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setIsBrowseDirectoryMissing(false);
    opencodeClient.listLocalDirectory(browseDirectoryAbsolutePath)
      .then((result) => {
        if (cancelled) return;
        setIsBrowseDirectoryMissing(false);
        const nextEntries = result
          .filter((entry) => entry.isDirectory)
          .map((entry) => ({
            name: entry.name,
            path: normalizeSeparators(entry.path),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        setEntries(nextEntries);
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setIsBrowseDirectoryMissing(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browseDirectoryAbsolutePath, open]);

  const filteredEntries = React.useMemo(() => {
    const includeHidden = showHidden || browseFilterQuery.startsWith('.');
    const visible = entries.filter((entry) => includeHidden || !entry.name.startsWith('.'));
    return partitionByFuzzyQuery(visible, browseFilterQuery, (entry) => entry.name).matching;
  }, [browseFilterQuery, entries, showHidden]);

  const rows = React.useMemo<BrowseRow[]>(() => {
    const nextRows: BrowseRow[] = [];
    if (canNavigateUp(query)) {
      nextRows.push({ type: 'up', value: 'browse:up', name: '..', path: getBrowseParentPath(query) });
    }
    for (const entry of filteredEntries) {
      const normalized = normalizeDirectoryPath(entry.path);
      nextRows.push({
        type: 'directory',
        value: `browse:${entry.path}`,
        name: entry.name,
        path: entry.path,
        alreadyAdded: Boolean(normalized && addedProjectPaths.has(normalized)),
      });
    }
    return nextRows;
  }, [addedProjectPaths, filteredEntries, query]);

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [query, rows.length]);

  const targetPath = React.useMemo(() => {
    if (!explorerRootDirectory) return '';
    return trimTrailingSeparators(displayPathToAbsolutePath(query, explorerRootDirectory));
  }, [explorerRootDirectory, query]);
  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  const isAlreadyAdded = Boolean(normalizedTargetPath && addedProjectPaths.has(normalizedTargetPath));
  const exactEntry = React.useMemo(() => {
    if (!browseFilterQuery) return null;
    return filteredEntries.find((entry) => entry.name === browseFilterQuery) ?? null;
  }, [browseFilterQuery, filteredEntries]);
  const shouldCreateTarget = Boolean(
    targetPath
    && !isAlreadyAdded
    && (
      (hasTrailingPathSeparator(query) && isBrowseDirectoryMissing)
      || (!hasTrailingPathSeparator(query) && browseFilterQuery.trim().length > 0 && exactEntry === null)
    )
  );
  const canAddProject = !isConfirming && !isOpeningFinder && !isAlreadyAdded && Boolean(targetPath);
  const canSubmitClone = canAddProject && cloneRemoteUrl.trim().length > 0;
  const stagedWorkspacePathKeys = React.useMemo(
    () => new Set(
      stagedWorkspacePaths
        .map(normalizeWorkspacePath)
        .filter(Boolean),
    ),
    [stagedWorkspacePaths],
  );
  const toggleStagedWorkspacePath = useEvent((candidatePath: string) => {
    const cleaned = normalizeWorkspacePath(candidatePath);
    if (!cleaned) return;
    setStagedWorkspacePaths((prev) => (
      prev.includes(cleaned)
        ? prev.filter((item) => item !== cleaned)
        : [...prev, cleaned]
    ));
  });
  const handleSaveWorkspace = useEvent(async () => {
    if (isConfirming || isOpeningFinder || isSavingWorkspace.current) return;
    const label = workspaceName.trim();
    if (!editProject && !label) {
      setWorkspaceNameError(true);
      workspaceNameInputRef.current?.focus({ preventScroll: true });
      return;
    }
    setWorkspaceNameError(false);
    isSavingWorkspace.current = true;
    setIsConfirming(true);
    try {
      if (editProject) {
        const result = await updateWorkspacePaths(editProject.id, { paths: stagedWorkspacePaths });
        if (!result.ok) {
          toast.error(result.error || t('workspace.paths.toast.updateFailed'));
          return;
        }
        onOpenChange(false);
        return;
      }
      const result = await createWorkspace({
        paths: stagedWorkspacePaths,
        label,
        activate: true,
      });
      if (!result.ok || !result.project) {
        toast.error(result.error || t('directoryExplorerDialog.toast.failedToAddProject'));
        return;
      }
      openNewSessionForAddedProject(result.project);
      handleClose();
    } finally {
      isSavingWorkspace.current = false;
      setIsConfirming(false);
    }
  });
  const highlightedRow = rows[highlightedIndex] ?? null;
  const hasHighlightedBrowseItem = Boolean(
    highlightedRow
  );
  const isMacShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const submitActionLabel = isAlreadyAdded
    ? t('directoryExplorerDialog.actions.alreadyAdded')
    : isCloneMode
      ? isConfirming
        ? t('directoryExplorerDialog.actions.cloning')
        : t('directoryExplorerDialog.actions.cloneAndAdd')
    : isConfirming
      ? t('directoryExplorerDialog.actions.adding')
    : shouldCreateTarget
      ? t('directoryExplorerDialog.actions.createAndAdd')
      : t('directoryExplorerDialog.actions.addProject');

  React.useLayoutEffect(() => {
    if (!open) return;
    focusPathInput(inputRef.current);
  }, [open]);

  React.useLayoutEffect(() => {
    const row = rows[highlightedIndex];
    if (!row) return;
    rowRefs.current.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, rows]);

  const handleClose = useEvent(() => {
    onOpenChange(false);
  });

  const selectAddedProjectForDraft = useEvent((project: { id: string; path: string }) => {
    const sessionUiState = useSessionUIStore.getState();
    if (!sessionUiState.newSessionDraft?.open) return;
    sessionUiState.setNewSessionDraftTarget({
      projectId: project.id,
      directoryOverride: project.path,
    }, { force: true });
  });

  const openNewSessionForAddedProject = useEvent((project: { id: string; path: string }) => {
    const draftOptions = {
      selectedProjectId: project.id,
      directoryOverride: project.path,
      preserveDirectoryOverride: true,
    } as const;
    if (isMobile) {
      useMobileNavigationStore.getState().openDraft(draftOptions);
      return;
    }
    useSessionUIStore.getState().openNewSessionDraft(draftOptions);
  });

  const handleQuickAdd = useEvent((event: React.MouseEvent, path: string) => {
    event.stopPropagation();
    const normalized = normalizeDirectoryPath(path);
    if (normalized && addedProjectPaths.has(normalized)) return;
    const project = addProject(path);
    if (!project) {
      toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
        description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
      });
      return;
    }
    selectAddedProjectForDraft(project);
  });

  const finalizeSelection = useEvent(async (target: string) => {
    if (!target || isConfirming) return;
    const normalized = normalizeDirectoryPath(target);
    if (normalized && addedProjectPaths.has(normalized)) return;
    let selectedTarget = target;

    setIsConfirming(true);
    try {
      const shouldCreateSelection = !isCloneMode && shouldCreateTarget && normalizeDirectoryPath(target) === normalizeDirectoryPath(targetPath);
      if (isCloneMode) {
        const remoteUrl = cloneRemoteUrl.trim();
        if (!remoteUrl) {
          toast.error(t('directoryExplorerDialog.toast.cloneUrlRequired'));
          return;
        }
        const result = await opencodeClient.cloneRepository({
          remoteUrl,
          destinationPath: target,
          gitIdentityId: selectedGitIdentity?.id ?? null,
        });
        selectedTarget = result.path;
      } else if (shouldCreateSelection) {
        await opencodeClient.createDirectory(target);
      }
      const project = addProject(selectedTarget);
      if (!project) {
        toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
          description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
        });
        return;
      }
      openNewSessionForAddedProject(project);
      handleClose();
    } catch (error) {
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      setIsConfirming(false);
    }
  });

  const browseToDisplayPath = useEvent((displayPath: string) => {
    setQuery(ensureBrowseDirectoryPath(displayPath));
  });

  const browseToEntry = useEvent((entry: BrowseEntry) => {
    setQuery(appendBrowsePathSegment(query, entry.name));
  });

  const executeRow = useEvent((row: BrowseRow | null) => {
    if (!row) return;
    if (row.type === 'up') {
      if (row.path) browseToDisplayPath(row.path);
      return;
    }
    browseToEntry(row);
  });

  const handleOpenInFinder = useEvent(async () => {
    if (!isDesktop || isOpeningFinder || isSavingWorkspace.current) return;
    setIsOpeningFinder(true);
    try {
      const result = await requestAccess(targetPath);
      if (!result.success || !result.path) {
        if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
            description: result.error,
          });
        }
        return;
      }

      const accessResult = await startAccessing(result.path);
      if (!accessResult.success) {
        toast.error(t('directoryExplorerDialog.toast.failedToOpenDirectory'), {
          description: accessResult.error || t('directoryExplorerDialog.toast.desktopCouldNotGrantAccess'),
        });
        return;
      }

      if (editProject) {
        const path = normalizeWorkspacePath(result.path);
        if (path) setStagedWorkspacePaths((previous) => previous.includes(path) ? previous : [...previous, path]);
      } else {
        await finalizeSelection(result.path);
      }
    } catch (error) {
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      setIsOpeningFinder(false);
    }
  });

  const handleKeyDown = useEvent((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isPrimaryModifierPressed(event)) {
        if (isWorkspaceMode) {
          void handleSaveWorkspace();
        } else {
          void finalizeSelection(targetPath);
        }
        return;
      }
      if (hasHighlightedBrowseItem) {
        executeRow(highlightedRow);
      }
      return;
    }
    if (event.key === 'Backspace' && query === '') {
      event.preventDefault();
      if (!isSavingWorkspace.current && !isOpeningFinder) handleClose();
    }
  });

  const multipleProjectsToggle = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      role="checkbox"
      aria-checked={isWorkspaceMode}
      disabled={isConfirming || isOpeningFinder}
      onClick={() => {
        if (!isWorkspaceMode) setIsCloneMode(false);
        setWorkspaceNameError(false);
        setAddingMultipleProjects(!isWorkspaceMode);
      }}
      className={cn(
        'yuri-directory-hidden-toggle shrink-0',
        isWorkspaceMode ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon name={isWorkspaceMode ? 'checkbox' : 'checkbox-blank'} className="size-3.5" />
      {t('directoryExplorerDialog.toggle.multipleProjects')}
    </Button>
  );

  const showHiddenToggle = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-pressed={showHidden}
      onClick={() => setShowHidden((value) => !value)}
      className="yuri-directory-hidden-toggle shrink-0 text-muted-foreground"
    >
      <Icon name={showHidden ? 'checkbox' : 'checkbox-blank'} className="size-3.5" />
      {t('directoryExplorerDialog.toggle.showHidden')}
    </Button>
  );

  const inputSection = (
    <div className="yuri-directory-inputs">
      <fieldset disabled={isConfirming} className="min-w-0">{machinePicker}</fieldset>
      {isWorkspaceMode && !editProject ? (
        <div className="yuri-directory-workspace-name">
          <label htmlFor={workspaceNameId}>{t('workspace.create.namePlaceholder')}</label>
          <Input
            id={workspaceNameId}
            ref={workspaceNameInputRef}
            type="text"
            value={workspaceName}
            onChange={(event) => {
              const nextValue = event.target.value;
              setWorkspaceName(nextValue);
              if (nextValue.trim()) setWorkspaceNameError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                 void handleSaveWorkspace();
              }
            }}
            required
            disabled={isConfirming}
            aria-invalid={workspaceNameError || undefined}
            aria-describedby={workspaceNameError ? `${workspaceNameId}-error` : undefined}
            maxLength={80}
          />
          {workspaceNameError ? (
            <p id={`${workspaceNameId}-error`} role="alert">
              {t('workspace.create.nameRequired')}
            </p>
          ) : null}
        </div>
      ) : null}
      {isCloneMode ? (
        <div className="yuri-directory-field">
          <Input
            value={cloneRemoteUrl}
            onChange={(event) => setCloneRemoteUrl(event.target.value)}
            placeholder={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')}
            aria-label={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')}
            className="min-w-0 flex-1 font-mono"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          <IdentityDropdown
            activeProfile={selectedGitIdentity}
            identities={availableGitIdentities}
            onSelect={(profile) => setSelectedGitIdentityId(profile.id)}
            isApplying={isConfirming}
            iconOnly
          />
        </div>
      ) : null}
      <div className="yuri-directory-field">
        <Icon name="folder-add" className="size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(normalizeSeparators(event.target.value))}
          onKeyDown={handleKeyDown}
          placeholder={t('directoryExplorerDialog.pathInput.placeholder')}
          aria-label={t('directoryExplorerDialog.pathInput.placeholder')}
          className="min-w-0 flex-1 font-mono"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        {!isMobile ? showHiddenToggle : null}
      </div>
      {isWorkspaceMode && stagedWorkspacePaths.length > 0 ? (
        <div className="yuri-directory-chips">
          {stagedWorkspacePaths.map((stagedPath, index) => {
            const name = stagedPath.split('/').filter(Boolean).at(-1) || stagedPath;
            return (
              <span key={stagedPath} className="yuri-directory-chip" title={stagedPath}>
                <span className="truncate">{name}</span>
                {index === 0 && stagedWorkspacePaths.length > 1 ? (
                  <span className="shrink-0 text-muted-foreground">· {t('workspace.paths.primaryBadge')}</span>
                ) : editProject && index > 0 ? (
                  <Button type="button" variant="ghost" size="xs" disabled={isConfirming || isOpeningFinder}
                    onClick={() => setStagedWorkspacePaths((paths) => [stagedPath, ...paths.filter((path) => path !== stagedPath)])}
                  >
                    {t('workspace.paths.setPrimary')}
                  </Button>
                ) : null}
                <button
                  type="button"
                  disabled={isConfirming || isOpeningFinder}
                  onClick={() => toggleStagedWorkspacePath(stagedPath)}
                  aria-label={t('workspace.paths.removeAria', { path: stagedPath })}
                  className="yuri-directory-chip-remove"
                >
                  <Icon name="close" className="size-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  const resultsSection = (
    <ScrollableOverlay
      outerClassName="yuri-directory-results overflow-clip"
      className="yuri-directory-list"
      aria-label={t('directoryExplorerDialog.browse.directories')}
      aria-busy={isLoading}
      disableHorizontal
    >
        {isLoading ? (
          <div className="yuri-directory-empty text-center text-muted-foreground" role="status">
            {t('directoryExplorerDialog.browse.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div className="yuri-directory-empty text-center text-muted-foreground" role="status">
            {t('directoryExplorerDialog.browse.empty')}
          </div>
        ) : (
          <div>
            {rows.map((row, index) => {
              const isActive = index === highlightedIndex;
              return (
                <div
                  key={row.value}
                  data-directory-row={row.type}
                  data-selected={isActive}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  className={cn(
                    'yuri-directory-row',
                    isActive && 'bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]',
                    !isActive && 'hover:bg-interactive-hover/50',
                  )}
                >
                  <button
                    ref={(node) => {
                      if (node) {
                        rowRefs.current.set(row.value, node);
                      } else {
                        rowRefs.current.delete(row.value);
                      }
                    }}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => executeRow(row)}
                    className="yuri-directory-entry"
                    title={row.path ?? row.name}
                  >
                    {row.type === 'up' ? (
                      <Icon name="arrow-left-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                    ) : (
                      <Icon name="folder-6" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                    )}
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="yuri-directory-name truncate text-foreground">{row.name}</span>
                    </span>
                  </button>
                  {row.type === 'directory' && isWorkspaceMode ? (
                    (() => {
                       const isStaged = stagedWorkspacePathKeys.has(normalizeWorkspacePath(row.path));
                      return (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          role="checkbox"
                          aria-checked={isStaged}
                          disabled={isConfirming || isOpeningFinder}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleStagedWorkspacePath(row.path);
                          }}
                          className={cn(
                            'shrink-0',
                            isStaged ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                          )}
                          title={t('workspace.create.stageDirAria', { name: row.name })}
                          aria-label={t('workspace.create.stageDirAria', { name: row.name })}
                        >
                          <Icon
                            name={isStaged ? 'checkbox' : 'checkbox-blank'}
                            className="h-3.5 w-3.5"
                          />
                        </Button>
                      );
                    })()
                  ) : row.type === 'directory' && row.alreadyAdded ? (
                    <span className="yuri-directory-added shrink-0 text-muted-foreground">
                      {t('directoryExplorerDialog.browse.addedBadge')}
                    </span>
                  ) : row.type === 'directory' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => handleQuickAdd(event, row.path)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title={t('directoryExplorerDialog.browse.quickAdd')}
                      aria-label={t('directoryExplorerDialog.browse.quickAdd')}
                    >
                      <Icon name="add" className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
    </ScrollableOverlay>
  );

  const content = (
    <div className="yuri-directory-content">
      {inputSection}
      {resultsSection}
    </div>
  );

  const shortcutHints = !isMobile ? (
    <div className="yuri-directory-shortcuts text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Kbd variant="hint" className="gap-0.5" aria-label="↑ ↓">
          <Icon name="arrow-up" className="size-2.5" />
          <Icon name="arrow-down" className="size-2.5" />
        </Kbd>
        {t('directoryExplorerDialog.footer.navigate')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd variant="hint" aria-label="Enter">
          <Icon name="corner-down-left" className="size-2.5" />
        </Kbd>
        {t('directoryExplorerDialog.footer.select')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd variant="hint" className="gap-0.5" aria-label={isMacShortcut ? '⌘ Enter' : 'Ctrl Enter'}>
          {isMacShortcut ? <Icon name="command" className="size-2.5" /> : 'Ctrl'}
          <Icon name="corner-down-left" className="size-2.5" />
        </Kbd>
        {t('directoryExplorerDialog.footer.add')}
      </span>
    </div>
  ) : null;

  const renderFooter = () => (
    <div className="yuri-directory-actions">
      {isDesktop && (!isWorkspaceMode || (editProject && isDesktopLocalOriginActive())) ? (
        <Button variant="ghost" size="xs" onClick={handleOpenInFinder} disabled={isConfirming || isOpeningFinder || isCloneMode}>
          {isOpeningFinder ? t('directoryExplorerDialog.actions.openingFinder') : t('directoryExplorerDialog.actions.openInFinder')}
        </Button>
      ) : null}
      {!isWorkspaceMode && onAddSsh ? <Button variant="ghost" size="xs" onClick={onAddSsh} disabled={isConfirming || isOpeningFinder}>
        {t('directoryExplorerDialog.actions.addSshInstance')}
      </Button> : !isWorkspaceMode ? <Button variant="ghost" size="xs" onClick={() => setIsCloneMode((value) => !value)} disabled={isConfirming || isOpeningFinder}>
        {isCloneMode ? t('directoryExplorerDialog.actions.addLocalProject') : t('directoryExplorerDialog.actions.cloneRepository')}
      </Button> : null}
      {editProject ? (
        <Button variant="ghost" size="xs" onClick={handleClose} disabled={isConfirming || isOpeningFinder}>
          {t('projectEditDialog.actions.cancel')}
        </Button>
      ) : null}
      {isWorkspaceMode ? (
        <Button
          size="xs"
          onClick={() => void handleSaveWorkspace()}
          disabled={isConfirming || isOpeningFinder}
          aria-busy={isConfirming}
        >
          {editProject ? t('projectEditDialog.actions.save') : isConfirming ? t('directoryExplorerDialog.actions.adding') : t('workspace.create.submit')}
        </Button>
      ) : (
        <Button size="xs" onClick={() => void finalizeSelection(targetPath)} disabled={isCloneMode ? !canSubmitClone : !canAddProject}>
          {submitActionLabel}
        </Button>
      )}
    </div>
  );

  const headerTrailing = isMobile ? (
    <>
      {!editProject ? multipleProjectsToggle : null}
      {showHiddenToggle}
    </>
  ) : !editProject ? multipleProjectsToggle : null;

  return <DirectoryExplorerSurface open={open} onOpenChange={(next) => {
    if (next || (!isSavingWorkspace.current && !isOpeningFinder)) onOpenChange(next);
  }} origin={origin} mobile={isMobile} title={editProject ? t('workspace.paths.sectionTitle') : undefined}
    trailing={headerTrailing} hints={isWorkspaceMode ? null : shortcutHints} footer={renderFooter()} initialFocus={false} error={discoveryError}>
    {content}
  </DirectoryExplorerSurface>;
};

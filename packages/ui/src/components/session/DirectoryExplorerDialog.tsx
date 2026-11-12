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
import { useDeviceInfo } from '@/lib/device';
import { DirectoryExplorerSurface, DirectoryMachineActions, DirectoryMachineList } from './DirectoryExplorerViews';
import { Icon } from "@/components/icon/Icon";
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
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
import './directory-explorer-dialog.css';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
  onRemoteProjectAdded?: (project: RemoteProject, location: HostLocation) => void | Promise<void>;
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

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = (props) => {
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
    return <DirectoryExplorerSurface open={props.open} onOpenChange={machine.changeOpen} mobile={isMobile} footer={null}>
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
    return <DirectoryExplorerSurface open={props.open} onOpenChange={machine.changeOpen} mobile={isMobile} footer={footer} error={catalog.error?.message}>
      <DirectoryMachineList hosts={selectableHosts} selectedId={hostId} onSelect={machine.selectHost} pending={catalog.isPending}
        error={machine.error} steps={steps} />
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
  return <LocalDirectoryExplorerDialog {...props} machinePicker={machinePicker} discoveryError={catalog.error?.message} />;
};

const LocalDirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps & { machinePicker: React.ReactNode; discoveryError?: string }> = ({
  open,
  onOpenChange,
  forceMobile,
  machinePicker,
  discoveryError,
}) => {
  const { t } = useI18n();
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const projects = useProjectsStore((s) => s.projects);
  const addProject = useProjectsStore((s) => s.addProject);
  const gitIdentityProfiles = useGitIdentitiesStore((s) => s.profiles);
  const globalGitIdentity = useGitIdentitiesStore((s) => s.globalIdentity);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadGitIdentityProfiles = useGitIdentitiesStore((s) => s.loadProfiles);
  const loadGlobalGitIdentity = useGitIdentitiesStore((s) => s.loadGlobalIdentity);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);
  const { isDesktop, requestAccess, startAccessing } = useFileSystemAccess();
  const deviceInfo = useDeviceInfo();
  const isMobile = resolveDirectoryExplorerMobileLayout(forceMobile, deviceInfo.isMobile);
  const inputRef = React.useRef<HTMLInputElement>(null);
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
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');
  const [selectedGitIdentityId, setSelectedGitIdentityId] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);

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
    setCloneRemoteUrl('');
    setSelectedGitIdentityId(null);
    setShowHidden(false);
    requestAnimationFrame(() => focusPathInput(inputRef.current));

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
      requestAnimationFrame(() => focusPathInput(inputRef.current));
    };
    void resolveHome();
    return () => {
      cancelled = true;
    };
  }, [homeDirectory, open]);

  React.useEffect(() => {
    if (!open) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
    void loadDefaultGitIdentityId();
  }, [loadDefaultGitIdentityId, loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

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
    const lowerFilter = browseFilterQuery.toLowerCase();
    const includeHidden = showHidden || browseFilterQuery.startsWith('.');
    return entries.filter((entry) => (
      entry.name.toLowerCase().startsWith(lowerFilter) && (includeHidden || !entry.name.startsWith('.'))
    ));
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
    if (!isDesktop || isOpeningFinder) return;
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

      await finalizeSelection(result.path);
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
        void finalizeSelection(targetPath);
        return;
      }
      if (hasHighlightedBrowseItem) {
        executeRow(highlightedRow);
      }
      return;
    }
    if (event.key === 'Backspace' && query === '') {
      event.preventDefault();
      handleClose();
    }
  });

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
                  {row.type === 'directory' && row.alreadyAdded ? (
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
      {isDesktop ? (
        <Button variant="ghost" size="xs" onClick={handleOpenInFinder} disabled={isConfirming || isOpeningFinder || isCloneMode}>
          {isOpeningFinder ? t('directoryExplorerDialog.actions.openingFinder') : t('directoryExplorerDialog.actions.openInFinder')}
        </Button>
      ) : null}
      <Button variant="ghost" size="xs" onClick={() => setIsCloneMode((value) => !value)} disabled={isConfirming || isOpeningFinder}>
        {isCloneMode ? t('directoryExplorerDialog.actions.addLocalProject') : t('directoryExplorerDialog.actions.cloneRepository')}
      </Button>
      <Button size="xs" onClick={() => void finalizeSelection(targetPath)} disabled={isCloneMode ? !canSubmitClone : !canAddProject}>
        {submitActionLabel}
      </Button>
    </div>
  );

  return <DirectoryExplorerSurface open={open} onOpenChange={onOpenChange} mobile={isMobile}
    trailing={isMobile ? showHiddenToggle : undefined} hints={shortcutHints} footer={renderFooter()} initialFocus={false} error={discoveryError}>
    {content}
  </DirectoryExplorerSurface>;
};

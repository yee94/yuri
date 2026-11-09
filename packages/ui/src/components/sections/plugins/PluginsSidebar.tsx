import React from 'react';
import { useEvent } from '@reactuses/core';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { AddPluginDialog } from './AddPluginDialog';
import { RegistryBadge } from './RegistryBadge';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { findPluginGuiMatches } from './pluginGuiState';
import {
  configEntryRuntimeTarget,
  findRuntimeMatches,
  pluginFileRuntimeTarget,
  resolveUpdateFlag,
  resolveLoadState,
  resolveEffectivePluginVersion,
} from './pluginLoadState';
import { Icon } from '@/components/icon/Icon';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import {
  usePendingPluginUpdateTargets,
  usePluginReloadPending,
  useUpdatePluginPackage,
} from '@/queries/pluginMutations';
import { PluginIcon } from './PluginIcon';
import { PluginListSkeleton } from './PluginSkeletons';
import { splitPluginSpec } from './pluginPresentation';
import './plugin-settings.css';
import { useI18n } from '@/lib/i18n';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  resolveConfigQueryDirectory,
  usePluginRegistryQuery,
  usePluginRuntimeQuery,
  usePluginsQuery,
} from '@/queries/pluginQueries';
import {
  usePluginsStore,
  type PluginEntry,
  type PluginFile,
} from '@/stores/usePluginsStore';

interface PluginsSidebarProps {
  onItemSelect?: () => void;
  onAddClick?: () => void;
}

export const PluginsSidebar: React.FC<PluginsSidebarProps> = ({
  onItemSelect,
  onAddClick,
}) => {
  const { t } = useI18n();
  const gui = useGuiPlugins();

  const { selectedId, setSelected, loadPlugins } =
    usePluginsStore(
      useShallow((s) => ({
        selectedId: s.selectedId,
        setSelected: s.setSelected,
        loadPlugins: s.loadPlugins,
      })),
    );

  const pluginsQuery = usePluginsQuery();
  const entries = React.useMemo(() => pluginsQuery.data?.entries ?? [], [pluginsQuery.data?.entries]);
  const files = React.useMemo(() => pluginsQuery.data?.files ?? [], [pluginsQuery.data?.files]);

  const specs = React.useMemo(() => entries.map((entry) => entry.spec), [entries]);
  const { data, isFetching } = usePluginRegistryQuery(specs, false);
  const registryInfo = React.useMemo(() => data ?? {}, [data]);
  const runtimeQuery = usePluginRuntimeQuery();
  const runtimeUnavailable = runtimeQuery.isError && runtimeQuery.data === undefined;
  const updatePackage = useUpdatePluginPackage();
  const [isUpdatingAll, setIsUpdatingAll] = React.useState(false);
  const updateAllPending = React.useRef(false);
  const pendingUpdateTargets = usePendingPluginUpdateTargets();
  const isReloading = usePluginReloadPending();
  const isInitialLoading = pluginsQuery.isPending && pluginsQuery.data === undefined;

  const [isAddOpen, setIsAddOpen] = React.useState(false);

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  React.useEffect(() => {
    const handleOpenAdd = () => setIsAddOpen(true);
    window.addEventListener('yuri:settings-open-plugin-add', handleOpenAdd);
    return () => window.removeEventListener('yuri:settings-open-plugin-add', handleOpenAdd);
  }, []);

  const openCodeUpdateTargets = React.useMemo(() => {
    const inventory = runtimeQuery.data;
    const targets = new Map<string, string>();
    if (!inventory) return targets;
    for (const entry of entries) {
      const target = configEntryRuntimeTarget(entry.spec, entry.sourcePath);
      if (target?.kind !== 'package') continue;
      if (pendingUpdateTargets.has(target.target)) continue;
      if (resolveUpdateFlag(findRuntimeMatches(target, inventory)) === 'available') {
        targets.set(entry.id, target.target);
      }
    }
    return targets;
  }, [entries, pendingUpdateTargets, runtimeQuery.data]);

  // Scope is a quiet tag on the row, not a section: user-level is the default,
  // so only project-level plugins are marked.
  const orderedEntries = React.useMemo(
    () => [...entries.filter((e) => e.scope === 'user'), ...entries.filter((e) => e.scope === 'project')],
    [entries],
  );
  const orderedFiles = React.useMemo(
    () => [...files.filter((f) => f.scope === 'user'), ...files.filter((f) => f.scope === 'project')],
    [files],
  );

  // Focus the selected plugin when it is chosen from outside the list
  // (for example the load-failure notification).
  React.useEffect(() => {
    if (!selectedId) return;
    const row = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selectedId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, entries.length, files.length]);

  const total = entries.length + files.length;
  const isEmpty = total === 0;

  const handleAdd = React.useCallback(() => {
    if (onAddClick) {
      onAddClick();
    } else {
      setIsAddOpen(true);
    }
  }, [onAddClick]);

  const handleSelect = React.useCallback(
    (id: string) => {
      setSelected(id);
      onItemSelect?.();
    },
    [onItemSelect, setSelected],
  );

  const availableUpdates = entries.flatMap((entry) => {
    const target = configEntryRuntimeTarget(entry.spec, entry.sourcePath);
    if (target?.kind !== 'package' || pendingUpdateTargets.has(target.target)) return [];
    const info = registryInfo[entry.spec];
    const registryUpdate = info?.kind === 'npm-ok' && info.hasUpdate && info.latestVersion ? info : null;
    if (!registryUpdate && !openCodeUpdateTargets.has(entry.id)) return [];
    return [{ target: target.target, name: splitPluginSpec(entry.spec, true).name,
      entry: registryUpdate ? { id: entry.id, spec: `${registryUpdate.name}@${registryUpdate.latestVersion}` } : undefined }];
  });

  const handleUpdateAll = useEvent(async () => {
    if (isReloading || updateAllPending.current || pendingUpdateTargets.size > 0) return;
    const transport = getRuntimeTransportIdentity();
    const directory = resolveConfigQueryDirectory();
    updateAllPending.current = true;
    setIsUpdatingAll(true);
    try {
      const updatedTargets = new Set<string>();
      for (const update of availableUpdates) {
        if (getRuntimeTransportIdentity() !== transport || resolveConfigQueryDirectory() !== directory) break;
        if (!update.entry && updatedTargets.has(update.target)) continue;
        await updatePackage(update.target, update.name, update.entry);
        updatedTargets.add(update.target);
      }
    } finally {
      updateAllPending.current = false;
      setIsUpdatingAll(false);
    }
  });

  const renderEntry = (entry: PluginEntry) => {
    const info = registryInfo[entry.spec];
    const spec = splitPluginSpec(entry.spec, entry.parsedKind === 'npm');
    const target = configEntryRuntimeTarget(entry.spec, entry.sourcePath);
    const matches = target && runtimeQuery.data ? findRuntimeMatches(target, runtimeQuery.data) : [];
    const load = runtimeQuery.data ? resolveLoadState(matches) : null;
    const version = resolveEffectivePluginVersion(matches);
    const updating = (target?.kind === 'package' && pendingUpdateTargets.has(target.target)) || resolveUpdateFlag(matches) === 'updating';
    const busy = updating || isReloading;
    const canUpdate =
      info?.kind === 'npm-ok' && info.hasUpdate && !!info.latestVersion;
    const latest = info?.kind === 'npm-ok' ? info.latestVersion : null;
    const subtitle = updating
      ? latest ? t('settings.plugins.update.running.toVersion', { version: latest }) : t('settings.plugins.update.running')
      : isReloading ? t('settings.plugins.sidebar.reloading')
        : load?.kind === 'failed' ? load.error.split('\n')[0]
          : canUpdate && latest ? t('settings.plugins.update.available.toVersion', { version: latest })
            : openCodeUpdateTargets.has(entry.id) ? t('settings.plugins.update.available.title') : null;
    const updateTarget = openCodeUpdateTargets.get(entry.id) ?? null;
    return (
      <SettingsSidebarItem
        compact
        key={entry.id}
        rowId={entry.id}
        title={<>
          <span className="min-w-0 flex-1 truncate" title={entry.spec}>{spec.name}</span>
          {findPluginGuiMatches(target, gui.inventory).length > 0 ? <span className="yuri-plugin-gui-tag" title={t('guiPlugins.interface')} role="img" aria-label={t('guiPlugins.interface')}><Icon name="window" className="size-[13px]" /></span> : null}
          {version ? <span className="inline-flex h-5 shrink-0 items-center font-mono text-[11px] leading-none text-muted-foreground/60" data-plugin-version>{version}</span> : null}
          {entry.scope === 'project' ? <span className="shrink-0 text-[10px] text-muted-foreground/60">{t('settings.plugins.sidebar.group.projectEntries')}</span> : null}
        </>}
        metadata={
          subtitle ? <span title={subtitle} className={load?.kind === 'failed' && !busy ? 'text-[var(--status-error)] opacity-70' : 'text-[var(--status-info)] opacity-80'}>{subtitle}</span>
            : info && info.kind !== 'npm-ok' ? <RegistryBadge info={info} /> : null
        }
        selected={selectedId === entry.id}
        onSelect={() => handleSelect(entry.id)}
        icon={(
          <PluginIcon
            name={entry.spec}
            src={info && 'icon' in info ? info.icon : undefined}
            fallback={entry.parsedKind === 'npm' ? undefined : 'folder'}
            busy={busy}
            marker={load?.kind === 'failed'
              ? <span className="size-1.5 rounded-full bg-[var(--status-error)]" />
              : canUpdate || updateTarget ? <span className="size-1.5 rounded-full bg-[var(--status-info)]" /> : null}
          />
        )}
      />
    );
  };

  const renderFile = (file: PluginFile) => {
    const target = pluginFileRuntimeTarget(file.absolutePath);
    const load = target && runtimeQuery.data ? resolveLoadState(findRuntimeMatches(target, runtimeQuery.data)) : null;
    return (
    <SettingsSidebarItem
      compact
      key={file.id}
      rowId={file.id}
      title={<><span className="min-w-0 flex-1 truncate" title={file.fileName}>{file.fileName}</span>
        {findPluginGuiMatches(target, gui.inventory).length > 0 ? <span className="yuri-plugin-gui-tag" title={t('guiPlugins.interface')} role="img" aria-label={t('guiPlugins.interface')}><Icon name="window" className="size-[13px]" /></span> : null}
      </>}
      metadata={
        isReloading ? t('settings.plugins.sidebar.reloading')
          : load?.kind === 'failed' ? <span className="text-[var(--status-error)] opacity-70" title={load.error}>{load.error.split('\n')[0]}</span>
          : file.scope === 'project' ? t('settings.plugins.sidebar.group.projectFiles') : null
      }
      selected={selectedId === file.id}
      onSelect={() => handleSelect(file.id)}
      icon={<PluginIcon name={file.fileName} fallback="file-text" busy={isReloading} marker={load?.kind === 'failed' ? <span className="size-1.5 rounded-full bg-[var(--status-error)]" /> : null} />}
    />
    );
  };

  const pluginHeaderActions = (
    <div className="flex shrink-0 items-center gap-1">
      {availableUpdates.length > 0 || isUpdatingAll ? <Button
        type="button"
        size="xs"
        data-settings-item="plugins.updateAll"
        onClick={() => void handleUpdateAll()}
        aria-busy={isUpdatingAll}
        disabled={isFetching || runtimeQuery.isFetching || isUpdatingAll || isReloading || isInitialLoading || pendingUpdateTargets.size > 0 || availableUpdates.length === 0}
        aria-label={t('settings.plugins.sidebar.actions.updateAll')}
        title={t('settings.plugins.sidebar.actions.updateAll')}
      >
        {isUpdatingAll ? <Icon name="loader-4" className="size-3 animate-spin" aria-hidden /> : null}
        {t('settings.plugins.sidebar.actions.updateAll')}
      </Button> : null}
      <Button
        data-settings-item="plugins.create"
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleAdd}
        aria-label={t('settings.plugins.sidebar.actions.addTitle')}
        title={t('settings.plugins.sidebar.actions.addTitle')}
      >
        <Icon name="add" className="size-4" />
      </Button>
    </div>
  );

  return (
    <>
      <SettingsSidebarLayout
        className="yuri-plugin-collection"
        variant="background"
        header={runtimeUnavailable ? (
          <p className="typography-micro mb-2 flex items-center gap-1 text-muted-foreground" role="status">
            <Icon name="question" className="size-3 shrink-0" />
            {t('settings.plugins.status.sidebar.unavailable')}
          </p>
        ) : undefined}
      >
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="typography-ui-label font-medium text-foreground">
              {t('settings.plugins.sidebar.title')}
            </h3>
            {isReloading ? (
              <span className="typography-micro text-muted-foreground/70" role="status">· {t('settings.plugins.sidebar.reloading')}</span>
            ) : total > 0 ? (
              <span className="typography-micro text-muted-foreground/70">{total}</span>
            ) : null}
          </div>
          {pluginHeaderActions}
        </div>

        <div className="yuri-plugin-list">
          {isInitialLoading ? (
            <PluginListSkeleton />
          ) : isEmpty ? (
            <div className="yuri-settings-group-row py-8 text-center text-muted-foreground">
              <Icon name="plug" className="mx-auto mb-2 h-8 w-8 opacity-50" />
              <p className="typography-ui-label font-medium">
                {t('settings.plugins.sidebar.empty.title')}
              </p>
              <p className="typography-meta mt-1 opacity-75">
                {t('settings.plugins.sidebar.empty.description')}
              </p>
            </div>
          ) : (
            <>
              {orderedEntries.map(renderEntry)}
              {orderedFiles.map(renderFile)}
            </>
          )}
        </div>
      </SettingsSidebarLayout>

      <AddPluginDialog open={isAddOpen} onOpenChange={setIsAddOpen} />

    </>
  );
};

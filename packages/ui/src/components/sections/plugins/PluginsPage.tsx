import React from 'react';
import { GuiPluginsManager } from '@/components/gui-plugins/GuiPluginsManager';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { findPluginGuiMatches } from './pluginGuiState';
import './plugin-settings.css';
import { usePluginsQuery, usePluginRuntimeQuery } from '@/queries/pluginQueries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePluginPackageUpdateState, useReloadPlugins } from '@/queries/pluginMutations';
import { PluginIcon } from './PluginIcon';
import { usePluginRegistryQuery } from '@/queries/pluginQueries';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsActionHeader } from '@/components/sections/shared/SettingsActionHeader';
import { RegistryBanner } from './RegistryBanner';
import { PluginStatusBanner } from './PluginStatusBanner';
import { PluginDetailSkeleton } from './PluginSkeletons';
import { usePluginBusy } from './usePluginBusy';
import { splitPluginSpec } from './pluginPresentation';
import { configEntryRuntimeTarget, pluginFileRuntimeTarget, findRuntimeMatches, resolveEffectivePluginVersion } from './pluginLoadState';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { SettingsJsonEditor } from '@/components/sections/shared/SettingsJsonEditor';
import {
  usePluginsStore,
  type PluginDraft,
  type PluginEntry,
  type PluginFile,
} from '@/stores/usePluginsStore';

interface OptionsParseResult {
  ok: boolean;
  value?: Record<string, unknown>;
}

function parseOptionsJson(raw: string): OptionsParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function stringifyOptions(options: Record<string, unknown> | undefined): string {
  if (!options || Object.keys(options).length === 0) {
    return '';
  }
  return JSON.stringify(options, null, 2);
}

function buildEntryDraft(entry: PluginEntry): PluginDraft {
  return {
    mode: 'entry',
    scope: entry.scope,
    spec: entry.spec,
    optionsJson: stringifyOptions(entry.options),
    fileName: '',
    content: '',
  };
}

function buildFileDraft(file: PluginFile, content: string): PluginDraft {
  return {
    mode: 'file',
    scope: file.scope,
    spec: '',
    optionsJson: '',
    fileName: file.fileName,
    content,
  };
}

const PluginTitle: React.FC<{ name: string; version: string | null; icon?: string; fallback?: 'folder' | 'file-text' }> = ({ name, version, icon, fallback }) => (
  <div className="flex min-w-0 items-center gap-2.5">
    <PluginIcon name={name} src={icon} fallback={fallback} size={28} />
    <div className="min-w-0">
      <h2 className="truncate text-[13px] font-medium leading-tight text-foreground" title={name}>{name}</h2>
      {version ? <div className="mt-0.5 font-mono text-[10px] leading-tight text-muted-foreground/70">v{version}</div> : null}
    </div>
  </div>
);

export const PluginsPage: React.FC = () => {
  const { t } = useI18n();

  const selectedId = usePluginsStore((s) => s.selectedId);
  const gui = useGuiPlugins();
  const pluginsQuery = usePluginsQuery();
  const runtimeQuery = usePluginRuntimeQuery();
  const entries = React.useMemo(() => pluginsQuery.data?.entries ?? [], [pluginsQuery.data?.entries]);
  const files = React.useMemo(() => pluginsQuery.data?.files ?? [], [pluginsQuery.data?.files]);
  const draft = usePluginsStore((s) => s.draft);
  const setDraft = usePluginsStore((s) => s.setDraft);
  const updateEntry = usePluginsStore((s) => s.updateEntry);
  const updateFile = usePluginsStore((s) => s.updateFile);
  const readFile = usePluginsStore((s) => s.readFile);
  const deleteEntry = usePluginsStore((s) => s.deleteEntry);
  const deleteFile = usePluginsStore((s) => s.deleteFile);
  const [deleteTarget, setDeleteTarget] = React.useState<{ kind: 'entry' | 'file'; id: string; name: string } | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const directEntry = selectedId ? entries.find((entry) => entry.id === selectedId) : undefined;
  const directTarget = directEntry ? configEntryRuntimeTarget(directEntry.spec, directEntry.sourcePath) : null;
  const selectedUpdate = usePluginPackageUpdateState(directTarget?.kind === 'package' ? directTarget.target : null, selectedId ?? undefined);
  const updatingEntry = selectedUpdate.kind !== 'idle' ? selectedUpdate.entry : undefined;
  const originalEntry = updatingEntry?.original;
  const replacement = originalEntry && updatingEntry ? entries.find((entry) => entry.spec === updatingEntry.spec
    && entry.scope === originalEntry.scope && entry.sourcePath === originalEntry.sourcePath) : undefined;
  const selectedEntry = directEntry ?? replacement ?? (selectedUpdate.kind === 'pending' ? originalEntry : undefined) ?? null;
  React.useEffect(() => {
    if (replacement && selectedId === originalEntry?.id && usePluginsStore.getState().selectedId === selectedId) {
      usePluginsStore.getState().setSelected(replacement.id);
    }
  }, [replacement, selectedId, originalEntry?.id]);
  const selectedFile = React.useMemo(
    () => (selectedId ? files.find((f) => f.id === selectedId) ?? null : null),
    [files, selectedId],
  );
  const selectedEntryTarget = React.useMemo(
    () => (selectedEntry ? configEntryRuntimeTarget(selectedEntry.spec, selectedEntry.sourcePath) : null),
    [selectedEntry],
  );
  const selectedFileTarget = React.useMemo(
    () => (selectedFile ? pluginFileRuntimeTarget(selectedFile.absolutePath) : null),
    [selectedFile],
  );

  const busy = usePluginBusy(selectedEntryTarget ?? selectedFileTarget, selectedEntry?.id) !== null || isDeleting;
  const guiIds = findPluginGuiMatches(selectedEntryTarget ?? selectedFileTarget, gui.inventory).map((plugin) => plugin.id);
  const guiControls = guiIds.length > 0 ? <div className={cn('transition-opacity', busy && 'opacity-40')} inert={busy || undefined}>
    <GuiPluginsManager key={selectedId} pluginIds={guiIds} disabled={busy} />
  </div> : null;
  const reloadMutation = useReloadPlugins();
  const isReloading = reloadMutation.isPending;
  const reload = () => reloadMutation.mutate();
  const registrySpecs = React.useMemo(() => entries.map((entry) => entry.spec), [entries]);
  const registryQuery = usePluginRegistryQuery(registrySpecs);
  const registryInfo = selectedEntry ? registryQuery.data?.[selectedEntry.spec] : undefined;
  const entryIcon = registryInfo && 'icon' in registryInfo ? registryInfo.icon : undefined;
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const originalFileContentById = React.useRef(new Map<string, string>());
  const confirmDelete = async () => {
    if (!deleteTarget || busy || isSaving || isLoadingFile) return;
    setIsDeleting(true);
    try {
      const result = await (deleteTarget.kind === 'entry' ? deleteEntry(deleteTarget.id) : deleteFile(deleteTarget.id));
      if (!result.ok) {
        toast.error(result.message || t('settings.plugins.sidebar.toast.deleteFailed'));
        return;
      }
      setDeleteTarget(null);
      if (result.reloadFailed) {
        toast.warning(result.message || t('settings.plugins.toast.reloadFailed'), { description: result.warning });
      } else {
        toast.success(t('settings.plugins.sidebar.toast.deleted', { name: deleteTarget.name }));
      }
    } finally {
      setIsDeleting(false);
    }
  };
  const deleteAction = <>
    <Button variant="ghost" size="icon" aria-label={t('settings.common.actions.delete')} title={t('settings.common.actions.delete')}
      disabled={busy || isSaving || isLoadingFile}
      onClick={() => {
        if (selectedEntry) setDeleteTarget({ kind: 'entry', id: selectedEntry.id, name: selectedEntry.spec });
        else if (selectedFile) setDeleteTarget({ kind: 'file', id: selectedFile.id, name: selectedFile.fileName });
      }}>
      <Icon name="delete-bin" className="size-4" />
    </Button>
    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.plugins.sidebar.deleteDialog.title')}</DialogTitle>
          <DialogDescription>{t('settings.plugins.sidebar.deleteDialog.description', { name: deleteTarget?.name ?? '' })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={isDeleting} onClick={() => setDeleteTarget(null)}>{t('settings.common.actions.cancel')}</Button>
          <Button variant="destructive" size="sm" disabled={busy || isSaving || isLoadingFile} aria-busy={isDeleting} onClick={() => void confirmDelete()}>
            {isDeleting ? t('settings.plugins.sidebar.actions.deleting') : t('settings.common.actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;

  React.useEffect(() => {
    let cancelled = false;

    if (selectedEntry) {
      setDraft(buildEntryDraft(selectedEntry));
      return () => {
        cancelled = true;
      };
    }

    if (selectedFile) {
      setIsLoadingFile(true);
      void (async () => {
        const result = await readFile(selectedFile.id);
        if (cancelled) return;
        setIsLoadingFile(false);
        const content = result?.content ?? '';
        originalFileContentById.current.set(selectedFile.id, content);
        setDraft(buildFileDraft(selectedFile, content));
      })();
      return () => {
        cancelled = true;
      };
    }

    setDraft(null);
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, selectedFile, readFile, setDraft]);

  const detailSkeleton = <PluginDetailSkeleton />;

  if (pluginsQuery.isPending && pluginsQuery.data === undefined) return detailSkeleton;

  if (!selectedId || (!selectedEntry && !selectedFile)) {
    return (
      <SettingsPageLayout>
        <div className="text-center text-muted-foreground">
          <Icon name="plug" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.plugins.page.empty.select')}</p>
          <p className="typography-meta mt-1 opacity-75">
            {t('settings.plugins.page.empty.add')}
          </p>
        </div>
      </SettingsPageLayout>
    );
  }

  if (selectedEntry && draft && draft.mode === 'entry') {
    const entrySpec = splitPluginSpec(selectedEntry.spec, selectedEntry.parsedKind === 'npm');
    const optionsResult = parseOptionsJson(draft.optionsJson);
    const optionsValid = optionsResult.ok;
    const isDirty =
      draft.spec !== selectedEntry.spec ||
      draft.optionsJson !== stringifyOptions(selectedEntry.options);

    const handleEntrySave = async () => {
      if (!optionsValid || busy) return;
      const spec = draft.spec.trim();
      if (!spec) {
        toast.error(t('settings.plugins.validation.specRequired'));
        return;
      }

      setIsSaving(true);
      try {
        const result = await updateEntry(selectedEntry.id, {
          spec,
          options: optionsResult.value,
        });
        if (result.ok) {
          if (result.reloadFailed) {
            toast.warning(
              result.message || t('settings.plugins.toast.reloadFailed'),
              { description: result.warning },
            );
          } else {
            toast.success(result.message || t('settings.plugins.toast.updated'));
          }
        } else {
          toast.error(result.message || t('settings.plugins.toast.reloadFailed'));
        }
      } finally {
        setIsSaving(false);
      }
    };

    return (
      <SettingsPageLayout className="yuri-plugin-detail sm:pt-6">
        <SettingsActionHeader className="py-0" actions={<div className={cn('flex flex-wrap items-center gap-1.5', busy && 'opacity-40')}>
          {deleteAction}
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={isReloading || isSaving || busy}>{t('settings.plugins.page.action.reload')}</Button>
          <Button size="sm" onClick={() => void handleEntrySave()} disabled={!isDirty || !optionsValid || isSaving || busy} aria-busy={isSaving}>{t('settings.plugins.page.action.save')}</Button>
        </div>}>
          <PluginTitle
            name={entrySpec.name}
            version={selectedEntryTarget && runtimeQuery.data ? resolveEffectivePluginVersion(findRuntimeMatches(selectedEntryTarget, runtimeQuery.data)) : null}
            icon={entryIcon}
            fallback={selectedEntry.parsedKind === 'npm' ? undefined : 'folder'}
          />
        </SettingsActionHeader>

        <PluginStatusBanner
          target={selectedEntryTarget}
          name={selectedEntry.spec}
          latestVersion={registryInfo?.kind === 'npm-ok' ? registryInfo.latestVersion : null}
          entryId={selectedEntry.id}
          registry={registryInfo}
        />

        <RegistryBanner spec={selectedEntry.spec} />
        {guiControls}

        <div data-settings-item="plugins.spec" className={cn('transition-opacity', busy && 'opacity-40')} inert={busy || undefined}>
          <SettingsGroup label={t('settings.plugins.page.field.spec')} cardClassName="contents">
            <Input
              value={draft.spec}
              aria-label={t('settings.plugins.page.field.spec')}
              onChange={(e) =>
                setDraft({ ...draft, spec: e.target.value })
              }
              placeholder={t('settings.plugins.page.field.spec.placeholder')}
              className="font-mono"
              disabled={busy}
              spellCheck={false}
            />
          </SettingsGroup>
        </div>

        <div data-settings-item="plugins.options" className={cn('transition-opacity', busy && 'opacity-40')} inert={busy || undefined}>
          <SettingsGroup
            label={t('settings.plugins.page.field.options')}
            description={!optionsValid ? t('settings.plugins.page.field.options.invalidJson') : undefined}
            cardClassName="overflow-hidden p-0"
          >
            <SettingsJsonEditor
              value={draft.optionsJson}
              onChange={(optionsJson) => setDraft({ ...draft, optionsJson })}
              className="h-[clamp(180px,32dvh,360px)]"
              hasError={!optionsValid}
              ariaLabel={t('settings.plugins.page.field.options')}
              placeholder={t('settings.plugins.page.field.options.placeholder')}
              readOnly={busy}
            />
          </SettingsGroup>
        </div>

      </SettingsPageLayout>
    );
  }

  if (selectedFile && draft && draft.mode === 'file') {
    const originalContent = originalFileContentById.current.get(selectedFile.id) ?? '';
    const isDirty = draft.content !== originalContent || draft.fileName !== selectedFile.fileName;

    const handleFileSave = async () => {
      if (busy) return;
      setIsSaving(true);
      try {
        const result = await updateFile(selectedFile.id, { content: draft.content });
        if (result.ok) {
          originalFileContentById.current.set(selectedFile.id, draft.content);
          if (result.reloadFailed) {
            toast.warning(
              result.message || t('settings.plugins.toast.reloadFailed'),
              { description: result.warning },
            );
          } else {
            toast.success(result.message || t('settings.plugins.toast.updated'));
          }
        } else {
          toast.error(result.message || t('settings.plugins.toast.reloadFailed'));
        }
      } finally {
        setIsSaving(false);
      }
    };

    return (
      <SettingsPageLayout className="yuri-plugin-detail sm:pt-6">
        <SettingsActionHeader className="py-0" actions={<div className={cn('flex flex-wrap items-center gap-1.5', busy && 'opacity-40')}>
          {deleteAction}
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={isReloading || isSaving || busy}>{t('settings.plugins.page.action.reload')}</Button>
          <Button size="sm" onClick={() => void handleFileSave()} disabled={!isDirty || isSaving || isLoadingFile || busy} aria-busy={isSaving}>{t('settings.plugins.page.action.save')}</Button>
        </div>}>
          <PluginTitle name={selectedFile.fileName} version={null} fallback="file-text" />
        </SettingsActionHeader>

        <PluginStatusBanner target={selectedFileTarget} name={selectedFile.fileName} />
        {guiControls}

        <div data-settings-item="plugins.content" className={cn('transition-opacity', busy && 'opacity-40')} inert={busy || undefined}>
          <SettingsGroup label={t('settings.plugins.page.field.content')} cardClassName="p-3">
            <Textarea
              embedded
              value={draft.content}
              aria-label={t('settings.plugins.page.field.content')}
              onChange={(e) =>
                setDraft({ ...draft, content: e.target.value })
              }
              rows={16}
              className="font-mono typography-meta min-h-[320px]"
              spellCheck={false}
              disabled={isLoadingFile}
            />
          </SettingsGroup>
        </div>

      </SettingsPageLayout>
    );
  }

  return detailSkeleton;
};

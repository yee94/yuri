import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { usePluginPackageUpdateState, usePluginReloadPending, useUpdatePluginPackage } from '@/queries/pluginMutations';
import type { RegistryResult } from '@/stores/usePluginsStore';
import type { PluginRuntimeTarget } from './pluginLoadState';
import { usePluginRuntimeStatus } from './usePluginRuntimeStatus';

interface PluginStatusBannerProps {
  target: PluginRuntimeTarget | null;
  /** How the plugin is named in toasts. */
  name: string;
  /** Newest release known from the registry, named while an update runs. */
  latestVersion?: string | null;
  entryId?: string;
  registry?: RegistryResult;
}

const COLLAPSED_ERROR_LINES = 2;

/** Load failure text, folded to a couple of lines until the reader asks for the rest. */
const PluginLoadError: React.FC<{ error: string; reference: string | null }> = ({ error, reference }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const lineCount = error.split('\n').length;
  const foldable = lineCount > COLLAPSED_ERROR_LINES;

  const handleCopy = useEvent(async () => {
    const result = await copyTextToClipboard(error);
    if (result.ok) toast.success(t('settings.plugins.status.failed.copied'));
    else toast.error(t('settings.plugins.status.failed.copyFailed'));
  });

  return (
    <div
      className="rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)]"
      role="alert"
      data-plugin-load-state="failed"
    >
      <pre
        className={cn(
          'whitespace-pre-wrap break-all px-3 pt-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground',
          !expanded && 'line-clamp-2',
        )}
      >
        {error}
      </pre>
      {reference ? (
        <p className="typography-micro px-3 pt-1 text-muted-foreground/70">
          {t('settings.plugins.status.failed.ref', { ref: reference })}
        </p>
      ) : null}
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground/70">
        {foldable ? (
          <button type="button" className="hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded
              ? t('settings.plugins.status.failed.collapse')
              : t('settings.plugins.status.failed.expand', { count: lineCount })}
          </button>
        ) : <span />}
        <button type="button" className="hover:text-foreground" onClick={() => void handleCopy()}>
          {t('settings.plugins.status.failed.copy')}
        </button>
      </div>
    </div>
  );
};

/** What OpenCode reports for the selected plugin, plus an in-place update that does not rewrite config. */
export const PluginStatusBanner: React.FC<PluginStatusBannerProps> = ({ target, name, latestVersion = null, entryId, registry }) => {
  const { t } = useI18n();
  const { status, retry, isRefreshing } = usePluginRuntimeStatus(target);
  const packageTarget = target?.kind === 'package' ? target.target : null;
  const packageUpdate = usePluginPackageUpdateState(packageTarget, entryId);
  const updatePackage = useUpdatePluginPackage();
  const reloading = usePluginReloadPending();
  const isUpdating = packageUpdate.kind === 'pending' || (status.kind === 'known' && status.update === 'updating');
  const registryUpdate = registry?.kind === 'npm-ok' && registry.hasUpdate && registry.latestVersion ? registry : null;
  const version = registryUpdate?.latestVersion ?? latestVersion;
  const rewriteEntry = registryUpdate && entryId
    ? { id: entryId, spec: `${registryUpdate.name}@${registryUpdate.latestVersion}` }
    : undefined;

  const handleRetry = useEvent(() => {
    retry();
  });

  const handleUpdate = useEvent(() => {
    if (!packageTarget || isUpdating || reloading) return;
    updatePackage(packageTarget, name, rewriteEntry);
  });

  const loadBlock = (() => {
    if (status.kind === 'loading') return null;
    if (status.kind === 'unknown') return (
      <div className="flex flex-wrap items-start gap-3 rounded-md border border-border bg-card p-3" role="status" data-plugin-load-state="unknown">
        <Icon name="question" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="typography-label text-foreground">{t('settings.plugins.status.unknown.title')}</p>
          <p className="typography-micro mt-0.5 text-muted-foreground">
            {t('settings.plugins.status.unknown.description')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRetry} disabled={isRefreshing}>
          {t('settings.plugins.status.retry')}
        </Button>
      </div>
    );
    const { load } = status;
    switch (load.kind) {
      case 'active':
        return null;
      case 'notReported':
        if (packageUpdate.kind !== 'idle' || reloading) return null;
        return (
          <div className="yuri-plugin-update-strip flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-[var(--status-info)]" role="status" data-plugin-load-state="notReported">
            <Icon name="loader-4" className="size-3 shrink-0 animate-spin" aria-hidden />
            <span className="min-w-0">{t('settings.plugins.status.notReported.description')}</span>
          </div>
        );
      case 'failed':
        return <PluginLoadError key={load.error} error={load.error} reference={load.ref} />;
    }
  })();
  const showUpdate = packageTarget !== null && (
    (status.kind === 'known' && status.update !== 'none') || registryUpdate !== null || packageUpdate.kind !== 'idle'
  );

  if (!loadBlock && !showUpdate) return null;

  return (
    <div className="flex flex-col gap-3" data-plugin-feedback>
      {loadBlock}
      {showUpdate ? (
        <div className="yuri-plugin-update-strip relative overflow-hidden rounded-md border px-3 py-1.5" aria-busy={isUpdating}>
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--status-info)]" role={isUpdating ? 'status' : undefined}>
              {isUpdating ? (
                <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-[var(--status-info)]" aria-hidden />
              ) : (
                <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-info)]" aria-hidden />
              )}
              {isUpdating
                ? (version
                  ? t('settings.plugins.update.running.toVersion', { version })
                  : t('settings.plugins.update.running'))
                : (version
                  ? t('settings.plugins.update.available.toVersion', { version })
                  : t('settings.plugins.update.available.title'))}
            </span>
            <button
              type="button"
              className="shrink-0 text-[11px] text-muted-foreground/70 hover:text-foreground disabled:opacity-50"
              onClick={handleUpdate}
              disabled={isUpdating || reloading}
            >
              {isUpdating ? t('settings.plugins.update.running') : t('settings.plugins.update.action')}
            </button>
          </div>
          {isUpdating ? (
            <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" aria-hidden>
              <div className="animate-indeterminate-slide h-full w-[30%] bg-[var(--status-info)] opacity-60" />
            </div>
          ) : null}
        </div>
      ) : null}
      {packageUpdate.kind === 'error' ? (
        <div>
          <span className="sr-only">{t('settings.plugins.update.failed.title')}</span>
          <PluginLoadError key={packageUpdate.error} error={packageUpdate.error} reference={null} />
        </div>
      ) : null}
    </div>
  );
};

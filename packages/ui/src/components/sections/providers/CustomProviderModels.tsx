import React from 'react';
import { useDebounce } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { ProviderModelRow } from './ProviderModelRow';
import { useI18n } from '@/lib/i18n';
import { customProviderModelQueryOptions } from './customProviderModelQueries';
import type { CustomProviderModelDraft } from './CustomProviderModelDialog';
import type { DiscoveredProviderModel } from '../../../../../web/server/lib/opencode/custom-provider-models';

export function CustomProviderModels({ input, enabled, models, onSelect, onAdd, onEdit, onRemove, onRemoveAll }: {
  input: Parameters<typeof customProviderModelQueryOptions>[0];
  enabled: boolean;
  models: CustomProviderModelDraft[];
  onSelect: (models: readonly DiscoveredProviderModel[]) => void;
  onAdd: () => void;
  onEdit: (model: CustomProviderModelDraft) => void;
  onRemove: (key: string) => void;
  onRemoveAll: () => void;
}) {
  const { t } = useI18n();
  const settledRevision = useDebounce(input.revision, 600);
  const ready = enabled && settledRevision === input.revision && Boolean(input.baseURL);
  const query = useQuery({ ...customProviderModelQueryOptions(input), enabled: ready });
  const [search, setSearch] = React.useState('');
  const selected = React.useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const available = query.data;
  const remaining = React.useMemo(() => (available ?? []).filter((model) => !selected.has(model.id)), [available, selected]);
  const matches = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return [
      ...models.map((model) => ({ id: model.id, name: model.name, configured: model, discovered: undefined })),
      ...remaining.map((model) => ({ id: model.id, name: model.name, configured: undefined, discovered: model })),
    ].filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(term));
  }, [models, remaining, search]);
  const visible = matches.slice(0, 100);

  return (
    <SettingsGroup className="[&_[data-settings-action-header]]:flex-wrap [&_[data-settings-action-header]>div:first-child]:flex-none [&_[data-settings-action-header]>div:last-child]:max-w-full"
      label={t('settings.providers.custom.modelsCount', { count: models.length })} actions={(
      <div className="flex flex-wrap items-center justify-end gap-1">
        <div className="relative w-28 min-w-0 sm:w-36">
          <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input bordered aria-label={t('settings.providers.page.models.filterPlaceholder')} placeholder={t('settings.providers.page.models.filterPlaceholder')}
            className="!h-7 !min-h-0 !pl-7 !pr-2 !text-left !text-xs" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <Button type="button" size="xs" disabled={!ready || query.isFetching || !remaining.length}
          onClick={() => onSelect(available ?? [])}>{t('settings.providers.custom.addAllModels')}</Button>
        <Button type="button" size="xs" disabled={!enabled || !models.length} onClick={onRemoveAll}>
          {t('settings.providers.models.removeAll')}
        </Button>
        <Button type="button" size="xs" disabled={!ready || query.isFetching} onClick={() => void query.refetch()}>
          <Icon name="refresh" className={query.isFetching ? 'size-3.5 motion-safe:animate-spin' : 'size-3.5'} />
          {query.isFetching ? t('settings.providers.page.state.loading') : t('settings.providers.custom.fetchModels')}
        </Button>
        <Button type="button" size="xs" disabled={!enabled} aria-label={t('settings.providers.custom.addModel')} onClick={onAdd}>
          <Icon name="add" className="size-3.5" />
        </Button>
      </div>
    )}>
        {query.isError && visible.length > 0 && <p role="alert" className="typography-meta text-status-error">{t('settings.providers.custom.discoveryFailed')}</p>}
        <ScrollableOverlay outerClassName="max-h-96" className="divide-y divide-[var(--yuri-settings-row-divider)]">
          {visible.map((model) => (
            <ProviderModelRow key={model.id} id={model.id} name={model.name} detail={model.name !== model.id ? model.id : undefined}
              added={Boolean(model.configured)} disabled={!enabled || (!model.configured && !ready)}
              capabilities={[
                ...(model.configured?.vision ? [{ icon: 'eye' as const, label: t('settings.providers.custom.vision') }] : []),
                ...(model.configured?.tools ? [{ icon: 'tools' as const, label: t('settings.providers.custom.tools') }] : []),
              ]}
              onSelect={() => model.configured ? onEdit(model.configured) : onSelect([model.discovered])}
              onEdit={model.configured ? () => { if (model.configured) onEdit(model.configured); } : undefined}
              onToggle={() => model.configured ? onRemove(model.configured.key) : onSelect([model.discovered])} />
          ))}
        </ScrollableOverlay>
        {!visible.length && <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-10 text-center text-muted-foreground">
          <Icon name={query.isFetching ? 'refresh' : search.trim() ? 'search' : 'stack'} aria-hidden="true"
            className={`size-8 opacity-60${query.isFetching ? ' motion-safe:animate-spin' : ''}`} />
          <p role={query.isError && !query.isFetching ? 'alert' : 'status'} className="typography-meta">
            {t(query.isFetching ? 'settings.providers.page.state.loading'
              : query.isError ? 'settings.providers.custom.discoveryFailed'
                : search.trim() ? 'settings.providers.page.models.noModelsMatchFilter'
                  : query.isSuccess ? 'settings.providers.custom.discoveryEmpty' : 'settings.providers.custom.emptyModels')}
          </p>
        </div>}
        {matches.length > 100 && <p className="yuri-settings-group-row typography-meta text-muted-foreground">{t('settings.providers.models.limit', { count: matches.length })}</p>}
    </SettingsGroup>
  );
}

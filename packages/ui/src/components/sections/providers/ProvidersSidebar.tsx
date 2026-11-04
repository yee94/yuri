import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { providerSourceQueryOptions } from './providerSourceQueries';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import './provider-settings.css';

const ADD_PROVIDER_ID = '__add_provider__';
const CUSTOM_PROVIDER_ID = '__custom_provider__';

interface ProvidersSidebarProps {
  onItemSelect?: () => void;
}

export const ProvidersSidebar: React.FC<ProvidersSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const directory = useDirectoryStore((state) => state.currentDirectory);
  React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const sourceQuery = useQuery(providerSourceQueryOptions(directory ?? undefined));
  const sourcesByProvider = sourceQuery.data;
  const [search, setSearch] = React.useState('');
  const connectionLabel = (id: string) => {
    const type = sourcesByProvider?.[id]?.auth.type;
    return t(type === 'api' ? 'settings.providers.page.auth.apiKeyLabel' : type === 'oauth' || type === 'external'
      ? 'settings.providers.auth.account' : 'settings.providers.auth.managed');
  };

  const projectProviders = React.useMemo(() => {
    return providers.filter((p) => Boolean(sourcesByProvider?.[p.id]?.project?.exists) && `${p.name} ${p.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  }, [providers, sourcesByProvider, search]);

  const userProviders = React.useMemo(() => {
    return providers.filter((p) => !sourcesByProvider?.[p.id]?.project?.exists && `${p.name} ${p.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  }, [providers, sourcesByProvider, search]);

  const userProvidersLabel = (
    <div className="flex items-center justify-between gap-4">
      <span>{t('settings.providers.sidebar.title')}</span>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => {
          setSelectedProvider(ADD_PROVIDER_ID);
          onItemSelect?.();
        }}
        aria-label={t('settings.providers.sidebar.actions.connectProviderAria')}
        title={t('settings.providers.sidebar.actions.connectProviderTitle')}
      >
        <Icon name="add" className="h-4 w-4" />
      </Button>
    </div>
  );

  const customProviderItem = (
    <ProviderListItem
      provider={{ id: CUSTOM_PROVIDER_ID, name: t('settings.providers.custom.title') }}
      selectedProviderId={selectedProviderId}
      onSelect={() => { setSelectedProvider(CUSTOM_PROVIDER_ID); onItemSelect?.(); }}
    />
  );

  return (
    <div className="yuri-settings-page-content h-full overflow-y-auto bg-background p-3">
      {userProvidersLabel}
      {sourceQuery.isError && <p role="alert" className="typography-meta text-muted-foreground">{t('settings.providers.page.toast.providerSourcesLoadFailed')}</p>}
      <div className="relative">
        <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="!h-8 !min-h-0 !pl-7 !text-left !text-[13px]" aria-label={t('settings.providers.page.connect.searchProvidersPlaceholder')}
          placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <SettingsGroup cardClassName="yuri-provider-collection-card">{customProviderItem}</SettingsGroup>
      <>
        {providers.length === 0 ? (
          <SettingsGroup>
            <div className="yuri-settings-group-row py-12 text-center text-muted-foreground">
              <Icon name="stack" className="mx-auto mb-3 h-10 w-10 opacity-50" />
              <p className="typography-ui-label font-medium">{t('settings.providers.sidebar.empty.title')}</p>
              <p className="typography-meta mt-1 opacity-75">{t('settings.providers.sidebar.empty.description')}</p>
            </div>
          </SettingsGroup>
        ) : (
          <>
            {userProviders.length > 0 ? (
              <SettingsGroup label={t('settings.providers.sidebar.section.userProviders')} cardClassName="yuri-provider-collection-card">
                {userProviders.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    description={connectionLabel(provider.id)}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => {
                      setSelectedProvider(provider.id);
                      onItemSelect?.();
                    }}
                  />
                ))}
              </SettingsGroup>
            ) : null}

            {projectProviders.length > 0 && (
              <SettingsGroup label={t('settings.providers.sidebar.section.projectProviders')} cardClassName="yuri-provider-collection-card">
                {projectProviders.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    description={connectionLabel(provider.id)}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => {
                      setSelectedProvider(provider.id);
                      onItemSelect?.();
                    }}
                  />
                ))}
              </SettingsGroup>
            )}
          </>
        )}
      </>
      {search && !userProviders.length && !projectProviders.length && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>}
    </div>
  );
};

const ProviderListItem: React.FC<{
  provider: { id: string; name?: string; models?: unknown[] };
  selectedProviderId: string;
  onSelect: () => void;
  description?: string;
}> = ({ provider, selectedProviderId, onSelect, description }) => {
  const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
  const isSelected = provider.id === selectedProviderId;

  return (
    <div
      key={provider.id}
      className={cn(
        // Compact single-line entity row: tighter than the default form-row geometry.
        'yuri-provider-collection-row group relative flex items-center transition-colors duration-150',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
        aria-current={isSelected ? 'page' : undefined}
        tabIndex={0}
      >
        {provider.id === CUSTOM_PROVIDER_ID ? <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--interactive-border)]"><Icon name="add" className="size-4" /></span> : <ProviderLogo providerId={provider.id} className="size-5 shrink-0" />}
        <span className="flex-1 min-w-0 text-foreground">
          <span className="block truncate text-[13px] leading-[18px] font-normal">{provider.name || provider.id}</span>
          {description && <span className="block truncate text-[11px] leading-4 text-muted-foreground">{description}</span>}
        </span>
        {provider.id === CUSTOM_PROVIDER_ID && <Icon name="arrow-right-s" className="size-4 text-muted-foreground" />}
        {provider.id !== CUSTOM_PROVIDER_ID && <span className="text-[11px] leading-4 tabular-nums text-muted-foreground/60 flex-shrink-0">
          {modelCount}
        </span>}
      </button>
    </div>
  );
};

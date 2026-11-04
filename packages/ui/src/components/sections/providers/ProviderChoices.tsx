import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import './provider-settings.css';

export function ProviderChoices({ providers, search, loading, error, onSearch, onSelect }: {
  providers: ReadonlyArray<{ id: string; name?: string; methods: ReadonlyArray<{ label?: string; type?: string }> }>;
  search: string;
  loading: boolean;
  error: string | null;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const matches = providers.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <>
    <h2 className="typography-ui-header text-foreground">{t('settings.providers.page.connect.title')}</h2>
    <SettingsGroup>
      <button type="button" className="yuri-provider-custom-choice" aria-label={t('settings.providers.custom.title')} onClick={() => onSelect('__custom_provider__')}>
        <Icon name="settings-3" className="size-7 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="block typography-ui-label text-foreground">{t('settings.providers.custom.title')}</span>
          <span className="block typography-meta text-muted-foreground">{t('settings.providers.custom.description')}</span>
          <span className="block typography-micro text-muted-foreground">OpenAI · Anthropic · Gemini</span>
        </span>
        <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </SettingsGroup>
    <SettingsGroup label={t('settings.providers.page.connect.providerField')} actions={(
      <div className="relative w-36 min-w-0">
        <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label={t('settings.providers.page.connect.searchProvidersPlaceholder')} placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
          className="!h-7 !min-h-0 !pl-7 !pr-2 !text-left !text-xs" value={search} onChange={(event) => onSearch(event.target.value)} />
      </div>
    )}>
      <div className="yuri-provider-choices">
        <div className="yuri-provider-choice-grid">
          {matches.map((provider) => <button key={provider.id} type="button" className="yuri-provider-choice" aria-label={provider.name || provider.id} onClick={() => onSelect(provider.id)}>
            <ProviderLogo providerId={provider.id} className="size-6 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate typography-ui-label">{provider.name || provider.id}</span>
              <span className="mt-1 block truncate typography-micro text-muted-foreground">{[...new Set(provider.methods.map((method) => method.label || t(method.type === 'oauth'
                ? 'settings.providers.auth.account' : method.type === 'key' ? 'settings.providers.page.auth.apiKeyLabel'
                  : method.type === 'env' ? 'settings.providers.auth.environment' : 'settings.providers.auth.managed')))].join(' / ') || t('settings.providers.auth.managed')}</span>
            </span>
            <Icon name="arrow-right-s" className="size-3.5 shrink-0 text-muted-foreground" />
          </button>)}
        </div>
      </div>
      {loading && <p className="yuri-settings-group-row typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>}
      {!loading && !matches.length && <p className="yuri-settings-group-row typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>}
    </SettingsGroup>
    {error && <p role="alert" className="typography-meta text-status-error">{error}</p>}
  </>;
}

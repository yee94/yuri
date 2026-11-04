import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';

export function ProviderAuthFields({ providerId, methods, apiKey, apiKeyEnabled = true, busyKey, pendingMethodIndex, details, codes,
  onKeyChange, onSaveKey, onStart, onCancel, onCodeChange, onComplete, onCopyCode, onOpen, onCopyLink }: {
  providerId: string;
  methods: ReadonlyArray<{ method: { label?: string; name?: string; description?: string; help?: string }; methodIndex: number }>;
  apiKey: string;
  apiKeyEnabled?: boolean;
  busyKey: string | null;
  pendingMethodIndex?: number;
  details: Record<string, { url?: string; instructions?: string; userCode?: string; mode: 'auto' | 'code' }>;
  codes: Record<string, string>;
  onKeyChange: (value: string) => void;
  onSaveKey: () => void;
  onStart: (index: number) => void;
  onCancel: () => void;
  onCodeChange: (key: string, value: string) => void;
  onComplete: (index: number) => void;
  onCopyCode: (code: string) => void;
  onOpen: (url: string) => void;
  onCopyLink: (url: string) => void;
}) {
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<number | 'key'>(methods[0]?.methodIndex ?? 'key');
  const activeMethod = typeof selectedMethod === 'number' && methods.some((entry) => entry.methodIndex === selectedMethod) ? selectedMethod : 'key';
  if (!methods.length && !apiKeyEnabled) return <p className="typography-meta text-muted-foreground">{t('settings.providers.auth.noMethods')}</p>;
  return <div className="yuri-provider-auth yuri-settings-section-stack">
    {(methods.length + Number(apiKeyEnabled)) > 1 && <div className="flex flex-wrap items-center gap-2" aria-label={t('settings.providers.page.auth.title')}>
      {methods.map(({ method, methodIndex }, index) => <Button key={methodIndex} variant="chip" size="xs" disabled={busyKey?.startsWith('api:')} aria-pressed={activeMethod === methodIndex}
        onClick={() => { if (activeMethod !== methodIndex) { onCancel(); setSelectedMethod(methodIndex); } }}>
        <Icon name="global" className="size-3.5" />{method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) })}
      </Button>)}
      {apiKeyEnabled && <Button variant="chip" size="xs" aria-pressed={activeMethod === 'key'} onClick={() => { if (activeMethod !== 'key') { onCancel(); setSelectedMethod('key'); } }}>
        <Icon name="key" className="size-3.5" />{t('settings.providers.page.auth.apiKeyLabel')}
      </Button>}
    </div>}
    {methods.filter((entry) => entry.methodIndex === activeMethod).map(({ method, methodIndex }, index) => {
      const key = `${providerId}:${methodIndex}`;
      const detail = details[key];
      const pending = pendingMethodIndex === methodIndex;
      const busy = busyKey === `oauth:${providerId}:${methodIndex}` || busyKey === `oauth-complete:${providerId}:${methodIndex}`;
      return <SettingsGroup key={key}>
        <div className="yuri-provider-auth-panel">
          <ProviderLogo providerId={providerId} className="size-8" />
          <span className="typography-ui-label text-foreground">{method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) })}</span>
          {(method.description || method.help) && <p className="typography-meta text-muted-foreground">{method.description || method.help}</p>}
          {pending && <div role="status" className="flex items-center gap-2 typography-meta text-muted-foreground">
            <Icon name="loader-4" className="size-4 motion-safe:animate-spin" />
            {t('settings.providers.page.auth.waiting')}
          </div>}
          {detail?.instructions && <p className="max-w-full break-words typography-meta text-muted-foreground">{detail.instructions}</p>}
          {detail?.userCode && <div className="flex w-full min-w-0 items-center gap-2">
            <Input aria-label={t('settings.providers.page.actions.copyCode')} value={detail.userCode} readOnly className="min-w-0 font-mono text-center tracking-widest" />
            <Button variant="ghost" size="xs" onClick={() => onCopyCode(detail.userCode!)}>{t('settings.providers.page.actions.copyCode')}</Button>
          </div>}
          {detail?.url && <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-2">
            <Input aria-label={t('settings.providers.page.actions.copy')} value={detail.url} readOnly className="w-full min-w-0 text-xs text-muted-foreground" />
            <Button size="xs" onClick={() => onOpen(detail.url!)}>{t('settings.providers.page.actions.open')}<Icon name="external-link" className="size-3.5" /></Button>
            <Button variant="ghost" size="xs" onClick={() => onCopyLink(detail.url!)}>{t('settings.providers.page.actions.copy')}</Button>
          </div>}
          {pending && detail?.mode === 'code' && <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-2">
            <Input aria-label={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
              placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')} value={codes[key] ?? ''}
              onChange={(event) => onCodeChange(key, event.target.value)} className="font-mono text-xs" />
            <Button size="xs" disabled={busy || !codes[key]?.trim()} onClick={() => onComplete(methodIndex)}>{t('settings.providers.page.actions.complete')}</Button>
          </div>}
          <div className="flex flex-wrap justify-center gap-2">
            {!pending && <Button size="sm" disabled={Boolean(busyKey)} onClick={() => onStart(methodIndex)}>
              {t('settings.providers.page.actions.connect')}
            </Button>}
            {pending && <Button variant="ghost" size="sm" onClick={onCancel}>{t('settings.common.actions.cancel')}</Button>}
          </div>
        </div>
      </SettingsGroup>;
    })}
    {activeMethod === 'key' && apiKeyEnabled && <SettingsGroup>
      <form className="yuri-settings-group-row flex min-w-0 flex-col gap-2" onSubmit={(event) => { event.preventDefault(); onSaveKey(); }}>
        <label htmlFor={`provider-key-${providerId}`} className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.apiKeyLabel')}</label>
        <div className="flex w-full min-w-0 items-center gap-2">
        <Input bordered type={showKey ? 'text' : 'password'} autoComplete="off" aria-label={t('settings.providers.page.auth.apiKeyLabel')}
          id={`provider-key-${providerId}`} disabled={busyKey?.startsWith('api:')}
           value={apiKey} onChange={(event) => onKeyChange(event.target.value)}
            placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')} className="min-w-0 flex-1 !text-left font-mono text-xs"
            endAdornment={(
              <Button type="button" variant="ghost" size="icon" disabled={busyKey?.startsWith('api:')} aria-label={t('settings.providers.custom.toggleKey')} aria-pressed={showKey} onClick={() => setShowKey((value) => !value)}>
                <Icon name={showKey ? 'eye-off' : 'eye'} className="size-4" />
              </Button>
            )} />
        <Button type="submit" size="sm" disabled={Boolean(busyKey) || !apiKey.trim()}>
          {t(busyKey === `api:${providerId}` ? 'settings.providers.page.actions.saving' : 'settings.providers.page.actions.saveKey')}
        </Button>
        </div>
      </form>
    </SettingsGroup>}
  </div>;
}

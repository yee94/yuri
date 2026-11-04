import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import type { ConfigProvider } from '@opencode/schema/config/provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { SettingsActionHeader } from '@/components/sections/shared/SettingsActionHeader';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { refreshOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { providerConnectionQueryOptions } from './providerConnectionQueries';
import { providerSourceQueryOptions } from './providerSourceQueries';
import { CustomProviderModels } from './CustomProviderModels';
import { CustomProviderModelDialog, type CustomProviderModelDraft } from './CustomProviderModelDialog';
import { customProviderProtocols as protocols, resolveCustomProviderURL } from '../../../../../web/shared/custom-provider-protocol';
import type { DiscoveredProviderModel } from '../../../../../web/server/lib/opencode/custom-provider-models';

const newModel = (): CustomProviderModelDraft => ({ key: crypto.randomUUID(), id: '', name: '', context: '', output: '', tools: true, vision: false });

const waitForCatalog = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

export function CustomProviderForm({ onCancel }: { onCancel?: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draftId] = React.useState(() => crypto.randomUUID());
  const [protocolIndex, setProtocolIndex] = React.useState(0);
  const [name, setName] = React.useState('');
  const [baseURL, setBaseURL] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const [removed, setRemoved] = React.useState<{ model: CustomProviderModelDraft; index: number } | null>(null);
  const [models, setModels] = React.useState<CustomProviderModelDraft[]>([]);
  const [editing, setEditing] = React.useState<CustomProviderModelDraft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [savedProviderId, setSavedProviderId] = React.useState<string | null>(null);
  const saved = savedProviderId !== null;
  const [error, setError] = React.useState('');
  const [revision, setRevision] = React.useState(0);
  const endpoint = resolveCustomProviderURL(baseURL, protocols[protocolIndex].package, models[0]?.id);
  const config = React.useMemo(() => ({
    name: name.trim(), package: protocols[protocolIndex].package,
    settings: { baseURL: endpoint?.baseURL ?? '' },
    models: Object.fromEntries(models.map((model) => [model.id.trim(), {
      ...(model.name.trim() ? { name: model.name.trim() } : {}),
      capabilities: { tools: model.tools, input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] },
      ...(model.context || model.output ? { limit: {
        ...(model.context ? { context: Number(model.context) } : {}),
        ...(model.output ? { output: Number(model.output) } : {}),
      } } : {}),
    }])),
  } satisfies ConfigProvider.Info), [name, protocolIndex, endpoint?.baseURL, models]);
  const existingIds = React.useMemo(() => models.filter((model) => model.key !== editing?.key).map((model) => model.id), [models, editing?.key]);
  const lifetime = React.useRef<AbortController | null>(null);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const addDiscoveredModels = useEvent((entries: readonly DiscoveredProviderModel[]) => {
    setModels((current) => {
      const ids = new Set(current.map((model) => model.id));
      const added: CustomProviderModelDraft[] = [];
      for (const model of entries) {
        if (ids.has(model.id)) continue;
        ids.add(model.id);
        added.push({ ...newModel(), id: model.id, name: model.name,
          context: model.context ? String(model.context) : '', output: model.output ? String(model.output) : '' });
      }
      return added.length ? [...current, ...added] : current;
    });
    setError('');
  });
  const submit = useEvent(async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || editing) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    const directory = opencodeClient.getDirectory();
    const generation = getRuntimeGeneration();
    const transportIdentity = getRuntimeTransportIdentity();
    const isCurrent = () => !controller.signal.aborted && getRuntimeGeneration() === generation
      && opencodeClient.getDirectory() === directory;
    let providerId = savedProviderId;
    setError('');
    submitting.current = true;
    setBusy(true);
    try {
      if (!providerId) {
        if (!models.length) {
          setError(t('settings.providers.custom.modelsEmpty'));
          return;
        }
        if (new Set(models.map((model) => model.id.trim())).size !== models.length) {
          setError(t('settings.providers.custom.invalidModels'));
          return;
        }
        const response = await runtimeFetch('/api/config/providers/custom', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), directory }),
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => null) as { code?: string } | null;
          if (isCurrent() && failure?.code === 'PROVIDER_CLEANUP_FAILED') {
            setError(t('settings.providers.custom.cleanupFailed'));
            return;
          }
          throw new Error('save');
        }
        const result = await response.json() as { providerId?: string };
        if (typeof result.providerId !== 'string' || !result.providerId) throw new Error('save');
        if (!isCurrent()) return;
        providerId = result.providerId;
        setSavedProviderId(providerId);
        setApiKey('');
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active', queryDirectory: directory, transportIdentity });
        if (!isCurrent()) return;
        if (useConfigStore.getState().providers.some((provider) => provider.id === providerId)) break;
        if (attempt === 4) throw new Error('refresh');
        await waitForCatalog(controller.signal);
        if (!isCurrent()) return;
      }
      const options = providerConnectionQueryOptions(directory);
      void queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: providerSourceQueryOptions(directory).queryKey, exact: true });
      useConfigStore.getState().setSelectedProvider(providerId);
    } catch {
      if (isCurrent()) setError(t(providerId ? 'settings.providers.custom.refreshFailed' : 'settings.providers.custom.saveFailed'));
    } finally {
      submitting.current = false;
      if (isCurrent()) setBusy(false);
    }
  });

  return (
    <>
    <form className="yuri-settings-section-stack" onSubmit={submit}>
      <SettingsActionHeader actions={(
        <>
        {onCancel && <Button type="button" size="sm" disabled={busy} onClick={onCancel}>{t('settings.common.actions.cancel')}</Button>}
        <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>
          {busy ? t('settings.providers.page.actions.saving') : saved ? t('settings.providers.page.actions.reconnect') : t('settings.common.actions.saveChanges')}
        </Button>
        </>
      )}>
        {onCancel && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-settings-item="providers.connect">
          <Icon name="arrow-left-s" className="size-4" />{t('settings.providers.page.connect.selectProviderTitle')}
        </Button>}
      </SettingsActionHeader>
      <SettingsGroup label={t('settings.providers.page.connectionDetails.title')} cardClassName="yuri-settings-equal-controls">
        <SettingsRow label={t('settings.providers.custom.name')}>
          <Input aria-label={t('settings.providers.custom.name')} required value={name} onChange={(event) => setName(event.target.value)} disabled={busy || saved} />
        </SettingsRow>
        <SettingsRow label={t('settings.providers.custom.protocol')}>
          <Select value={String(protocolIndex)} onValueChange={(value) => { setProtocolIndex(Number(value)); setRevision((value) => value + 1); }} disabled={busy || saved}>
            <SelectTrigger aria-label={t('settings.providers.custom.protocol')}><SelectValue>{protocols[protocolIndex].label}</SelectValue></SelectTrigger>
            <SelectContent>
              {protocols.map((protocol, index) => <SelectItem key={protocol.package} value={String(index)}>{protocol.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('settings.providers.custom.baseURL')} footer={endpoint && (
          <p className="mt-1 break-all text-right typography-meta text-muted-foreground">
            {t('settings.providers.custom.urlExact', { url: endpoint.requestURL })}
          </p>
        )}>
          <Input aria-label={t('settings.providers.custom.baseURL')} type="url" required value={baseURL} placeholder="https://api.example.com"
            onChange={(event) => { setBaseURL(event.target.value); setRevision((value) => value + 1); }} disabled={busy || saved} />
        </SettingsRow>
        <SettingsRow label={t('settings.providers.page.auth.apiKeyLabel')} description={t('settings.providers.custom.optionalKey')}>
          <Input aria-label={t('settings.providers.page.auth.apiKeyLabel')} type={showKey ? 'text' : 'password'} autoComplete="off" value={apiKey}
            onChange={(event) => { setApiKey(event.target.value); setRevision((value) => value + 1); }} disabled={busy || saved}
            endAdornment={(
              <Button type="button" size="icon" variant="ghost" disabled={busy || saved} aria-label={t('settings.providers.custom.toggleKey')} aria-pressed={showKey} onClick={() => setShowKey((value) => !value)}>
                <Icon name={showKey ? 'eye-off' : 'eye'} className="size-4" />
              </Button>
            )} />
        </SettingsRow>
      </SettingsGroup>
      <CustomProviderModels input={{ draftId, revision, directory: opencodeClient.getDirectory(),
        package: protocols[protocolIndex].package, baseURL: endpoint?.baseURL ?? '', apiKey }}
        enabled={!busy && !saved} models={models} onSelect={addDiscoveredModels}
        onAdd={() => setEditing(newModel())} onEdit={setEditing}
        onRemoveAll={() => { setModels([]); setRemoved(null); }}
        onRemove={(key) => {
          const index = models.findIndex((model) => model.key === key);
          if (index < 0) return;
          setRemoved({ model: models[index], index });
          setModels((current) => current.filter((model) => model.key !== key));
        }} />
      {removed && !models.some((model) => model.id === removed.model.id) && <div role="status" className="flex items-center justify-between gap-2 typography-meta text-muted-foreground">
        <span>{t('settings.providers.models.removed', { name: removed.model.name || removed.model.id })}</span>
        <Button type="button" variant="ghost" size="xs" disabled={busy || saved} onClick={() => {
          setModels((current) => { const next = [...current]; next.splice(Math.min(removed.index, next.length), 0, removed.model); return next; });
          setRemoved(null);
        }}>{t('settings.providers.models.undo')}</Button>
      </div>}
      {error && <p role={saved ? 'status' : 'alert'} className={`typography-meta ${saved ? 'text-muted-foreground' : 'text-status-error'}`}>{error}</p>}
    </form>
    {editing && <CustomProviderModelDialog key={editing.key} model={editing} existingIds={existingIds}
      isEditing={models.some((model) => model.key === editing.key)} onClose={() => setEditing(null)}
      onSave={(model) => {
        setModels((current) => current.some((entry) => entry.key === model.key)
          ? current.map((entry) => entry.key === model.key ? model : entry) : [...current, model]);
        setEditing(null);
        setError('');
      }} />}
    </>
  );
}

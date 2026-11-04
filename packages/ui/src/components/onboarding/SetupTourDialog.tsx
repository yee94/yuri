import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { PluginIcon } from '@/components/sections/plugins/PluginIcon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import doubaoLogo from '@/assets/model-icons/doubao.svg';
import { YuriWordmark } from '@/components/ui/YuriWordmark';
import { YuriLogo } from '@/components/ui/YuriLogo';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { VolcengineSpeechSettings } from '@/components/sections/yuri/VolcengineSpeechSettings';
import { VoiceSettings } from '@/components/sections/yuri/VoiceSettings';
import { useSpeechSettingsForm } from '@/components/sections/yuri/useSpeechSettingsForm';
import { speechSettingsQueryOptions } from '@/queries/speechSettingsQueries';
import { pluginRegistryQueryOptions, usePluginConfigDirectory, usePluginsQuery } from '@/queries/pluginQueries';
import { providerCatalogQueryOptions } from '@/queries/configCatalogQueries';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSetupTourStore, type SetupTourStep } from '@/stores/useSetupTourStore';
import type { RegistryResult } from '@/stores/usePluginsStore';
import type { SpeechSettings } from '@/lib/voice/speechSettings';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { tourPlugins, hasTourPlugin, installRecommendedPlugins } from './tourPlugins';
import './setup-tour.css';

const specs = tourPlugins.map((plugin) => plugin.spec);
const stepKeys = ['tour.models', 'tour.plugins', 'tour.voice'] as const;
const providerChoices = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' },
] as const;

function TourPluginCard({ index, info, installed, selected, onSelect, onReadme }: {
  index: number; info?: RegistryResult; installed: boolean; selected: boolean;
  onSelect: () => void; onReadme: () => void;
}) {
  const { t } = useI18n();
  const plugin = tourPlugins[index];
  const metadata = info?.kind === 'npm-ok' ? info : undefined;
  return <section className={cn('yuri-tour-plugin yuri-tour-select-card', selected && 'yuri-tour-card-selected')}>
    <Button variant="ghost" className="yuri-tour-card-toggle" aria-label={plugin.name} aria-pressed={selected} onClick={onSelect}>
      <span className="yuri-tour-card-check" aria-hidden="true">{selected && <Icon name="check" className="size-5" />}</span>
    </Button>
    <div className="flex items-start gap-3 pr-10">
      <PluginIcon name={plugin.name} src={metadata?.icon} size={30} />
      <div className="min-w-0 flex-1"><h3 className="typography-ui-label font-medium">{plugin.name}</h3>
        <p className="break-all typography-micro text-muted-foreground">{plugin.spec}</p>
      </div>
      {metadata?.latestVersion && <span className="typography-micro text-muted-foreground">{metadata.latestVersion}</span>}
    </div>
    <p className="flex-1 typography-meta text-muted-foreground">{metadata?.description || (info ? t('tour.metadataUnavailable') : t('common.loading'))}</p>
    <div className="flex items-center justify-between gap-2">
      <Button size="xs" variant="ghost" className="yuri-tour-card-link" disabled={!metadata} onClick={onReadme}>README</Button>
      {installed && <span className="typography-meta text-muted-foreground">{t('tour.saved')}</span>}
    </div>
  </section>;
}

function TourVoiceForm({ settings, onComplete, onBusy }: { settings: SpeechSettings; onComplete: () => void; onBusy: (busy: boolean) => void }) {
  const { t } = useI18n();
  const form = useSpeechSettingsForm(settings, {
    voiceProvider: 'volcengine', sttProvider: 'volcengine', dictationEnabled: true, showMessageTTSButtons: true,
  });
  const onSaving = useEvent(onBusy);
  React.useEffect(() => { onSaving(form.saving); return () => onSaving(false); }, [form.saving, onSaving]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings.configured && !form.draft.apiKey?.trim()) return;
    const saved = await form.save();
    if (saved?.configured) onComplete();
  };
  return <form id="yuri-tour-voice" onSubmit={(event) => void submit(event)} className="yuri-settings-section-stack">
    <SettingsGroup label={t('settings.voice.volcengine.name')}>
      <VolcengineSpeechSettings mode="tts" form={form} />
      <VolcengineSpeechSettings mode="asr" form={form} showCredentials={false} />
    </SettingsGroup>
    {!settings.configured && !form.draft.apiKey?.trim() && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.toast.apiKeyRequired')}</p>}
  </form>;
}

export function SetupTourDialog({ runtime, onClose }: { runtime: string; onClose: () => void }) {
  const { t } = useI18n();
  const directory = usePluginConfigDirectory();
  const step = useSetupTourStore((state) => state.progress[runtime]?.step ?? 0);
  const [provider, setProvider] = React.useState<'magpie' | 'other'>('magpie');
  const [connectionId, setConnectionId] = React.useState<string | undefined>();
  const [selected, setSelected] = React.useState<string[]>(specs.slice(1));
  const [page, setPage] = React.useState<'tour' | 'providers' | 'voice' | 'asr' | 'tts'>('tour');
  const [readme, setReadme] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = getRuntimeGeneration();
  const transport = getRuntimeTransportIdentity();
  const lifetime = React.useRef<AbortController | null>(null);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const plugins = usePluginsQuery();
  const metadata = useQuery({ ...pluginRegistryQueryOptions(directory, specs.slice(1), false, transport, true), enabled: step === 1 });
  const speech = useQuery({ ...speechSettingsQueryOptions(transport), enabled: step === 2 });
  const entries = plugins.data?.entries ?? [];
  const openProvider = (id?: string) => {
    const config = useConfigStore.getState();
    const connected = id && config.providers.some((item) => item.id === id);
    setProvider('other');
    setConnectionId(connected ? undefined : id);
    config.setSelectedProvider(connected ? id : '__add_provider__');
    setPage('providers');
  };
  const current = () => !lifetime.current?.signal.aborted && generation === getRuntimeGeneration() && transport === getRuntimeTransportIdentity();
  const move = (next: SetupTourStep) => { setPage('tour'); setError(null); useSetupTourStore.getState().move(runtime, next); };
  const finish = () => { if (current()) onClose(); };
  const later = () => { if (step === 2) finish(); else move((step + 1) as SetupTourStep); };
  const proceed = async () => {
    if (submitting.current || busy || !lifetime.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const wanted = step === 0 ? provider === 'magpie' ? [specs[0]] : [] : selected;
      if (wanted.length) {
        const result = await installRecommendedPlugins(wanted, directory, lifetime.current.signal);
        if (!current()) return;
        if (result.failed.length) { setError(t('tour.installFailed', { names: result.failed.join(', ') })); return; }
        if (result.pending.length) { setError(t('tour.activationPending', { names: result.pending.join(', ') })); return; }
      }
      if (step === 0) {
        const catalog = await queryClient.fetchQuery({ ...providerCatalogQueryOptions(directory, transport), staleTime: 0 });
        if (!current()) return;
        if (catalog.partial || !catalog.providers.some((entry) => Object.keys(entry.models).length > 0)) {
          setError(t(provider === 'magpie' ? 'tour.magpieSetup' : 'tour.noModels')); return;
        }
        await useConfigStore.getState().loadProviders({ directory, forceRefresh: true, source: 'setup-tour' });
      }
      if (current()) later();
    } catch {
      if (current()) setError(t('tour.operationFailed'));
    } finally {
      submitting.current = false;
      if (current()) setBusy(false);
    }
  };
  const back = () => { if (readme !== null) setReadme(null); else if (page !== 'tour') setPage('tour'); else if (step > 0) move((step - 1) as SetupTourStep); };
  const readmeInfo = readme === null ? undefined : metadata.data?.[specs[readme]];
  const readmeContent = readmeInfo?.kind === 'npm-ok' ? readmeInfo.readme : undefined;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) { if (readme !== null || page !== 'tour') back(); else finish(); } }}>
    <DialogContent className="yuri-setup-tour yuri-settings-workspace" showCloseButton={false} aria-describedby={undefined}>
      <div className="yuri-tour-watermark" aria-hidden="true"><YuriLogo width={440} height={440} /></div>
      <DialogHeader>
        <DialogTitle className="yuri-tour-title"><span aria-hidden="true">👋</span>{t('tour.title').split('Yuri').map((part, index) => <React.Fragment key={index}>{index > 0 && <YuriWordmark width="2.05em" />}<span>{part.trim()}</span></React.Fragment>)}</DialogTitle>
      </DialogHeader>
      <div className="yuri-tour-body">
      <nav className="yuri-tour-progress" aria-label={t('tour.title')}>
        {stepKeys.map((key, index) => <Button key={key} variant="ghost" size="lg" disabled={busy} aria-current={step === index ? 'step' : undefined} onClick={() => { setReadme(null); move(index as SetupTourStep); }}>
          <span className="yuri-tour-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span>{t(key)}</span>
        </Button>)}
      </nav>
      <div className={cn('yuri-tour-content', page === 'providers' && readme === null && 'yuri-tour-provider-content')}><fieldset disabled={busy} className="contents">
        {readme !== null ? <><h3 className="typography-ui-label mb-4">{tourPlugins[readme].name} · README</h3>{readmeContent ? <SimpleMarkdownRenderer content={readmeContent} enableFileReferences={false} /> : <p className="typography-meta text-muted-foreground">{t('tour.metadataUnavailable')}</p>}</>
          : page === 'providers' ? <ProvidersPage initialConnectionId={connectionId} />
          : page === 'voice' && speech.data ? <TourVoiceForm settings={speech.data} onComplete={finish} onBusy={setBusy} />
          : page === 'asr' || page === 'tts' ? <VoiceSettings section={page} />
          : <>
            {step < 2 && ((step === 1 && metadata.isError) || plugins.isError) && <div role="alert" className="yuri-tour-feedback"><p>{t('tour.metadataUnavailable')}</p><Button size="xs" onClick={() => { if (step === 1) void metadata.refetch(); void plugins.refetch(); }}>{t('settings.plugins.status.retry')}</Button></div>}
            {step === 0 && <>
              <section className={cn('yuri-tour-magpie yuri-tour-select-card', provider === 'magpie' && 'yuri-tour-card-selected')}>
                <Button variant="ghost" className="yuri-tour-card-toggle" aria-label="Magpie" aria-pressed={provider === 'magpie'} onClick={() => setProvider(provider === 'magpie' ? 'other' : 'magpie')}>
                  <span className="yuri-tour-card-check" aria-hidden="true">{provider === 'magpie' && <Icon name="check" className="size-5" />}</span>
                </Button>
                <div className="flex w-full items-center gap-3 pr-10">
                  <ProviderLogo providerId="magpie" alt="Magpie" className="size-8 shrink-0" />
                  <span className="typography-ui-label">Magpie</span>
                  <span className="yuri-tour-recommended">{t('tour.recommended')}</span>
                </div>
                <p className="typography-meta text-muted-foreground">{t('tour.magpieDescription')}</p>
                <a className="yuri-tour-card-link typography-meta text-muted-foreground underline" href="https://usemagpie.ai/docs/start" target="_blank" rel="noreferrer">{t('tour.docs')} ↗</a>
              </section>
              <div className="yuri-tour-provider-heading"><span className="typography-meta text-muted-foreground">OpenCode</span>
                <a className="typography-meta text-muted-foreground underline" href="https://opencode.ai/docs/providers/" target="_blank" rel="noreferrer">{t('tour.docs')} ↗</a>
              </div>
              <div className="yuri-tour-provider-grid">{providerChoices.map((choice) => <Button key={choice.id} variant="ghost" className="yuri-tour-provider-choice" onClick={() => openProvider(choice.id)}>
                <ProviderLogo providerId={choice.id} alt={choice.name} className="size-6 shrink-0" /><span>{choice.name}</span>
              </Button>)}</div>
              <Button className="mt-3" size="sm" variant="ghost" onClick={() => openProvider()}>{t('tour.otherProvider')}<Icon name="arrow-right-s" className="size-4" /></Button>
            </>}
            {step === 1 && <>
              <div className="yuri-tour-plugins">{[1, 2].map((index) => <TourPluginCard key={index} index={index} info={metadata.data?.[specs[index]]} installed={hasTourPlugin(entries, specs[index])} selected={selected.includes(specs[index])} onSelect={() => setSelected((items) => items.includes(specs[index]) ? items.filter((spec) => spec !== specs[index]) : [...items, specs[index]])} onReadme={() => setReadme(index)} />)}</div>
              <a className="mt-4 inline-block typography-meta text-muted-foreground underline underline-offset-4 hover:text-foreground" href="https://opencode.ai/docs/ecosystem/#plugins" target="_blank" rel="noopener noreferrer">{t('tour.morePlugins')} ↗</a>
            </>}
            {step === 2 && <>
              <div className="yuri-tour-voice-intro">
                <h2>{t('tour.voiceHeading')}</h2>
                <p>{t('tour.voiceIntro')}</p>
              </div>
              <div className="yuri-tour-voice-capabilities">
                <section>
                  <Icon name="mic" className="yuri-tour-voice-icon" />
                  <h3>{t('settings.voice.page.section.speechRecognition')}</h3>
                  <p>{t('tour.dictationDescription')}</p>
                  <div className="yuri-tour-voice-services"><span><img src={doubaoLogo} alt="" className="size-4" />{t('settings.voice.volcengine.name')}</span><span><Icon name="computer" />{t('settings.voice.page.provider.local')}</span><span><Icon name="server" />{t('settings.voice.page.provider.server')}</span></div>
                  <Button size="sm" onClick={() => setPage('asr')}>{t('tour.configureInput')}<Icon name="arrow-right-s" className="size-4" /></Button>
                </section>
                <section>
                  <Icon name="volume-up" className="yuri-tour-voice-icon" />
                  <h3>{t('tour.readAloudTitle')}</h3>
                  <p>{t('tour.readAloudDescription')}</p>
                  <div className="yuri-tour-voice-services"><span><img src={doubaoLogo} alt="" className="size-4" />{t('settings.voice.volcengine.name')}</span><span><ProviderLogo providerId="openai" alt="OpenAI" className="size-4" />OpenAI</span><span><Icon name="computer" />{t('settings.voice.page.provider.browser')}</span><span><Icon name="cloud" />{t('settings.voice.page.provider.custom')}</span></div>
                  <Button size="sm" onClick={() => setPage('tts')}>{t('tour.configureReadAloud')}<Icon name="arrow-right-s" className="size-4" /></Button>
                </section>
              </div>
              <section className="yuri-tour-voice-recommendation">
                <img src={doubaoLogo} alt="" className="size-6 shrink-0" />
                <div><div className="flex flex-wrap items-center gap-2"><h3>{t('settings.voice.volcengine.name')}</h3><span className="yuri-tour-recommended">{t('tour.recommended')}</span></div><p>{t('tour.voiceAllowance')}</p></div>
                <Button disabled={!speech.data} size="sm" onClick={() => setPage('voice')}>{t('tour.configureVoice')}</Button>
              </section>
              {speech.isError && <div role="alert" className="yuri-tour-feedback"><p>{t('settings.voice.volcengine.loadFailed')}</p><Button size="xs" onClick={() => void speech.refetch()}>{t('settings.voice.volcengine.retry')}</Button></div>}
            </>}
          </>}
        {error && readme === null && <p role="alert" className="yuri-tour-feedback">{error}</p>}
      </fieldset></div>
      </div>
      <footer className="yuri-tour-footer">
        {(page !== 'tour' || readme !== null) && <Button variant="ghost" size="sm" disabled={busy} onClick={back}>{t('onboarding.common.actions.back')}</Button>}
        {readme === null && <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={later}>{t('tour.later')}</Button>
          {step === 2 ? <Button size="sm" disabled={busy} type={page === 'voice' ? 'submit' : 'button'} form={page === 'voice' ? 'yuri-tour-voice' : undefined} onClick={page === 'voice' ? undefined : finish}>{t(page === 'voice' ? 'settings.common.actions.saveChanges' : 'tour.finish')}</Button>
            : <Button size="sm" disabled={busy || !plugins.data || plugins.isError} aria-busy={busy} onClick={() => void proceed()}>{busy && <Icon name="loader-4" className="size-3 animate-spin" />}{t('tour.continue')}</Button>}
        </div>}
      </footer>
    </DialogContent>
  </Dialog>;
}

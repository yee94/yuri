import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
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
import { usePluginConfigDirectory } from '@/queries/pluginQueries';
import { providerCatalogQueryOptions } from '@/queries/configCatalogQueries';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSetupTourStore, type SetupTourStep } from '@/stores/useSetupTourStore';
import type { SpeechSettings } from '@/lib/voice/speechSettings';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { tourPlugins, saveRecommendedPlugins } from './tourPlugins';
import { HistoryImportStep } from './HistoryImportStep';
import './setup-tour.css';

const [magpiePlugin, ...toolPlugins] = tourPlugins;
const stepKeys = ['tour.models', 'tour.plugins', 'tour.import', 'tour.voice'] as const;
const providerChoices = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' },
] as const;

function TourPluginCard({ plugin, selected, onSelect }: {
  plugin: (typeof toolPlugins)[number];
  selected: boolean; onSelect: () => void;
}) {
  const { t } = useI18n();
  return <section className={cn('yuri-tour-plugin yuri-tour-select-card', selected && 'yuri-tour-card-selected')}>
    <Button variant="ghost" className="yuri-tour-card-toggle" aria-label={plugin.name} aria-pressed={selected} onClick={onSelect}>
      <span className="yuri-tour-card-check" aria-hidden="true">{selected && <Icon name="check" className="size-5" />}</span>
    </Button>
    <div className="flex items-start gap-3 pr-10">
      <PluginIcon name={plugin.name} size={30} />
      <div className="min-w-0 flex-1"><h3 className="typography-ui-label font-medium">{plugin.name}</h3>
        <p className="break-all typography-micro text-muted-foreground">{plugin.spec}</p>
      </div>
    </div>
    <a className="yuri-tour-card-link self-start typography-meta text-muted-foreground underline" href={`https://www.npmjs.com/package/${plugin.spec}`} target="_blank" rel="noreferrer">{t('tour.docs')} ↗</a>
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
  const [selected, setSelected] = React.useState<string[]>(() => toolPlugins.map((plugin) => plugin.spec));
  const [page, setPage] = React.useState<'tour' | 'providers' | 'voice' | 'asr' | 'tts'>('tour');
  const [busy, setBusy] = React.useState(false);
  const [importAction, setImportAction] = React.useState<{ disabled: boolean; background?: boolean }>({ disabled: true });
  const [error, setError] = React.useState<string | null>(null);
  const generation = getRuntimeGeneration();
  const transport = getRuntimeTransportIdentity();
  const lifetime = React.useRef<AbortController | null>(null);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const speech = useQuery({ ...speechSettingsQueryOptions(transport), enabled: step === 3 });
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
  const advance = () => { if (step === 3) finish(); else move((step + 1) as SetupTourStep); };
  const proceed = async () => {
    if (step === 2) { advance(); return; }
    if (submitting.current || busy || !lifetime.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const wanted = step === 0 ? provider === 'magpie' ? [magpiePlugin.spec] : [] : selected;
      if (wanted.length) {
        const saved = await saveRecommendedPlugins(wanted, lifetime.current.signal);
        if (!current()) return;
        if (!saved) { setError(t('tour.saveFailed', { names: wanted.join(', ') })); return; }
      }
      if (step === 0 && provider === 'other') {
        const catalog = await queryClient.fetchQuery({ ...providerCatalogQueryOptions(directory, transport), staleTime: 0 });
        if (!current()) return;
        if (catalog.partial || !catalog.providers.some((entry) => Object.keys(entry.models).length > 0)) {
          setError(t('tour.noModels')); return;
        }
        await useConfigStore.getState().loadProviders({ directory, forceRefresh: true, source: 'setup-tour' });
      }
      if (current()) advance();
    } catch {
      if (current()) setError(t('tour.operationFailed'));
    } finally {
      submitting.current = false;
      if (current()) setBusy(false);
    }
  };
  const back = () => setPage('tour');
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) { if (page !== 'tour') back(); else finish(); } }}>
    <DialogContent className="yuri-setup-tour yuri-settings-workspace" showCloseButton={false} aria-describedby={undefined}>
      <div className="yuri-tour-watermark" aria-hidden="true"><YuriLogo width={440} height={440} /></div>
      <DialogHeader>
        <DialogTitle className="yuri-tour-title"><span aria-hidden="true">👋</span>{t('tour.title').split('Yuri').map((part, index) => <React.Fragment key={index}>{index > 0 && <YuriWordmark width="2.05em" />}<span>{part.trim()}</span></React.Fragment>)}</DialogTitle>
      </DialogHeader>
      <div className="yuri-tour-body">
      <nav className="yuri-tour-progress" aria-label={t('tour.title')}>
        {stepKeys.map((key, index) => <Button key={key} variant="ghost" size="lg" disabled={busy} aria-current={step === index ? 'step' : undefined} onClick={() => move(index as SetupTourStep)}>
          <span className="yuri-tour-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span>{t(key)}</span>
        </Button>)}
      </nav>
      <div className={cn('yuri-tour-content', page === 'providers' && 'yuri-tour-provider-content')}><fieldset disabled={busy} className="contents">
        {page === 'providers' ? <ProvidersPage initialConnectionId={connectionId} />
          : page === 'voice' && speech.data ? <TourVoiceForm settings={speech.data} onComplete={finish} onBusy={setBusy} />
          : page === 'asr' || page === 'tts' ? <VoiceSettings section={page} />
          : <>
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
              <div className="yuri-tour-plugins">{toolPlugins.map((plugin) => <TourPluginCard key={plugin.spec} plugin={plugin} selected={selected.includes(plugin.spec)} onSelect={() => setSelected((items) => items.includes(plugin.spec) ? items.filter((spec) => spec !== plugin.spec) : [...items, plugin.spec])} />)}</div>
              <a className="mt-4 inline-block typography-meta text-muted-foreground underline underline-offset-4 hover:text-foreground" href="https://opencode.ai/docs/ecosystem/#plugins" target="_blank" rel="noopener noreferrer">{t('tour.morePlugins')} ↗</a>
            </>}
            {step === 2 && <HistoryImportStep onBusy={setBusy} directory={directory} onPrimaryChange={setImportAction} onComplete={() => move(3)} />}
            {step === 3 && <>
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
        {error && <p role="alert" className="yuri-tour-feedback">{error}</p>}
      </fieldset></div>
      </div>
      <footer className="yuri-tour-footer">
        {page !== 'tour' && <Button variant="ghost" size="sm" disabled={busy} onClick={back}>{t('onboarding.common.actions.back')}</Button>}
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={finish}>{t('tour.later')}</Button>
          {step === 2 ? <Button size="sm" type="submit" form="yuri-tour-import" disabled={busy || importAction.disabled} aria-busy={busy}>{busy && <Icon name="loader-4" className="size-3 animate-spin" />}{t(importAction.background ? 'historyImport.background' : 'historyImport.next')}</Button>
            : step === 3 ? <Button size="sm" disabled={busy} type={page === 'voice' ? 'submit' : 'button'} form={page === 'voice' ? 'yuri-tour-voice' : undefined} onClick={page === 'voice' ? undefined : finish}>{t(page === 'voice' ? 'settings.common.actions.saveChanges' : 'tour.finish')}</Button>
            : <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => void proceed()}>{busy && <Icon name="loader-4" className="size-3 animate-spin" />}{t('tour.continue')}</Button>}
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}

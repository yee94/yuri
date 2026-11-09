import { cleanup, computed, effect, Image, lifecycle, openUrl, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, NavPage, TextView } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import magpie from '../ui/src/assets/provider-logos/magpie.svg';
import openai from '../ui/src/assets/provider-logos/openai.svg';
import anthropic from '../ui/src/assets/provider-logos/anthropic.svg';
import google from '../ui/src/assets/provider-logos/google.svg';
import copilot from '../ui/src/assets/provider-logos/github-copilot.svg';
import deepseek from '../ui/src/assets/provider-logos/deepseek.svg';
import openrouter from '../ui/src/assets/provider-logos/openrouter.svg';
import doubao from '../ui/src/assets/model-icons/doubao.svg';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeCodeTextViewStyles } from './appearance';
import { SettingsGroup, settingsAction } from './settings-controls';
import { app, captureHostOperation } from './state';
import { createSetupTour, setupTourHasPlugin, setupTourPlugins, setupTourProviders, setupTourSteps, type SetupTourController, type SetupTourMetadata, type SetupTourStep } from './setup-tour-core';
import { createNativeHistoryImport, NativeHistoryImportStep } from './history-import';
import type { HistoryImportController } from './history-import-core';
import type { SetupTourLane } from './setup-tour-operation';

export type SetupTourDetail =
  | { kind: 'provider'; providerID?: string }
  | { kind: 'voice'; section: 'asr' | 'tts' | 'doubao' };
const logos = { openai, anthropic, google, 'github-copilot': copilot, deepseek, openrouter };
const stepKeys: Record<SetupTourStep, I18nKey> = { models: 'tour.models', plugins: 'tour.plugins', import: 'tour.import', voice: 'tour.voice' };

/** Capture once at route/controller construction, never at press/retry time. */
export function createNativeSetupTour(input: { directory?: string; step?: SetupTourStep; onMove?: (step: SetupTourStep) => void; onClose?: () => void; onHistoryJobsSettled?: (ids: readonly string[]) => void; historyImport?: HistoryImportController; operation?: ReturnType<typeof captureHostOperation> }) {
  if (input.historyImport && (!input.historyImport.current() || input.historyImport.directory !== (input.directory ?? null))) throw new Error('import_owner_scope_mismatch');
  const connection = app.connection(), hostID = connection?.id, origin = connection?.url, authorizationID = connection?.authorizationID;
  let retiredIdentity = false;
  const identityCurrent = () => {
    if (hostID !== app.connection()?.id || origin !== app.connection()?.url || authorizationID !== app.connection()?.authorizationID) retiredIdentity = true;
    return !retiredIdentity;
  };
  const operation = input.operation ?? captureHostOperation();
  const tour = createSetupTour({ ...input, send: operation.request, displayCurrent: identityCurrent, current: () => identityCurrent() && operation.current() });
  const historyImport = input.historyImport ?? createNativeHistoryImport({ directory: input.directory, onJobsSettled: input.onHistoryJobsSettled, operation });
  const stopCompletion = historyImport.observeCompletion(() => tour.completeImport());
  return { ...tour, historyImport, async replaceLane(next: ReturnType<typeof captureHostOperation> | SetupTourLane) {
    if (!identityCurrent()) { tour.dispose(); return false; }
    if (!next.current()) return false;
    await tour.replaceLane({ send: 'request' in next ? next.request : next.send, current: () => identityCurrent() && next.current() }); return tour.current();
  }, dispose() { stopCompletion(); if (!input.historyImport) historyImport.dispose(); tour.dispose(); } };
}

/** Owns one native NavPage, not a NavStack or a WebView. Main keeps the controller
 * across pushed settings pages and supplies real top-route activity. */
export function NativeSetupTourPage(props: {
  controller: SetupTourController & { historyImport: HistoryImportController }; active: boolean;
  onOpenDetail: (detail: SetupTourDetail) => void;
  onOpenHistoryTasks: () => void;
  onOpenReadmeLink: (url: string) => Promise<void>;
}) {
  const state = signal(props.controller.snapshot()), readme = signal<SetupTourMetadata | null>(null), linkError = signal(false);
  const selectedStep = computed(() => state().step);
  const writing = computed(() => state().busy);
  const history = props.controller.historyImport;
  const historyState = signal(history.snapshot());
  const stopHistory = history.subscribe(value => { if (props.active && state().step === 'import' && lifecycle() === 'active') historyState.set(value); });
  cleanup(stopHistory);
  const unsubscribe = props.controller.subscribe(value => state.set(value));
  cleanup(() => { unsubscribe(); props.controller.activate(false); });
  const active = () => props.active && lifecycle() === 'active' && props.controller.current();
  effect(() => {
    const visible = active(), step = selectedStep(), busy = writing();
    untracked(() => { props.controller.activate(visible); if (!visible) readme.set(null); else if (step === 'import') historyState.set(history.snapshot()); else if (!busy) void props.controller.refresh(); });
  });
  const blocked = () => !active() || state().busy || historyState()?.writing === true;
  const historyPrimary = () => { historyState(); return history.primary(); };
  function detail(value: SetupTourDetail) { if (!blocked()) { if (value.kind === 'provider') props.controller.selectProvider('other'); props.onOpenDetail(value); } }
  async function docs(url: string) {
    if (blocked()) return;
    linkError.set(false);
    try { if (!(await openUrl(url)).opened) throw new Error('not-opened'); }
    catch { if (active()) linkError.set(true); }
  }
  async function readmeLink(url: string) {
    if (blocked()) return;
    linkError.set(false);
    try { if (!props.onOpenReadmeLink) throw new Error('Resource route unavailable'); await props.onOpenReadmeLink(url); }
    catch { if (active()) linkError.set(true); }
  }
  return <NavPage testID="setup-tour-page" title={t('tour.title')} headerBackTitle="" class="flex-1 bg-background" popOnBack={!state().busy && !historyState().writing} onDismiss={() => props.controller.dismissNavigation()}>
    <Scroll class="flex-1" contentClass="p-5 gap-5 pb-6">
      <Text class="text-sm text-muted-foreground">{t('tour.description')}</Text>
      <View class="flex-row flex-wrap gap-2"><Each of={setupTourSteps}>{step => <Button testID={`setup-tour-step-${step()}`} class={settingsAction + ' selected:bg-accent'} selected={state().step === step()} disabled={blocked()} accessibilityLabel={t(stepKeys[step()])} onPress={() => props.controller.move(step())}><Text class="text-foreground">{setupTourSteps.indexOf(step()) + 1} · {t(stepKeys[step()])}</Text></Button>}</Each></View>
      <If when={!!state().error || linkError()}><View class="gap-2">
        <Text testID="setup-tour-error" class="text-sm text-destructive">{t(state().error ?? 'tour.operationFailed', { names: state().failedNames.join(', ') })}</Text>
        <Button testID="setup-tour-retry" class={settingsAction} disabled={blocked()} onPress={() => { linkError.set(false); void props.controller.refresh(); }}><Text class="text-foreground">{t('settings.plugins.status.retry')}</Text></Button>
      </View></If>
      <If when={state().step === 'models'}>
        <SettingsGroup title={t('tour.models')}>
          <Button testID="setup-tour-magpie" class="min-h-12 flex-row items-center gap-3" disabled={blocked()} accessibilityLabel="Magpie" selected={state().provider === 'magpie'} onPress={() => props.controller.selectProvider(state().provider === 'magpie' ? 'other' : 'magpie')}>
            <Icon name={state().provider === 'magpie' ? 'checkbox-circle' : 'checkbox-blank'} /><Image src={magpie} style={{ width: 32, height: 32 }} /><Text class="text-base text-foreground">Magpie</Text><Text class="text-xs text-muted-foreground">{t('tour.recommended')}</Text>
          </Button>
          <Text class="text-sm text-muted-foreground">{t('tour.magpieDescription')}</Text>
          <Text class="text-xs text-muted-foreground">{t('tour.magpieNote')}</Text>
          <Button class={settingsAction} disabled={blocked()} onPress={() => { void docs('https://usemagpie.ai/docs/start'); }}><Text class="text-foreground">{t('tour.docs')}</Text></Button>
        </SettingsGroup>
        <SettingsGroup title="OpenCode"><Each of={setupTourProviders}>{provider => <Button testID={`setup-tour-provider-${provider().id}`} class="min-h-12 flex-row items-center gap-3" disabled={blocked()} onPress={() => detail({ kind: 'provider', providerID: provider().id })}><Image src={logos[provider().id]} style={{ width: 24, height: 24 }} /><Text class="text-foreground">{provider().name}</Text><Icon name="arrow-right-s" size={16} /></Button>}</Each>
          <Button testID="setup-tour-other-provider" class={settingsAction} disabled={blocked()} onPress={() => detail({ kind: 'provider' })}><Text class="text-foreground">{t('tour.otherProvider')}</Text></Button>
          <Button class={settingsAction} disabled={blocked()} onPress={() => { void docs('https://opencode.ai/docs/providers/'); }}><Text class="text-foreground">{t('tour.docs')}</Text></Button>
        </SettingsGroup>
      </If>
      <If when={state().step === 'plugins'}>
        <Each of={setupTourPlugins.slice(1)}>{spec => <SettingsGroup title={state().metadata[spec()]?.name || spec()}>
          <Button testID={`setup-tour-plugin-${spec()}`} class="min-h-12 flex-row items-center gap-3" disabled={blocked()} accessibilityLabel={state().metadata[spec()]?.name || spec()} selected={state().selected.includes(spec())} onPress={() => props.controller.togglePlugin(spec())}>
            <Icon name={state().selected.includes(spec()) ? 'checkbox-circle' : 'checkbox-blank'} />
            <If when={!!state().metadata[spec()]?.icon}><Image src={state().metadata[spec()]?.icon || ''} style={{ width: 30, height: 30 }} /></If>
            <Text class="flex-1 text-foreground">{state().metadata[spec()]?.name || spec()}</Text>
          </Button>
          <Text class="text-xs text-muted-foreground">{spec()}</Text>
          <If when={!!state().metadata[spec()]?.latestVersion}><Text class="text-xs text-muted-foreground">{state().metadata[spec()]?.latestVersion}</Text></If>
          <Text class="text-sm text-muted-foreground">{state().metadata[spec()]?.description || t(state().loading ? 'common.loading' : 'tour.metadataUnavailable')}</Text>
          <If when={!!state().entries && setupTourHasPlugin(state().entries || [], spec())}><Text class="text-xs text-muted-foreground">{t('tour.saved')}</Text></If>
          <Button testID={`setup-tour-readme-${spec()}`} class={settingsAction} disabled={blocked() || !state().metadata[spec()]} onPress={() => readme.set(state().metadata[spec()] || null)}><Text class="text-foreground">README</Text></Button>
        </SettingsGroup>}</Each>
        <Button class={settingsAction} disabled={blocked()} onPress={() => { void docs('https://opencode.ai/docs/ecosystem/#plugins'); }}><Text class="text-foreground">{t('tour.morePlugins')}</Text></Button>
      </If>
      <If when={state().step === 'import'}><NativeHistoryImportStep controller={history} active={active() && state().step === 'import'} onOpenTasks={props.onOpenHistoryTasks} /></If>
      <If when={state().step === 'voice'}>
        <Text class="text-base text-foreground">{t('tour.voiceHeading')}</Text><Text class="text-sm text-muted-foreground">{t('tour.voiceIntro')}</Text>
        <SettingsGroup title={t('settings.voice.page.section.speechRecognition')}>
          <Text class="text-sm text-muted-foreground">{t('tour.dictationDescription')}</Text>
          <View class="flex-row flex-wrap items-center gap-2"><Image src={doubao} style={{ width: 20, height: 20 }} /><Text class="text-sm text-foreground">{t('settings.voice.volcengine.name')}</Text><Text class="text-sm text-muted-foreground">{t('settings.voice.page.provider.local')} · {t('settings.voice.page.provider.server')}</Text></View>
          <Button testID="setup-tour-asr" class={settingsAction} disabled={blocked()} onPress={() => detail({ kind: 'voice', section: 'asr' })}><Text class="text-foreground">{t('tour.configureInput')}</Text></Button>
        </SettingsGroup>
        <SettingsGroup title={t('tour.readAloudTitle')}>
          <Text class="text-sm text-muted-foreground">{t('tour.readAloudDescription')}</Text>
          <View class="flex-row flex-wrap items-center gap-2"><Image src={doubao} style={{ width: 20, height: 20 }} /><Text class="text-sm text-foreground">{t('settings.voice.volcengine.name')}</Text><Image src={openai} style={{ width: 20, height: 20 }} /><Text class="text-sm text-foreground">OpenAI</Text><Text class="text-sm text-muted-foreground">{t('settings.voice.page.provider.browser')} · {t('settings.voice.page.provider.custom')}</Text></View>
          <Button testID="setup-tour-tts" class={settingsAction} disabled={blocked()} onPress={() => detail({ kind: 'voice', section: 'tts' })}><Text class="text-foreground">{t('tour.configureReadAloud')}</Text></Button>
        </SettingsGroup>
        <SettingsGroup title={t('settings.voice.volcengine.name')}>
          <View class="flex-row items-center gap-2"><Image src={doubao} style={{ width: 28, height: 28 }} /><Text class="text-xs text-muted-foreground">{t('tour.recommended')}</Text></View>
          <Text class="text-sm text-muted-foreground">{t('tour.voiceAllowance')}</Text>
          <Text class="text-xs text-muted-foreground">{t('tour.voiceQuota')}</Text>
          <Button testID="setup-tour-doubao" class={settingsAction} disabled={blocked() || !state().speech} onPress={() => detail({ kind: 'voice', section: 'doubao' })}><Text class="text-foreground">{t('tour.configureVoice')}</Text></Button>
        </SettingsGroup>
      </If>
    </Scroll>
    <View class="flex-row flex-wrap justify-end gap-2 p-4" style={{ glassEffect: 'regular' }}>
      <Button testID="setup-tour-later" class={settingsAction} disabled={blocked()} onPress={() => props.controller.later()}><Text class="text-foreground">{t('tour.later')}</Text></Button>
      <If when={state().step === 'import'}><Button testID="setup-tour-import-next" class={settingsAction} disabled={blocked() || historyPrimary().disabled} onPress={() => { void history.proceed(); }}><Text class="text-foreground">{t(historyPrimary().background ? 'historyImport.background' : 'historyImport.next')}</Text></Button></If>
      <If when={state().step !== 'import'}><Button testID="setup-tour-continue" class={settingsAction} disabled={blocked() || (state().step === 'models' || state().step === 'plugins') && !state().entries} onPress={() => { void props.controller.proceed(); }}><Text class="text-foreground">{t(state().step === 'voice' ? 'tour.finish' : 'tour.continue')}</Text></Button></If>
    </View>
    <Sheet testID="setup-tour-readme" open={!!readme()} closeOnSwipe onOpenChange={event => { if (!event.open) readme.set(null); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: '85%' }} backdropClass="bg-background/50">
      <Scroll class="flex-1" contentClass="p-5 gap-4 pb-10"><Text class="text-base text-foreground">{readme()?.name} · README</Text><TextView markdown={readme()?.readme || t('tour.metadataUnavailable')} selectable styles={nativeCodeTextViewStyles()} links="report" onLinkPress={event => { void readmeLink(event.url); }} class="text-foreground" /><If when={linkError()}><Text class="text-sm text-destructive">{t('tour.operationFailed')}</Text></If><Button class={settingsAction} onPress={() => readme.set(null)}><Text class="text-foreground">{t('onboarding.common.actions.back')}</Text></Button></Scroll>
    </Sheet>
  </NavPage>;
}

import { cleanup, computed, effect, lifecycle, openUrl, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, NavPage } from 'nsh/base';
import { VOLCENGINE_TTS_RESOURCES, VOLCENGINE_TTS_VOICES } from '../ui/src/lib/voice/volcengine-catalog';
import { t } from './i18n';
import type { SettingsCallbacks } from './settings';
import { SettingsBasics } from './settings-basics';
import { SettingsIntegration } from './settings-integration';
import { SettingsProviders } from './settings-providers';
import { SettingsChoice, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime, type SettingsHostOperation } from './settings-controls';
import { createSetupTourDoubao, setupTourASRResources } from './setup-tour-voice';
import type { SetupTourDetail } from './setup-tour';
import type { SettingsVoiceConfirmationState } from './settings-voice-confirm';
import { SettingsVoiceTests } from './settings-voice-test';
import type { VoiceTestAsrAdapter, VoiceTestConfirmation } from './settings-voice-test-core';

/** Main pushes this as a sibling of NativeSetupTourPage, never wraps either in
 * another NavPage. Existing provider and voice settings retain their ownership. */
export function NativeSetupTourDetailPage(props: SettingsCallbacks & {
  detail: SetupTourDetail; directory?: string; active: boolean; onComplete: () => void; asrAdapter?: VoiceTestAsrAdapter | null; asrReady?: boolean; operationToken?: SettingsHostOperation | null;
}) {
  if (props.detail.kind === 'voice' && props.detail.section === 'doubao') return <NativeSetupTourDoubaoPage {...props} />;
  const detail = props.detail;
  const title = () => detail.kind === 'provider' ? t('tour.models') : t(detail.section === 'asr' ? 'tour.configureInput' : 'tour.configureReadAloud');
  return <NavPage title={title()} headerBackTitle="" class="flex-1 bg-background">
    <If when={detail.kind === 'provider' && !!detail.providerID}>
      <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10"><SettingsIntegration integrationID={detail.kind === 'provider' ? detail.providerID || '' : ''} directory={props.directory} disabled={!props.active} />
        <Button class={settingsAction} disabled={!props.active} onPress={() => props.onOpen({ page: 'providers', directory: props.directory })}><Text class="text-foreground">{t('settings.page.providers.title')}</Text></Button>
      </Scroll>
    </If>
    <If when={detail.kind === 'provider' && !detail.providerID}><SettingsProviders {...props} page="providers" active={props.active} /></If>
    <If when={detail.kind === 'voice'}><SettingsBasics {...props} page="voice" target={detail.kind === 'voice' && detail.section === 'asr' ? 'voice.sttProvider' : 'voice.voiceProvider'} active={props.active} /></If>
  </NavPage>;
}

/** Credential/resource/context form and the existing native audio-test UI. Main
 * supplies the existing recognition adapter; absent capability is unsupported,
 * never silently substituted with device dictation. */
export function NativeSetupTourDoubaoPage(props: Pick<SettingsCallbacks, 'onBack' | 'onOpen'> & { active: boolean; directory?: string; onComplete: () => void; asrAdapter?: VoiceTestAsrAdapter | null; asrReady?: boolean }) {
  const life = settingsPageLifetime(() => props.active && lifecycle() === 'active');
  const state = signal<SettingsVoiceConfirmationState>({ data: {}, changes: {}, draftRevision: 0, ready: false });
  const active = () => props.active && lifecycle() === 'active' && life.current();
  const initial = life.operation();
  const voice = createSetupTourDoubao({ send: initial?.request ?? (async () => { throw new Error('host_operation_stale'); }), current: life.current, active, changed: value => state.set(value) });
  const ready = computed(() => state().ready);
  const customResource = signal(false), customVoice = signal(false);
  const value = (key: string) => typeof state().data[key] === 'string' ? state().data[key] as string : '';
  const disabled = () => !active() || life.busy() || !ready();
  let previous: ReturnType<typeof life.operation> | undefined;
  effect(() => { const visible = active(), operation = life.operation(); untracked(() => {
    if (operation !== previous) { previous = operation; voice.replaceLane(operation ? { send: operation.request, current: operation.current } : null); }
    voice.activate(visible); if (visible) void life.perform(() => voice.load());
  }); });
  cleanup(() => voice.dispose());
  async function confirm(): Promise<VoiceTestConfirmation | null> {
    if (disabled()) return null;
    let receipt: VoiceTestConfirmation | null = null;
    await life.perform(async () => {
      try { receipt = await voice.save(); }
      catch (error) { throw new Error(t(error instanceof Error && error.message === 'setup-tour-api-key-required' ? 'settings.providers.page.toast.apiKeyRequired' : 'tour.operationFailed')); }
    });
    return active() ? receipt : null;
  }
  async function save() {
    const receipt = await confirm();
    if (receipt && active()) props.onComplete();
  }
  async function back() {
    if (!active() || life.busy()) return;
    if (!Object.keys(state().changes).length) { props.onBack(); return; }
    const result = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('filesView.unsaved.description'), actions: [
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
      { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
      { id: 'save', label: t('filesView.unsaved.saveChanges') },
    ] });
    if (!active()) return;
    if (result.action === 'discard') props.onBack();
    else if (result.action === 'save') await save();
  }
  async function consoleLink() {
    if (disabled()) return;
    await life.perform(async () => { if (!(await openUrl('https://console.volcengine.com/speech/new')).opened) throw new Error(t('tour.operationFailed')); });
  }
  return <NavPage testID="setup-tour-doubao-page" title={t('tour.configureVoice')} headerBackTitle="" popOnBack={false} onBackPress={() => { void back(); }} class="flex-1 bg-background">
    <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
      <If when={!!life.error()}><Text class="text-sm text-destructive">{life.error()}</Text><Button class={settingsAction} disabled={life.busy() || !active()} onPress={() => { if (ready()) void save(); else void life.perform(() => voice.load()); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
      <If when={ready()}><SettingsGroup title={t('settings.voice.volcengine.name')}>
        <SettingsInput testID="setup-tour-voice-key" title={t('settings.voice.page.field.apiKey')} value={value('apiKey')} masked disabled={disabled()} onChange={next => voice.update('apiKey', next)} />
        <Text class="text-xs text-muted-foreground">{t('settings.voice.volcengine.keyHelp')}</Text>
        <If when={ready() && voice.configured()}><Text class="text-xs text-muted-foreground">{t('tour.saved')}</Text></If>
        <Button class={settingsAction} disabled={disabled()} onPress={() => { void consoleLink(); }}><Text class="text-foreground">{t('settings.voice.volcengine.openLink')}</Text></Button>
        <SettingsChoice title={t('settings.voice.volcengine.resource')} value={customResource() || !VOLCENGINE_TTS_RESOURCES.some(item => item.value === value('resourceId')) ? '$custom' : value('resourceId')} disabled={disabled()} items={[...VOLCENGINE_TTS_RESOURCES.map(item => ({ value: item.value, title: item.label })), { value: '$custom', title: t('settings.voice.volcengine.custom') }]} onChange={next => { customResource.set(next === '$custom'); if (next !== '$custom') voice.update('resourceId', next); }} />
        <If when={customResource() || !VOLCENGINE_TTS_RESOURCES.some(item => item.value === value('resourceId'))}><SettingsInput title={t('settings.voice.volcengine.resource')} value={value('resourceId')} disabled={disabled()} onChange={next => voice.update('resourceId', next)} /></If>
        <SettingsChoice title={t('settings.voice.volcengine.speaker')} value={customVoice() || value('resourceId') !== 'seed-tts-2.0' || !VOLCENGINE_TTS_VOICES.some(item => item.value === value('voice')) ? '$custom' : value('voice')} disabled={disabled()} items={[...(value('resourceId') === 'seed-tts-2.0' ? VOLCENGINE_TTS_VOICES.map(item => ({ value: item.value, title: item.label })) : []), { value: '$custom', title: t('settings.voice.volcengine.custom') }]} onChange={next => { customVoice.set(next === '$custom'); if (next !== '$custom') voice.update('voice', next); }} />
        <If when={customVoice() || value('resourceId') !== 'seed-tts-2.0' || !VOLCENGINE_TTS_VOICES.some(item => item.value === value('voice'))}><SettingsInput title={t('settings.voice.volcengine.speaker')} value={value('voice')} disabled={disabled()} onChange={next => voice.update('voice', next)} /></If>
        <SettingsChoice title={t('settings.voice.volcengine.asrResource')} value={value('asrResourceId')} disabled={disabled()} items={[...setupTourASRResources, ...(!setupTourASRResources.some(item => item.value === value('asrResourceId')) && value('asrResourceId') ? [{ value: value('asrResourceId'), title: value('asrResourceId') }] : [])]} onChange={next => voice.update('asrResourceId', next)} />
        <Text class="text-xs text-muted-foreground">{t(value('asrResourceId').endsWith('.duration') ? 'settings.voice.volcengine.durationHelp' : 'settings.voice.volcengine.concurrentHelp')}</Text>
        <SettingsInput title={t('settings.voice.volcengine.asrContext')} multiline value={value('asrContext')} disabled={disabled()} onChange={next => voice.update('asrContext', next)} />
        <Text class="text-xs text-muted-foreground">{t('settings.voice.volcengine.asrContextHelp')}</Text>
      </SettingsGroup></If>
      <If when={ready() && props.asrReady !== false}><SettingsVoiceTests tts asr active={active()} current={life.current} disabled={disabled()} dirty={Object.keys(state().changes).length > 0} draftRevision={state().draftRevision} confirm={confirm} asrAdapter={props.asrAdapter} /></If>
      <Text class="text-xs text-muted-foreground">{t('tour.voiceQuota')}</Text>
    </Scroll>
    <View class="flex-row flex-wrap gap-2 p-4" style={{ glassEffect: 'regular' }}>
      <Button class={settingsAction} disabled={disabled()} onPress={() => { void back(); }}><Text class="text-foreground">{t('tour.later')}</Text></Button>
      <Button testID="setup-tour-voice-save" class={settingsAction} disabled={disabled()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.common.actions.saveChanges')}</Text></Button>
    </View>
  </NavPage>;
}

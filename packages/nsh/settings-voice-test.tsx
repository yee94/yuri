import { cleanup, effect, host, lifecycle, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, Dialog, NavPage, NavStack, TextView } from 'nsh/base';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import { native } from './runtime';
import { SettingsGroup, settingsAction } from './settings-controls';
import { Icon } from './Icon';
import { createSettingsVoiceTestController, type VoiceTestAsrAdapter, type VoiceTestConfirmation, type VoiceTestKind, type VoiceTestState } from './settings-voice-test-core';
import { voiceTestAsrAction, voiceTestErrorLabels } from './settings-voice-test-labels';
import { voiceTestTranscriptDocument } from './settings-voice-test-presentation';

let owners = 0;
export type SettingsVoiceTestProps = {
  tts: boolean; asr: boolean; active?: boolean; current: () => boolean; disabled: boolean;
  dirty: boolean; draftRevision: number;
  /** Save + successful authoritative GET. Return null on failed/unconfirmed writes or an edited draft. */
  confirm: (kind: VoiceTestKind) => Promise<VoiceTestConfirmation | null>;
  /** Null until configured-provider native microphone/Host transport is implemented. Never substitute Speech.start. */
  asrAdapter?: VoiceTestAsrAdapter | null;
  call?: (name: string, data: Record<string, unknown>) => Promise<unknown>;
};

/** Settings testing is independent of Chat's visibility/input mode and owns no settings or credentials. */
export function SettingsVoiceTests(props: SettingsVoiceTestProps) {
  const controller = createSettingsVoiceTestController({
    owner: `settings-voice-${++owners}`, current: props.current, dirty: () => props.dirty,
    draftRevision: () => props.draftRevision, disabled: () => props.disabled, allowed: kind => kind === 'tts' ? props.tts : props.asr,
    confirm: kind => props.confirm(kind), call: props.call ?? native, asr: props.asrAdapter ?? null,
    previewText: settings => settings.voiceProvider === 'openai-compatible' ? t('settings.voice.page.preview.customServerLine')
      : t('settings.voice.page.preview.voiceLine', { voiceName: settings.voiceProvider === 'openai' ? settings.openaiVoice
        : settings.voiceProvider === 'say' ? settings.sayVoice : settings.voiceProvider === 'local' ? String(settings.localTtsVoiceId)
        : settings.voiceProvider === 'browser' && settings.browserVoice ? settings.browserVoice : 'Yuri' }),
    changed: value => state.set(value),
  });
  const state = signal(controller.snapshot());
  const subscriptions = ['speech.playing', 'speech.invalidated'].map(name => host.on(name, value => controller.event(name, value)));
  effect(() => {
    const active = props.active !== false && lifecycle() === 'active' && props.current();
    props.dirty; props.draftRevision; props.tts; props.asr;
    untracked(() => controller.activate(active));
  });
  cleanup(() => { subscriptions.forEach(stop => stop()); void controller.dispose(); });
  const blocked = () => props.disabled || props.active === false || !props.current() || lifecycle() !== 'active';
  const previewActive = () => ['saving', 'loading', 'playing', 'stopping'].includes(state().tts);
  const primary = () => { if (state().asr === 'recording') void controller.finishAsr(); else if (state().asr === 'failed') void controller.retryAsr(); else void controller.startAsr(); };
  const error = (kind: VoiceTestKind) => {
    const code = kind === 'tts' ? state().ttsError : state().asrError;
    return code ? t(voiceTestErrorLabels[code]) : '';
  };
  return <View class="gap-5">
    <If when={props.tts}><SettingsGroup title={t('settings.voice.page.actions.preview')}>
      <Button testID="settings-voice-preview" class={settingsAction} disabled={state().tts === 'stopping' || !previewActive() && blocked()} accessibilityLabel={t(previewActive() ? 'settings.voice.volcengine.stop' : 'settings.voice.page.actions.preview')} onPress={() => { void controller.preview(); }}>
        <Text class="text-foreground">{t(previewActive() ? 'settings.voice.volcengine.stop' : 'settings.voice.page.actions.preview')}</Text>
      </Button>
      <If when={!!state().ttsError}><Text testID="settings-voice-preview-error" class="text-sm text-destructive">{error('tts')}</Text></If>
    </SettingsGroup></If>
    <If when={props.asr}><SettingsGroup title={t('settings.voice.volcengine.asrTest')}>
      <Text class="text-xs text-muted-foreground">{t('settings.voice.volcengine.testHelp')}</Text>
      <Button testID="settings-voice-asr-open" class={settingsAction} disabled={blocked() || state().asr === 'saving'} onPress={() => { void controller.openAsr(); }}><Text class="text-foreground">{t(state().asr === 'saving' ? 'common.loading' : 'settings.voice.volcengine.asrTest')}</Text></Button>
      <If when={!!state().asrError && !state().asrOpen}><Text testID="settings-voice-asr-error" class="text-sm text-destructive">{error('asr')}</Text></If>
    </SettingsGroup></If>
    <If when={state().asrOpen}><SettingsVoiceAsrTestDialog state={state} controller={controller} blocked={blocked} primary={primary} error={() => error('asr')} /></If>
  </View>;
}

/** Each native presentation captures its close identity; a delayed old swipe cannot dismiss a quick reopen. */
function SettingsVoiceAsrTestDialog(props: {
  state: () => VoiceTestState; controller: ReturnType<typeof createSettingsVoiceTestController>;
  blocked: () => boolean; primary: () => void; error: () => string;
}) {
  const revision = props.state().asrRevision, navigation = createNavStack(['asr']);
  const state = props.state;
  const asrBusy = () => ['saving', 'starting', 'processing'].includes(state().asr);
  const close = () => { void props.controller.closeAsr(revision); };
  return <Dialog testID="settings-voice-asr-dialog" open presentation="formSheet" class="flex-1 bg-background" closeOnEscape closeOnBackdropPress closeOnSwipe onOpenChange={event => { if (!event.open) close(); }}>
        <NavStack state={navigation} class="flex-1">{() => <NavPage title={t('settings.voice.volcengine.asrTest')} headerClass="bg-background text-foreground" onBackPress={close}
          header={<View class="flex-row items-center justify-between p-4"><Text class="text-base text-foreground">{t('settings.voice.volcengine.asrTest')}</Text><Button class={settingsAction} onPress={close}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button></View>}
          headerRight={<Button testID="settings-voice-asr-close" class="min-h-11 px-3 items-center justify-center" onPress={close} accessibilityLabel={t('settings.common.actions.cancel')}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>}>
           <Scroll class="flex-1" contentClass="p-5 gap-5 items-center" contentStyle={nativeDensity().pages.voiceTest}>
            <Text class="text-xs text-muted-foreground">{t('settings.voice.volcengine.testHelp')}</Text>
            <Button testID="settings-voice-asr-primary" class="size-28 rounded-full bg-secondary active:bg-accent items-center justify-center disabled:opacity-40" disabled={props.blocked() || asrBusy() || state().asr === 'unsupported'} accessibilityLabel={t(voiceTestAsrAction(state()))} onPress={props.primary}>
              <Icon name={asrBusy() || state().asr === 'failed' ? 'refresh' : state().asr === 'recording' ? 'stop' : 'mic'} size={48} />
            </Button>
            <Text class="text-sm text-muted-foreground">{t(voiceTestAsrAction(state()))}</Text>
            <If when={state().asr === 'unsupported'}><Text testID="settings-voice-asr-unsupported" class="text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
            <If when={state().asr === 'finished' && !state().transcript}><Text testID="settings-voice-asr-silence" class="text-sm text-muted-foreground">{t('settings.voice.volcengine.silence')}</Text></If>
            <If when={!!(state().partial || state().transcript)}><TextView testID="settings-voice-asr-transcript" class="w-full text-foreground" classes={{ paragraph: 'text-base text-foreground' }} document={voiceTestTranscriptDocument(state().partial || state().transcript)} selectable links="report" /></If>
            <If when={!!state().asrError}><Text testID="settings-voice-asr-dialog-error" class="text-sm text-destructive">{props.error()}</Text></If>
          </Scroll>
        </NavPage>}</NavStack>
      </Dialog>;
}

import { cleanup, effect, host, lifecycle, signal, untracked, Text, View } from 'nsh';
import { Button, AlertDialog } from 'nsh/base';
import { native } from './runtime';
import { captureHostRequest } from './state';
import type { PageOperation } from './page-operations';
import { Icon } from './Icon';
import { t } from './i18n';
import { createSpeechController, type SpeechState, type SpeechIntent } from './speech-core';

let owners = 0;
export type NativeSpeech = ReturnType<typeof createNativeSpeech>;
/** Create inside Chat's lifecycle scope; pass the same owner to every action row. */
export function createNativeSpeech(input: { current: () => boolean; preferredModel?: () => { providerID?: string; modelID?: string }; operation?: () => PageOperation | null }) {
  const initialRequest = captureHostRequest();
  const state = signal<SpeechState>({ status: 'unloaded' });
  const listeners = new Set<(intent: SpeechIntent) => void>();
  let controller: ReturnType<typeof createSpeechController> | undefined, assigned: PageOperation | null | undefined, disposed = false;
  function replace(operation?: PageOperation | null) {
    const previous = controller; controller = undefined; assigned = operation;
    if (previous) void previous.dispose().catch(() => {});
    state.set({ status: 'unloaded' });
    if (disposed || input.operation && !operation?.current()) return;
    const current = () => !disposed && controller === next && input.current() && (!input.operation || assigned === operation && operation?.current() === true);
    const request = operation?.request ?? initialRequest;
    const next = createSpeechController({
    owner: `speech-${Date.now()}-${++owners}`, current, call: async (name, body) => {
      if (!['speech.release', 'speech.stop'].includes(name) && !current()) throw new Error('speech_operation_stale');
      return native(name, body);
    }, changed: value => { if (controller === next && !disposed) state.set(value); },
    summarize: async text => {
      const preferred = input.preferredModel?.();
      const result = await request('/api/small-model/generate', 'POST', {
        prompt: text,
        system: 'Summarize the assistant reply for text-to-speech listening. Reply with 2-4 sentences of plain spoken prose in the same language as the reply. No markdown, no lists, no code — mention code changes briefly in words instead.',
        ...(preferred?.providerID ? { preferredProviderID: preferred.providerID } : {}),
        ...(preferred?.modelID ? { preferredModelID: preferred.modelID } : {}),
      }) as { text?: unknown };
      return typeof result?.text === 'string' ? result.text : null;
    },
    });
    controller = next;
    next.subscribeIntent(intent => listeners.forEach(listener => listener(intent)));
  }
  if (!input.operation) replace();
  effect(() => { if (input.operation) { const operation = input.operation(); untracked(() => { if (assigned !== operation) replace(operation); }); } });
  const subscriptions = ['speech.playing', 'speech.invalidated'].map(name => host.on(name, payload => controller?.event(name, payload)));
  let wasActive = false;
  effect(() => {
    const active = lifecycle() === 'active' && input.current(), status = state().status;
    const entered = active && !wasActive; wasActive = active;
    untracked(() => {
      if (active && (entered || status === 'unloaded')) void controller?.prepare();
      else if (!active && ['loading-settings', 'loading', 'playing'].includes(status)) void controller?.stop('lifecycle').catch(() => {});
    });
  });
  const dispose = async () => { disposed = true; subscriptions.forEach(off => off()); const previous = controller; controller = undefined; await previous?.dispose(); listeners.clear(); };
  cleanup(() => { void dispose().catch(() => {}); });
  return { state, dispose, capture: () => controller, prepare: () => controller?.prepare() ?? Promise.resolve(),
    play: (...args: Parameters<ReturnType<typeof createSpeechController>['play']>) => controller?.play(...args) ?? Promise.resolve('cancelled' as const),
    stop: (...args: Parameters<ReturnType<typeof createSpeechController>['stop']>) => controller?.stop(...args) ?? Promise.resolve(),
    awake: (enabled: boolean) => controller?.awake(enabled) ?? Promise.resolve(false),
    canResume: (id: string, text: string) => controller?.canResume(id, text) ?? false,
    subscribeIntent(listener: (intent: SpeechIntent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** No network, subscriptions or lifecycle ownership in a message row. */
export function NativeSpeechAction(props: { speech: NativeSpeech; messageID: string; text: string }) {
  const own = () => props.speech.state().messageID === props.messageID;
  const active = () => own() && ['loading', 'playing'].includes(props.speech.state().status);
  const failed = () => own() && props.speech.state().status === 'error';
  const resume = () => props.speech.canResume(props.messageID, props.text);
  async function press() {
    const captured = props.speech.capture();
    if (!captured) return;
    if (active()) { await captured.stop(); return; }
    if (!resume()) { await captured.play(props.messageID, props.text); return; }
    const result = await AlertDialog.show({ title: t('chat.messageBody.tts.readAloud'), actions: [
      { id: 'resume', label: t('chat.messageBody.tts.resume') },
      { id: 'restart', label: t('chat.messageBody.tts.restart') },
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
    ] });
    if (result.action === 'resume' || result.action === 'restart') await captured.play(props.messageID, props.text, result.action === 'restart');
  }
  return <If when={props.speech.state().settings?.visible && !!props.text.trim()}><View class="flex-row items-center gap-1">
    <Button testID={`speech-${props.messageID}`} class="h-6 w-6 items-center justify-center rounded-lg active:bg-accent" hitSlop={10}
      accessibilityLabel={active() ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud')}
      onPress={() => { void press().catch(() => {}); }}>
      <Icon name={own() && props.speech.state().status === 'loading' ? 'loader-4' : active() ? 'volume-up-fill' : 'volume-up'} size={16} />
    </Button>
    <If when={failed()}><Text testID={`speech-error-${props.messageID}`} class="text-xs text-destructive">{t('chat.messageBody.tts.failed')}</Text></If>
  </View></If>;
}

/** Mount once beside the transcript so a failed settings read is not an invisible default. */
export function NativeSpeechSettingsError(props: { speech: NativeSpeech }) {
  return <If when={props.speech.state().failed && !props.speech.state().settings}><Button testID="speech-settings-retry" class="px-3 py-2 rounded-xl bg-secondary active:bg-accent" onPress={() => { void props.speech.prepare(); }}>
    <Text class="text-sm text-destructive">{t('chat.messageBody.tts.failed')}</Text>
  </Button></If>;
}

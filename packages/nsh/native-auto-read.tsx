import { cleanup, computed, effect, lifecycle, signal, Storage, untracked } from 'nsh';
import type { NativeSpeech } from './speech';
import { createNativeAutoReadController, createNativeAutoReadPreference, type NativeAutoReadPreference, type NativeAutoReadSnapshot, type NativeAutoReadState } from './native-auto-read-core';
import { nativeAutoReadBody } from './native-auto-read-reply';
import { createNativeAutoReadAwake, type NativeAutoReadAwakeState } from './native-auto-read-awake';

let preference: NativeAutoReadPreference | undefined;
/** Chat owns speech; this adapter owns only automatic admission and the shared device preference. */
export function createNativeAutoRead(input: {
  speech: NativeSpeech;
  snapshot: () => Omit<NativeAutoReadSnapshot, 'foreground'>;
  onError: (key: 'mobile.menu.autoReadFailed' | 'mobile.menu.autoReadAwakeFailed') => void;
  onWarning?: (key: 'mobile.menu.autoReadAwakeFailed') => void;
  preference?: NativeAutoReadPreference;
}) {
  const preferred = input.preference ?? (preference ??= createNativeAutoReadPreference(Storage));
  const state = signal<NativeAutoReadState>({ preferred: preferred.state().preferred, available: false, running: false, playingMessageID: null, error: preferred.state().error });
  const awakeState = signal<NativeAutoReadAwakeState>('idle');
  const awakeContext = signal({ scope: '', active: false, foreground: false });
  const running = computed(() => state().running);
  const warnAwake = () => (input.onWarning ?? input.onError)('mobile.menu.autoReadAwakeFailed');
  const awake = createNativeAutoReadAwake({ awake: input.speech.awake, changed: next => awakeState.set(next), failed: warnAwake });
  let lastError: NativeAutoReadState['error'] = null;
  const controller = createNativeAutoReadController({ speech: input.speech, preference: preferred, changed: next => {
    state.set(next);
    if (next.error && next.error !== lastError) input.onError('mobile.menu.autoReadFailed');
    lastError = next.error;
  } });
  effect(() => {
    const next = input.snapshot(), foreground = lifecycle() === 'active';
    untracked(() => {
      const previous = awakeContext();
      if (previous.scope !== next.scope || previous.active !== next.active || previous.foreground !== foreground) awakeContext.set({ scope: next.scope, active: next.active, foreground });
      controller.update({ ...next, foreground });
    });
  });
  effect(() => {
    const enabled = running(), context = awakeContext();
    untracked(() => awake.update(enabled && context.active && context.foreground, context.scope));
  });
  cleanup(() => { void awake.dispose().catch(warnAwake); void controller.dispose(); });
  return { ...controller, state, awakeState, ready: preferred.ready, retryPreference: preferred.retry, mode: () => input.speech.state().settings?.mode };
}
export type NativeAutoRead = ReturnType<typeof createNativeAutoRead>;

/** Mount beside the actual NativeTranscriptBody, inside the same virtualized row lifetime. */
export function NativeAutoReadBody(props: Omit<Parameters<typeof nativeAutoReadBody>[0], 'mode'> & { autoRead: NativeAutoRead }) {
  effect(() => {
    if (!props.autoRead.state().running) return;
    const mode = props.autoRead.mode();
    if (!mode) return;
    const body = nativeAutoReadBody({ scope: props.scope, sessionID: props.sessionID, row: props.row, plan: props.plan, streaming: props.streaming, mode });
    if (body.streaming) untracked(() => props.autoRead.streaming(body.reply));
    if (!body.completed) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => props.autoRead.rendered(body.reply));
    });
    cleanup(() => { cancelAnimationFrame(first); cancelAnimationFrame(second); });
  });
  return null;
}

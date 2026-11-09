import type { NativeBtwSpeech } from './desktop-btw-panel';
import type { NativeSpeech } from './speech';

/** A namespaced view of Chat's existing audio owner, never another provider,
 * settings request, segment queue or lifecycle subscription. */
export function createDesktopBtwSpeech(options: {
  speech: NativeSpeech;
  identity: string;
  current: () => boolean;
  resume: () => Promise<'resume' | 'restart' | 'cancel'>;
}) {
  const key = (messageID: string) => JSON.stringify(['btw', options.identity, messageID]);
  const own = (messageID: string) => options.speech.state().messageID === key(messageID);
  const port: NativeBtwSpeech = {
    state(messageID) {
      if (!options.current() || !own(messageID)) return 'idle';
      const status = options.speech.state().status;
      return status === 'playing' || status === 'loading' || status === 'error' ? status : 'idle';
    },
    async speak(messageID, text) {
      if (!options.current() || !options.speech.state().settings?.visible || !text.trim()) return;
      const captured = options.speech.capture(), id = key(messageID);
      if (!captured) return;
      let restart = false;
      if (options.speech.canResume(id, text)) {
        const choice = await options.resume();
        if (choice === 'cancel') return;
        restart = choice === 'restart';
      }
      if (!options.current() || options.speech.capture() !== captured || !options.speech.state().settings?.visible) return;
      await captured.play(id, text, restart);
    },
    async stop(messageID) {
      // A hidden side panel cannot interrupt audio subsequently started by Chat.
      if (own(messageID)) await options.speech.stop();
    },
  };
  return () => options.current() && options.speech.state().settings?.visible ? port : undefined;
}

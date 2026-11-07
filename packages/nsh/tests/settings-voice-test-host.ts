import { speechDefaults, type SpeechSettings } from '../../ui/src/lib/voice/speechSettings';
import type { VoiceTestAsrAdapter, VoiceTestAsrSession } from '../settings-voice-test-core';

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Strict synthetic provider/audio. No synthesis, recording, sockets, credentials or settings writes. */
export function createVoiceTestHost(overrides: Partial<SpeechSettings> = {}) {
  const settings = { ...speechDefaults, ...overrides };
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [], routes: Array<string | null> = [];
  const asrCalls: string[] = [];
  let owner = '', revision = 0;
  let playing: ReturnType<typeof deferred<unknown>> | null = null;
  let prepareGate: ReturnType<typeof deferred<unknown>> | null = null;
  let asrStartGate: ReturnType<typeof deferred<void>> | null = null;
  let final = deferred<{ text: string }>();
  let partial: ((text: string) => void) | null = null;
  let observedProvider: SpeechSettings['sttProvider'] | null = null;
  let returnedProvider: SpeechSettings['sttProvider'] | null = null;
  const failures = new Map<string, number>();
  let event: (name: string, payload: unknown) => void = () => {};
  const exact = (input: object, expected: string) => {
    if (Object.keys(input).sort().join(',') !== expected) throw new Error('Unexpected voice-test fixture payload');
  };
  const asr: VoiceTestAsrAdapter = {
    supports: provider => ['local', 'openai-compatible', 'volcengine'].includes(provider),
    cancelStart: async input => { exact(input, 'owner,revision'); asrCalls.push('cancel-start'); },
    async start(input) {
      exact(input, 'owner,partial,provider,revision');
      if (!input.owner || !Number.isInteger(input.revision) || input.revision < 1 || input.provider !== settings.sttProvider) throw new Error('Unexpected synthetic ASR provider');
      asrCalls.push('start'); observedProvider = input.provider; partial = input.partial;
      if (asrStartGate) await asrStartGate.promise;
      const session: VoiceTestAsrSession = { provider: returnedProvider ?? settings.sttProvider,
        finish: () => { asrCalls.push('finish'); return final.promise; },
        cancel: async () => { asrCalls.push('cancel'); if (failures.get('asr.cancel')) { failures.set('asr.cancel', failures.get('asr.cancel')! - 1); throw new Error('Synthetic cleanup failure'); } },
      };
      return session;
    },
  };
  async function call(name: string, input: Record<string, unknown>) {
    calls.push({ name, input });
    if (failures.get(name)) { failures.set(name, failures.get(name)! - 1); throw new Error('Synthetic audio failure'); }
    if (name === 'speech.prepare') {
      exact(input, 'owner');
      if (typeof input.owner !== 'string' || !input.owner) throw new Error('Invalid synthetic speech owner');
      if (prepareGate) await prepareGate.promise;
      owner = input.owner; revision = 0;
      return { provider: settings.voiceProvider, visible: settings.showMessageTTSButtons, mode: settings.ttsInputMode };
    }
    if (name === 'speech.segment') {
      exact(input, 'owner,revision,source,text');
      if (input.owner !== owner || typeof input.revision !== 'number' || input.revision <= revision || input.source !== 'settings-preview' ||
        typeof input.text !== 'string' || !input.text.trim()) throw new Error('Invalid synthetic speech segment');
      revision = input.revision;
      routes.push(settings.voiceProvider === 'browser' ? null : settings.voiceProvider === 'local' ? '/api/dictation/tts/speak' : settings.voiceProvider === 'say' ? '/api/tts/say/speak' : '/api/tts/speak');
      playing = deferred<unknown>(); event('speech.playing', { owner, revision });
      return playing.promise;
    }
    if (name === 'speech.stop') {
      exact(input, 'owner,revision');
      if (input.owner === owner) { playing?.resolve(null); playing = null; }
      return null;
    }
    if (name === 'speech.release') {
      exact(input, 'owner');
      if (input.owner === owner) { playing?.resolve(null); playing = null; owner = ''; }
      return null;
    }
    throw new Error('Unexpected voice-test fixture native call');
  }
  return { settings, calls, routes, call, asr, asrCalls, provider: () => observedProvider,
    onEvent: (listener: typeof event) => { event = listener; },
    completeAudio: () => { playing?.resolve(null); playing = null; },
    failAudio: () => { playing?.reject(new Error('synthetic-private-provider-error')); playing = null; },
    holdPrepare: () => { prepareGate = deferred<unknown>(); return prepareGate; },
    holdAsrStart: () => { asrStartGate = deferred<void>(); return asrStartGate; },
    returnAsrProvider: (provider: SpeechSettings['sttProvider']) => { returnedProvider = provider; },
    failNext: (name: string) => { failures.set(name, (failures.get(name) ?? 0) + 1); },
    emitPartial: (text: string) => partial?.(text),
    final: (text: string) => final.resolve({ text }),
    failFinal: () => final.reject(new Error('synthetic-private-ASR-error')),
    retryFinal: () => { final = deferred<{ text: string }>(); },
  };
}

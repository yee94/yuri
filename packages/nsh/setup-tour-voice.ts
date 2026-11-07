import { createSettingsVoiceConfirmation, type SettingsVoiceConfirmationState } from './settings-voice-confirm';
import type { SettingsRequest } from './settings-protocol';
import { parseSpeechSettings } from '../ui/src/lib/voice/speechSettings';

export const setupTourASRResources = [
  { value: 'volc.seedasr.sauc.duration', title: 'Seed ASR 2.0 · duration' },
  { value: 'volc.seedasr.sauc.concurrent', title: 'Seed ASR 2.0 · concurrent' },
  { value: 'volc.bigasr.sauc.duration', title: 'Big ASR 1.0 · duration' },
  { value: 'volc.bigasr.sauc.concurrent', title: 'Big ASR 1.0 · concurrent' },
] as const;

/** The existing Voice owner remains the sole wire/secret/ACK implementation.
 * Recommendation defaults are draft edits, applied only inside an explicitly
 * opened Doubao form, never PUT by opening or resuming the Tour. */
export function createSetupTourDoubao(input: {
  send: SettingsRequest; current: () => boolean; active: () => boolean;
  changed: (value: SettingsVoiceConfirmationState) => void;
}) {
  let configured = false;
  const bind = (lane: { send: SettingsRequest; current: () => boolean }): SettingsRequest => async (...args) => {
    const result = await lane.send(...args);
    if (lane.current() && args[0] === '/api/voice/settings') configured = parseSpeechSettings(result).configured;
    return result;
  };
  const voice = createSettingsVoiceConfirmation({ ...input, send: bind(input) });
  let laneCurrent = input.current;
  let prepared = false;
  return {
    snapshot: voice.snapshot, activate: voice.activate, update: voice.update, dispose: voice.dispose,
    configured: () => configured,
    replaceLane(next: { send: SettingsRequest; current: () => boolean } | null) { laneCurrent = next?.current ?? (() => false); voice.replaceLane(next ? { send: bind(next), current: next.current } : null); },
    async load() {
      await voice.load();
      if (prepared || !voice.snapshot().ready || !laneCurrent() || !input.active()) return;
      prepared = true;
      for (const [key, value] of Object.entries({ voiceProvider: 'volcengine', sttProvider: 'volcengine', dictationEnabled: true, showMessageTTSButtons: true })) voice.update(key, value);
    },
    async save() {
      const state = voice.snapshot();
      if (!configured && !(typeof state.changes.apiKey === 'string' && state.changes.apiKey.trim())) throw new Error('setup-tour-api-key-required');
      const receipt = await voice.confirm('tts');
      if (!receipt?.settings.configured) return null;
      return receipt;
    },
  };
}

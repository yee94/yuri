import { settingsObject, type SettingsRequest } from './settings-protocol';

export type NativeVoiceIdentity = { identifier: string; name: string; language: string };
export type NativeVoiceCatalog = { voices: NativeVoiceIdentity[] };
export function parseNativeVoiceCatalog(value: unknown): NativeVoiceCatalog {
  const result = settingsObject(value);
  if (!Array.isArray(result.voices)) throw new Error('native-voice-catalog-invalid');
  const ids = new Set<string>();
  const voices = result.voices.map(item => {
    const row = settingsObject(item);
    if (typeof row.identifier !== 'string' || !row.identifier || ids.has(row.identifier) || typeof row.name !== 'string' || !row.name || typeof row.language !== 'string' || !row.language) throw new Error('native-voice-catalog-invalid');
    ids.add(row.identifier);
    return { identifier: row.identifier, name: row.name, language: row.language };
  });
  return { voices };
}
/** A Web voice name is not an AVSpeechSynthesisVoice identifier. Never guess. */
export function resolveNativeBrowserVoice(catalog: NativeVoiceCatalog, browserVoice: string): NativeVoiceIdentity | null {
  if (!browserVoice) return null;
  const matches = catalog.voices.filter(voice => voice.name === browserVoice);
  if (matches.length !== 1) throw new Error('native-browser-voice-unmapped');
  return matches[0];
}
export async function readSayVoiceCatalog(send: SettingsRequest) {
  const result = settingsObject(await send('/api/tts/say/status'));
  if (typeof result.available !== 'boolean' || !Array.isArray(result.voices)) throw new Error('say-voice-catalog-invalid');
  const voices = result.voices.map(item => {
    const row = settingsObject(item);
    if (typeof row.name !== 'string' || !row.name || typeof row.locale !== 'string') throw new Error('say-voice-catalog-invalid');
    return { name: row.name, locale: row.locale };
  });
  return { available: result.available, voices };
}

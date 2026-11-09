import { expect, test, vi } from 'vitest';
import { parseNativeVoiceCatalog, readSayVoiceCatalog, resolveNativeBrowserVoice } from './settings-voice-catalog-core';

test('native directory maps an exact unique Web name to the real UIKit identifier; no name-as-ID fallback', () => {
  const catalog = parseNativeVoiceCatalog({ voices: [{ identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US' }] });
  expect(resolveNativeBrowserVoice(catalog, 'Samantha')?.identifier).toBe('com.apple.voice.compact.en-US.Samantha');
  expect(resolveNativeBrowserVoice(catalog, '')).toBeNull();
  expect(() => resolveNativeBrowserVoice(catalog, 'com.apple.voice.compact.en-US.Samantha')).toThrow('unmapped');
  expect(() => resolveNativeBrowserVoice({ voices: [...catalog.voices, { ...catalog.voices[0], identifier: 'enhanced' }] }, 'Samantha')).toThrow('unmapped');
});
test('say uses the real Host capability route and preserves native name/locale identity', async () => {
  const send = vi.fn(async () => ({ available: true, voices: [{ name: 'Tingting', locale: 'zh_CN' }] }));
  expect(await readSayVoiceCatalog(send)).toEqual({ available: true, voices: [{ name: 'Tingting', locale: 'zh_CN' }] });
  expect(send).toHaveBeenCalledWith('/api/tts/say/status');
  await expect(readSayVoiceCatalog(async () => ({ available: false }))).rejects.toThrow();
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import { settingsBasicFields, settingsBasicTarget } from './settings-basics-core';
import { voiceLocalModels } from './settings-voice-models-core';
import { parseNativeVoiceCatalog, readSayVoiceCatalog, resolveNativeBrowserVoice } from './settings-voice-catalog-core';
import { parseSpeechSettings, speechDefaults } from '../ui/src/lib/voice/speechSettings';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(directory, relative), 'utf8');
it('local management models match Web and Host catalogs without loading either runtime', () => {
  const web = source('../ui/src/components/sections/yuri/VoiceSettings.tsx');
  const host = source('../web/server/lib/dictation/local/model-catalog.js');
  for (const model of voiceLocalModels) { expect(web).toContain(model.id); expect(host).toContain(model.id); }
  const fields = settingsBasicFields('voice');
  expect(fields.find(field => field.key === 'sttLocalModel')).toMatchObject({ managed: true });
  expect(fields.find(field => field.key === 'localTtsVoiceId')).toMatchObject({ managed: true, kind: 'number', min: 0, max: 10 });
  const managed = fields.filter(field => field.managed);
  const groups = {
    hostLocalModels: ['sttLocalModel', 'localTtsVoiceId'],
    hostSayCatalog: ['sayVoice'],
    deviceSpeechCatalog: ['browserVoice'],
  };
  expect(managed.map(field => field.key)).toEqual(Object.values(groups).flat());
  expect(managed.filter(field => groups.hostLocalModels.includes(field.key)).map(field => settingsBasicTarget('voice', field))).toEqual(['voice.sttLocalModel', 'voice.localTtsVoiceId']);
  for (const key of [...groups.hostSayCatalog, ...groups.deviceSpeechCatalog]) expect(fields.find(field => field.key === key)).toMatchObject({ kind: 'text', managed: true });
  // A device-owned voice directory does not make its saved Web name a device-only preference.
  for (const field of managed) expect(field.local).not.toBe(true);
  const publicSettings = parseSpeechSettings({ ...speechDefaults, sttLocalModel: voiceLocalModels.find(model => model.kind === 'stt')!.id, localTtsVoiceId: 10, sayVoice: 'Tingting', browserVoice: 'Samantha' });
  expect(publicSettings).toMatchObject({ sttLocalModel: voiceLocalModels[0].id, localTtsVoiceId: 10, sayVoice: 'Tingting', browserVoice: 'Samantha' });
});
it('separates the Host say catalog from device browser speech identities without swapping their storage meaning', async () => {
  const paths: string[] = [];
  const say = await readSayVoiceCatalog(async path => { paths.push(path); return { available: true, voices: [{ name: 'Tingting', locale: 'zh_CN' }] }; });
  expect(paths).toEqual(['/api/tts/say/status']);
  expect(say.voices[0]).toEqual({ name: 'Tingting', locale: 'zh_CN' });
  const device = parseNativeVoiceCatalog({ voices: [{ identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US' }] });
  expect(resolveNativeBrowserVoice(device, 'Samantha')?.identifier).toBe('com.apple.voice.compact.en-US.Samantha');
  expect(() => resolveNativeBrowserVoice(device, 'Tingting')).toThrow('unmapped');
  expect(() => resolveNativeBrowserVoice(device, device.voices[0].identifier)).toThrow('unmapped');
});
it('the unique native Host-storage explanation exists in all ten real dictionaries', () => {
  const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk'];
  const values = locales.map(locale => {
    const dictionary = source(`../ui/src/lib/i18n/messages/${locale}.settings.ts`);
    const matches = [...dictionary.matchAll(/['"]settings\.voice\.nativeModels\.hostStorage['"]:\s*(['"])(.+)\1,/g)];
    expect(matches).toHaveLength(1); expect(matches[0][2].length).toBeGreaterThan(20); return matches[0][2];
  });
  expect(new Set(values).size).toBe(10);
});

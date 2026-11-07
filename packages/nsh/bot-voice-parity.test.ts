import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import { settingsBasicFields, settingsBasicTarget } from './settings-basics-core';
import { voiceLocalModels } from './settings-voice-models-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(directory, relative), 'utf8');
it('local management models match Web and Host catalogs without loading either runtime', () => {
  const web = source('../ui/src/components/sections/yuri/VoiceSettings.tsx');
  const host = source('../web/server/lib/dictation/local/model-catalog.js');
  for (const model of voiceLocalModels) { expect(web).toContain(model.id); expect(host).toContain(model.id); }
  const fields = settingsBasicFields('voice');
  expect(fields.find(field => field.key === 'sttLocalModel')).toMatchObject({ managed: true });
  expect(fields.find(field => field.key === 'localTtsVoiceId')).toMatchObject({ managed: true, kind: 'number', min: 0, max: 10 });
  expect(fields.filter(field => field.managed).map(field => settingsBasicTarget('voice', field))).toEqual(['voice.sttLocalModel', 'voice.localTtsVoiceId']);
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

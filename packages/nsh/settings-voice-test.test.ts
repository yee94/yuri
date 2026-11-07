import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW';
import { dict as ja } from '../ui/src/lib/i18n/messages/ja';
import { dict as ko } from '../ui/src/lib/i18n/messages/ko';
import { dict as fr } from '../ui/src/lib/i18n/messages/fr';
import { dict as es } from '../ui/src/lib/i18n/messages/es';
import { dict as pl } from '../ui/src/lib/i18n/messages/pl';
import { dict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR';
import { dict as uk } from '../ui/src/lib/i18n/messages/uk';
import { voiceTestLabels } from './settings-voice-test-labels';
import { voiceTestTranscriptDocument } from './settings-voice-test-presentation';

test('ASR results remain exact literal TextView nodes, not interpreted Markdown, HTML or links', () => {
  const text = '**literal**\n<script>not HTML</script> [not a link](https://example.invalid)\n中文 🎤';
  expect(voiceTestTranscriptDocument(text)).toEqual({ blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
});

test.each(Object.entries({ en, zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk }))('settings test UI has complete existing %s translations', (_language, dict) => {
  for (const key of voiceTestLabels) expect(dict[key], key).toEqual(expect.any(String));
});

test('settings test component has its own native dialog/lifecycle and reuses Settings controls without browser or system-ASR shortcuts (static only)', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'settings-voice-test.tsx'), 'utf8');
  expect(source).toContain('createSettingsVoiceTestController');
  expect(source).toContain('SettingsGroup, settingsAction');
  expect(source).toContain('<Dialog testID="settings-voice-asr-dialog"');
  expect(source).toContain('presentation="formSheet"');
  expect(source).toContain('<NavStack'); expect(source).toContain('<NavPage');
  expect(source).toContain('onOpenChange={event => { if (!event.open) close(); }}');
  expect(source).toContain("lifecycle() === 'active'");
  expect(source).toContain('controller.dispose()');
  expect(source).toContain('props.asrAdapter ?? null');
  expect(source).toContain('document={voiceTestTranscriptDocument(state().partial || state().transcript)} selectable links="report"');
  expect(source).not.toMatch(/<Text\b[^>]*\bselectable\b/);
  expect(source).not.toMatch(/\bSpeech\.start\s*\(|\bnew Audio\s*\(|\bfetch\s*\(/);
  expect(source).not.toContain('createNativeSpeech');
});

import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { VoiceTestError, VoiceTestState } from './settings-voice-test-core';

export const voiceTestErrorLabels: Record<VoiceTestError, I18nKey> = {
  'save-failed': 'settings.voice.volcengine.saveFailed',
  changed: 'filesView.unsaved.title',
  'not-configured': 'settings.providers.page.toast.apiKeyRequired',
  'playback-failed': 'chat.messageBody.tts.failed',
  'asr-failed': 'chat.dictation.failed',
  'cleanup-failed': 'common.unavailable',
};
export function voiceTestAsrAction(state: VoiceTestState): I18nKey {
  return state.asr === 'failed' ? 'chat.dictation.retry'
    : state.asr === 'recording' ? 'settings.voice.volcengine.finishRecording'
    : state.asr === 'processing' ? 'chat.dictation.processing'
    : state.asr === 'saving' || state.asr === 'starting' ? 'common.loading'
    : 'settings.voice.volcengine.startRecording';
}

/** Existing shared keys, all shipped in the ten dictionaries; no English-only native copy. */
export const voiceTestLabels: readonly I18nKey[] = [
  ...Object.values(voiceTestErrorLabels), 'settings.voice.page.actions.preview', 'settings.voice.volcengine.stop',
  'settings.voice.volcengine.asrTest', 'settings.voice.volcengine.testHelp', 'settings.voice.volcengine.silence',
  'settings.voice.volcengine.finishRecording', 'settings.voice.volcengine.startRecording', 'chat.dictation.processing',
  'chat.dictation.retry',
  'common.loading', 'settings.common.actions.cancel', 'settings.voice.page.preview.voiceLine', 'settings.voice.page.preview.customServerLine',
];

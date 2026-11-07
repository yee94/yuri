import { t } from './i18n';

export type NewSessionMessage = 'unknownTitle' | 'unknownBody' | 'recoveryID' | 'recoveryChoose' | 'recoveryNotEmpty' | 'recoveryMismatch' | 'storageFailed' | 'operationFailed' | 'handedOff' | 'reviewSessions' | 'selectedSession' | 'capturedInput';

export function newSessionText(key: NewSessionMessage, params: Record<string, string> = {}) {
  return t(`chat.newSessionDraft.${key}`, params);
}

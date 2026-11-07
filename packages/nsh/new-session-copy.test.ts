import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const system = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('nsh', () => ({
  locale: () => system.locale,
  signal: <T>(initial: T) => {
    let value = initial;
    return Object.assign(() => value, { set: (next: T) => { value = next; } });
  },
}));

import { language, t } from './i18n';
import { newSessionText, type NewSessionMessage } from './new-session-copy';

const dictionaries = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr, es, pl, 'pt-BR': ptBR, uk };
const messages = [
  'unknownTitle', 'unknownBody', 'recoveryID', 'recoveryChoose',
  'recoveryNotEmpty', 'recoveryMismatch', 'storageFailed', 'operationFailed',
  'handedOff', 'reviewSessions', 'selectedSession', 'capturedInput',
] as const satisfies readonly NewSessionMessage[];

describe('new-session copy from the shared ten-language dictionaries', () => {
  beforeEach(() => {
    language.set('system');
    system.locale = 'en';
  });

  it.each(Object.entries(dictionaries))('%s contains all 12 translated messages with consistent parameters', (locale, dictionary) => {
    const keys = Object.keys(dictionary).filter(key => key.startsWith('chat.newSessionDraft.')).sort();
    expect(keys).toEqual(messages.map(key => `chat.newSessionDraft.${key}`).sort());

    for (const message of messages) {
      const key = `chat.newSessionDraft.${message}` as const;
      const value = dictionary[key];
      expect(value.trim(), key).not.toBe('');
      expect(value.match(/\{\w+\}/g) ?? [], key).toEqual(message === 'selectedSession' ? ['{id}'] : []);
      if (locale !== 'en') expect(value, key).not.toBe(en[key]);
    }
  });

  it.each(Object.entries(dictionaries))('%s resolves every message through NSH i18n and interpolates the session ID', (locale, dictionary) => {
    language.set(locale);
    const id = 'ses_$&_{id}';
    for (const message of messages) {
      const key = `chat.newSessionDraft.${message}` as const;
      const expected = dictionary[key].replace('{id}', () => id);
      expect(newSessionText(message, { id })).toBe(expected);
      expect(newSessionText(message, { id })).toBe(t(key, { id }));
    }
    expect(newSessionText('selectedSession')).toBe(dictionary['chat.newSessionDraft.selectedSession']);
    expect(language()).toBe(locale);
  });

  it.each([
    ['en-US', 'en'], ['zh-CN', 'zh-CN'], ['zh-Hans-SG', 'zh-CN'],
    ['zh-Hant-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['ja-JP', 'ja'],
    ['ko-KR', 'ko'], ['fr-FR', 'fr'], ['es-ES', 'es'], ['pl-PL', 'pl'],
    ['pt-PT', 'pt-BR'], ['pt-BR', 'pt-BR'], ['uk-UA', 'uk'], ['de-DE', 'en'],
  ] as const)('uses NSH system-locale normalization and fallback for %s', (locale, expected) => {
    system.locale = locale;
    expect(newSessionText('unknownTitle')).toBe(dictionaries[expected]['chat.newSessionDraft.unknownTitle']);
    expect(language()).toBe('system');
    expect(system.locale).toBe(locale);
  });

  it('follows locale changes without changing the selected language or system locale', () => {
    system.locale = 'zh-Hant-TW';
    expect(newSessionText('unknownTitle')).toBe(zhTW['chat.newSessionDraft.unknownTitle']);
    language.set('pt-BR');
    expect(newSessionText('unknownTitle')).toBe(ptBR['chat.newSessionDraft.unknownTitle']);
    system.locale = 'ja-JP';
    expect(newSessionText('unknownTitle')).toBe(ptBR['chat.newSessionDraft.unknownTitle']);
    expect(language()).toBe('pt-BR');
    language.set('system');
    expect(newSessionText('unknownTitle')).toBe(ja['chat.newSessionDraft.unknownTitle']);
    expect(system.locale).toBe('ja-JP');
  });
});

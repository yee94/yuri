import { expect, it } from 'vitest';
import { settingsDict as en } from '../ui/src/lib/i18n/messages/en.settings';
import { settingsDict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN.settings';
import { settingsDict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW.settings';
import { settingsDict as ja } from '../ui/src/lib/i18n/messages/ja.settings';
import { settingsDict as ko } from '../ui/src/lib/i18n/messages/ko.settings';
import { settingsDict as fr } from '../ui/src/lib/i18n/messages/fr.settings';
import { settingsDict as es } from '../ui/src/lib/i18n/messages/es.settings';
import { settingsDict as pl } from '../ui/src/lib/i18n/messages/pl.settings';
import { settingsDict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR.settings';
import { settingsDict as uk } from '../ui/src/lib/i18n/messages/uk.settings';

it('ships the 21 formal settings.github.native keys in all ten shared locale dictionaries', () => {
  const keys = Object.keys(en).filter(key => key.startsWith('settings.github.native.'));
  expect(keys).toHaveLength(21);
  const dictionaries: Record<string, Record<string, string>> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr, es, pl, 'pt-BR': ptBR, uk };
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    expect(Object.keys(dictionary).filter(key => key.startsWith('settings.github.native.'))).toEqual(keys);
    for (const key of keys) { expect(dictionary[key].length).toBeGreaterThan(0); if (locale !== 'en' && !key.includes('.color.') && !key.includes('.icon.')) expect(dictionary[key]).not.toBe(en[key as keyof typeof en]); }
  }
});

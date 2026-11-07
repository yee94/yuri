import { expect, test } from 'vitest';
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

test('About-owned keys exist with real translations in all ten formal dictionaries', () => {
  const keys = Object.keys(en).filter(key => key.startsWith('settings.nsh.about.')) as (keyof typeof en)[];
  expect(keys).toHaveLength(5);
  for (const dict of [zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) {
    for (const key of keys) { expect(dict[key]).toBeTruthy(); expect(dict[key]).not.toBe(en[key]); }
  }
});

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

test('the collection-owned import error exists and is translated in all ten dictionaries', () => {
  const key = 'settings.nsh.collections.importInvalid';
  expect(en[key]).toContain('{reason}');
  for (const dict of [zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) {
    expect(dict[key]).toContain('{reason}');
    expect(dict[key]).not.toBe(en[key]);
  }
});

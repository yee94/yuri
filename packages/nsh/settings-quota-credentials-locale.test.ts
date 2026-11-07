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

test('existing Web credential strings have translations in all ten dictionaries', () => {
  const keys = Object.keys(en).filter(key => key.startsWith('settings.providers.quota.') || key.startsWith('settings.providers.page.openCodeGo.')) as (keyof typeof en)[];
  expect(keys.length).toBeGreaterThan(20);
  for (const dict of [en, zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) for (const key of keys) expect(dict[key], key).toBeTruthy();
});

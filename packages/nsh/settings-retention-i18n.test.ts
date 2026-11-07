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

const additions = ['state.unknown', 'actions.scan', 'error.load', 'error.catalog', 'error.save', 'error.hostPreferences', 'error.journal', 'error.admission', 'confirm.archive', 'confirm.delete', 'result.uncertain', 'result.ack', 'result.completed', 'result.failed', 'result.skipped', 'actions.verify', 'error.invalidDays', 'description.safety', 'state.unsynced'];
test.each(Object.entries({ en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr, es, pl, 'pt-BR': ptBR, uk }))('%s has all formal retention translations, with matching value placeholders', (locale, dictionary) => {
  const entries: Record<string, string> = dictionary, source: Record<string, string> = en;
  for (const suffix of additions) {
    const key = `settings.yuri.sessionRetention.${suffix}`;
    expect(entries[key], key).toBeTruthy();
    if (locale !== 'en') expect(entries[key], key).not.toBe(source[key]);
    expect(entries[key].match(/\{\w+\}/g) ?? [], key).toEqual(source[key].match(/\{\w+\}/g) ?? []);
  }
});

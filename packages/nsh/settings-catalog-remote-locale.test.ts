import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { settingsSearchItems, searchSettingsFields } from './settings-search-core';

const root = path.dirname(fileURLToPath(import.meta.url));
test('new uncertainty feedback is genuinely translated in all ten locales', () => {
  const key = 'settings.common.writeUnconfirmed';
  for (const dictionary of [zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) { expect(dictionary[key]).toBeTruthy(); expect(dictionary[key]).not.toBe(en[key]); }
});
test('catalog/remote literal and dynamic settings keys exist across every settings dictionary', () => {
  const sources = ['settings-skills-catalog.tsx', 'settings-remote-instances.tsx'].map(name => readFileSync(path.join(root, name), 'utf8')).join('\n');
  const literals = [...sources.matchAll(/['"](settings\.[\w.-]+)['"]/g)].map(match => match[1]);
  const dynamic = [
    ...['userOpencode', 'projectOpencode', 'userAgents', 'projectAgents'].map(value => `settings.skills.location.option.${value}.label`),
    ...['skip', 'overwrite'].map(value => `settings.skills.catalog.conflicts.decision.${value}`),
    ...['relay', 'lan', 'local'].map(value => `settings.remoteInstances.clientAuth.addDevice.transport.${value}`),
  ];
  for (const dictionary of [en, zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) for (const key of [...literals, ...dynamic]) expect((dictionary as Record<string, string>)[key], key).toBeTruthy();
});
test('new searchable surfaces are available on iOS and desktop and target actual native anchors', () => {
  const entries = settingsSearchItems.filter(item => ['skills.catalog', 'remote-instances'].includes(item.page));
  expect(entries).toHaveLength(4);
  for (const entry of entries) {
    const source = readFileSync(path.join(root, entry.page === 'skills.catalog' ? 'settings-skills-catalog.tsx' : 'settings-remote-instances.tsx'), 'utf8');
    expect(source).toContain(`id="${entry.id}"`); expect(source).toContain('navigation.reveal(node)');
    for (const os of ['ios', 'macos', 'windows']) expect(searchSettingsFields(entry.keywords.split(' ')[0], key => key, os)).toContain(entry);
  }
});

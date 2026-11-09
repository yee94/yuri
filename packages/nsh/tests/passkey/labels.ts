import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { passkeyManagementLabels } from '../../settings-passkey-native';
import { dict as en } from '../../../ui/src/lib/i18n/messages/en';
import { dict as zhCN } from '../../../ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../../../ui/src/lib/i18n/messages/zh-TW';
import { dict as ja } from '../../../ui/src/lib/i18n/messages/ja';
import { dict as ko } from '../../../ui/src/lib/i18n/messages/ko';
import { dict as fr } from '../../../ui/src/lib/i18n/messages/fr';
import { dict as es } from '../../../ui/src/lib/i18n/messages/es';
import { dict as pl } from '../../../ui/src/lib/i18n/messages/pl';
import { dict as ptBR } from '../../../ui/src/lib/i18n/messages/pt-BR';
import { dict as uk } from '../../../ui/src/lib/i18n/messages/uk';

for (const dictionary of [en, zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) {
  const labels = passkeyManagementLabels(key => dictionary[key]);
  assert.deepEqual(Object.keys(labels).sort(), ['cancel', 'passwordPlaceholder', 'submit', 'title']);
  assert.deepEqual(labels, { title: dictionary['sessionAuth.locked.unlockTitle'], cancel: dictionary['settings.common.actions.cancel'], submit: dictionary['sessionAuth.actions.unlockAria'], passwordPlaceholder: dictionary['sessionAuth.password.placeholder'] });
  for (const value of Object.values(labels)) assert.ok(typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value));
  if (dictionary !== en) for (const value of Object.values(labels)) assert.ok(!Object.values(passkeyManagementLabels(key => en[key])).includes(value), 'all four labels have real non-English translations');
}
let selected = zhCN;
const translate = (key: keyof typeof en) => selected[key];
const chinese = passkeyManagementLabels(translate);
selected = fr;
assert.notDeepEqual(passkeyManagementLabels(translate), chinese, 'labels resolved when the authorization action runs, after app-language changes');
const glue = readFileSync(new URL('../../settings-sessions.tsx', import.meta.url), 'utf8');
assert.match(glue, /authorizeManagement: async \(\) => \{ await native\('passkey\.authorizeManagement', \{ expectedHost: props\.operation\(\)\?\.scope, labels: passkeyManagementLabels\(t\) \}\)/);
console.log('PASS: exact native label schema, all ten dictionaries and action-time language changes');

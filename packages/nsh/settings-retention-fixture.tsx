import { mount, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { native } from './runtime';
import { createNativeRetentionOwner, SettingsSessionRetentionSection } from './settings-retention';

/** Production section + synthetic Host only. No App, bootstrap, credentials or real network. */
language.set('en');
function RetentionFixture() {
  const active = signal(true), audit = signal('');
  const controller = createNativeRetentionOwner({
    scope: 'retention-synthetic-host', current: () => true, active, protectedIDs: () => new Set(), autoRun: false, now: () => 200 * 86_400_000,
    storage: {
      getItem: key => native<string | null>('retention.fixture.storage', { key }),
      setItem: async (key, value) => { await native('retention.fixture.storage', { key, value }); },
    },
  });
  return <Scroll class="flex-1 bg-background" contentClass="p-5 gap-5">
    <View class="gap-2">
      <Each of={['normal', 'fail-one', 'partial', 'legacy', 'catalog-failed', 'active-failed', 'pref-dropped', 'pref-read-failed', 'unknown-delete', 'read-after-ack']}>{mode => <Button testID={`retention-fixture-${mode()}`} onPress={() => { void native('retention.fixture.scenario', { mode: mode() }); }}><Text>{mode()}</Text></Button>}</Each>
      <Button testID="retention-fixture-audit" onPress={() => { void native('retention.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Fixture audit</Text></Button>
      <Button testID="retention-fixture-active" onPress={() => active.set(!active())}><Text>Fixture lifecycle</Text></Button>
      <Button testID="retention-fixture-zh" onPress={() => language.set('zh-CN')}><Text>Fixture Chinese</Text></Button>
      <Text testID="retention-fixture-audit-result">{audit()}</Text>
    </View>
    <SettingsSessionRetentionSection controller={controller} active={active()} target="sessions.retention-cleanup" />
  </Scroll>;
}
mount(RetentionFixture);

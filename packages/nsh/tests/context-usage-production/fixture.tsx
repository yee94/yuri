import { host, mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { YuriNativeApp } from '../../application';

/** Only fake-Host controls: no route/state/Chat access and no hidden navigation. */
function Fixture() {
  const audit = signal('');
  return <View class="flex-1 bg-background">
    <YuriNativeApp />
    <View class="flex-row">
      <Button testID="context-production-delta" onPress={() => { void host.call('context.production.delta', {}); }}><Text>Emit synthetic token</Text></Button>
      <Button testID="context-production-fail" onPress={() => { void host.call('context.production.failHistory', {}); }}><Text>Fail synthetic history</Text></Button>
      <Button testID="context-production-audit" onPress={() => { void host.call('context.production.audit', {}).then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect synthetic Host</Text></Button>
    </View>
    <Text testID="context-production-stats" style={{ height: 1, numberOfLines: 1 }}>{audit()}</Text>
  </View>;
}

void Storage.setItem('language', 'en').then(() => mount(Fixture));

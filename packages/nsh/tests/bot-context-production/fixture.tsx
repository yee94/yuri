import { mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { YuriNativeApp } from '../../application';
import { request } from '../../runtime';

/** Production routes and selection callbacks; only the audit control is synthetic. */
function Fixture() {
  const audit = signal('not inspected');
  return <View class="flex-1 bg-background">
    <YuriNativeApp />
    <Button testID="bot-context-production-audit" onPress={() => {
      void request('/__fixture/bot-context-production/audit').then(value => audit.set(`bot-context-audit:${JSON.stringify(value)}`));
    }}><Text class="text-foreground">Inspect synthetic Host</Text></Button>
    <Text testID="bot-context-production-stats" class="text-foreground">{audit()}</Text>
  </View>;
}

void Storage.setItem('language', 'en').then(() => mount(Fixture));

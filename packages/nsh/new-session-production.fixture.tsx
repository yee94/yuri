import { mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { YuriNativeApp } from './application';
import { record } from './model';
import { request } from './runtime';

/** Production application/navigation; only the out-of-band fake Host audit is test UI. */
function Fixture() {
  const audit = signal('not inspected');
  let inspections = 0;
  return <View class="flex-1 bg-background">
    <YuriNativeApp />
    <Button testID="new-session-production-audit" class="min-h-11 bg-secondary" onPress={() => {
      void request('/__fixture/new-session-production/audit').then(value => {
        const stats = record(value);
        audit.set(`audit:${++inspections} writes:${stats.writes} creates:${stats.creates} prompts:${stats.prompts}`);
      });
    }}><Text class="text-foreground">Inspect fake Host writes</Text></Button>
    <Text testID="new-session-production-stats" class="text-foreground">{audit()}</Text>
  </View>;
}

void Storage.setItem('language', 'en').then(() => mount(Fixture));

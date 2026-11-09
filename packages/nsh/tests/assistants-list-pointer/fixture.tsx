import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { AssistantHome } from '../../assistants';
import { AssistantSwipeRow } from '../../assistants-swipe';
import { language } from '../../i18n';
import { settingsEngineFixtureBoot } from '../../settings-engine-fixture-boot';
import { app } from '../../state';
import { readListTrace, recordPage, recordRow, resetListTrace } from './trace';

language.set('en');
function FixedRow() {
  const binding = {}, revealed = signal<string | null>(null);
  return <AssistantSwipeRow binding={binding} generation={1} id="list-control" name="Fixed row control" pinned={false} disabled={false} revealed={revealed()}
    onReveal={id => { recordRow('reveal', () => false); revealed.set(id); }} onOpen={() => recordRow('open', () => false)}
    onEdit={() => recordRow('edit', () => false)} onDelete={() => recordRow('delete', () => false)} onMenu={() => recordRow('menu', () => false)}>
    <Text class="text-foreground">Fixed row control</Text>
  </AssistantSwipeRow>;
}
function Fixture() {
  const boot = settingsEngineFixtureBoot(), mode = signal<'production-list' | 'fixed-row'>('production-list');
  app.tab.set(1);
  return <View class="flex-1 bg-background">
    <View class="flex-row p-3 gap-2" style={{ height: 56 }}>
      <Button testID="list-pointer-list" onPress={() => { mode.set('production-list'); recordPage('list-mode'); }}><Text>Production List</Text></Button>
      <Button testID="list-pointer-row" onPress={() => { mode.set('fixed-row'); recordPage('row-mode'); }}><Text>Fixed row</Text></Button>
      <Button testID="list-pointer-reset" onPress={resetListTrace}><Text>Reset</Text></Button>
    </View>
    <View style={{ height: 28 }}><Text testID="list-pointer-mode" class="text-xs text-foreground">{mode()}</Text></View>
    <View class="flex-1">
      <If when={mode() === 'production-list'} else={<View class="p-5"><FixedRow /></View>}>
        <If when={boot.mounted()} else={<Text testID="list-pointer-boot" class="text-foreground">{boot.error() || 'Loading synthetic scope'}</Text>}>
          <AssistantHome active={boot.active() && mode() === 'production-list'}
            onOpenChat={() => recordRow('open', () => false)} onEdit={() => recordRow('edit', () => false)} onCreate={() => recordPage('create')} onOpenSettings={() => recordPage('settings')} />
        </If>
      </If>
    </View>
    <View style={{ height: 200 }} class="overflow-hidden p-3"><Text testID="list-pointer-trace" class="text-xs text-foreground">{readListTrace().join(' → ')}</Text></View>
  </View>;
}
mount(Fixture);

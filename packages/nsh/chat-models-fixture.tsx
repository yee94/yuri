import { host, mount, safeArea, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { ChatModels } from './chat-models';
import { language } from './i18n';
import { app } from './state';
import { createModelPickerSheet } from './model-picker-presentation';
import { NativeNewSessionModels } from './new-session-models';
import type { NativeNewSessionSelection } from './new-session';
import { NativeNewSessionModal } from './new-session-modal';

function PickerFixture() {
  app.runtimeScope.set({ hostID: 'fixture-host', lease: 'fixture-lease' });
  const panel = signal<'model' | 'agent' | 'new-model' | ''>('');
  const sheet = createModelPickerSheet(() => panel.set(''));
  const selection = signal<NativeNewSessionSelection>({ agent: 'build' });
  const owner = { directory: '/fixture/project', current: () => true, selection, select: async (value: NativeNewSessionSelection) => { selection.set(value); } };
  const nativeModal = signal(false);
  void host.call('fixture.nativeModal').then(value => nativeModal.set(value === true));
  return <View class="flex-1" style={{ paddingTop: safeArea().top }}>
    <If when={!panel()}><Button testID="open-model" onPress={() => { sheet.reset(); panel.set('model'); }}><Text>Open model fixture</Text></Button><Button testID="open-new-model" onPress={() => { sheet.reset(); panel.set('new-model'); }}><Text>Open new model fixture</Text></Button><Button testID="open-agent" onPress={() => panel.set('agent')}><Text>Open agent fixture</Text></Button><Button testID="fixture-chinese" onPress={() => language.set('zh-CN')}><Text>Use Chinese fixture</Text></Button></If>
    <Sheet open={!!panel() && (!nativeModal() || panel() !== 'new-model')} closeOnSwipe onOpenChange={event => { if (!event.open) panel.set(''); }} popupStyle={{ height: sheet.height() }}>
      <If when={panel() === 'model'}><ChatModels target={{ kind: 'session', id: 'test-session', title: 'Picker fixture', directory: '/fixture/project' }} initialTab="model" embedded sheet={sheet} onDone={() => panel.set('')} /></If>
      <If when={panel() === 'new-model' && !nativeModal()}><NativeNewSessionModels owner={owner} mode="model" active={() => panel() === 'new-model'} sheet={sheet} onDone={() => panel.set('')} /></If>
      <If when={panel() === 'agent'}><ChatModels target={{ kind: 'session', id: 'test-session', title: 'Picker fixture', directory: '/fixture/project' }} initialTab="agent" embedded onDone={() => panel.set('')} /></If>
    </Sheet>
    <If when={nativeModal()}><NativeNewSessionModal value={panel() === 'new-model' ? 'model' : null} active={() => true} onClose={() => panel.set('')} height={sheet.height()}>{(_value, active, close, resize) => <View class="flex-1" style={{ paddingBottom: safeArea().bottom }}><NativeNewSessionModels owner={owner} mode="model" active={active} sheet={resize} onDone={close} /></View>}</NativeNewSessionModal></If>
  </View>;
}
mount(PickerFixture);

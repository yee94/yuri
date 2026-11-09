import { List, mount, signal, Text, View } from 'nsh';
import { NativeComposerChanges } from './chat-changes';
import { language } from './i18n';
import { loadConnections } from './state';

language.set('en-US');
const height = signal(0);
mount(() => {
  const ready = signal(false);
  void loadConnections().then(() => ready.set(true));
  return <If when={ready()}><View style={{ width: 402, height: 778 }}>
  <List testID="layout-transcript" class="flex-1" each={['Neutral history']} onLayout={event => height.set(event.bounds.size.height)}>
    {value => <Text>{value()}</Text>}
  </List>
  <NativeComposerChanges directory="/workspace/project" active onOpenFile={() => {}} />
  <View style={{ height: 100 }}><Text>{`viewport:${height()}`}</Text></View>
</View></If>;
});

import { List, mount, signal, Text, View } from 'nsh';
import { NativeComposerChanges } from './chat-changes';
import { language } from './i18n';
import { prepareChangesFixture } from './chat-changes-fixture-bootstrap';

language.set('en-US');
const height = signal(0);
function LayoutContent() { return <View style={{ width: 402, height: 778 }}>
  <List testID="layout-transcript" class="flex-1" each={['Neutral history']} onLayout={event => height.set(event.bounds.size.height)}>
    {value => <Text>{value()}</Text>}
  </List>
  <NativeComposerChanges directory="/workspace/project" active onOpenFile={() => {}} />
  <View style={{ height: 100 }}><Text>{`viewport:${height()}`}</Text></View>
</View>; }
mount(() => {
  const boot = prepareChangesFixture();
  return <If when={boot.ready()} else={<Text testID="changes-layout-boot">{boot.error() || 'Loading fixture connection'}</Text>}><LayoutContent /></If>;
});

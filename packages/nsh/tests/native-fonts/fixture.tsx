import { effect, host, mount, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeAppearanceSync, nativeAppearance, refreshNativeAppearance } from '../../appearance';
import { NativeAppearanceFeedback } from '../../appearance-feedback';
import { nativeEditorTextStyle } from '../../native-editor-style';
import { loadConnections } from '../../state';

const audit = signal('waiting');
void loadConnections().catch(() => audit.set('admission-failed'));
function Fixture() {
  let requested: number | undefined;
  effect(() => {
    const current = nativeAppearance.current();
    if (current?.fontStatus !== 'ready' || requested === current.fontTicket) return;
    requested = current.fontTicket;
    untracked(() => { void host.call('font.fixture.audit').then(result => audit.set((result as { valid?: boolean }).valid ? 'verified' : 'failed')).catch(() => audit.set('audit-failed')); });
  });
  return <View class="flex-1 bg-background px-5 pt-24 gap-4">
    <NativeAppearanceSync /><NativeAppearanceFeedback />
    <Text testID="font-fixture-status">{() => nativeAppearance.current()?.fontStatus ?? 'loading'} · {audit}</Text>
    <Text testID="font-fixture-selection">{() => `${nativeAppearance.current()?.fonts.ui ?? ''} / ${nativeAppearance.current()?.fonts.mono ?? ''}`}</Text>
    <Button disabled={nativeAppearance.current()?.fontStatus === 'loading' || audit() !== 'verified'} testID="font-fixture-next" onPress={() => {
      audit.set('waiting'); void host.call('font.fixture.next').then(() => refreshNativeAppearance()).catch(() => audit.set('next-failed'));
    }}><Text>Next font pair</Text></Button>
    <If when={host.params.fontRunDiagnostics === true}>
      <View class="gap-1">
        <Text testID="font-run-ui-regular" style={{ fontSize: 16 }}>HAMBURGEFONTSIV 012345</Text>
        <Text testID="font-run-ui-medium" class="font-medium" style={{ fontSize: 16 }}>HAMBURGEFONTSIV 012345</Text>
        <Text testID="font-run-ui-semibold" class="font-semibold" style={{ fontSize: 16 }}>HAMBURGEFONTSIV 012345</Text>
        <Text testID="font-run-mono-regular" class="font-mono" style={{ fontSize: 13 }}>HAMBURGEFONTSIV 012345</Text>
        <Text testID="font-run-mono-medium" class="font-mono font-medium" style={{ fontSize: 13 }}>HAMBURGEFONTSIV 012345</Text>
        <Text testID="font-run-mono-semibold" class="font-mono font-semibold" style={{ fontSize: 13 }}>HAMBURGEFONTSIV 012345</Text>
      </View>
    </If>
    <Text testID="font-fixture-inherited-text">Inherited UI text ABC 012</Text>
    <Input testID="font-fixture-ui-input" value="UI input ABC 012" onChange={() => {}} />
    <Text class="font-mono" testID="font-fixture-mono-text">Inherited mono text ABC 012</Text>
    <Input testID="font-fixture-mono-input" multiline class="font-mono h-20" value="Mono input ABC 012" onChange={() => {}} />
    <Input testID="font-fixture-editor" multiline class="h-20" style={nativeEditorTextStyle()} value="Skills editor ABC 012" onChange={() => {}} />
  </View>;
}
mount(Fixture);

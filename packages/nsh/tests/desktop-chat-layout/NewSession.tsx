import { host, mount, signal, Text, View, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeNewSessionLayout } from '../../new-session-layout';

function Fixture() {
  const result = signal(''), draft = signal('');
  let pane: ViewRef | undefined, content: ViewRef | undefined;
  host.on('layout.measure', () => {
    void Promise.all([pane?.measure(), content?.measure()]).then(([pane, content]) => result.set(JSON.stringify({ pane, content })));
  });
  return <View class="flex-1 bg-background">
    <View style={{ height: 48 }} />
    <View class="flex-1 flex-row">
      <View style={{ width: 260 }} />
      <View class="flex-1 min-w-0" ref={view => { pane = view; }}>
        <NativeNewSessionLayout><View class="w-full" ref={view => { content = view; }}>
          <Text style={{ fontSize: 30, lineHeight: 36 }}>Synthetic new session</Text>
          <Input testID="draft" multiline value={draft()} onChange={event => draft.set(event.value)} />
          <Button testID="local-action"><Text>Local preview only</Text></Button>
        </View></NativeNewSessionLayout>
      </View>
    </View>
    <Text testID="result">{`result:${result()}`}</Text>
  </View>;
}
mount(Fixture);

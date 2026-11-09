import { cleanup, host, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeChangesSheet, NativeComposerChanges } from './chat-changes';
import { language } from './i18n';
import { loadConnections } from './state';

function ReadyChangesFixture() {
  const ready = signal(false);
  void loadConnections().then(() => ready.set(true));
  return <If when={ready()}><ChangesFixture /></If>;
}

function ChangesFixture() {
  language.set('en');
  const open = signal(false), historical = signal(false), draft = signal(''), active = signal(true), audit = signal('');
  cleanup(host.on('changes.fixture.audit', value => audit.set(JSON.stringify(value))));
  return <View class="flex-1 bg-background">
    <Text testID="changes-fixture-audit">{`changes-audit:${audit()}`}</Text>
    <Input testID="changes-fixture-draft" value={draft()} onChange={event => draft.set(event.value)} />
    <NativeComposerChanges directory="/fixture" active={active()} onOpenFile={() => { throw new Error('Legacy Markdown navigation must not run'); }} />
    <Button testID="changes-fixture-workspace" onPress={() => open.set(true)}><Text>Workspace fixture</Text></Button>
    <Button testID="changes-fixture-history" onPress={() => historical.set(true)}><Text>History fixture</Text></Button>
    <Button testID="changes-fixture-active" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
    <Each of={['seed-staged', 'fail-next-status', 'hold-commit', 'release']}>{name => <Button testID={`changes-fixture-${name()}`} onPress={() => { void host.call('changes.fixture.control', { name: name() }); }}><Text>{name()}</Text></Button>}</Each>
    <NativeChangesSheet source={{ kind: 'workspace', directory: '/fixture' }} open={open()} active={active()} onClose={() => open.set(false)} />
    <NativeChangesSheet source={{ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', path: 'history.ts', files: [{ path: 'history.ts', patch: '@@ -1 +1 @@\n-old\n+HISTORICAL_ONLY' }, { path: 'thin.ts' }] }} open={historical()} active={active()} onClose={() => historical.set(false)} />
  </View>;
}
mount(ReadyChangesFixture);

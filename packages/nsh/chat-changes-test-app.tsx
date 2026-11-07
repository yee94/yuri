import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeChangesSheet, NativeComposerChanges } from './chat-changes';
import { language } from './i18n';

function ChangesFixture() {
  language.set('en');
  const open = signal(false), historical = signal(false), draft = signal('');
  return <View class="flex-1 bg-background">
    <Input testID="changes-fixture-draft" value={draft()} onChange={event => draft.set(event.value)} />
    <NativeComposerChanges directory="/fixture" active onOpenFile={() => { throw new Error('Legacy Markdown navigation must not run'); }} />
    <Button testID="changes-fixture-workspace" onPress={() => open.set(true)}><Text>Workspace fixture</Text></Button>
    <Button testID="changes-fixture-history" onPress={() => historical.set(true)}><Text>History fixture</Text></Button>
    <NativeChangesSheet source={{ kind: 'workspace', directory: '/fixture' }} open={open()} active onClose={() => open.set(false)} />
    <NativeChangesSheet source={{ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', path: 'history.ts', files: [{ path: 'history.ts', patch: '@@ -1 +1 @@\n-old\n+HISTORICAL_ONLY' }, { path: 'thin.ts' }] }} open={historical()} active onClose={() => historical.set(false)} />
  </View>;
}
mount(ChangesFixture);

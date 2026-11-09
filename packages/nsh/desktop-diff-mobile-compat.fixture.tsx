import { mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeComposerChanges } from './chat-changes';
import { loadConnections } from './state';
import { language } from './i18n';

/** Actual mobile consumers after the same confirmed connection admission as root. */
function Fixture() {
  language.set('en');
  const ready = signal(false), draft = signal('');
  void loadConnections().then(() => ready.set(true));
  return <View class="flex-1">
    <Input testID="mobile-diff-draft" value={draft()} onChange={event => draft.set(event.value)} />
    <If when={ready()}>
      <NativeComposerChanges directory="/repo" active />
    </If>
    <Text>{ready() ? 'mobile-diff-admitted' : 'mobile-diff-pending'}</Text>
  </View>;
}
mount(Fixture);

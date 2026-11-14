import { computed, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { app, captureHostRequest } from './state';
import { createChangesReader } from './chat-changes-model';
import { createChangesDraft } from './chat-changes-generation';
import { NativeChangesSheet, type NativeChangesOwner } from './chat-changes';
import { language } from './i18n';

/** Isolated mock-only Sheet. Does not bootstrap connections or use root Chat state. */
function FixtureContent() {
  language.set('en');
  app.runtimeScope.set({ hostID: 'changes-callback-fixture', lease: 'fixture-only' });
  const request = captureHostRequest(), revision = signal(0), open = signal(true);
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, request, () => open(), () => revision.set(revision() + 1));
  const state = () => { revision(); return reader.state(); };
  const owner = { reader, state, snapshot: computed(() => state().snapshot), draft: createChangesDraft() };
  void reader.refresh();
  return <View class="flex-1 bg-background"><Button testID="changes-fixture-reopen" onPress={() => open.set(true)}><Text>Reopen mock Changes</Text></Button><NativeChangesSheet source={reader.source} owner={owner as unknown as NativeChangesOwner} open={open()} active onClose={() => open.set(false)} generationContext={{ sessionID: 'fixture-session' }} /></View>;
}
mount(FixtureContent);

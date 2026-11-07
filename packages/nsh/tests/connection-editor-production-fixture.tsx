import { mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { YuriNativeApp } from '../application';
import { app, createChat, epoch } from '../state';
import { native } from '../runtime';

type AuthoritySnapshot = {
  ready: boolean; error: string; resolved: boolean; sameSelectedObject: boolean;
  sameEpoch: boolean; sameMessages: boolean; sameHistoryGeneration: boolean;
};
let inspectAuthority = (): AuthoritySnapshot => ({ ready: false, error: '', resolved: false, sameSelectedObject: false, sameEpoch: false, sameMessages: false, sameHistoryGeneration: false });

/** Actual createChat authority, deliberately paused so background safety polls cannot contaminate metadata counts. */
function AuthorityProbe() {
  const selected = app.connection(), capturedEpoch = epoch();
  const chat = createChat({ kind: 'session', id: 'connection-editor-authority', title: 'Synthetic authority probe', directory: '/fixture/connection-editor' });
  chat.active.set(false);
  const ready = signal(false), failure = signal('');
  let messages = chat.messages(), historyGeneration = chat.historyGeneration();
  inspectAuthority = () => ({
    ready: ready(), error: failure() || chat.error(), resolved: chat.messagesResolved(),
    sameSelectedObject: app.connection() === selected, sameEpoch: epoch() === capturedEpoch,
    sameMessages: chat.messages() === messages, sameHistoryGeneration: chat.historyGeneration() === historyGeneration,
  });
  void (async () => {
    await chat.draftReady;
    // Drain any initial activation flight, then adopt a fresh paused authoritative page.
    await chat.load(false, ['messages']);
    await chat.load(false, ['messages']);
    if (!chat.messagesResolved() || chat.messages().length !== 1 || chat.error()) throw new Error('Synthetic Chat authority did not resolve');
    messages = chat.messages(); historyGeneration = chat.historyGeneration(); ready.set(true);
  })().catch(error => failure.set(error instanceof Error ? error.message : 'Synthetic authority failure'));
  return <Text testID="connection-editor-production-authority" class="text-xs text-muted-foreground">{failure() || (ready() ? 'Synthetic authority ready' : 'Synthetic authority loading')}</Text>;
}

function Fixture() {
  const audit = signal(''), error = signal('');
  return <View class="flex-1 bg-background">
    <YuriNativeApp />
    <If when={!!app.connection()}><AuthorityProbe /></If>
    <Button testID="connection-editor-production-audit" onPress={() => {
      void native<Record<string, unknown>>('connectionEditor.fixture.audit').then(value => audit.set('connection-editor-production-audit:' + JSON.stringify({
        ...value, authority: inspectAuthority(), appError: app.error(), online: app.online(),
        selectedID: app.connection()?.id, selectedLabel: app.connection()?.label,
        list: app.connections(),
      }))).catch(failure => error.set(failure instanceof Error ? failure.message : 'Synthetic audit failure'));
    }}><Text class="text-foreground">Inspect synthetic connection boundary</Text></Button>
    <Text testID="connection-editor-production-stats" class="text-xs text-muted-foreground">{audit()}</Text>
    <Text testID="connection-editor-production-fixture-error" class="text-destructive">{error()}</Text>
  </View>;
}

// Only the initial tab preference is seeded; Instances/editor/reauthorize use YuriNativeApp's public routes.
app.tab.set(3);
void Storage.setItem('language', 'en').then(() => mount(Fixture));

import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeReferencePicker } from './composer-references-controls';
import { captureHostRequest, createChat } from './state';
import { prepareInteractionFixture } from './tests/chat-interaction-fixture-bootstrap';
import { nativeReferenceTrigger } from './composer-references';

function ChatFixture() {
  const request = captureHostRequest();
  const chat = createChat({ kind: 'session', id: 'reference-chat', title: 'References', directory: '/workspace' });
  const open = signal(false);
  return <View>
    <Text>{chat.draftStatus()}</Text>
    <Input testID="reference-chat-composer" value={chat.draft()} onChange={event => chat.setDraftText(event.value)} />
    <Text>{`references:${chat.references().length}`}</Text>
    <Text>{chat.error()}</Text>
    <Button testID="reference-chat-open" disabled={chat.draftStatus() !== 'ready'} onPress={() => { chat.setDraftText(`${chat.draft()}${chat.draft() && !/\s$/.test(chat.draft()) ? ' ' : ''}@`); open.set(true); }}><Text>@</Text></Button>
    <NativeReferencePicker scope={chat.referenceScope} open={open()} query={nativeReferenceTrigger(chat.draft())?.query} currentSessionID="reference-chat" request={request} onClose={() => open.set(false)} onChoose={candidate => { const trigger = nativeReferenceTrigger(chat.draft()); chat.insertReference(candidate, trigger?.start, trigger?.end); open.set(false); }} />
    <Button testID="reference-chat-send" onPress={() => { void chat.send(); }}><Text>Send</Text></Button>
    <Button testID="reference-chat-flush" onPress={() => { void chat.flushDraft(); }}><Text>Flush</Text></Button>
    <Each of={chat.messages()}>{item => <Text>{item().text}</Text>}</Each>
  </View>;
}
function ReferenceChatApp() {
  const present = signal(true);
  const boot = prepareInteractionFixture();
  return <View>
    <Button testID="reference-chat-toggle" onPress={() => present.set(!present())}><Text>Toggle</Text></Button>
    <If when={!boot.ready()}><Text>{boot.error() || 'Loading fixture connection'}</Text></If>
    <If when={boot.ready() && present()}><ChatFixture /></If>
  </View>;
}
mount(ReferenceChatApp);

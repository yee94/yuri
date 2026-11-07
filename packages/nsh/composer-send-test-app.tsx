import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeComposerSend } from './composer-send';
import { language } from './i18n';

mount(() => {
  language.set('en');
  const draft = signal(''), inFlight = signal(false), sent = signal(0), busy = signal(false);
  return <View class="flex-1">
    <Input testID="send-fixture-draft" value={draft()} onChange={event => draft.set(event.value)} />
    <NativeComposerSend disabled={!draft().trim()} inFlight={inFlight()} canAbort={busy()} hasContent={!!draft().trim()} onStop={() => busy.set(false)} onPress={() => { sent.set(sent() + 1); draft.set(''); inFlight.set(true); }} />
    <Text>{`admissions:${sent()}`}</Text>
    <Button testID="send-fixture-complete" onPress={() => inFlight.set(false)}><Text>Complete</Text></Button>
    <Button testID="send-fixture-busy" onPress={() => busy.set(true)}><Text>Begin generation</Text></Button>
  </View>;
});

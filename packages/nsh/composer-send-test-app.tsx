import { mount, signal, Text, View, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeComposerSend } from './composer-send';
import { language } from './i18n';

mount(() => {
  language.set('en');
  const draft = signal(''), inFlight = signal(false), sent = signal(0), busy = signal(false), desktop = signal(false), active = signal(true), size = signal('');
  let control: ViewRef | undefined;
  return <View class="flex-1">
    <Input testID="send-fixture-draft" value={draft()} onChange={event => draft.set(event.value)} />
    <View ref={ref => { control = ref; }} class="self-start"><NativeComposerSend presentation={desktop() ? 'desktop' : 'mobile'} active={active()} disabled={!draft().trim()} inFlight={inFlight()} canAbort={busy()} hasContent={!!draft().trim()} onStop={() => busy.set(false)} onPress={() => { sent.set(sent() + 1); draft.set(''); inFlight.set(true); }} /></View>
    <Text>{`admissions:${sent()}`}</Text>
    <Button testID="send-fixture-complete" onPress={() => inFlight.set(false)}><Text>Complete</Text></Button>
    <Button testID="send-fixture-busy" onPress={() => busy.set(true)}><Text>Begin generation</Text></Button>
    <Button testID="send-fixture-desktop" onPress={() => desktop.set(!desktop())}><Text>Presentation</Text></Button>
    <Button testID="send-fixture-active" onPress={() => active.set(!active())}><Text>Activity</Text></Button>
    <Button testID="send-fixture-measure" onPress={() => { void control?.measure().then(frame => { if (frame) size.set(JSON.stringify(frame.bounds.size)); }); }}><Text>Measure</Text></Button>
    <Text>{`control-size:${size()}`}</Text>
  </View>;
});

import { computed, host, mount, signal, Text, View } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { createNativeSpeech } from './speech';
import { createNativeAutoRead, NativeAutoReadBody } from './native-auto-read';
import { createNativeAutoReadPreference } from './native-auto-read-core';
import { messageFrom, type Message } from './model';
import { nativeBodyPlan, nativeBodyRows } from './transcript-body-model';

/** Synthetic only: in-memory preference and a test Host, never real Storage or TTS. */
function AutoReadFixture() {
  const active = signal(true), stream = signal(false), metrics = signal(''), failure = signal(''), warning = signal('');
  const messages = signal<Message[]>([messageFrom({ id: 'history', type: 'assistant', content: [{ type: 'text', text: 'Historical reply.' }], finish: 'stop', time: { created: 10, completed: 20 } })!]);
  const preference = createNativeAutoReadPreference({ getItem: async () => null, setItem: async () => {} });
  const speech = createNativeSpeech({ current: () => active() });
  const autoRead = createNativeAutoRead({ speech, preference, snapshot: () => ({ scope: 'fixture/host/session/0', sessionID: 'session', active: active(), resolved: true, recognizing: false, messages: messages() }), onError: key => failure.set(key), onWarning: key => warning.set(key) });
  const row = computed(() => nativeBodyRows(messages()).at(-1)!);
  const plan = computed(() => nativeBodyPlan(row()));
  let next = 0;
  function append(streaming: boolean) {
    const id = `reply-${++next}`;
    stream.set(streaming);
    messages.set([...messages(), messageFrom({ id, type: 'assistant', content: [{ type: 'text', text: `Rendered body ${id}.` }], ...(streaming ? {} : { finish: 'stop' }), time: { created: 30 + next * 10, ...(streaming ? {} : { completed: 35 + next * 10 }) } })!]);
  }
  function complete() {
    messages.set(messages().map(message => message.id === `reply-${next}` ? { ...message, finish: 'stop', time: { ...message.time, completed: 35 + next * 10 } } : message));
    stream.set(false);
  }
  return <View>
    <Text testID="auto-state">{`${autoRead.state().preferred ? 'on' : 'off'}:${autoRead.state().running ? 'armed' : 'halted'}:${autoRead.state().playingMessageID ?? 'none'}`}</Text>
    <Text testID="auto-failure">{failure()}</Text><Text testID="auto-warning">{warning()}</Text><Text>{metrics()}</Text>
    <If when={active()}><View>
      <TextView testID="committed-reply-body" markdown={row().tail.text} />
      <NativeAutoReadBody autoRead={autoRead} scope="fixture/host/session/0" sessionID="session" row={row()} plan={plan()} streaming={stream()} />
    </View></If>
    <Button testID="auto-toggle" onPress={() => { void autoRead.toggle(); }}><Text>Fixture toggle</Text></Button>
    <Button testID="auto-stream" onPress={() => append(true)}><Text>Fixture stream</Text></Button>
    <Button testID="auto-settle" onPress={complete}><Text>Fixture settle</Text></Button>
    <Button testID="auto-next" onPress={() => append(false)}><Text>Fixture next</Text></Button>
    <Button testID="auto-finish" onPress={() => { void host.call('runtime.request', { path: '/fixture/finish' }); }}><Text>Fixture finish audio</Text></Button>
    <Button testID="auto-fail" onPress={() => { void host.call('runtime.request', { path: '/fixture/fail' }); }}><Text>Fixture fail audio</Text></Button>
    <Button testID="auto-stop" onPress={() => { void speech.stop(); }}><Text>Fixture manual stop</Text></Button>
    <Button testID="auto-hide" onPress={() => active.set(!active())}><Text>Fixture visibility</Text></Button>
    <Button testID="auto-metrics" onPress={() => { void host.call('runtime.request', { path: '/fixture/metrics' }).then(value => metrics.set(String(value))); }}><Text>Fixture metrics</Text></Button>
  </View>;
}
mount(AutoReadFixture);

import { host, lifecycle, List, mount, reduceMotion, signal, Text, View, type ListRef, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeDesktopAssistantSendFeedback } from './desktop-assistant-send-feedback';
import { nativeAssistantAvatarClock } from './assistants-avatar-clock';
import { encodeAssistantAvatar, resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { language } from './i18n';
import type { Row } from './model';

language.set('en');
function Fixture() {
  const sending = signal(false), processing = signal(false), current = signal(true), flight = signal(false), failed = signal(false);
  const draft = signal(''), unrelated = signal(0), report = signal('');
  let priorityReads = 0, seedReads = 0, botReads = 0, subscriptions = 0, releases = 0, presenterMounts = 0, listMounts = 0, rowMounts = 0, sequence = 0;
  let list: ListRef | undefined, column: ViewRef | undefined, composer: ViewRef | undefined, region: ViewRef | undefined;
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: String(index), value: `Original transcript row ${index}` }));
  const bot: Row = { id: 'feedback-fixture-bot', name: 'Synthetic contact', working: true };
  const recipe = encodeAssistantAvatar({ ...resolveAssistantAvatar('feedback-fixture'), animate: true }, 'feedback-fixture');
  Object.defineProperty(bot, 'avatarSeed', { get: () => { seedReads++; return recipe; } });
  const subscribe = nativeAssistantAvatarClock.subscribe;
  nativeAssistantAvatarClock.subscribe = (...args) => {
    subscriptions++;
    const lease = subscribe(...args);
    return { working: lease.working, release: () => { releases++; lease.release(); } };
  };
  function readSending() { priorityReads++; return sending(); }
  function readProcessing() { priorityReads++; return processing(); }
  function Feedback() {
    presenterMounts++;
    return <NativeDesktopAssistantSendFeedback sending={readSending()} processing={readProcessing()} current={current}
      sameScopeSendFlight={flight()} bot={(() => { botReads++; return bot; })()} />;
  }
  function Transcript() {
    listMounts++;
    return <List testID="feedback-original-list" ref={value => { list = value; }} inverted class="flex-1" each={rows} keyExtractor={row => row.id}
      contentStyle={{ paddingHorizontal: 32 }} header={() => <View style={{ height: 48 }} />}>
      {row => { rowMounts++; return <View class="w-full self-center" style={{ height: 48, maxWidth: 672 }}><Text>{row().value}</Text></View>; }}
    </List>;
  }
  async function snapshot(measure = false) {
    const frames = measure ? { list: await list?.measure(), column: await column?.measure(), composer: await composer?.measure(), region: await region?.measure() } : undefined;
    report.set(JSON.stringify({ sequence: ++sequence, priorityReads, seedReads, botReads, subscriptions, releases, presenterMounts, listMounts, rowMounts, frames,
      reduced: reduceMotion(), lifecycle: lifecycle(), sending: sending(), processing: processing(), current: current(), flight: flight(), failed: failed() }));
  }
  host.on<{ action: string; value?: number | boolean | string }>('feedback.control', event => {
    if (event.action === 'snapshot') void snapshot(event.value === 'measure');
    else if (event.action === 'sending') sending.set(event.value === true);
    else if (event.action === 'processing') processing.set(event.value === true);
    else if (event.action === 'flight') flight.set(event.value === true);
    else if (event.action === 'current') current.set(event.value === true);
    else if (event.action === 'unrelated') unrelated.set(Number(event.value));
    else if (event.action === 'failed') { sending.set(false); processing.set(false); flight.set(false); failed.set(true); }
    else if (event.action === 'locale') language.set(String(event.value));
  });
  return <View class="flex-1 bg-background">
    <View style={{ height: 48 }}><Text>Synthetic existing window chrome</Text></View>
    <View class="flex-1 flex-row min-h-0">
      <View class="shrink-0" style={{ width: 256 }} />
      <View class="flex-1 min-w-0 min-h-0">
        <View class="shrink-0" style={{ height: 64 }}><Text>Synthetic retained contact header</Text></View>
        <View testID="feedback-transcript-region" ref={value => { region = value; }} class="relative flex-1 min-h-0">
          <Transcript />
          <View testID="feedback-overlay-insets" accessible={false} class="absolute items-center" style={{ top: 0, right: 32, bottom: 0, left: 32, pointerEvents: 'none' }}>
            <View testID="feedback-overlay-column" ref={value => { column = value; }} accessible={false} class="relative flex-1 w-full" style={{ maxWidth: 672, pointerEvents: 'none' }}><Feedback /></View>
          </View>
        </View>
        <View ref={value => { composer = value; }} class="shrink-0" style={{ height: 76, paddingHorizontal: 32, paddingTop: 10, paddingBottom: 18 }}>
          <Input testID="feedback-real-input" value={draft()} style={{ height: 48 }} onChange={event => draft.set(event.value)} />
        </View>
      </View>
    </View>
    <Text testID="feedback-existing-error" style={{ height: 16 }}>{failed() ? 'Existing message-scoped failure' : 'Existing feedback placeholder'}</Text>
    <Text style={{ height: 1, fontSize: 1 }}>{`unrelated:${unrelated()}`}</Text>
    <Text testID="feedback-report" style={{ height: 1, fontSize: 1 }}>{`report:${report()}`}</Text>
    <Button testID="feedback-noop" class="absolute" style={{ top: 0, right: 0, width: 32, height: 32 }} onPress={() => {}}><Text>·</Text></Button>
  </View>;
}
mount(Fixture);

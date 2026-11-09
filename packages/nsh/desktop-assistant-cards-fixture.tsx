import { host, mount, signal, Text, View, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeDesktopAssistantCard } from './desktop-assistant-cards';
import { AssistantAvatar } from './assistants-avatar-live';
import { nativeAssistantAvatarClock } from './assistants-avatar-clock';
import { encodeAssistantAvatar, resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { language } from './i18n';
import { app, epoch } from './state';
import type { Row } from './model';

language.set('en');
function Fixture() {
  const draft = signal(''), unrelated = signal(0), interactive = signal(true), report = signal(''), calls = signal(0), mode = signal('complete');
  const live = signal<string | undefined>(undefined), working = signal(false), scheduleKind = signal('daily');
  let cardMounts = 0, sessionReads = 0, modelReads = 0, seedReads = 0, subscriptions = 0, releases = 0, sequence = 0;
  let sessionFrame: ViewRef | undefined, assistantFrame: ViewRef | undefined, scheduleFrame: ViewRef | undefined;
  const samples: Record<number, string> = {};
  const original = nativeAssistantAvatarClock.subscribe;
  nativeAssistantAvatarClock.subscribe = (scope, identity, seed, paint) => {
    const id = ++subscriptions;
    const lease = original(scope, identity, seed, sample => { samples[id] = sample.uri; paint(sample); });
    return { working: lease.working, release: () => { releases++; delete samples[id]; lease.release(); } };
  };
  const recipe = encodeAssistantAvatar({ ...resolveAssistantAvatar('card-fixture'), animate: true }, 'card-fixture');
  const assistant: Row = { id: 'assistant-new', working: false };
  Object.defineProperty(assistant, 'avatarSeed', { get: () => { seedReads++; return recipe; } });
  Object.defineProperty(assistant, 'working', { get: () => working() });
  const session: Row = { title: 'Actual live session title', directory: '/workspace/actual-project', summary: { additions: 12, deletions: 3, files: 2 } };
  Object.defineProperty(session, 'providerID', { get: () => { modelReads++; return 'openai'; } });
  Object.defineProperty(session, 'modelID', { get: () => { modelReads++; return 'gpt-5'; } });
  Object.defineProperty(session, 'title', { get: () => { sessionReads++; return 'Actual live session title'; } });
  const sessionCard = { type: 'card', cardType: 'session', sessionID: 'session-actual', directory: '/old/project', title: 'Original receipt title', status: 'complete', branch: 'stale' };
  const assistantCard = { type: 'card', cardType: 'assistant', assistantID: 'assistant-new', name: 'Created assistant with a long full accessible name', providerID: 'anthropic', modelID: 'claude-sonnet-4' };
  const scheduleCard = { type: 'card', cardType: 'schedule', taskID: 'task-actual', projectID: 'project-actual', name: 'Daily project summary', kind: 'daily', prompt: 'Read the project changes and prepare a full summary.', times: ['09:30'] };
  const originalParts: Row[] = [sessionCard, assistantCard, scheduleCard];
  function Card(props: { type: 'session' | 'assistant' | 'schedule' }) {
    cardMounts++;
    const card = () => props.type === 'session' ? mode() === 'sparse' ? { ...sessionCard, title: null, status: null } : sessionCard : props.type === 'assistant' ? assistantCard : { ...scheduleCard, kind: scheduleKind(), ...(scheduleKind() === 'weekly' ? { weekdays: [1, 5] } : scheduleKind() === 'cron' ? { cron: '0 9 * * 1', times: null } : scheduleKind() === 'once' ? { date: '2026-11-09', time: '09:30', times: null } : scheduleKind() === 'unknown' ? { times: null } : {}) };
    return <NativeDesktopAssistantCard card={card()} session={props.type === 'session' && mode() !== 'sparse' ? session : undefined} assistant={assistant}
      liveStatus={props.type === 'session' && live() ? { type: live() } : undefined} branch={mode() === 'sparse' ? undefined : 'feature/native-contact'}
      avatarClockScope={JSON.stringify([epoch(), app.connection()?.id])} current={interactive}
      onOpen={raw => { if (raw === sessionCard || raw === assistantCard || raw.cardType === 'schedule') calls.set(calls() + 1); }} />;
  }
  async function snapshot(measure = false) {
    const frames = measure ? { session: await sessionFrame?.measure(), assistant: await assistantFrame?.measure(), schedule: await scheduleFrame?.measure() } : undefined;
    report.set(JSON.stringify({ sequence: ++sequence, cardMounts, sessionReads, modelReads, seedReads, subscriptions, releases, frames, samples: Object.values(samples), rawIntact: originalParts[0].title === 'Original receipt title' && originalParts[0].branch === 'stale' }));
  }
  host.on<{ action: string; value?: string | number }>('cards.control', event => {
    if (event.action === 'snapshot') void snapshot(event.value === 'measure');
    else if (event.action === 'unrelated') unrelated.set(Number(event.value));
    else if (event.action === 'status') live.set(String(event.value));
    else if (event.action === 'schedule') scheduleKind.set(String(event.value));
    else if (event.action === 'locale') language.set(String(event.value));
    else if (event.action === 'sparse') { live.set(undefined); mode.set('sparse'); }
  });
  return <View class="flex-1 bg-background" style={{ padding: 16, gap: 8 }}>
    <View ref={ref => { sessionFrame = ref; }} class="shrink-0" style={{ width: 304, maxWidth: '100%' }}><Card type="session" /></View>
    <View ref={ref => { assistantFrame = ref; }} class="shrink-0" style={{ width: 304, maxWidth: '100%' }}><Card type="assistant" /></View>
    <View ref={ref => { scheduleFrame = ref; }} class="shrink-0" style={{ width: 304, maxWidth: '100%' }}><Card type="schedule" /></View>
    <Input testID="cards-input" value={draft()} onChange={event => draft.set(event.value)} style={{ height: 48 }} />
    <View class="flex-row" style={{ height: 32, gap: 8 }}><Button testID="cards-modal" onPress={() => interactive.set(!interactive())}><Text>Modal</Text></Button><Button testID="cards-working" onPress={() => working.set(!working())}><Text>Working</Text></Button></View>
    <AssistantAvatar bot={assistant} size={32} active={interactive()} testID="existing-shared-avatar" />
    <Text testID="cards-calls">{`calls:${calls()}`}</Text>
    <Text testID="cards-report" style={{ fontSize: 1, height: 1 }}>{`report:${report()}`}</Text>
    <Text style={{ fontSize: 1, height: 1 }}>{`unrelated:${unrelated()}`}</Text>
  </View>;
}
mount(Fixture);

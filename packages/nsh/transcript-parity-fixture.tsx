/** Isolated production components. No connection, model, speech, or settings writes. */
import { computed, List, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { messageFrom, record, type Row } from './model';
import { createNativeHistoryRows } from './history-rows';
import { createNativePendingHeaders, nativeTurnHeaderMessage, nativeTurnModelName, nativeTurnPresentation } from './transcript-tools-turn-model';
import { NativeTurnHeader } from './transcript-tools-turn';
import { NativeTranscriptBody } from './transcript-body';
import { nativeAppearance } from './appearance';
import { appearanceFromSettings } from './appearance-core';
import { createActivityMaterializer, materializedActivityMessage } from './transcript-materialization';

const txt = (text: string): Row => ({ type: 'text', text });
const tool = (id: string): Row => ({ type: 'tool', id, name: 'read', state: { status: 'completed', input: { filePath: 'example.ts' }, output: 'CONTENTS' } });
const user: Row = { id: 'u', type: 'user', text: 'Question', metadata: { model: { providerID: 'aggregate', modelID: 'gpt-fixture', variant: 'high' }, agent: 'plan' } };
const first: Row = { id: 'a', type: 'assistant', content: [{ type: 'reasoning', text: 'THOUGHT' }, txt('EARLY TEXT'), tool('read-a')], finish: 'tool-calls' };
const middle: Row = { id: 'b', type: 'assistant', content: [tool('read-b')], finish: 'tool-calls', model: { providerID: 'different', id: 'claude-fixture', variant: 'low' }, agent: 'build' };
const last: Row = { id: 'c', type: 'assistant', content: [txt('FINAL ANSWER')], finish: 'stop', model: { providerID: 'different', id: 'claude-fixture', variant: 'low' }, agent: 'build' };
const catalog = [{ id: 'aggregate', models: [{ id: 'gpt-fixture', name: 'Catalog GPT' }] }, { id: 'different', models: { 'claude-fixture': { name: 'Catalog Claude' } } }];

function App() {
  const source = signal([user, first, middle, last].map(raw => messageFrom(raw)!));
  const project = createNativeHistoryRows(), rows = computed(() => project(source()));
  const live = signal(false), choices = signal<Record<string, boolean>>({}), ready = signal(false);
  const reads = signal(0), fillRevision = signal(0), mounted = signal(true);
  const fill = createActivityMaterializer({ current: () => true, message: id => source().find(message => message.id === id),
    read: async (id, expected) => {
      reads.set(reads() + 1);
      if (reads() === 1) throw new Error('Fixture offline');
      return materializedActivityMessage({ id, type: 'assistant', content: [{ type: 'reasoning', id: 'slim-thought', text: 'EXACT THOUGHT' }, txt('SLIM ANSWER')] }, expected, 'fixture');
    },
    apply: (full, expected) => { if (!source().includes(expected)) return false; source.set(source().map(message => message === expected ? full : message)); return true; },
    changed: () => fillRevision.set(fillRevision() + 1),
  });
  const materialization = { request: fill.request, state: (ids: readonly string[]) => { fillRevision(); return fill.state(ids); } };
  const presentation = computed(() => nativeTurnPresentation(source(), live(), rows().slice().reverse()));
  const projectPending = createNativePendingHeaders(), pending = computed(() => projectPending(rows(), live(), false));
  void appearanceFromSettings({}, async () => ({ themes: [] })).then(appearance => {
    nativeAppearance.current.set({ ...appearance, uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] });
    ready.set(true);
  });
  function replace(raw: Row[], working = false) { fill.cancel(true); reads.set(0); choices.set({}); live.set(working); source.set(raw.map(item => messageFrom(item)!)); }
  function preference(patch: Row) { const value = nativeAppearance.current(); if (value) nativeAppearance.current.set({ ...value, ...patch }); }
  const header = (row: ReturnType<typeof project>[number]) => nativeTurnHeaderMessage(row, { active: live() });
  return <View class="flex-1 p-3">
    <Text testID="parity-ready">{ready() ? 'READY' : 'WAIT'}</Text>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="segmented" onPress={() => replace([user, first, { id: 'notice', type: 'synthetic', description: 'Continuing after restart' }, middle, last])}><Text>Segments</Text></Button>
      <Button testID="compact" onPress={() => replace([{ ...user, text: '/compact' }, { id: 'summary', type: 'assistant', content: [txt('COMPACT SUMMARY')], finish: 'stop' }])}><Text>Compact</Text></Button>
      <Button testID="pending-header" onPress={() => replace([user], true)}><Text>Pending</Text></Button>
      <Button testID="first-packet" onPress={() => source.set([user, { id: 'a', type: 'assistant', content: [txt('PACKET')] }].map(item => messageFrom(item)!))}><Text>Packet</Text></Button>
      <Button testID="reasoning-off" onPress={() => preference({ showReasoningTraces: false })}><Text>Hide reasoning</Text></Button>
      <Button testID="summary-mode" onPress={() => preference({ activityRenderMode: 'summary' })}><Text>Summary mode</Text></Button>
      <Button testID="live-mode" onPress={() => preference({ chatRenderMode: 'live' })}><Text>Live mode</Text></Button>
      <Button testID="skills" onPress={() => replace([user, { id: 'skills', type: 'assistant', finish: 'tool-calls', content: ['alpha', 'beta', 'gamma', 'delta'].map(name => ({ type: 'tool', id: name, name: 'skill', state: { status: 'completed', input: { name } } })) }, last])}><Text>Skills</Text></Button>
      <Button testID="wire-identity" onPress={() => replace([{ id: 'unknown-user', type: 'user', text: 'Identity' }, { ...first, model: { providerID: 'aggregate', id: 'gpt-fixture' } }])}><Text>Wire identity</Text></Button>
      <Button testID="drop-identity" onPress={() => source.set(source().map(message => ({ ...message, modelID: undefined, providerID: undefined, agent: undefined, projectionInfo: { ...record(message.projectionInfo), model: undefined, agent: undefined } })))}><Text>Partial identity</Text></Button>
      <Button testID="tasks" onPress={() => replace([user, { id: 'tasks', type: 'assistant', finish: 'tool-calls', content: ['one', 'one', 'two', 'three'].map((seed, index) => ({ type: 'tool', id: `task-${index}`, name: 'task', state: { status: 'completed', input: {}, metadata: { sessionID: `child-${seed}` } } })) }, last])}><Text>Tasks</Text></Button>
      <Button testID="active-compact" onPress={() => replace([{ ...user, text: '/compact' }, { id: 'summary', type: 'assistant', content: [txt('STREAMING SUMMARY')] }], true)}><Text>Active compact</Text></Button>
      <Button testID="settle" onPress={() => { source.set(source().map(message => message.role === 'assistant' ? { ...message, finish: 'stop' } : message)); live.set(false); }}><Text>Settle</Text></Button>
      <Button testID="slim" onPress={() => replace([user, { id: 'slim', type: 'assistant', finish: 'stop', content: [{ id: 'slim-thought', type: 'reasoning', slim: true }, txt('SLIM ANSWER')] }])}><Text>Slim</Text></Button>
      <Button testID="remount" onPress={() => mounted.set(!mounted())}><Text>Remount</Text></Button>
      <Button testID="two-turns" onPress={() => replace([user, first, last, { ...user, id: 'u2' }, { ...first, id: 'a2' }, { ...last, id: 'c2' }])}><Text>Two turns</Text></Button>
    </View>
    <Text>{`READS ${reads()}`}</Text>
    <If when={mounted()}>
    <List class="flex-1" inverted each={rows()} keyExtractor={row => row.key} testID="parity-list">
      {row => <View class="gap-2">
        <If when={!!presentation().get(row().head.id)?.header}><NativeTurnHeader message={header(row())} modelName={nativeTurnModelName(header(row()), catalog)} identityKey={row().turn?.turnId} /></If>
         <NativeTranscriptBody row={row()} live={live()} activityMaterialization={materialization} target={{ kind: 'session', id: 'fixture', directory: '/workspace/project', title: 'Fixture' }} current={() => true}
          activityChoice={choices()[row().turn?.turnId ?? row().key]} onToggleActivity={(key, expanded) => choices.set({ ...choices(), [key]: expanded })}
          renderCard={card => <Text>{String(card.id)}</Text>} />
        <If when={pending().has(row().head.id)}><NativeTurnHeader message={header(row())} modelName={nativeTurnModelName(header(row()), catalog)} identityKey={row().turn?.turnId} /></If>
      </View>}
    </List>
    </If>
  </View>;
}
mount(App);

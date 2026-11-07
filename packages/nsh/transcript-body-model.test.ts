import { describe, expect, it } from 'vitest';
import { messageFrom, type Message, type Row } from './model';
import { nativeBodyPlan, nativeBodyRows, nativeMessageRole, type NativeBodyNode } from './transcript-body-model';

const txt = (id: string, value = id): Row => ({ id, type: 'text', text: value });
const tool = (id: string, status = 'completed', name = 'bash'): Row => ({ id, type: 'tool', name, state: { status, input: { command: 'printf fixture' }, output: 'fixture output' } });
const msg = (id: string, content: Row[], extra: Row = {}): Message => messageFrom({ id, type: 'assistant', content, finish: 'stop', ...extra })!;
const order = (nodes: NativeBodyNode[]) => nodes.flatMap(node => node.kind === 'part' ? [node.part.source.id] : node.parts.map(part => part.source.id));

describe('native original-order turn body', () => {
  it('Activity headers deduplicate child-session identities and aggregate edits without consuming inline file bodies', () => {
    const task = (id: string, sessionID?: string, status = 'completed'): Row => ({ id, type: 'tool', name: 'task', state: { status, input: {}, metadata: { sessionID } } });
    const tasks = [task('t1', 'child-one'), task('resumed', 'child-one'), task('t2', 'child-two'), task('t3', undefined, 'running')];
    const edit: Row = { id: 'edit', type: 'tool', name: 'edit', slim: true, state: { status: 'completed', input: { filePath: 'a.ts' }, metadata: { additions: 7, deletions: 2 } } };
    const row = nativeBodyRows([msg('tools', [...tasks, edit], { finish: 'tool-calls' }), msg('final', [txt('answer')])])[0]!;
    const plan = nativeBodyPlan(row);
    expect(plan.header.agents).toEqual({ all: ['child-one', 'child-two', 'tools:t3'], active: ['tools:t3'] });
    expect(plan.header.diffs).toMatchObject({ added: 7, removed: 2 });
    expect(plan.materializationMessageIDs).toEqual(['tools']);
    expect(row.messages[0]!.content).toEqual([...tasks, edit]);
  });
  it('bodyless slim reasoning still owns an expandable Activity and exact-fill source', () => {
    const row = nativeBodyRows([msg('trace', [{ id: 'thought', type: 'reasoning', slim: true }, txt('answer')])])[0]!;
    expect(nativeBodyPlan(row)).toMatchObject({ hasActivity: true, activity: [], materializationMessageIDs: ['trace'] });
  });
  it('active compaction keeps its disclosure but locks open until authoritative settlement, even without tools', () => {
    const command = messageFrom({ id: 'compact', type: 'user', text: '/compact' })!;
    const active = msg('summary', [txt('summary')], { finish: undefined });
    const row = nativeBodyRows([command, active])[1]!;
    expect(nativeBodyPlan(row, { live: true })).toMatchObject({ compaction: true, hasActivity: true, locked: true, foldInline: true });
    const settled = nativeBodyRows([command, { ...active, finish: 'stop' }])[1]!;
    expect(nativeBodyPlan(settled)).toMatchObject({ compaction: true, hasActivity: true, locked: false, foldInline: true, defaultExpanded: false });
  });
  it('keeps the loaded row key when an older page extends the same assistant run and reuses unchanged rows', () => {
    const older = msg('older', [txt('older-text')]);
    const loaded = msg('loaded', [txt('loaded-text')]);
    const user = messageFrom({ id: 'user', type: 'user', text: 'Neutral question' })!;
    const newest = msg('newest', [txt('newest-text')]);
    const before = nativeBodyRows([loaded, user, newest]);
    const after = nativeBodyRows([older, loaded, user, newest], before);
    expect(after[0]!.key).toBe(before[0]!.key);
    expect(after[0]!.head).toBe(older);
    expect(after[0]!.messages).toEqual([older, loaded]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(before[0]!.head).toBe(loaded);
    expect(before[0]!.messages).toEqual([loaded]);
    expect(nativeBodyRows([older, loaded, user, newest], after)).toBe(after);
  });
  it('does not split an assistant run on historical identity changes', () => {
    const first = msg('first', [txt('first-text')]);
    const last = msg('last', [txt('last-text')]);
    const before = nativeBodyRows([last]);
    const merged = nativeBodyRows([first, last], before);
    const changed = { ...last, agent: 'different' };
    const split = nativeBodyRows([first, changed], merged);
    expect(split.map(row => row.key)).toEqual(['last']);
    expect(new Set(split.map(row => row.key)).size).toBe(split.length);
  });
  it('does not fold the running turn when an unanswered queued user arrives', () => {
    const running = msg('running', [tool('call', 'running')], { finish: 'tool-calls' });
    const queued = messageFrom({ id: 'queued', type: 'user', text: 'next' })!;
    const rows = nativeBodyRows([running, queued]);
    expect(nativeBodyPlan(rows[0]!).defaultExpanded).toBe(true);
    const next = nativeBodyRows([running, queued, msg('answer', [txt('answer-text')])], rows);
    expect(nativeBodyPlan(next[0]!).defaultExpanded).toBe(false);
  });
  it('50 live updates preserve all 200 settled history turns and identities', () => {
    const history = Array.from({ length: 200 }, (_, index) => [messageFrom({ id: `user-${index}`, type: 'user', text: `Question ${index}` })!, msg(`answer-${index}`, [txt(`body-${index}`)])]).flat();
    let live = msg('live', [txt('stream', '0')]);
    const activeUser = messageFrom({ id: 'active-user', type: 'user', text: 'current' })!;
    let previous = nativeBodyRows([...history, activeUser, live]);
    const settled = previous.slice(0, -2);
    for (let index = 1; index <= 50; index++) {
      live = { ...live, text: String(index), content: [txt('stream', String(index))] };
      const next = nativeBodyRows([...history, activeUser, live], previous);
      settled.forEach((row, at) => expect(next[at]).toBe(row));
      expect(next.at(-1)!.key).toBe(previous.at(-1)!.key);
      previous = next;
    }
  });
  it('keeps two production text parts before tools and only the trailing text outside Activity', () => {
    const row = nativeBodyRows([msg('m', [txt('one'), txt('two'), tool('call')], { finish: 'tool-calls' }), msg('last', [txt('final')])])[0]!;
    const plan = nativeBodyPlan(row);
    expect(order(plan.activity)).toEqual(['one', 'two', 'call']);
    expect(order(plan.inline)).toEqual(['final']);
    expect(plan.defaultExpanded).toBe(false);
    expect(plan.activity.map(node => node.kind)).toEqual(['part', 'part', 'process']);
  });
  it('groups consecutive assistant steps with real head/tail identities without inventing a message', () => {
    const user = messageFrom({ id: 'u', type: 'user', text: 'question', time: { created: 1000 } })!;
    const a = msg('a', [txt('one'), tool('call')], { finish: 'tool-calls' });
    const b = msg('b', [txt('two'), txt('final')], { time: { completed: 107000 } });
    const rows = nativeBodyRows([user, a, b]);
    expect(rows).toHaveLength(2); expect(rows[1]!.head).toBe(a); expect(rows[1]!.tail).toBe(b);
    expect(order(nativeBodyPlan(rows[1]!).activity)).toEqual(['one', 'call', 'two']);
    expect(order(nativeBodyPlan(rows[1]!).inline)).toEqual(['final']);
    expect(nativeBodyPlan(rows[1]!).durationMs).toBe(106000);
  });
  it.each(['pending', 'running', 'completed', 'error'])('retains %s tool input/output and authoritative active state', status => {
    const source = tool('call', status);
    const plan = nativeBodyPlan(nativeBodyRows([msg('m', [txt('one'), source, txt('final')])])[0]!);
    const group = plan.activity.find(node => node.kind === 'process')!;
    expect(group.kind).toBe('process');
    if (group.kind === 'process') { expect(group.parts[0]!.source).toBe(source); expect(group.active).toBe(['pending', 'running'].includes(status)); }
  });
  it('does not fold short no-tool turns or reorder/trim long readonly markdown', () => {
    const value = '# Heading\n\n' + 'full selectable text\n'.repeat(400) + '\n[link](https://example.test)\n```ts\nconst x = 1;\n```';
    const plan = nativeBodyPlan(nativeBodyRows([msg('m', [txt('full', value)])])[0]!);
    expect(plan.hasActivity).toBe(false); expect(plan.inline[0]!.kind).toBe('part');
    if (plan.inline[0]!.kind === 'part') expect(plan.inline[0]!.part.source.text).toBe(value);
  });
  it('hidden reasoning and empty Thought do not split tools, visible reasoning/narration does', () => {
    const parts = [tool('a'), { type: 'reasoning', text: 'Thinking' }, tool('b'), txt('empty', '\u200B'), tool('c'), txt('narration'), tool('d'), txt('final')];
    const row = nativeBodyRows([msg('m', parts.slice(0, -1), { finish: 'tool-calls' }), msg('last', [txt('final')])])[0]!;
    expect(nativeBodyPlan(row, { showReasoning: false }).activity.map(node => node.kind)).toEqual(['process', 'part', 'process']);
    expect(nativeBodyPlan(row).activity.map(node => node.kind)).toEqual(['process', 'part', 'process', 'part', 'process']);
  });
  it('keeps structured inline parts outside Activity without splitting the assistant turn', () => {
    const card = { type: 'card', id: 'card' }, file = { type: 'file', id: 'file', name: 'a.txt' };
    const a = msg('a', [txt('one'), tool('call'), card, txt('final'), file]);
    const b = msg('b', [txt('next')]);
    const rows = nativeBodyRows([a, b]); expect(rows).toHaveLength(1);
    expect(order(nativeBodyPlan(rows[0]!).activity)).toEqual(['one', 'call', 'final']);
    expect(order(nativeBodyPlan(rows[0]!).inline)).toEqual(['card', 'file', 'next']);
  });
  it('stays expanded during live step gaps and honors mode without dropping parts', () => {
    const row = nativeBodyRows([msg('m', [txt('one'), tool('call')], { finish: 'tool-calls' })])[0]!;
    expect(nativeBodyPlan(row, { live: true }).locked).toBe(true);
    expect(nativeBodyPlan(row, { live: false }).defaultExpanded).toBe(true);
    expect(nativeBodyPlan(row, { mode: 'live' }).hasActivity).toBe(false);
    expect(order(nativeBodyPlan(row, { mode: 'live' }).inline)).toEqual(['one', 'call']);
  });
  it('reuses consecutive Skill grouping, name precedence and three-name overflow without swallowing task/todo boundaries', () => {
    const skill = (id: string): Row => ({ id, type: 'tool', name: 'skill', state: { status: 'completed', input: { name: `input-${id}` }, metadata: { name: id } } });
    const row = nativeBodyRows([msg('skills', [skill('one'), skill('two'), skill('three'), skill('four'), tool('todo', 'completed', 'todowrite'), skill('five')], { finish: 'tool-calls' }), msg('final', [txt('final-body')])])[0]!;
    const plan = nativeBodyPlan(row);
    expect(plan.activity.map(node => node.kind)).toEqual(['skill', 'part', 'skill']);
    const group = plan.activity[0]!;
    if (group.kind === 'skill') expect(group.names).toEqual({ visibleNames: ['one', 'two', 'three'], joinedVisible: 'one, two, three', hiddenCount: 1 });
    expect(order(plan.activity)).toEqual(['one', 'two', 'three', 'four', 'todo', 'five']);
  });
  it('live mode keeps per-message tool groups while sorted Activity consolidates display-adjacent steps', () => {
    const row = nativeBodyRows([msg('first', [tool('one')], { finish: 'tool-calls' }), msg('second', [tool('two')], { finish: 'tool-calls' }), msg('final', [txt('body')])])[0]!;
    expect(nativeBodyPlan(row).activity.map(node => node.kind)).toEqual(['process']);
    expect(nativeBodyPlan(row, { mode: 'live' }).inline.map(node => node.kind)).toEqual(['process', 'process', 'part']);
  });
  it('honors normalized clientRole for legacy compaction commands without rewriting their source record', () => {
    const source = msg('legacy', [{ type: 'compaction' }]);
    const rows = nativeBodyRows([source, msg('summary', [txt('summary-text')])]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.head).toBe(source);
    expect(source.role).toBe('assistant');
    expect(nativeMessageRole(source)).toBe('user');
    expect(nativeBodyPlan(rows[0]!).inline).toEqual([]);
    expect(nativeBodyPlan(rows[1]!)).toMatchObject({ compaction: true, foldInline: true });
  });
  it('preserves legacy external files and recovered error source without a duplicate header row', () => {
    const attachment = { name: 'legacy.txt', uri: 'file:///host/legacy.txt' };
    const a = msg('a', [txt('one')], { error: { message: 'Original failure' }, files: [attachment] });
    const b = msg('b', [txt('final')]);
    const rows = nativeBodyRows([a, b]);
    expect(rows).toHaveLength(1); expect(rows[0]!.head.error).toBe('Original failure'); expect(rows[0]!.tail.error).toBe('');
    const file = nativeBodyPlan(rows[0]!).inline.find(node => node.kind === 'part' && node.part.source.type === 'file')!;
    expect(file.kind).toBe('part');
    if (file.kind === 'part') expect(file.part.source).toMatchObject({ type: 'file', name: 'legacy.txt' });
  });
});

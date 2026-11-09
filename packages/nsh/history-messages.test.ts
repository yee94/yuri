import { expect, it } from 'vitest';
import { mergeHistoryMessages, stableHistoryMessages } from './history-messages';
import { contactMessageFrom, messageFrom, messagesFrom, type Message, type Row } from './model';
import { hasSlimActivity } from './transcript-materialization';
const message = (id: string, text = id): Message => ({ id, role: 'user', text, reasoning: '', tools: [], cards: [], files: [], error: '' });

const toolPart = (slim = false, patch: Row = {}): Row => ({ id: 'call', type: 'tool', name: 'bash', ...(slim ? { slim: true } : {}), state: { status: 'completed', time: { start: 1, end: 2 }, input: { command: slim ? 'truncated' : 'complete command body' }, ...(slim ? {} : { output: 'EXACT OUTPUT', metadata: { patch: 'EXACT PATCH' } }), ...patch } });
const assistant = (content: Row[], extra: Row = {}) => messageFrom({ id: 'a', type: 'assistant', content, finish: 'stop', ...extra })!;

it('a slim poll retains settled exact bodies, complete inputs and rich metadata while adopting new summary metadata', () => {
  const previous = assistant([toolPart(), { id: 'thought', type: 'reasoning', text: 'FULL THOUGHT', time: { start: 1, end: 2 } }, { id: 'file', type: 'file', url: 'data:text/plain,exact', mime: 'text/plain' }]);
  const poll = assistant([toolPart(true, { metadata: { additions: 3 } }), { id: 'thought', type: 'reasoning', slim: true, time: { start: 1, end: 2 } }, { id: 'file', type: 'file', slim: true, mime: 'text/plain' }], { agent: 'new-authority' });
  const [next] = stableHistoryMessages([previous], [poll]);
  expect(next!.agent).toBe('new-authority'); expect(next!.reasoning).toBe('FULL THOUGHT'); expect(next!.files[0]!.url).toBe('data:text/plain,exact');
  expect(next!.tools[0]!.state).toMatchObject({ input: { command: 'complete command body' }, output: 'EXACT OUTPUT', metadata: { patch: 'EXACT PATCH', additions: 3 } });
  expect(hasSlimActivity(next!)).toBe(false); expect(previous.agent).toBeUndefined();
  const rows = [next!];
  for (let i = 0; i < 50; i++) expect(stableHistoryMessages(rows, [poll])).toBe(rows);
});
it('changed lifecycle clocks/status invalidate old exact bodies without affecting unrelated full parts', () => {
  const thought = { id: 'thought', type: 'reasoning', text: 'old thought', time: { start: 1, end: 2 } };
  const previous = assistant([toolPart(), thought]);
  for (const state of [{ status: 'running' }, { status: 'error' }, { time: { start: 1, end: 3 } }]) {
    const poll = assistant([toolPart(true, state), thought]);
    const [next] = mergeHistoryMessages([previous], [poll]);
    expect(next!.tools[0]!.slim).toBe(true); expect((next!.tools[0]!.state as Row).output).toBeUndefined();
    expect(next!.reasoning).toBe('old thought');
  }
  const poll = assistant([toolPart(true), { ...thought, text: undefined, slim: true, time: { start: 1, end: 3 } }]);
  const [next] = stableHistoryMessages([previous], [poll]);
  expect(next!.reasoning).toBe(''); expect((next!.tools[0]!.state as Row).output).toBe('EXACT OUTPUT');
});

it('repairs overlapping authoritative page order without ranking message ids or times', () => {
  const a = message('z-before'), b = message('a-after'), checkpoint = message('checkpoint');
  const previous = [a, b, checkpoint];
  const next = mergeHistoryMessages(previous, [a, checkpoint, b]);
  expect(next).toEqual([a, checkpoint, b]); expect(next[0]).toBe(a); expect(next[2]).toBe(b);
});
it('older page overlap preserves current content while a newer authority can settle it', () => {
  const current = message('overlap', 'live');
  const older = mergeHistoryMessages([current], [message('old'), message('overlap', 'stale')], true);
  expect(older[1]).toBe(current);
  const newest = mergeHistoryMessages(older, [message('overlap', 'final')]);
  expect(newest.map(row => row.text)).toEqual(['old', 'final']);
});
it('successful complete empty snapshots clear and repeated complete snapshots retain references', () => {
  const previous = [message('one')];
  expect(stableHistoryMessages(previous, [message('one')])).toBe(previous);
  expect(stableHistoryMessages(previous, [])).toEqual([]);
});
it('contact pagination and overlapping authority retain exact peer identity, clocks and latest status', () => {
  const peer = contactMessageFrom({ messageID: 'z-peer', role: 'peer', turnID: 'dm', ordinal: 2, createdAt: 500, fromAssistantID: 'sender', fromAssistantName: 'Sender', status: 'complete', text: 'hello' })!;
  const older = messagesFrom({ generation: 3, revision: 11, complete: true, messages: [
    { messageID: 'earlier', role: 'user', turnID: 'first', ordinal: 1, createdAt: 100, text: 'before' },
    { messageID: 'z-peer', role: 'peer', turnID: 'dm', ordinal: 2, createdAt: 400, fromAssistantID: 'stale-sender', status: 'error', text: 'stale' },
  ] }, true);
  const paged = mergeHistoryMessages([peer], older.messages, true);
  expect(paged.map(message => message.id)).toEqual(['earlier', 'z-peer']); expect(paged[1]).toBe(peer);
  const incoming = contactMessageFrom({ messageID: 'z-peer', role: 'peer', turnID: 'dm', ordinal: 2, createdAt: 500, fromAssistantID: 'sender', fromAssistantName: 'Renamed', status: 'complete', text: 'updated' })!;
  const settled = mergeHistoryMessages(paged, [incoming]);
  expect(settled[1]?.contact).toEqual(incoming.contact); expect(settled[1]?.time?.created).toBe(500);
  expect(stableHistoryMessages(settled, [...settled])).toBe(settled);
});
it('contact identity reconciliation preserves original cards/files and metadata on a no-op snapshot', () => {
  const card = { type: 'card', cardType: 'session', sessionID: 's' }, file = { type: 'file', mime: 'text/plain', url: 'data:text/plain,body' };
  const raw = { messageID: 'contact', role: 'assistant', createdAt: 100, turnID: 'turn', status: 'complete', parts: [card, file] };
  const previous = contactMessageFrom(raw)!;
  const poll = contactMessageFrom({ ...raw })!;
  const messages = [previous], next = stableHistoryMessages(messages, [poll]);
  expect(next).toBe(messages); expect(next[0]?.contact).toEqual(poll.contact);
  expect(next[0]?.cards).toEqual([card]); expect(next[0]?.files).toEqual([file]); expect(next[0]?.contextRaw).toBe(raw);
});

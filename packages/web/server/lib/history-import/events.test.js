import { describe, expect, test } from 'vitest';
import { Schema } from 'effect';
import { SessionMessage } from '@opencode/schema/session-message';
import { SessionTransfer } from '@opencode/schema/session-transfer';
import { combineSessions, parseTranscript, toNativeTransfer } from './events.js';

const at = '2026-01-01T00:00:00.000Z';
const claude = (id, parent, type, content, extra = {}) => ({ uuid: id, parentUuid: parent, type, timestamp: at, sessionId: 'chat', cwd: '/project', message: { content }, ...extra });

describe('source readers', () => {
  test.each(['parent_thread_id', 'thread_spawn'])('Codex self-parent metadata is detached without losing the transcript (%s)', (field) => {
    const parent = field === 'parent_thread_id' ? { parent_thread_id: 'same-thread' }
      : { source: { subagent: { thread_spawn: { parent_thread_id: 'same-thread' } } } };
    const result = parseTranscript('codex', [
      { type: 'session_meta', payload: { id: 'same-thread', ...parent } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Keep this conversation' } },
    ], 'fallback');
    expect(result.parentID).toBeUndefined();
    expect(result.events.map((event) => event.text)).toEqual(['Keep this conversation']);
    expect(result.warnings).toContain('parent_detached');
  });
  test('Claude follows the active branch and preserves genuine repeated messages', () => {
    const entries = [claude('u1', null, 'user', 'continue'), claude('a1', 'u1', 'assistant', [{ type: 'text', text: 'old' }]),
      claude('a2', 'u1', 'assistant', [{ type: 'text', text: 'new' }], { timestamp: '2026-01-01T00:00:01Z' }),
      claude('u2', 'a2', 'user', 'continue', { timestamp: '2026-01-01T00:00:02Z' })];
    const result = parseTranscript('claude', entries, 'fallback');
    expect(result.events.map((event) => event.text)).toEqual(['continue', 'new', 'continue']);
    expect(result.warnings).toContain('inactive_branches_omitted');
  });
  test('Claude keeps ordered text/tool/results and never fabricates tool completion', () => {
    const entries = [claude('u', null, 'user', 'hello'), claude('a', 'u', 'assistant', [
      { type: 'text', text: 'before' }, { type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'x' } }, { type: 'text', text: 'after' },
      { type: 'tool_use', id: 'missing', name: 'Bash', input: { command: 'never run' } },
    ]), claude('r', 'a', 'user', [{ type: 'tool_result', tool_use_id: 'call', content: 'full result' }], { timestamp: '2026-01-01T00:00:02Z' })];
    const result = parseTranscript('claude', entries, 'fallback');
    expect(result.events.map((event) => event.kind)).toEqual(['user', 'assistant-text', 'tool', 'assistant-text', 'tool']);
    expect(result.events[2]).toMatchObject({ output: 'full result', incomplete: false });
    expect(result.events[4]).toMatchObject({ incomplete: true });
  });
  test('parallel Claude tool fragments and snip relinks survive chain recovery', () => {
    const entries = [claude('u', null, 'user', 'hello'),
      claude('a1', 'u', 'assistant', [{ type: 'tool_use', id: 'one', name: 'Read' }], { message: { id: 'shared', content: [{ type: 'tool_use', id: 'one', name: 'Read' }] } }),
      claude('a2', 'u', 'assistant', [], { message: { id: 'shared', content: [{ type: 'tool_use', id: 'two', name: 'Read' }] }, timestamp: '2026-01-01T00:00:01Z' }),
      claude('r1', 'a1', 'user', [{ type: 'tool_result', tool_use_id: 'one', content: 'one' }]),
      claude('r2', 'a2', 'user', [{ type: 'tool_result', tool_use_id: 'two', content: 'two' }], { timestamp: '2026-01-01T00:00:02Z' })];
    expect(parseTranscript('claude', entries, 'fallback').events.filter((event) => event.kind === 'tool').map((event) => event.output).sort()).toEqual(['one', 'two']);
  });
  test.each([false, true])('Codex pairs both dual-track orders without removing repeated turns (%s)', (reverse) => {
    const event = (text) => ({ type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: text } });
    const response = (text) => ({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const pair = (text) => reverse ? [event(text), response(text)] : [response(text), event(text)];
    const assistant = { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } };
    const entries = [{ type: 'session_meta', payload: { id: 'codex', cwd: '/project' } }, ...pair('continue'), assistant, ...pair('continue'), assistant,
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }, ...pair('replacement')];
    const result = parseTranscript('codex', entries, 'fallback');
    expect(result.events.map((item) => item.text)).toEqual(['continue', 'answer', 'replacement']);
  });
  test('Codex includes complete tool outputs without replay payloads', () => {
    const result = parseTranscript('codex', [{ type: 'session_meta', payload: { id: 'id' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'shell', arguments: '{"cmd":"echo test"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'x'.repeat(100000) } }], 'fallback');
    expect(result.events[0].output).toHaveLength(100000);
    expect(result.events[0].incomplete).toBe(false);
  });
  test('Codex event-only assistant output survives without duplicating its native encoding or a later repeated turn', () => {
    const user = { type: 'event_msg', payload: { type: 'user_message', message: 'continue' } };
    const answer = { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } };
    const native = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } };
    const reasoning = { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'historical reasoning' } };
    const result = parseTranscript('codex', [user, answer, native, user, answer, reasoning], 'fixture');
    expect(result.events.map((event) => event.text)).toEqual(['continue', 'answer', 'continue', 'answer', 'historical reasoning']);
  });
  test('DSH surface replacements exclude superseded history and pair tool blocks only once', () => {
    const entries = [{ type: 'session', version: 4, id: 'dsh', cwd: '/project', parentSession: 'parent' },
      { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] } },
      { type: 'user/message', seq: 1, time: 2, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] } },
      { type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append', data: { message: { content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] } } },
      { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c', name: 'read', arguments: '{}' } },
      { type: 'tool/result', seq: 4, time: 4, surfaceOp: 'append', data: { message: { source: { callId: 'c' }, content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'result' }] }] } } }];
    const result = parseTranscript('dsh', entries, 'fallback');
    expect(result.events).toHaveLength(2);
    expect(result.events[0].text).toBe('summary');
    expect(result.events[1]).toMatchObject({ kind: 'tool', name: 'read', input: '{}', output: 'result', incomplete: false });
    expect(result.parentID).toBeUndefined();
    expect(result.warnings).toContain('fork_archived');
  });
  test('DSH unknown versions and broken sequences are explicit errors', () => {
    expect(() => parseTranscript('dsh', [{ type: 'session', version: 99, id: 'd' }], 'fallback')).toThrow('unsupported_source_version');
    expect(() => parseTranscript('dsh', [{ type: 'session', version: 4, id: 'd' }, { type: 'user/message', seq: 10 }], 'fallback')).toThrow('invalid_source');
  });
});

test('native transfer round-trips the installed official schemas, with no permissions or native replay data', () => {
  const session = parseTranscript('claude', [claude('u', null, 'user', [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' } }]),
    claude('a', 'u', 'assistant', [{ type: 'thinking', thinking: 'historical reasoning' }, { type: 'text', text: 'answer' }], { timestamp: '2026-01-01T00:00:01Z' })], 'fallback');
  const transfer = toNativeTransfer(session, '/project', 'ses_import', { version: 1 });
  const decoded = Schema.decodeUnknownSync(SessionTransfer.Data)({ info: transfer.info, messages: transfer.messages });
  expect(decoded.messages).toHaveLength(3);
  for (const message of transfer.messages) expect(() => Schema.decodeUnknownSync(SessionMessage.Info)(message)).not.toThrow();
  expect(transfer.info.permissions).toBeUndefined();
  expect(transfer.info.model).toBeUndefined();
  expect(transfer.messages[0].files[0].source).toEqual({ type: 'inline' });
  expect(transfer.info.time.updated).toBe(Date.parse('2026-01-01T00:00:01Z'));
});

test('explicit merge deduplicates only a shared prefix and preserves continuation order', () => {
  const u = (text) => ({ kind: 'user', text, time: 1 });
  const result = combineSessions([{ title: 'a', events: [u('hello'), u('continue')] }, { title: 'b', events: [u('hello'), u('different'), u('continue'), u('continue')] }]);
  expect(result.filter((event) => event.kind === 'user').map((event) => event.text)).toEqual(['hello', 'continue', 'different', 'continue', 'continue']);
});

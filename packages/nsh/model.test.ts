import { describe, expect, it } from 'vitest';
import { activeFrom, applySessionContent, eventBusy, eventSessionID, inboxFrom, messageFrom, messagesFrom, runtimeEventFrom, slashCommand, type RuntimeEvent } from './model';

describe('native protocol projections', () => {
  it('strips native version suffixes, preserves identity/clocks, and drops sync replicas', () => {
    const frame = { id: 'evt_one', created: 12, type: 'session.tool.success.2', location: { directory: '/repo' }, data: { sessionID: 's', assistantMessageID: 'm', id: 'call' } };
    expect(runtimeEventFrom({ key: 'chat', data: JSON.stringify(frame) })).toMatchObject({ type: 'session.tool.success', id: 'evt_one', created: 12, directory: '/repo' });
    expect(runtimeEventFrom({ key: 'chat', data: JSON.stringify({ ...frame, durable: { aggregateID: 'sync:s' } }) })).toBeNull();
  });
  it('updates per-kind ordinals in place and full end values repair missed deltas without doubling', () => {
    const first = messageFrom({ id: 'm', type: 'assistant', content: [{ type: 'text', text: 'old' }, { type: 'tool', id: 'z' }, { type: 'reasoning', text: 'think' }, { type: 'text', text: 'second' }] })!;
    const event = (type: string, body = {}): RuntimeEvent => ({ key: 'chat', type, directory: '/repo', body: { assistantMessageID: 'm', sessionID: 's', ...body } });
    const next = applySessionContent(first, event('session.text.delta', { ordinal: 1, delta: ' more' }))!;
    expect(next.text).toBe('old\n\nsecond more');
    expect(next.content?.map(part => part.type)).toEqual(['text', 'tool', 'reasoning', 'text']);
    expect(next.tools).toBe(first.tools);
    const ended = applySessionContent(next, event('session.text.ended', { ordinal: 1, text: 'settled' }))!;
    expect(ended.text).toBe('old\n\nsettled');
    expect(applySessionContent(ended, event('session.text.ended', { ordinal: 1, text: 'settled' }))).toBe(ended);
    expect(applySessionContent(ended, event('session.text.started', { ordinal: 1 }))).toBe(ended);
  });
  it('preserves real tool timestamps and terminal state against late input/called events', () => {
    const event = (type: string, body = {}, created = 100): RuntimeEvent => ({ key: 'chat', type, directory: '/repo', created, body: { assistantMessageID: 'm', sessionID: 's', id: 'call', ...body } });
    const first = applySessionContent(undefined, event('session.tool.input.started', { name: 'shell' }));
    const called = applySessionContent(first, event('session.tool.called', { input: { command: 'printf OK' } }));
    const ended = applySessionContent(called, event('session.tool.success', { content: [{ type: 'text', text: 'OK' }] }, 200))!;
    expect(ended.tools[0]).toMatchObject({ id: 'call', name: 'shell', state: { status: 'completed', output: 'OK', input: { command: 'printf OK' }, time: { start: 100, end: 200 } } });
    expect(applySessionContent(ended, event('session.tool.called'))).toBe(ended);
    expect(applySessionContent(ended, event('session.tool.input.delta', { delta: 'late' }))).toBe(ended);
  });
  it('keeps structured step failures visible and shutdown interruption busy', () => {
    const event: RuntimeEvent = { key: 'chat', type: 'session.step.failed', directory: '', body: { assistantMessageID: 'm', error: { type: 'provider.auth', message: 'Rejected' } } };
    expect(applySessionContent(undefined, event)?.error).toBe('Rejected');
    expect(eventBusy({ ...event, type: 'session.execution.interrupted', body: { reason: 'shutdown' } })).toBe(true);
    expect(eventBusy({ ...event, type: 'session.execution.interrupted', body: { reason: 'user' } })).toBe(false);
  });
  it('parses slash invocation arguments without silently flattening a command into text', () => {
    expect(slashCommand('/goal pause')).toEqual({ name: 'goal', text: 'pause' });
    expect(slashCommand('/explore inspect\nthis')).toEqual({ name: 'explore', text: 'inspect\nthis' });
    expect(slashCommand('ordinary /goal text')).toBeUndefined();
  });
  it('advances desc cursor.next, counts raw control rows, and stops on a short page', () => {
    const data = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, type: index ? 'system' : 'user', text: 'hello' }));
    expect(messagesFrom({ data, cursor: { next: 'opaque-next', previous: 'wrong' } }, false)).toMatchObject({ cursor: 'opaque-next', complete: false, messages: [{ id: 'm0' }] });
    expect(messagesFrom({ data: data.slice(0, 1), cursor: { next: 'position-only' } }, false)).toMatchObject({ cursor: null, complete: true });
    expect(messagesFrom({ data, cursor: 'bare' }, false).cursor).toBe('bare');
  });
  it('reads contact messageID, peer role, ordinal order, card and file parts', () => {
    const page = messagesFrom({ generation: 2, revision: 8, complete: true, messages: [
      { messageID: 'z', ordinal: 1, role: 'peer', parts: [{ type: 'text', text: 'hi' }, { type: 'card', cardType: 'session', sessionID: 's' }, { type: 'file', attachmentID: 'a' }] },
      { messageID: 'a', ordinal: 2, role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
    ] }, true);
    expect(page.messages.map(message => message.id)).toEqual(['z', 'a']);
    expect(page.messages[0]).toMatchObject({ role: 'user', text: 'hi', cards: [{ cardType: 'session' }], files: [{ attachmentID: 'a' }] });
  });
  it('keeps only real user inbox entries and throws for failed authority', () => {
    expect(inboxFrom({ data: [{ id: 'm', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'pending' } }, { id: 'c', type: 'compaction' }] })).toHaveLength(1);
    expect(() => inboxFrom({ error: 'unavailable' })).toThrow();
    expect(() => activeFrom({ s: { type: 'busy' } }, 's')).toThrow();
    expect(activeFrom({ s: { type: 'running' } }, 's')).toBe(true);
    expect(activeFrom({}, 's')).toBe(false);
  });
  it('decodes Swift data strings and native/legacy lifecycle bodies', () => {
    const event = runtimeEventFrom({ key: 'chat', data: JSON.stringify({ directory: '/repo', payload: { type: 'session.execution.started', data: { sessionID: 's' } } }) });
    expect(eventSessionID(event!)).toBe('s'); expect(eventBusy(event!)).toBe(true);
    expect(eventBusy(runtimeEventFrom({ key: 'chat', data: JSON.stringify({ type: 'session.execution.interrupted', properties: { sessionID: 's', reason: 'shutdown' } }) })!)).toBe(true);
    expect(runtimeEventFrom({ key: 'global', data: 'malformed' })).toBeNull();
  });
});

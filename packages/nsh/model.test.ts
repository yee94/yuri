import { describe, expect, it } from 'vitest';
import { activeFrom, applySessionContent, contactMessageFrom, eventBusy, eventSessionID, inboxFrom, mergeMessages, messageFrom, messagesFrom, runtimeEventFrom, sessionDisplayMetadata, sessionsFrom, slashCommand, type RuntimeEvent } from './model';

describe('native protocol projections', () => {
  it('keeps only real compact session display metadata from the original index without copying raw private fields', () => {
    const summary = { additions: 8, deletions: 0, files: 2, diffCount: 9, secret: 'do not retain' };
    const rows = sessionsFrom({ available: true, directories: [{ directory: '/repo', sessions: [
      { id: 's', title: 'Live title', time: { updated: 4 }, providerID: ' provider ', modelID: ' model ', summary, metadata: { secret: 'do not retain' } },
      { id: 'unknown', time: { updated: 3 }, summary: { additions: 0, deletions: -1, files: NaN } },
      { id: 'child', parentID: 's', time: { updated: 8 } },
    ] }] });
    expect(rows).toEqual([
      { id: 's', title: 'Live title', directory: '/repo', updated: 4, parentID: undefined, model: 'provider/model', summary: { additions: 8, files: 2 } },
      { id: 'unknown', title: 'unknown', directory: '/repo', updated: 3, parentID: undefined },
    ]);
    expect(rows[0]?.summary).not.toBe(summary);
    summary.additions = 999; expect(rows[0]?.summary?.additions).toBe(8);
    expect(sessionDisplayMetadata({ model: { provider: 'nested', id: 'exact' }, summary: { diffCount: 3 } })).toEqual({ model: 'nested/exact', summary: { files: 3 } });
    expect(sessionDisplayMetadata({ providerID: 'missing-model', model: { id: 'unpaired' }, summary: 'invalid' })).toEqual({});
  });
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
  it('retains real contact wire identity, original parts and clocks without changing compatible role', () => {
    const raw = { messageID: 'peer', assistantID: 'recipient', role: 'peer', turnID: 'dm', bubbleIndex: 0,
      createdAt: 1700000000123, ordinal: 4, status: 'complete', fromAssistantID: 'sender', fromAssistantName: 'Other bot',
      text: 'direct text', parts: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' },
        { type: 'card', cardType: 'assistant', assistantID: 'sender', name: 'Other bot', providerID: 'p', modelID: 'm', mode: 'continuous' },
        { type: 'file', mime: 'text/plain', filename: 'kept.txt', attachmentID: 'f', sha256: 'hash', size: 12 }],
      files: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==' }], sensitiveExtra: 'not-metadata' };
    const message = contactMessageFrom(raw)!;
    expect(message.contact).toEqual({ kind: 'peer', assistantID: 'recipient', turnID: 'dm', bubbleIndex: 0, createdAt: raw.createdAt, status: 'complete', fromAssistantID: 'sender', fromAssistantName: 'Other bot' });
    expect(message).toMatchObject({ role: 'user', text: 'direct text', time: { created: raw.createdAt }, ordinal: 4, cards: [raw.parts[2]], files: [raw.parts[3], raw.files[0]] });
    expect(message.contextRaw).toBe(raw); expect(message.content?.[0]).toBe(raw.parts[0]); expect(message.contextContent).toBe(message.content);
  });
  it('supports top-level text, content/parts, cards, files and structured or text contact errors without inventing body text', () => {
    const card = { type: 'card', cardType: 'session', sessionID: 's' }, file = { type: 'file', mime: 'text/plain', url: 'data:text/plain,kept' };
    expect(contactMessageFrom({ messageID: 'top', role: 'assistant', text: 'only top', cards: [card], files: [file], status: 'error' })).toMatchObject({ text: 'only top', error: 'only top', cards: [card], files: [file] });
    expect(contactMessageFrom({ messageID: 'parts', role: 'assistant', parts: [{ type: 'text', text: 'first' }, { type: 'text', text: '\nsecond' }] })?.text).toBe('first\nsecond');
    expect(contactMessageFrom({ messageID: 'content', role: 'user', content: [{ type: 'text', text: 'body' }, file], error: { message: 'Rejected' } })).toMatchObject({ text: 'body', error: 'Rejected', files: [file] });
    expect(contactMessageFrom({ messageID: 'failure', role: 'assistant', error: 'Offline' })?.error).toBe('Offline');
    expect(contactMessageFrom({ messageID: 'empty', role: 'assistant', text: '', parts: [{ type: 'text', text: 'not the top-level body' }] })?.text).toBe('');
  });
  it('copies only finite contact timestamps, does not guess order for ties or missing ordinals, and preserves revision authority', () => {
    const rows = [{ messageID: 'z', role: 'user', ordinal: 2, createdAt: Infinity }, { messageID: 'a', role: 'assistant', ordinal: 2, createdAt: '12' }, { messageID: 'late-id', role: 'peer', ordinal: 1, createdAt: 0 }];
    const page = messagesFrom({ messages: rows, nextCursor: 'opaque', complete: false, generation: 8, revision: 190 }, true);
    expect(page.messages.map(message => message.id)).toEqual(['late-id', 'z', 'a']);
    expect(page).toMatchObject({ cursor: 'opaque', complete: false, generation: 8, revision: 190 });
    expect(page.messages[0]?.time?.created).toBe(0); expect(page.messages[1]?.time?.created).toBeUndefined(); expect(page.messages[2]?.contact?.createdAt).toBeUndefined();
    const partial = messagesFrom({ messages: [rows[0], { messageID: 'unranked', role: 'user' }, rows[2]], complete: true }, true);
    expect(partial.messages.map(message => message.id)).toEqual(['z', 'unranked', 'late-id']);
  });
  it('keeps ordinary Session semantics unchanged even when contact-looking fields are present', () => {
    const raw = { id: 'm', type: 'peer', createdAt: 123, fromAssistantID: 'sender', parts: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], time: { created: 7 } };
    const message = messageFrom(raw)!;
    expect(message).toMatchObject({ role: 'user', text: 'one\n\ntwo', time: { created: 7 } });
    expect(message.contact).toBeUndefined(); expect(message.contextRaw).toBe(raw);
    expect(messagesFrom({ data: [raw] }, false).messages[0]).toEqual(message);
    expect(contactMessageFrom({ role: 'system', id: 'control' })).toBeNull();
  });
  it('retains contact semantics through incremental content and identity merges, with no historical status revival', () => {
    const original = contactMessageFrom({ messageID: 'm', role: 'assistant', turnID: 'turn', createdAt: 10, status: 'streaming', parts: [{ type: 'text', ordinal: 0, text: 'first' }] })!;
    const event: RuntimeEvent = { key: 'chat', type: 'session.text.delta', directory: '', body: { assistantMessageID: 'm', ordinal: 0, delta: ' second' } };
    const streamed = applySessionContent(original, event)!;
    expect(streamed.contact).toBe(original.contact); expect(streamed.time).toBe(original.time);
    expect(mergeMessages([original], [streamed])[0]).toMatchObject({ text: 'first second', contact: original.contact });
    const authoritative = contactMessageFrom({ messageID: 'm', role: 'assistant', turnID: 'turn', createdAt: 10, status: 'complete', text: 'finished' })!;
    expect(mergeMessages([streamed], [authoritative])[0]?.contact?.status).toBe('complete');
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

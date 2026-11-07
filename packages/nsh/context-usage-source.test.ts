import { describe, expect, it } from 'vitest';
import { applySessionContent, messageFrom, messagesFrom, type Message, type Row, type RuntimeEvent } from './model';
import { contextUsageEntryFromNative, contextUsagePatchFromNative, contextUsageSnapshotFromChat, createContextUsageSourceAdapter } from './context-usage-source';
import { createContextUsageOwner } from './context-usage-core';
import { contextUsageFixtureSnapshot } from './context-usage-fixture-data';
import { normalizeSessionProjectionMessage } from '../ui/src/sync/context-usage-projection';
import { materializedActivityMessage } from './transcript-materialization';

const seed = contextUsageFixtureSnapshot(), scope = seed.scope;
function native(id = 'answer', extra: Row = {}): Row {
  return { id, type: 'assistant', sessionID: scope.sessionID, model: { id: 'model', providerID: 'actual' },
    time: { created: 1000, streamed: 3000, completed: 3100 }, finish: 'stop', cost: .002,
    tokens: { input: 1200, output: 100, reasoning: 20, cache: { read: 300, write: 40 } },
    content: [{ type: 'text', text: 'Actually received' }], futureMetadata: { preserved: true }, ...extra };
}
function message(raw: Row): Message {
  const value = messageFrom(raw); if (!value) throw new Error('Test source was dropped'); return value;
}
function snapshot(messages: Message[]) {
  return contextUsageSnapshotFromChat({ scope, messages, messagesResolved: true, session: seed.session, providers: seed.providers });
}
function ownerFor(messages: Message[]) {
  const owner = createContextUsageOwner(scope, { current: () => true, showAssistantTps: true }); owner.reset(snapshot(messages)); return owner;
}
function delta(id: string, value: string, type = 'session.text.delta'): RuntimeEvent {
  return { key: 'chat', type, directory: scope.directory, created: 999999, body: { sessionID: scope.sessionID, assistantMessageID: id, ordinal: 0, delta: value } };
}

describe('production context source: current loaded Chat, retained received data and unknown usage', () => {
  it('retains full native wire identity and delegates canonical projection to the shared Web normalizer', () => {
    const raw = native(), source = message(raw), entry = contextUsageEntryFromNative(source, scope.sessionID)!;
    expect(source.contextRaw).toBe(raw); expect(source.tokens).toEqual({ output: 100, reasoning: 20 });
    const expected = normalizeSessionProjectionMessage(scope.sessionID, raw)!;
    expect({ info: entry.info, parts: entry.parts }).toEqual(expected);
    expect(contextUsageEntryFromNative(source, scope.sessionID)).toBe(entry);
    const owner = ownerFor([source]);
    expect(owner.view()).toMatchObject({ tokenBreakdown: { input: 1200, output: 100, cacheRead: 300, cacheWrite: 40, total: 1660 }, totalAssistantCost: .002, providerModel: { providerName: 'Actual provider' } });
    expect(owner.known()).toMatchObject({ cost: true, tokens: { total: true, input: true }, partial: false });
    expect(JSON.parse(owner.json(source.id))).toEqual(raw); // Unknown future fields are not lost in the render normalizer.
  });
  it('uses only messagesFrom’s current loaded window in authoritative order; no full-history read or first-session/model guess', () => {
    const page = messagesFrom({ data: [native('second'), { id: 'first', type: 'user', text: 'hello', time: { created: 1 } }], cursor: { next: 'opaque' } }, false, 2);
    expect(page.complete).toBe(false);
    const current = snapshot(page.messages);
    expect(current.messages.map(row => row.info.id)).toEqual(['first', 'second']);
    expect(current.messages[1].info.sessionID).toBe(scope.sessionID);
    expect(current.scope).toEqual(scope); expect(current.scope).not.toBe(scope);
    expect(current.providers).toBe(seed.providers);
    expect(snapshot([]).messages).toEqual([]);
    const base = { scope, messages: page.messages, session: seed.session, providers: seed.providers };
    expect(() => contextUsageSnapshotFromChat({ ...base, messagesResolved: false })).toThrow('unresolved');
    expect(() => contextUsageSnapshotFromChat({ ...base, messagesResolved: true, historyError: 'refresh failed' })).toThrow('refresh failed');
    expect(() => contextUsageSnapshotFromChat({ ...base, messagesResolved: true, session: { id: 'wrong' } })).toThrow('scope mismatch');
  });
  it('keeps missing cost/input/cache unknown, including raw row counters; explicit zero remains known', () => {
    const unknown = ownerFor([message(native('partial', { cost: undefined, tokens: { output: 100 } }))]);
    expect(unknown.known()).toEqual({ cost: false, composition: false, partial: true, tokens: { input: false, output: true, reasoning: false, cacheRead: false, cacheWrite: false, total: false } });
    const zero = ownerFor([message(native('zero', { cost: 0, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))]);
    expect(zero.known()).toMatchObject({ cost: true, tokens: { output: true, cacheRead: true, cacheWrite: true, total: true } });
    expect(zero.view()?.totalAssistantCost).toBe(0);
    expect(ownerFor([message(native('all-zero', { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))]).known()).toMatchObject({ partial: false, tokens: { total: true } });
    expect(ownerFor([]).known()).toMatchObject({ cost: true, partial: false, tokens: { total: true } });
  });
  it('accepts legacy info/parts and flat role/parts without throwing away cost/cache/extra received fields', () => {
    const entry = seed.messages[2], raw = { info: entry.info, parts: entry.parts, extension: 'received' };
    for (const wire of [raw, { ...entry.info, parts: entry.parts }]) {
      const source = message(wire), canonical = contextUsageEntryFromNative(source, scope.sessionID)!;
      expect(source.id).toBe(entry.info.id); expect(source.contextRaw).toBe(wire);
      expect(canonical.info).toEqual(entry.info); expect(canonical.parts).toBe(entry.parts);
      const owner = ownerFor([source]); expect(owner.known().cost).toBe(true); expect(JSON.parse(owner.json(source.id))).toEqual(wire);
      const updated = applySessionContent(source, delta(source.id, ' live'))!;
      expect(contextUsageEntryFromNative(updated, scope.sessionID)!.parts[0]).toMatchObject({ text: String((entry.parts[0] as { text?: string }).text) + ' live' });
    }
  });
  it('live-only source shows actually received content without invented token totals, costs or TPS clocks', () => {
    const streamed = applySessionContent(undefined, delta('live', 'Only live data'))!;
    const entry = contextUsageEntryFromNative(streamed, scope.sessionID)!;
    expect(entry.info.time).toEqual({}); expect(entry.info.tokens).toBeUndefined(); expect(entry.info.cost).toBeUndefined();
    expect(entry.parts[0]).toMatchObject({ type: 'text', text: 'Only live data' });
    const owner = ownerFor([streamed]);
    expect(owner.view()).toMatchObject({ sessionTpsLabel: null, lastAssistantTpsLabel: null, lastActivityAt: seed.session.time?.created });
    expect(owner.known()).toMatchObject({ cost: false, partial: true, tokens: { input: false, total: false } });
    expect(JSON.parse(owner.json('live'))).toMatchObject({ received: { id: 'live', type: 'assistant' }, currentContent: [{ text: 'Only live data' }] });
  });
  it('GET plus body delta preserves measured usage, updates just the affected content and distinguishes live overlay from received wire', () => {
    const raw = native(), first = message(raw), owner = ownerFor([first]), before = owner.operations();
    const changed = applySessionContent(first, delta(first.id, ' appended'))!;
    expect(changed.contextRaw).toBe(raw);
    owner.patch(contextUsagePatchFromNative(scope, changed));
    expect(owner.message(first.id)?.parts[0]).toMatchObject({ text: 'Actually received appended' });
    expect(owner.view()?.totalAssistantCost).toBe(.002); expect(owner.known().tokens.input).toBe(true);
    expect(owner.operations().messageVisits - before.messageVisits).toBe(1);
    expect(JSON.parse(owner.json(first.id))).toEqual({ received: raw, currentContent: changed.content });
    const failure = applySessionContent(changed, { ...delta(first.id, ''), type: 'session.step.failed', body: { assistantMessageID: first.id, error: { message: 'Actual failure' } } })!;
    expect(contextUsageEntryFromNative(failure, scope.sessionID)?.info.error).toMatchObject({ message: 'Actual failure' });
  });
  it('never derives assistant TPS from event.created, completed or client wall clocks', () => {
    const source = message(native('no-clock', { time: { completed: 3000 } }));
    const changed = applySessionContent(source, delta(source.id, ' late'))!;
    expect(contextUsageEntryFromNative(changed, scope.sessionID)?.info.time).toEqual({ completed: 3000 });
    const owner = ownerFor([changed]); expect(owner.view()?.sessionTpsLabel).toBeNull(); expect(owner.view()?.lastAssistantTpsLabel).toBeNull();
  });
  it('slim activity remains a real received source, visibly incomplete; never fabricates body data or composition', () => {
    const raw = native('slim', { content: [{ type: 'tool', id: 'tool', name: 'read', slim: true, state: { status: 'completed' } }] });
    const owner = ownerFor([message(raw)]);
    expect(owner.known()).toMatchObject({ partial: true, composition: false, cost: true, tokens: { total: true } });
    expect(JSON.parse(owner.json('slim'))).toEqual(raw);
    const original = message(raw);
    const full = materializedActivityMessage(native('slim', { content: [{ type: 'tool', id: 'tool', name: 'read', state: { status: 'completed', input: { path: 'actual.ts' }, output: 'Exact received body' } }] }), original, scope.sessionID);
    const filled = ownerFor([full]);
    expect(filled.known().partial).toBe(false);
    expect(JSON.parse(filled.json('slim'))).toMatchObject({ received: raw, currentContent: [{ state: { output: 'Exact received body' } }] });
  });
  it('rejects absent raw authority, mismatched IDs/sessions and malformed legacy fields; errors preserve prior source', () => {
    const source = message(native()), owner = ownerFor([source]), prior = owner.view();
    for (const invalid of [
      { ...source, contextRaw: undefined },
      { ...source, contextRaw: native('wrong') },
      message(native('bad-session', { sessionID: 'wrong' })),
      message({ info: { ...seed.messages[2].info, sessionID: 'wrong' }, parts: seed.messages[2].parts }),
      message({ ...seed.messages[2].info, parts: [{ type: 'text' }] }),
    ]) {
      expect(() => contextUsageEntryFromNative(invalid, scope.sessionID)).toThrow();
      try { owner.reset(snapshot([invalid])); } catch (error) { owner.failed(error); }
      expect(owner.view()).toEqual(prior);
    }
    contextUsageEntryFromNative(source, scope.sessionID);
    expect(() => contextUsageEntryFromNative(source, 'other')).toThrow('across sessions');
    expect(contextUsageEntryFromNative(message({ id: 'idle', type: 'future', role: 'idle' }), scope.sessionID)).toBeNull();
  });
  it('200 patches over a 5100-message authority normalize only their supplied record and never access the history window', () => {
    const messages = Array.from({ length: 1700 }, (_, index) => [message({ id: `user-${index}`, type: 'user', text: 'Question', time: { created: 1 } }), message(native(`step-${index}`, { finish: 'tool-calls' })), message(native(`answer-${index}`))]).flat();
    const owner = ownerFor(messages), first = owner.message(messages[0].id), before = owner.operations();
    let current = messages.at(-1)!;
    for (let index = 0; index < 200; index++) {
      current = applySessionContent(current, delta(current.id, '.'))!;
      const patch = contextUsagePatchFromNative(scope, current);
      expect(patch.entries).toHaveLength(1); owner.patch(patch);
    }
    expect(owner.operations().messageVisits - before.messageVisits).toBe(200);
    expect(owner.operations().turnVisits - before.turnVisits).toBeLessThanOrEqual(600);
    expect(owner.operations().resets).toBe(1); expect(owner.operations().jsonBuilds).toBe(0);
    expect(owner.message(messages[0].id)).toBe(first);
  });
  it('route adapter captures scope, batches only touched commits, and rereads the loaded Chat only at structural boundaries', () => {
    let reads = 0, current = true;
    let rows = [message(native('first')), message(native('second'))];
    const originalScope = { ...scope };
    const adapter = createContextUsageSourceAdapter({ scope: originalScope, current: () => current, read: () => {
      reads++; return { messages: rows, messagesResolved: true, session: seed.session, providers: seed.providers };
    } });
    originalScope.directory = '/not-the-captured-chat';
    expect(adapter.snapshot()).toMatchObject({ kind: 'snapshot', value: { scope } }); expect(reads).toBe(1);
    for (let index = 0; index < 200; index++) {
      rows = rows.map(row => applySessionContent(row, delta(row.id, '.'))!);
      const source = adapter.commit(rows);
      expect(source).toMatchObject({ kind: 'patch', entries: [{ info: { id: 'first' } }, { info: { id: 'second' } }] });
    }
    expect(reads).toBe(1); // Not one read/normalization of the loaded history per token.
    rows = [...rows, message(native('new'))];
    expect(adapter.commit([rows[2]])).toMatchObject({ kind: 'snapshot', value: { messages: [{}, {}, { info: { id: 'new' } }] } }); expect(reads).toBe(2);
    const legacy = seed.messages[2]; rows = [message({ info: { ...legacy.info, id: 'first', parentID: 'changed-parent' }, parts: legacy.parts.map(part => ({ ...part, messageID: 'first' })) })];
    expect(adapter.commit(rows)?.kind).toBe('snapshot'); expect(reads).toBe(3);
    current = false; expect(adapter.snapshot()).toBeNull(); expect(adapter.commit(rows)).toBeNull(); expect(reads).toBe(3);
    current = true; adapter.dispose(); expect(adapter.snapshot()).toBeNull(); expect(reads).toBe(3);
  });
});
